// lib/search.ts — text (FTS + substring fallback), semantic (chunk-based), and hybrid (RRF) search
import { query as dbQuery, toVector } from './db';
import { getEmbedding, getRelevanceAnchors, type RelevanceAnchors } from './embeddings';

export type Confidence = 'strong' | 'moderate' | 'weak';

export type SearchResult = {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  score: number;
  // The one number an agent should act on: 0..1, normalized per arm against
  // calibrated anchors (cosine → model-dependent floor/strong from
  // lib/embeddings.ts; ts_rank → measured TS_RANK_ANCHORS; substring →
  // fixed title/content levels). On hybrid results it is the MAX of the
  // contributing arms — arms corroborate a hit, they don't add up.
  // Comparable within one query's results; NOT across models or queries.
  relevance: number;
  confidence: Confidence;
  // Present only on hybrid results, and only for the pass(es) that actually
  // matched this note — text_score is FTS ts_rank (or a positional fallback
  // score for substring matches), semantic_score is raw cosine similarity.
  // `score` itself stays the RRF rank fusion, used for hybrid's own sort
  // order — it is NOT a relevance measure (see rrfMerge); keep using
  // relevance/confidence for decisions and these raw fields for debugging.
  text_score?: number;
  semantic_score?: number;
  // Which pass(es) actually matched this note — derivable from which of
  // text_score/semantic_score are present, but spelled out explicitly so an
  // agent doesn't have to infer it. A result present in only one pass lost
  // out on the other pass's rank contribution entirely (RRF's known
  // single-arm penalty), which this makes visible instead of implicit.
  matched_by?: ('text_score' | 'semantic_score')[];
};

/**
 * Linear normalization between two calibrated anchors: at `floor` (the
 * search threshold — barely admitted) relevance is 0, at `strong` (a
 * confident hit on the live battery) it is 1, clamped outside.
 */
export function normalizeRelevance(value: number, anchors: RelevanceAnchors): number {
  if (anchors.strong <= anchors.floor) return 0;
  return Math.max(0, Math.min(1, (value - anchors.floor) / (anchors.strong - anchors.floor)));
}

export function confidenceFor(relevance: number): Confidence {
  return relevance >= 0.7 ? 'strong' : relevance >= 0.35 ? 'moderate' : 'weak';
}

// Anchors for the FTS arm's ts_rank, which is unbounded and NOT comparable
// to cosines. Measured on this vault's live queries: clear keyword hits rank
// ~0.066–0.099, weak tail matches sit under ~0.02.
const TS_RANK_ANCHORS: RelevanceAnchors = { floor: 0.01, strong: 0.09 };

// The substring fallback has no rank at all — an exact-substring hit on a
// title is a decent match for identifier-ish queries, one buried in content
// is weaker. Fixed levels, deliberately capped below "strong".
const SUBSTRING_RELEVANCE = { title: 0.65, content: 0.5 };

const RRF_K = 60;

const EXCERPT_LENGTH = 300;

// How far makeExcerpt will nudge a cut to land on whitespace. Bounded so a
// long unbroken run (a URL, a CJK sentence, the x/y fillers in tests) keeps
// its hard cut instead of losing half the window to the snap.
const EXCERPT_SNAP_WINDOW = 24;

export type SearchFilters = {
  folderId?: string;
  tag?: string;
  updatedAfter?: string;
  updatedBefore?: string;
};

// search_notes_fts / match_chunks don't carry folder_id or updated_at, and
// giving them extra params would mean a migration for what's a rarely-used,
// small-vault filter. Instead: resolve the filter to an id set once, overfetch
// candidates from the existing RPCs, then keep only ids in the set. Cheap and
// exact as long as the vault is a few hundred notes, not exact at huge scale
// (a heavily-filtered query against a huge unfiltered candidate pool could
// still come back short) — acceptable for what this targets.
const OVERFETCH_FACTOR = 8;
const OVERFETCH_CAP = 300;

function hasFilters(f?: SearchFilters): f is SearchFilters {
  return !!f && (f.folderId !== undefined || f.tag !== undefined || f.updatedAfter !== undefined || f.updatedBefore !== undefined);
}

async function filteredNoteIds(filters: SearchFilters): Promise<Set<string>> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters.folderId)      { params.push(filters.folderId);      conds.push(`folder_id = $${params.length}`); }
  if (filters.tag)           { params.push([filters.tag]);         conds.push(`tags @> $${params.length}`); }
  if (filters.updatedAfter)  { params.push(filters.updatedAfter);  conds.push(`updated_at >= $${params.length}`); }
  if (filters.updatedBefore) { params.push(filters.updatedBefore); conds.push(`updated_at <= $${params.length}`); }
  const rows = await dbQuery<{ id: string }>(
    `select id from notes where ${conds.join(' and ')}`,
    params
  );
  return new Set(rows.map((r) => r.id));
}

async function applyFilters(
  results: SearchResult[],
  limit: number,
  filters: SearchFilters | undefined
): Promise<SearchResult[]> {
  if (!hasFilters(filters)) return results.slice(0, limit);
  const allowed = await filteredNoteIds(filters);
  return results.filter((r) => allowed.has(r.id)).slice(0, limit);
}

function overfetchLimit(limit: number, filters: SearchFilters | undefined): number {
  return hasFilters(filters) ? Math.min(OVERFETCH_CAP, limit * OVERFETCH_FACTOR) : limit;
}

/**
 * A chunk keeps its section's `# Heading` line as its first line (see
 * lib/chunking.ts). semanticSearch surfaces that heading separately as a
 * `[Heading]` context prefix, so leaving the line in the excerpt body printed
 * it twice ("[Heading] # Heading …"). Strip a single leading heading line so
 * the heading shows once, as context.
 */
export function stripLeadingHeading(content: string): string {
  return content.replace(/^\s*#{1,6}[ \t]+.*(?:\r?\n)+/, '');
}

/**
 * Build a short excerpt from note content.
 * If `query` occurs in the content (case-insensitive), the window is centered
 * on the first match; otherwise the head of the document is used. The window
 * is one contiguous slice (never stitched from several places), and its cut
 * points are snapped to nearby whitespace so it doesn't begin or end
 * mid-word; the "…" markers appear only where content was actually dropped.
 */
export function makeExcerpt(content: string, query?: string, maxLen = EXCERPT_LENGTH): string {
  if (content.length <= maxLen) return content;

  let start = 0;
  if (query) {
    const idx = content.toLowerCase().indexOf(query.toLowerCase());
    if (idx > 0) start = Math.max(0, idx - Math.floor((maxLen - query.length) / 2));
  }
  let end = Math.min(content.length, start + maxLen);

  // Snap the start forward to just after the next whitespace, and the end back
  // to just before the last whitespace, so neither edge splits a word.
  if (start > 0) {
    const ws = content.slice(start, start + EXCERPT_SNAP_WINDOW).search(/\s/);
    if (ws !== -1) start += ws + 1;
  }
  if (end < content.length) {
    const from = Math.max(start + 1, end - EXCERPT_SNAP_WINDOW);
    const ws = content.slice(from, end).search(/\s\S*$/); // start of the last (partial) word
    if (ws !== -1) end = from + ws;
  }

  const body = content.slice(start, end).trim();
  return (start > 0 ? '…' : '') + body + (end < content.length ? '…' : '');
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
  const scoreMap = new Map<string, { result: SearchResult; rrfScore: number; relevance: number; extra: Partial<SearchResult> }>();

  for (const { field, results } of lists) {
    results.forEach((item, rank) => {
      const rrfScore = 1 / (RRF_K + rank + 1);
      const existing = scoreMap.get(item.id);
      if (existing) {
        existing.rrfScore += rrfScore;
        // Arms corroborate a hit rather than add up: the merged relevance is
        // the best arm's normalized score, so a note that only one arm found
        // keeps that arm's full relevance (unlike its RRF rank, which the
        // single-arm penalty halves).
        existing.relevance = Math.max(existing.relevance, item.relevance);
        existing.extra[field] = item.score;
      } else {
        scoreMap.set(item.id, { result: item, rrfScore, relevance: item.relevance, extra: { [field]: item.score } });
      }
    });
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ result, rrfScore, relevance, extra }) => ({
      ...result,
      ...extra,
      score: rrfScore,
      relevance,
      confidence: confidenceFor(relevance),
      matched_by: Object.keys(extra) as ('text_score' | 'semantic_score')[],
    }));
}

type FtsRow = { id: string; title: string; tags: string[]; rank: number; headline: string };
type NoteRow = { id: string; title: string; content: string; tags: string[] };

/**
 * Full-text search with ru+en morphology via the search_notes_fts RPC
 * (uses the bilingual GIN index from migration 001). Falls back to
 * substring matching when FTS finds nothing — partial words and code
 * fragments like "kmv" or "tsconfig" don't survive stemming.
 */
export async function textSearch(query: string, limit = 10, filters?: SearchFilters): Promise<SearchResult[]> {
  const fetchLimit = overfetchLimit(limit, filters);
  const rows = await dbQuery<FtsRow>(
    'select * from search_notes_fts($1, $2)',
    [query, fetchLimit]
  );
  if (rows.length === 0) return substringSearch(query, limit, filters);

  // n.rank is Postgres's actual ts_rank for this query — a genuine
  // relevance signal, unlike the positional score substringSearch falls
  // back to below (there is no rank for a plain substring match).
  const results = rows.map((n) => {
    const relevance = normalizeRelevance(n.rank, TS_RANK_ANCHORS);
    return {
      id:      n.id,
      title:   n.title,
      excerpt: n.headline.replace(/<\/?b>/g, ''),
      tags:    n.tags,
      score:   n.rank,
      relevance,
      confidence: confidenceFor(relevance),
    };
  });
  return applyFilters(results, limit, filters);
}

/** Title matches rank above content matches (queried separately, merged in order). */
async function substringSearch(query: string, limit: number, filters?: SearchFilters): Promise<SearchResult[]> {
  const cols = 'id, title, content, tags';
  const escapedQuery = query.replace(/[%_]/g, '\\$&');
  const fetchLimit = overfetchLimit(limit, filters);
  const [byTitle, byContent] = await Promise.all([
    dbQuery<NoteRow>(`select ${cols} from notes where title ilike $1 limit $2`, [`%${escapedQuery}%`, fetchLimit]),
    dbQuery<NoteRow>(`select ${cols} from notes where content ilike $1 limit $2`, [`%${escapedQuery}%`, fetchLimit]),
  ]);

  const seen = new Set<string>();
  const merged: (NoteRow & { viaTitle: boolean })[] = [];
  const titleIds = new Set(byTitle.map(r => r.id));
  for (const row of [...byTitle, ...byContent]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push({ ...row, viaTitle: titleIds.has(row.id) });
  }

  const results = merged.map((n, i) => {
    const relevance = n.viaTitle ? SUBSTRING_RELEVANCE.title : SUBSTRING_RELEVANCE.content;
    return {
      id:      n.id,
      title:   n.title,
      excerpt: makeExcerpt(n.content, query),
      tags:    n.tags,
      score:   1 / (i + 1),
      relevance,
      confidence: confidenceFor(relevance),
    };
  });
  return applyFilters(results, limit, filters);
}

/**
 * Chunk-based semantic search: each note is indexed as per-section vectors
 * (see lib/indexing.ts), match_chunks returns the best chunk per note,
 * so the excerpt is the actually-relevant section, not the document head.
 *
 * Threshold behavior: the cosine floor (getMinSimilarity, model-dependent)
 * is applied INSIDE match_chunks at the CHUNK level — `where similarity >=
 * min_similarity` on each note's single best chunk (migration 002). So every
 * row returned here is at or above the floor, and `score` is that best
 * chunk's cosine. NOTE: in hybridSearch the FTS/text arm is NOT cosine-
 * filtered, so a hybrid result CAN sit below this floor (or have no
 * semantic_score at all) when it entered via the text pass — that's why the
 * combined output shows notes a pure-semantic pass would have dropped.
 */
export async function semanticSearch(query: string, limit = 10, filters?: SearchFilters): Promise<SearchResult[]> {
  const [embedding, anchors] = await Promise.all([
    getEmbedding(query, 'query'),
    getRelevanceAnchors(),
  ]);

  const fetchLimit = overfetchLimit(limit, filters);
  const data = await dbQuery(
    'select * from match_chunks($1::vector, $2, $3)',
    [toVector(embedding), fetchLimit, anchors.floor]
  );

  const results = data.map((n: Record<string, unknown>) => {
    const heading = n.heading as string | null;
    // Drop the chunk's own `# Heading` line so it isn't repeated by the
    // `[heading]` context prefix below.
    const excerpt = makeExcerpt(stripLeadingHeading(n.chunk_content as string), query);
    const relevance = normalizeRelevance(n.similarity as number, anchors);
    return {
      id:      n.id as string,
      title:   n.title as string,
      excerpt: heading ? `[${heading}] ${excerpt}` : excerpt,
      tags:    n.tags as string[],
      score:   n.similarity as number,
      relevance,
      confidence: confidenceFor(relevance),
    };
  });
  return applyFilters(results, limit, filters);
}

/**
 * Best chunk similarity ignoring the configured floor (call match_chunks with
 * min_similarity=0). Lets a caller distinguish "nothing came close" from
 * "just under the threshold" when a real semantic/hybrid search came back
 * empty — a bare [] can't tell those apart.
 */
export async function bestSemanticScore(query: string): Promise<number | null> {
  const embedding = await getEmbedding(query, 'query');
  const [row] = await dbQuery<{ similarity: number }>(
    'select similarity from match_chunks($1::vector, 1, 0)',
    [toVector(embedding)]
  );
  return row?.similarity ?? null;
}

export async function hybridSearch(query: string, limit = 10, filters?: SearchFilters): Promise<SearchResult[]> {
  const [text, semantic] = await Promise.all([
    textSearch(query, limit, filters),
    semanticSearch(query, limit, filters),
  ]);
  return rrfMerge([
    { field: 'text_score', results: text },
    { field: 'semantic_score', results: semantic },
  ]).slice(0, limit);
}
