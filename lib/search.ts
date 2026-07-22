// lib/search.ts — text (FTS + substring fallback), semantic (chunk-based), and hybrid (RRF) search
import { query as dbQuery, toVector } from './db';
import { getEmbedding } from './embeddings';

export type SearchResult = {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  score: number;
  // Present only on hybrid results, and only for the pass(es) that actually
  // matched this note — text_score is FTS ts_rank (or a positional fallback
  // score for substring matches), semantic_score is raw cosine similarity.
  // `score` itself stays the RRF rank fusion, used for hybrid's own sort
  // order — it is NOT a relevance measure (see rrfMerge).
  text_score?: number;
  semantic_score?: number;
};

const RRF_K = 60;

// Calibrated 2026-06-12 against text-embedding-004 on this vault:
// relevant hits score 0.62–0.74, noise floor tops out at ~0.53.
const MIN_SIMILARITY = 0.55;

const EXCERPT_LENGTH = 300;

/**
 * Build a short excerpt from note content.
 * If `query` occurs in the content (case-insensitive), the window is centered
 * on the first match; otherwise the head of the document is used.
 */
export function makeExcerpt(content: string, query?: string, maxLen = EXCERPT_LENGTH): string {
  if (content.length <= maxLen) return content;

  let start = 0;
  if (query) {
    const idx = content.toLowerCase().indexOf(query.toLowerCase());
    if (idx > 0) start = Math.max(0, idx - Math.floor((maxLen - query.length) / 2));
  }
  const end = Math.min(content.length, start + maxLen);

  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
}

export type NamedResultList = { field: 'text_score' | 'semantic_score'; results: SearchResult[] };

/**
 * Reciprocal Rank Fusion — merges multiple ranked result lists into one.
 * Deduplicates by id, re-sorts by combined RRF score.
 * Avoids the incompatible-scale problem (FTS ts_rank vs cosine similarity):
 * `score` on the merged result is the RRF fusion, which is rank-based and
 * says nothing about how relevant a hit actually is — only its position
 * within each pass. Each contributing pass's own score is preserved under
 * `field` (text_score / semantic_score) so a caller can still tell "this
 * matched with cosine 0.72" from "this only showed up in the text pass".
 */
export function rrfMerge(lists: NamedResultList[]): SearchResult[] {
  const scoreMap = new Map<string, { result: SearchResult; rrfScore: number; extra: Partial<SearchResult> }>();

  for (const { field, results } of lists) {
    results.forEach((item, rank) => {
      const rrfScore = 1 / (RRF_K + rank + 1);
      const existing = scoreMap.get(item.id);
      if (existing) {
        existing.rrfScore += rrfScore;
        existing.extra[field] = item.score;
      } else {
        scoreMap.set(item.id, { result: item, rrfScore, extra: { [field]: item.score } });
      }
    });
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ result, rrfScore, extra }) => ({ ...result, ...extra, score: rrfScore }));
}

type FtsRow = { id: string; title: string; tags: string[]; rank: number; headline: string };
type NoteRow = { id: string; title: string; content: string; tags: string[] };

/**
 * Full-text search with ru+en morphology via the search_notes_fts RPC
 * (uses the bilingual GIN index from migration 001). Falls back to
 * substring matching when FTS finds nothing — partial words and code
 * fragments like "kmv" or "tsconfig" don't survive stemming.
 */
export async function textSearch(query: string, limit = 10): Promise<SearchResult[]> {
  const rows = await dbQuery<FtsRow>(
    'select * from search_notes_fts($1, $2)',
    [query, limit]
  );
  if (rows.length === 0) return substringSearch(query, limit);

  // n.rank is Postgres's actual ts_rank for this query — a genuine
  // relevance signal, unlike the positional score substringSearch falls
  // back to below (there is no rank for a plain substring match).
  return rows.map((n) => ({
    id:      n.id,
    title:   n.title,
    excerpt: n.headline.replace(/<\/?b>/g, ''),
    tags:    n.tags,
    score:   n.rank,
  }));
}

/** Title matches rank above content matches (queried separately, merged in order). */
async function substringSearch(query: string, limit: number): Promise<SearchResult[]> {
  const cols = 'id, title, content, tags';
  const escapedQuery = query.replace(/[%_]/g, '\\$&');
  const [byTitle, byContent] = await Promise.all([
    dbQuery<NoteRow>(`select ${cols} from notes where title ilike $1 limit $2`, [`%${escapedQuery}%`, limit]),
    dbQuery<NoteRow>(`select ${cols} from notes where content ilike $1 limit $2`, [`%${escapedQuery}%`, limit]),
  ]);

  const seen = new Set<string>();
  const merged: NoteRow[] = [];
  for (const row of [...byTitle, ...byContent]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }

  return merged.slice(0, limit).map((n, i) => ({
    id:      n.id,
    title:   n.title,
    excerpt: makeExcerpt(n.content, query),
    tags:    n.tags,
    score:   1 / (i + 1),
  }));
}

/**
 * Chunk-based semantic search: each note is indexed as per-section vectors
 * (see lib/indexing.ts), match_chunks returns the best chunk per note,
 * so the excerpt is the actually-relevant section, not the document head.
 */
export async function semanticSearch(query: string, limit = 10): Promise<SearchResult[]> {
  const embedding = await getEmbedding(query, 'query');

  const data = await dbQuery(
    'select * from match_chunks($1::vector, $2, $3)',
    [toVector(embedding), limit, MIN_SIMILARITY]
  );

  return data.map((n: Record<string, unknown>) => {
    const heading = n.heading as string | null;
    const excerpt = makeExcerpt(n.chunk_content as string, query);
    return {
      id:      n.id as string,
      title:   n.title as string,
      excerpt: heading ? `[${heading}] ${excerpt}` : excerpt,
      tags:    n.tags as string[],
      score:   n.similarity as number,
    };
  });
}

export async function hybridSearch(query: string, limit = 10): Promise<SearchResult[]> {
  const [text, semantic] = await Promise.all([
    textSearch(query, limit),
    semanticSearch(query, limit),
  ]);
  return rrfMerge([
    { field: 'text_score', results: text },
    { field: 'semantic_score', results: semantic },
  ]).slice(0, limit);
}
