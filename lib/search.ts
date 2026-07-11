// lib/search.ts — text (FTS + substring fallback), semantic (chunk-based), and hybrid (RRF) search
import { query as dbQuery, toVector } from './db';
import { getEmbedding } from './embeddings';

export type SearchResult = {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  score: number;
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

/**
 * Reciprocal Rank Fusion — merges multiple ranked result lists into one.
 * Deduplicates by id, re-sorts by combined RRF score.
 * Avoids the incompatible-scale problem (FTS ts_rank vs cosine similarity).
 */
export function rrfMerge(lists: SearchResult[][]): SearchResult[] {
  const scoreMap = new Map<string, { result: SearchResult; rrfScore: number }>();

  for (const list of lists) {
    list.forEach((item, rank) => {
      const rrfScore = 1 / (RRF_K + rank + 1);
      const existing = scoreMap.get(item.id);
      if (existing) {
        existing.rrfScore += rrfScore;
      } else {
        scoreMap.set(item.id, { result: item, rrfScore });
      }
    });
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ result, rrfScore }) => ({ ...result, score: rrfScore }));
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

  return rows.map((n, i) => ({
    id:      n.id,
    title:   n.title,
    excerpt: n.headline.replace(/<\/?b>/g, ''),
    tags:    n.tags,
    score:   1 / (i + 1),
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
  const embedding = await getEmbedding(query);

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
  return rrfMerge([text, semantic]).slice(0, limit);
}
