// lib/search.ts — text (FTS + substring fallback), semantic (chunk-based), and hybrid (RRF) search
import { query as dbQuery, toVector } from './db';
import { getEmbedding, getRelevanceAnchors, type RelevanceAnchors } from './embeddings';
import { escapeLike } from './sql';
import { TABLE_ROW_RE, TABLE_SEPARATOR_RE, unpairedFenceIndex } from './markdown';

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
  // Filled in by enrichResults (a single id = any($1) lookup, not part
  // of search_notes_fts/match_chunks — see there for why). Absent only if
  // the note was deleted in the gap between the search RPC and the lookup.
  created_at?: string;
  // Same lookup as created_at — lets a caller tell a long note from a short
  // one before spending a get_note call on it (list_notes already does this).
  content_length?: number;
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

// hybridSearch feeds each arm's results into RRF fusion. If each arm is
// capped at the final output size, a note ranked just outside `limit` in
// BOTH arms never reaches rrfMerge at all — even though their combined rank
// would place it in the fused top results. Overfetch a wider candidate pool
// per arm, then slice down to `limit` only after fusion.
const RRF_CANDIDATE_FACTOR = 3;
const RRF_CANDIDATE_CAP = 50;

const EXCERPT_LENGTH = 300;

// How far makeExcerpt will nudge a cut to land on whitespace. Bounded so a
// long unbroken run (a URL, a CJK sentence, the x/y fillers in tests) keeps
// its hard cut instead of losing half the window to the snap.
const EXCERPT_SNAP_WINDOW = 24;

// ts_headline (search_notes_fts, migration 009) builds its snippet in
// Postgres with no access to note structure — makeExcerpt's table-header
// recovery above doesn't apply to it, so a hit whose headline opens inside a
// table body still loses its header there. Repairing it needs the note's
// full content, which search_notes_fts deliberately doesn't return (see
// FtsRow) to keep the common, non-table case cheap. Capped so a query that
// happens to land inside several table-heavy notes can't turn every
// textSearch call into N single-row content fetches.
const MAX_TABLE_REPAIR_FETCHES = 3;

export type SearchFilters = {
  folderId?: string;
  tag?: string;
  createdAfter?: string;
  createdBefore?: string;
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
  return !!f && (f.folderId !== undefined || f.tag !== undefined || f.createdAfter !== undefined
    || f.createdBefore !== undefined || f.updatedAfter !== undefined || f.updatedBefore !== undefined);
}

async function filteredNoteIds(filters: SearchFilters): Promise<Set<string>> {
  const conds: string[] = ['deleted_at is null'];
  const params: unknown[] = [];
  if (filters.folderId)      { params.push(filters.folderId);      conds.push(`folder_id = $${params.length}`); }
  if (filters.tag)           { params.push([filters.tag]);         conds.push(`tags @> $${params.length}`); }
  if (filters.createdAfter)  { params.push(filters.createdAfter);  conds.push(`created_at >= $${params.length}`); }
  if (filters.createdBefore) { params.push(filters.createdBefore); conds.push(`created_at <= $${params.length}`); }
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

/**
 * Attaches created_at and content_length to each result with one extra
 * id = any($1) lookup — deliberately NOT inside applyFilters (which only
 * ever runs when filters are given) and NOT a rewrite of
 * search_notes_fts/match_chunks (which would mean a migration to alter two
 * working, tested SQL functions for two columns). Called once at the end of
 * textSearch and semanticSearch, on their own final (already limited) result
 * list — not on hybridSearch's per-arm overfetch candidates. hybridSearch
 * does not call this itself: its two arms are already enriched by the time
 * rrfMerge runs, and rrfMerge preserves extra fields via its `...result`
 * spread, so a third lookup on the merged/sliced set would just re-fetch
 * data already present.
 */
async function enrichResults(results: SearchResult[]): Promise<SearchResult[]> {
  if (results.length === 0) return results;
  const rows = await dbQuery<{ id: string; created_at: string; content_length: number }>(
    'select id, created_at, length(content) as content_length from notes where id = any($1)',
    [results.map((r) => r.id)]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return results.map((r) => ({
    ...r,
    created_at: byId.get(r.id)?.created_at,
    content_length: byId.get(r.id)?.content_length,
  }));
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
 * If `offset` lands inside a table's body, returns its header + separator
 * row (with trailing newlines, ready to prepend) and the character offset
 * where that pair starts. Returns null when `offset` isn't inside a table —
 * including a false one (pipe-looking text with no separator row) — or when
 * it falls ON the header/separator lines themselves, since a caller windowing
 * from there already has them.
 *
 * Table-row shape is TABLE_ROW_RE/TABLE_SEPARATOR_RE from lib/markdown.ts —
 * the same definition renderTables uses to decide what parseMarkdown renders
 * as a <table>, so an excerpt and the rendered note never disagree about
 * what counts as one.
 */
export function tableHeaderAbove(content: string, offset: number): { text: string; offset: number } | null {
  const lines = content.split('\n');
  const starts: number[] = [];
  let pos = 0;
  for (const line of lines) { starts.push(pos); pos += line.length + 1; }

  const i0 = starts.findIndex((s, idx) => s <= offset && (idx === lines.length - 1 || starts[idx + 1] > offset));
  if (i0 === -1 || !TABLE_ROW_RE.test(lines[i0])) return null;

  // A `|`-looking line inside a fenced code block is code, not a table —
  // mirrors parseMarkdown's own ordering (fences come out as placeholders
  // before renderTables ever sees the text; nothing extracts them on this
  // path, so the check has to happen here instead).
  const unpaired = unpairedFenceIndex(lines);
  let inFence = false;
  for (let k = 0; k <= i0; k++) {
    if (k !== unpaired && /^```/.test(lines[k].trim())) inFence = !inFence;
  }
  if (inFence) return null;

  // Walk up through consecutive row-shaped lines to the top of this table.
  let i = i0;
  while (i > 0 && TABLE_ROW_RE.test(lines[i - 1])) i--;
  if (i + 1 >= lines.length || !TABLE_SEPARATOR_RE.test(lines[i + 1])) return null;

  return { text: `${lines[i]}\n${lines[i + 1]}\n`, offset: starts[i] };
}

/**
 * Build a short excerpt from note content.
 * If `query` occurs in the content (case-insensitive), the window is centered
 * on the first match; otherwise the head of the document is used. The window
 * is one contiguous slice (never stitched from several places), and its cut
 * points are snapped to nearby whitespace so it doesn't begin or end
 * mid-word; the "…" markers appear only where content was actually dropped.
 *
 * A window that opens inside a table loses the header row it depends on for
 * meaning — "0.68" or "46 nodes" read as nothing without the column name
 * above them. When that happens, the header + separator row is prepended
 * (see tableHeaderAbove) and the tail is shaved by the same amount, so a
 * table hit doesn't grow the excerpt budget — same maxLen, reallocated
 * toward the row that makes the rest of it readable.
 */
export function makeExcerpt(content: string, query?: string, maxLen = EXCERPT_LENGTH): string {
  if (content.length <= maxLen) return content;

  let start = 0;
  let matchEnd = 0; // end of the actual match text — the tail shave below must never cut into it
  if (query) {
    const idx = content.toLowerCase().indexOf(query.toLowerCase());
    if (idx > 0) {
      start = Math.max(0, idx - Math.floor((maxLen - query.length) / 2));
      matchEnd = idx + query.length;
    }
  }
  let end = Math.min(content.length, start + maxLen);

  // Snap the start forward to just after the next whitespace, and the end back
  // to just before the last whitespace, so neither edge splits a word.
  if (start > 0) {
    const ws = content.slice(start, start + EXCERPT_SNAP_WINDOW).search(/\s/);
    if (ws !== -1) start += ws + 1;
  }

  let tableHeader = '';
  let pinnedToMatchEnd = false;
  if (start > 0) {
    const header = tableHeaderAbove(content, start);
    if (header && header.offset + header.text.length <= start) {
      tableHeader = header.text;
      const shaved = Math.max(start, end - tableHeader.length);
      // Never shave past the match itself — showing the header only to lose
      // the row that was searched for defeats the point of both. Pinned
      // here skips the whitespace-snap below too: snapping backward from an
      // already-tight matchEnd boundary would cut into the match text it
      // exists to protect.
      if (shaved < matchEnd) { end = matchEnd; pinnedToMatchEnd = true; }
      else { end = shaved; }
    }
  }

  if (end < content.length && !pinnedToMatchEnd) {
    const from = Math.max(start + 1, end - EXCERPT_SNAP_WINDOW);
    const ws = content.slice(from, end).search(/\s\S*$/); // start of the last (partial) word
    if (ws !== -1) end = from + ws;
  }

  const body = content.slice(start, end).trim();
  return tableHeader + (start > 0 ? '…' : '') + body + (end < content.length ? '…' : '');
}

export type NamedResultList = { field: 'text_score' | 'semantic_score'; results: SearchResult[] };

// A single-arm SearchResult's `score` is that arm's own ranking value (ts_rank,
// cosine, positional fallback) — meaningful on its own. Once merged, it isn't:
// rrf_score is rank-based fusion across arms, useful for explaining hybrid's
// sort order but not comparable to a relevance score, so the merged shape
// carries a differently-named field instead of overloading `score` with two
// unrelated meanings depending on whether you're looking at a raw or a
// hybrid result.
export type HybridSearchResult = Omit<SearchResult, 'score'> & { rrf_score: number };

/**
 * Reciprocal Rank Fusion — merges multiple ranked result lists into one.
 * Deduplicates by id, re-sorts by combined RRF score.
 * Avoids the incompatible-scale problem (FTS ts_rank vs cosine similarity):
 * `rrf_score` on the merged result is the RRF fusion, which is rank-based and
 * says nothing about how relevant a hit actually is — only its position
 * within each pass. Each contributing pass's own score is preserved under
 * `field` (text_score / semantic_score) so a caller can still tell "this
 * matched with cosine 0.72" from "this only showed up in the text pass".
 */
export function rrfMerge(lists: NamedResultList[]): HybridSearchResult[] {
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
    .map(({ result, rrfScore, relevance, extra }) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop `score`, forward everything else
      const { score: _score, ...rest } = result;
      return {
        ...rest,
        ...extra,
        rrf_score: rrfScore,
        relevance,
        confidence: confidenceFor(relevance),
        matched_by: Object.keys(extra) as ('text_score' | 'semantic_score')[],
      };
    });
}

type FtsRow = { id: string; title: string; tags: string[]; rank: number; headline: string };
type NoteRow = { id: string; title: string; content: string; tags: string[] };

/**
 * A ts_headline snippet that looks like loose table-cell fragments (at
 * least a couple of `|` delimiters) with no separator row anywhere in it.
 * Deliberately NOT line-anchored like TABLE_ROW_RE/TABLE_SEPARATOR_RE:
 * ts_headline crops at word boundaries (MaxWords=45, migration 009), not
 * cell boundaries, so a genuinely broken snippet routinely has NO full
 * `|...|`-shaped line at all — the row's own opening pipe falls before the
 * crop, its closing one after. A real live case: `без префикса −0.004) |
 * полоса 0.60–0.68 ... |` starts and ends mid-cell, no line passes
 * TABLE_ROW_RE, and a check built on that regex misses it outright. Pipe
 * counting plus a substring separator check catches it anyway. Errs toward
 * over-flagging on purpose — a false positive costs one wasted point-fetch
 * in repairBrokenTableExcerpts below (cheap, capped); a false negative
 * leaves a hit silently unreadable, the failure this pass exists to catch.
 */
function looksLikeBrokenTableExcerpt(excerpt: string): boolean {
  const pipeCount = (excerpt.match(/\|/g) ?? []).length;
  if (pipeCount < 2) return false;
  return !/\|[ \t]*:?-{2,}:?[ \t]*\|/.test(excerpt);
}

/**
 * Point-fixes ts_headline snippets flagged by looksLikeBrokenTableExcerpt:
 * one batched `id = any($1)` fetch (same pattern as enrichResults) for at
 * most MAX_TABLE_REPAIR_FETCHES of them, locates the snippet inside the
 * fetched content via indexOf on its own first line (the headline is a
 * verbatim substring of the note once <b> tags are stripped — same trick
 * makeExcerpt's own centering uses), and prepends the table header
 * tableHeaderAbove finds there. Mutates `results` in place. Silent no-op
 * for any candidate that doesn't resolve (note edited concurrently, or the
 * headline genuinely wasn't inside a table after all) — the excerpt is left
 * exactly as ts_headline produced it, no worse than before this ran.
 */
async function repairBrokenTableExcerpts(results: SearchResult[]): Promise<void> {
  const candidates = results.filter((r) => looksLikeBrokenTableExcerpt(r.excerpt));
  if (candidates.length === 0) return;
  const toFix = candidates.slice(0, MAX_TABLE_REPAIR_FETCHES);
  if (candidates.length > toFix.length) {
    console.warn(
      `[search] table-header repair: ${candidates.length} broken excerpts this call, ` +
      `fixing only ${toFix.length} (MAX_TABLE_REPAIR_FETCHES)`
    );
  }

  const rows = await dbQuery<{ id: string; content: string }>(
    'select id, content from notes where id = any($1)',
    [toFix.map((r) => r.id)]
  );
  const contentById = new Map(rows.map((r) => [r.id, r.content]));

  for (const r of toFix) {
    const content = contentById.get(r.id);
    if (!content) continue;
    const firstLine = r.excerpt.split('\n')[0];
    const idx = content.indexOf(firstLine);
    if (idx === -1) continue;
    const header = tableHeaderAbove(content, idx);
    if (header && header.offset + header.text.length <= idx) {
      r.excerpt = header.text + r.excerpt;
    }
  }
}

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
  if (rows.length === 0) return enrichResults(await substringSearch(query, limit, filters));

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
  const filtered = await applyFilters(results, limit, filters);
  await repairBrokenTableExcerpts(filtered);
  return enrichResults(filtered);
}

/** Title matches rank above content matches (queried separately, merged in order). */
async function substringSearch(query: string, limit: number, filters?: SearchFilters): Promise<SearchResult[]> {
  const cols = 'id, title, content, tags';
  const escapedQuery = escapeLike(query);
  const fetchLimit = overfetchLimit(limit, filters);
  const [byTitle, byContent] = await Promise.all([
    dbQuery<NoteRow>(`select ${cols} from notes where title ilike $1 and deleted_at is null limit $2`, [`%${escapedQuery}%`, fetchLimit]),
    dbQuery<NoteRow>(`select ${cols} from notes where content ilike $1 and deleted_at is null limit $2`, [`%${escapedQuery}%`, fetchLimit]),
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
  return enrichResults(await applyFilters(results, limit, filters));
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

export async function hybridSearch(query: string, limit = 10, filters?: SearchFilters): Promise<HybridSearchResult[]> {
  const candidateLimit = Math.min(RRF_CANDIDATE_CAP, limit * RRF_CANDIDATE_FACTOR);
  const [text, semantic] = await Promise.all([
    textSearch(query, candidateLimit, filters),
    semanticSearch(query, candidateLimit, filters),
  ]);
  return rrfMerge([
    { field: 'text_score', results: text },
    { field: 'semantic_score', results: semantic },
  ]).slice(0, limit);
}
