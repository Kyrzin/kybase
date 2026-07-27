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
  // Present only on hybrid results, and only for the pass(es) that actually
  // matched this note — text_score is FTS ts_rank (or a positional fallback
  // score for substring matches), semantic_score is raw cosine similarity.
  // `score` itself stays the RRF rank fusion, used for hybrid's own sort
  // order — it is NOT a relevance measure (see rrfMerge).
  text_score?: number;
  semantic_score?: number;
  // Which pass(es) actually matched this note — derivable from which of
  // text_score/semantic_score are present, but spelled out explicitly so an
  // agent doesn't have to infer it. A result present in only one pass lost
  // out on the other pass's rank contribution entirely (RRF's known
  // single-arm penalty), which this makes visible instead of implicit.
  matched_by?: ('text_score' | 'semantic_score')[];
  // A single 0..1 measure of how well this result matches the query, and its
  // coarse bucket. Unlike score/text_score/semantic_score (raw, per-arm, on
  // incompatible scales), relevance is one comparable number: the semantic
  // cosine mapped through the model's floor/strong anchors, the text rank
  // capped and normalized, and — for hybrid — the max of the two arms (they
  // corroborate, so the stronger wins; they are not summed). Comparable
  // WITHIN one query's results, not across queries or models. The raw scores
  // stay for debugging.
  relevance?: number;
  confidence?: Confidence;
};

const RRF_K = 60;

// ── relevance normalization ──────────────────────────────────────────────
// ts_rank (Postgres FTS) is unbounded in theory but, with our default
// normalization, a genuine lexical hit on this vault lands ~0.08–0.10
// regardless of how central the term is — the rank barely graduates. So we
// cap-and-scale: TEXT_RANK_STRONG is the ts_rank at which a text match is
// treated as fully relevant. 0.15 keeps ordinary FTS hits in the "moderate"
// band and reserves "strong" for high-proximity multi-term matches, rather
// than calling every lexical hit strong.
const TEXT_RANK_STRONG = 0.15;

// Confidence buckets over the 0..1 relevance. strong ≥ 0.70, weak < 0.35,
// moderate between — calibrated against the live battery (see search.test.ts
// and the pass report).
const CONFIDENCE_STRONG = 0.70;
const CONFIDENCE_WEAK = 0.35;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Map a raw cosine similarity onto 0..1 via the model's floor/strong anchors. */
export function semanticRelevance(cosine: number, anchors: RelevanceAnchors): number {
  if (cosine <= anchors.floor) return 0;
  return clamp01((cosine - anchors.floor) / (anchors.strong - anchors.floor));
}

/** Map an FTS ts_rank onto 0..1 (capped — raw ts_rank is unbounded). */
export function textRankRelevance(rank: number): number {
  return clamp01(rank / TEXT_RANK_STRONG);
}

export function confidenceFor(relevance: number): Confidence {
  if (relevance >= CONFIDENCE_STRONG) return 'strong';
  if (relevance < CONFIDENCE_WEAK) return 'weak';
  return 'moderate';
}

/** Attach relevance (rounded) and its confidence bucket to a result. */
function withRelevance<T extends SearchResult>(result: T, relevance: number): T {
  const r = round3(relevance);
  return { ...result, relevance: r, confidence: confidenceFor(r) };
}

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
  const scoreMap = new Map<string, { result: SearchResult; rrfScore: number; extra: Partial<SearchResult>; relevance: number }>();

  for (const { field, results } of lists) {
    results.forEach((item, rank) => {
      const rrfScore = 1 / (RRF_K + rank + 1);
      const existing = scoreMap.get(item.id);
      if (existing) {
        existing.rrfScore += rrfScore;
        existing.extra[field] = item.score;
        // Arms corroborate: keep the stronger arm's relevance, don't add them.
        existing.relevance = Math.max(existing.relevance, item.relevance ?? 0);
      } else {
        scoreMap.set(item.id, { result: item, rrfScore, extra: { [field]: item.score }, relevance: item.relevance ?? 0 });
      }
    });
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ result, rrfScore, extra, relevance }) => {
      const r = round3(relevance);
      return {
        ...result,
        ...extra,
        score: rrfScore,
        matched_by: Object.keys(extra) as ('text_score' | 'semantic_score')[],
        relevance: r,
        confidence: confidenceFor(r),
      };
    });
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
  const results = rows.map((n) => withRelevance({
    id:      n.id,
    title:   n.title,
    excerpt: n.headline.replace(/<\/?b>/g, ''),
    tags:    n.tags,
    score:   n.rank,
  }, textRankRelevance(n.rank)));
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
  const merged: NoteRow[] = [];
  for (const row of [...byTitle, ...byContent]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }

  // A substring hit is exact literal containment (title matches lead), but
  // there is no ts_rank — so relevance is positional: the top hit reads as a
  // confident match and it tapers from there.
  const results = merged.map((n, i) => {
    const positional = 1 / (i + 1);
    return withRelevance({
      id:      n.id,
      title:   n.title,
      excerpt: makeExcerpt(n.content, query),
      tags:    n.tags,
      score:   positional,
    }, positional);
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
    const cosine = n.similarity as number;
    return withRelevance({
      id:      n.id as string,
      title:   n.title as string,
      excerpt: heading ? `[${heading}] ${excerpt}` : excerpt,
      tags:    n.tags as string[],
      score:   cosine,
    }, semanticRelevance(cosine, anchors));
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
