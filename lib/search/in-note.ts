import { query as dbQuery, toVector } from '../db';
import { getEmbedding, embeddingModelKey } from '../embeddings';
import { getEmbeddingConfig } from '../settings';
import { escapeLike } from '../sql';
import { extractHeadings } from '../markdown';
import { rerankConfig, rerankAvailable, rerankTexts, bestWindow } from '../rerank';
import type { ArmFailure, HybridSearchResult, SearchResult } from './types';
import { RRF_K } from './config';
import { NEEDLE_CHARS, OFFSET_WORTH_IT_ABOVE } from './results';
import { bestPassageOffset, makeExcerpt, stripLeadingHeading } from './excerpt';
import { significantWords } from './signals';
import { reasonOf, SearchUnavailableError } from './hybrid';
import { project, type SearchOptions } from './service';

/** Chunks each arm puts into one note's candidate pool. */
const IN_NOTE_CANDIDATES = 15;

type NoteChunk = { chunk_index: number; heading: string | null; content: string; score: number };

/**
 * The note's chunks nearest the query by meaning. match_chunks ranks across
 * the vault and keeps two chunks per note; materializing this note's chunks
 * keeps the vector index out, so the order within the note is exact.
 */
async function noteChunksByMeaning(noteId: string, query: string, modelKey: string, count: number): Promise<NoteChunk[]> {
  const embedding = await getEmbedding(query, 'query');
  return dbQuery<NoteChunk>(
    `with scoped as materialized (
       select chunk_index, heading, content, embedding from note_chunks
       where note_id = $1 and embedding is not null
         and (embedding_model is null or embedding_model = $3)
     )
     select chunk_index, heading, content, 1 - (embedding <=> $2::vector) as score
     from scoped order by embedding <=> $2::vector, chunk_index limit $4`,
    [noteId, toVector(embedding), modelKey, count]
  );
}

/**
 * The note's chunks containing the query's words, each word weighted by its
 * rarity in this note, so a word found in almost every chunk cannot outvote a
 * rare one. Substring rather than full-text: compound words still match, and
 * no language setting has to fit the note.
 */
async function noteChunksByWords(noteId: string, words: string[], count: number): Promise<NoteChunk[]> {
  if (words.length === 0) return [];
  return dbQuery<NoteChunk>(
    `with scoped as materialized (
       select chunk_index, heading, content, coalesce(heading, '') || ' ' || content as hay
       from note_chunks where note_id = $1
     ),
     hits as materialized (
       select s.chunk_index, w.i
       from scoped s cross join unnest($2::text[]) with ordinality as w(pattern, i)
       where s.hay ilike w.pattern
     ),
     weights as (
       select i, ln(1 + (select count(*) from scoped)::float / (1 + count(*))) as weight
       from hits group by i
     ),
     ranked as (
       select chunk_index, sum(weight) as score from hits join weights using (i) group by chunk_index
     )
     select s.chunk_index, s.heading, s.content, r.score
     from ranked r join scoped s using (chunk_index)
     order by r.score desc, s.chunk_index
     limit $3`,
    [noteId, words.map((w) => `%${escapeLike(w)}%`), count]
  );
}

/** How far before its located paragraph a chunk may start in the note's text. */
const CHUNK_START_SLACK = 200;

/**
 * Offset and section for each place, looked up from inside its own chunk.
 * The vault-wide lookups take the first occurrence of an excerpt's text,
 * which in a book is often the table of contents repeating a chapter's
 * opening line. A chunk's longest paragraph is kept verbatim by the chunker
 * and rarely repeated, so it tells which occurrence belongs to this chunk.
 */
async function placeInNote(noteId: string, page: SearchResult[], chunks: NoteChunk[], query: string): Promise<void> {
  const [note] = await dbQuery<{ content: string }>('select content from notes where id = $1', [noteId]);
  if (!note) return;
  const { content } = note;
  const headings = extractHeadings(content);
  page.forEach((r, i) => {
    const needle = r.excerpt.replace(/^[…\s]+/, '').replace(/[…\s]+$/, '').slice(0, NEEDLE_CHARS);
    if (needle.length < 20) return;
    const chunk = chunks[i].content;
    const probe = chunk.split(/\n{2,}/).reduce((a, b) => (b.length > a.length ? b : a), '');
    const probeAt = content.indexOf(probe);
    const from = probeAt === -1 ? 0 : Math.max(0, probeAt - chunk.indexOf(probe) - CHUNK_START_SLACK);
    const at = content.indexOf(needle, from);
    if (at === -1) return;
    if (content.length > OFFSET_WORTH_IT_ABOVE) r.excerpt_offset = at;
    // Same rule as attachSections: the heading above the line that matches
    // the query, not above wherever the excerpt window happens to open.
    const anchor = bestPassageOffset(content.slice(at, at + r.excerpt.length), query);
    const target = at + (anchor?.start ?? 0);
    let heading: string | null = null;
    for (const h of headings) {
      if (h.offset > target) break;
      heading = h.text;
    }
    if (heading) r.section = heading;
  });
}

export type InNoteSearch = {
  results: SearchResult[];
  hasMore: boolean;
  armsUsed: ('text' | 'semantic')[];
  failures: ArmFailure[];
  reranked: boolean;
  /** A reranker is switched on, so `reranked: false` means it did not answer. */
  rerankEnabled: boolean;
  embeddingModel: string;
  /** The note's index is being rebuilt: places may be missing or show older text. */
  indexPending: boolean;
};

/**
 * Places inside one note, best first — for a hit that is a long document,
 * where the vault-wide search shows one excerpt per note. Candidates come from
 * both arms; the reranker orders them when available, rank fusion otherwise.
 * rerank_min_score is not applied: the caller has already chosen the note.
 *
 * null when no live note has this id.
 */
export async function searchInNote(
  noteId: string,
  query: string,
  options: Pick<SearchOptions, 'mode' | 'limit' | 'offset' | 'explain' | 'rerank'> = {}
): Promise<InNoteSearch | null> {
  const { mode = 'hybrid', limit = 10, offset = 0, explain = false, rerank = true } = options;
  const [note] = await dbQuery<{ id: string; title: string; tags: string[]; content_length: number; embedding_pending: boolean }>(
    'select id, title, tags, length(content) as content_length, embedding_pending from notes where id = $1 and deleted_at is null',
    [noteId]
  );
  if (!note) return null;

  const modelKey = embeddingModelKey(await getEmbeddingConfig());
  const words = [...new Set(significantWords(query.toLowerCase()))];
  const pool = Math.max(IN_NOTE_CANDIDATES, offset + limit);
  const arms = ([
    ['text', 'text_score', () => noteChunksByWords(note.id, words, pool)],
    ['semantic', 'semantic_score', () => noteChunksByMeaning(note.id, query, modelKey, pool)],
  ] as const).filter(([arm]) => mode === 'hybrid' || mode === arm);
  const outcomes = await Promise.allSettled(arms.map(([, , run]) => run()));

  type Field = 'text_score' | 'semantic_score';
  type Place = { chunk: NoteChunk; fused: number; matchedBy: Field[]; scores: Partial<Record<Field, number>>; rerank?: number };
  const places = new Map<number, Place>();
  const failures: ArmFailure[] = [];
  const armsUsed: ('text' | 'semantic')[] = [];
  outcomes.forEach((outcome, i) => {
    const [arm, field] = arms[i];
    if (outcome.status === 'rejected') {
      failures.push({ arm, reason: reasonOf(outcome.reason) });
      return;
    }
    armsUsed.push(arm);
    outcome.value.forEach((chunk, rank) => {
      const place = places.get(chunk.chunk_index) ?? { chunk, fused: 0, matchedBy: [], scores: {} };
      place.fused += 1 / (RRF_K + rank + 1);
      place.matchedBy.push(field);
      place.scores[field] = chunk.score;
      places.set(chunk.chunk_index, place);
    });
  });
  if (armsUsed.length === 0) throw new SearchUnavailableError(failures);

  const byChunkOrder = (a: Place, b: Place) => a.chunk.chunk_index - b.chunk.chunk_index;
  const ranked = [...places.values()].sort((a, b) => b.fused - a.fused || byChunkOrder(a, b));

  const cfg = await rerankConfig();
  let reranked = false;
  if (cfg && rerank && mode === 'hybrid' && ranked.length > 1 && rerankAvailable()) {
    // The same short window, chosen by the same words, as the vault-wide pass
    // (selectPassages): counting short words such as articles picks a window
    // that lacks the term the query is about.
    const windowWords = words.filter((w) => w.length > 3);
    const scored = await rerankTexts(
      query,
      ranked.map(({ chunk }) => (chunk.heading ? chunk.heading + '\n' : '') + bestWindow(chunk.content, windowWords)),
      cfg
    );
    if (scored) {
      for (const { index, score } of scored) ranked[index].rerank = score;
      ranked.sort((a, b) => (b.rerank ?? -Infinity) - (a.rerank ?? -Infinity) || b.fused - a.fused || byChunkOrder(a, b));
      reranked = true;
    }
  }

  const top = reranked ? ranked[0]?.rerank ?? 0 : ranked[0]?.fused ?? 0;
  const results: HybridSearchResult[] = ranked.map(({ chunk, fused, matchedBy, scores, rerank: score }) => ({
    id: note.id,
    title: note.title,
    excerpt: makeExcerpt(stripLeadingHeading(chunk.content), query),
    tags: note.tags,
    rrf_score: fused,
    relevance: top > 0 ? (reranked ? score ?? 0 : fused) / top : 0,
    matched_by: matchedBy,
    ...scores,
    ...(chunk.heading ? { section: chunk.heading } : {}),
    ...(score !== undefined ? { rerank_score: score } : {}),
    content_length: note.content_length,
    ...(note.embedding_pending ? { index_pending: true } : {}),
  }));
  const page = project(results, limit, offset, explain);
  await placeInNote(note.id, page, ranked.slice(offset, offset + limit).map((p) => p.chunk), query);
  return {
    results: page,
    hasMore: results.length > offset + limit,
    armsUsed,
    failures,
    reranked,
    rerankEnabled: cfg !== null,
    embeddingModel: modelKey,
    indexPending: note.embedding_pending,
  };
}
