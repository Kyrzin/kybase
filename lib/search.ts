// lib/search.ts — text (FTS + substring fallback), semantic (chunk-based), and hybrid (RRF) search
import { query as dbQuery, toVector } from './db';
import { getEmbedding, getMinSimilarity } from './embeddings';
import { getFtsLanguages, getTagWeights, type TagWeights, getFolderWeights, type FolderWeights } from './settings';
import { escapeLike } from './sql';
import { TABLE_ROW_RE, TABLE_SEPARATOR_RE, unpairedFenceIndex } from './markdown';

export type Confidence = 'strong' | 'moderate' | 'weak';

export type SearchResult = {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  score: number;
  // How this hit compares to the BEST hit in this same response — always
  // exactly 1.0 for the top result, 0..1 for the rest. A ratio, not an
  // absolute score: says nothing about quality on its own (a relevance-1.0
  // hit can still be the best of a bad set), and is NOT comparable across
  // different queries' results, only within one. `confidence` is the field
  // to actually act on. On hybrid results this is the MAX of the
  // contributing arms — arms corroborate a hit, they don't add up.
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
  // Which cascade level found this on the text side (textSearch only;
  // absent on a pure-semantic hit). 'and' means the strict query itself
  // matched — real corroboration. 'or'/'substring' mean the strict query
  // found NOTHING and a looser pass filled in instead: recall, not
  // confirmation. confidenceFor discounts non-'and' tiers accordingly —
  // exposed here so that discount is checkable from outside, not just
  // trusted (2026-08-14 measurement: an 'or' match was silently counting
  // as full corroboration and inflating confidence).
  text_tier?: 'and' | 'or' | 'substring';
  // textSearch only. Fraction of the query's significant lexemes actually
  // present in this hit's search_vector (see computeTextCoverage) — a
  // query/document ratio, not a corpus-tuned constant. Exists because
  // relative-to-best normalization (step 4) hands the top result of an
  // ALL-junk set relevance 1.0 with no way to tell "matched every word" from
  // "matched one of five and nothing else came close" — measured live
  // 2026-08-14: a 5-word nonsense query's top hit read `relevance: 1` on a
  // single incidental word match. Exposed as its own field, not folded
  // invisibly into relevance, because the alternative was already tried and
  // failed silently (the confidence label alone was correct; the number
  // still lied — see the 2026-08-14 search-relevance overhaul, step 3b).
  coverage?: number;
  // Filled in by enrichResults (a single id = any($1) lookup, not part
  // of search_notes_fts/match_chunks — see there for why). Absent only if
  // the note was deleted in the gap between the search RPC and the lookup.
  created_at?: string;
  // Same lookup as created_at — lets a caller tell a long note from a short
  // one before spending a get_note call on it (list_notes already does this).
  content_length?: number;
};

// confidence is the only field an agent should treat as a verdict — everyone
// upstream (relevance) only says "how this compares to the best hit in its
// own result set," which says nothing about absolute quality on its own.
// `strong` means corroborated: both arms found the note AND it's at/near the
// top of its own set. A single arm — no matter how close to the top of its
// own ranking — tops out at `moderate`: one signal, unconfirmed. Replaces
// the old flat relevance>=0.7/0.35 bands, which let a single-arm hit read as
// `strong` just for being the best of a bad set (2026-08-14 measurement:
// three notes tied at the same ts_rank all got `strong`).
//
// `corroboratingArms` is not the same as "how many of text/semantic
// matched" — a text match found only via the OR/substring cascade doesn't
// count (0 corroborating arms if that's the only thing that matched; still
// excluded from the count even alongside a real semantic match). The
// strict query found nothing, so there's nothing solid to corroborate with
// — measured live: an OR-cascade match on a near-meaningless control query
// (single common word) was reaching `moderate` on its own, and combined
// with an unrelated semantic hit was reaching `strong`. Callers compute
// this discount (textSearch for its own single-arm case, rrfMerge for the
// merged case) — this function just enforces the resulting bands.
export function confidenceFor(relevance: number, corroboratingArms: 0 | 1 | 2 = 1): Confidence {
  if (corroboratingArms === 0) return 'weak';
  if (relevance >= 0.9 && corroboratingArms === 2) return 'strong';
  if ((relevance >= 0.9 && corroboratingArms === 1) || (relevance >= 0.7 && corroboratingArms === 2)) return 'moderate';
  return 'weak';
}

// The substring fallback has no rank at all — an exact-substring hit on a
// title is a decent match for identifier-ish queries, one buried in content
// is weaker. Fixed levels, deliberately capped below "strong".
const SUBSTRING_RELEVANCE = { title: 0.65, content: 0.5 };

// Degenerate-semantic-set guard (semanticSearch): how far above the
// per-model junk-gate floor the top hit must land before it's treated as
// real signal rather than "the least-noisy noise".
//
// A FRACTION of the floor's remaining headroom (1 - floor), not a flat
// cosine number — found during pre-publication review: a flat margin is
// itself an absolute cosine value, and models don't share a cosine scale
// any more than they share a floor (that's the whole reason the floor
// itself is per-model, lib/embeddings.ts). embeddinggemma's floor (0.30)
// leaves 0.70 of headroom, so the old flat 0.05 was ~7% of it; nomic's
// compressed range puts its floor at 0.65, leaving only 0.35 of headroom —
// the same flat 0.05 there was ~14% of a MUCH smaller usable range, eating
// disproportionately into the one model this margin exists to protect.
// 0.07 reproduces the old, live-validated 0.05 almost exactly for
// embeddinggemma (0.07 × 0.70 ≈ 0.049) while scaling down proportionally
// for a compressed-range model (0.07 × 0.35 ≈ 0.025) instead of eating a
// fixed slice regardless of how much range there is to eat from. Still
// comfortably catches nomic's own measured degenerate gap (noise ~0.66 vs
// floor 0.65, a 0.01 gap — well under 0.025).
const MIN_SIGNAL_MARGIN_FRACTION = 0.07;

function signalMargin(floor: number): number {
  return MIN_SIGNAL_MARGIN_FRACTION * (1 - floor);
}

// What a caller actually needs to see to interpret an empty semantic/hybrid
// result: getMinSimilarity() alone is necessary but not sufficient — a best
// hit that clears the floor by less than signalMargin(floor) still gets
// discarded by the degenerate-set guard below, so a raw best_score just
// above the floor can still come back empty. Measured live 2026-08-14: floor
// 0.30, best_score 0.305 → empty results, but the envelope reported
// threshold: 0.3 — a caller had no way to tell "0.305 is still short" from
// "the filter itself is broken", because the number shown wasn't the number
// actually applied. mcp-server.ts's threshold field uses this instead of
// getMinSimilarity() directly for exactly that reason.
export async function effectiveSemanticThreshold(): Promise<number> {
  const floor = await getMinSimilarity();
  return floor + signalMargin(floor);
}

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

// match_chunks doesn't carry folder_id or updated_at at all, and
// search_notes_fts's folder_id (migration 021) exists only for the weight
// multiply below, not for filtering — giving either RPC an exact-match
// filter param would mean a second migration for what's a rarely-used,
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
  // content_updated_at, not updated_at — same reasoning as list_notes
  // (migration 020): a rename elsewhere rewriting a [[link]] inside this
  // note must not make it match an "updated recently" filter.
  if (filters.updatedAfter)  { params.push(filters.updatedAfter);  conds.push(`content_updated_at >= $${params.length}`); }
  if (filters.updatedBefore) { params.push(filters.updatedBefore); conds.push(`content_updated_at <= $${params.length}`); }
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
  const scoreMap = new Map<string, {
    result: SearchResult; rrfScore: number; relevance: number;
    extra: Partial<SearchResult>; textTier: SearchResult['text_tier'];
    textCoverage: number | undefined;
  }>();

  // A single arm's own `results` can itself contain the same id twice —
  // semanticSearch can now return up to 2 chunks per note (migration 017,
  // match_chunks' distinct-on-note_id removed). That's handled here without
  // special-casing: the first (best-scoring, match_chunks still orders by
  // similarity desc) occurrence sets `result`/excerpt and is never
  // overwritten by a later duplicate; a second matching chunk just adds a
  // small extra rrfScore contribution (reasonable — two good passages is
  // real corroboration) and can raise `relevance` via the max below.
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
        if (field === 'text_score') { existing.textTier = item.text_tier; existing.textCoverage = item.coverage; }
      } else {
        scoreMap.set(item.id, {
          result: item, rrfScore, relevance: item.relevance,
          extra: { [field]: item.score },
          textTier: field === 'text_score' ? item.text_tier : undefined,
          textCoverage: field === 'text_score' ? item.coverage : undefined,
        });
      }
    });
  }

  return [...scoreMap.values()]
    .map(({ result, rrfScore, relevance, extra, textTier, textCoverage }) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- drop `score`, forward everything else
      const { score: _score, ...rest } = result;
      const matched_by = Object.keys(extra) as ('text_score' | 'semantic_score')[];
      // A text arm corroborates if the STRICT query found it ('and') — or,
      // since step 3b, if the OR cascade found it but genuinely contains
      // EVERY significant word of the query (coverage === 1): the strict
      // pass failing there isn't "recall filled in for a weak match", it's
      // websearch_to_tsquery's own AND-tsquery construction not firing for
      // some other reason (word order, cross-language stemming, the
      // multi-config OR-combination search_notes_fts builds) even though
      // the content is genuinely all there. Reviewed live on an external
      // 28-note corpus (2026-08-14): requiring strict-AND-only made `strong`
      // unreachable for 11/11 real queries against short, precise notes —
      // natural-language queries routinely don't echo a note's exact
      // wording verbatim, so the OR cascade fires even for a fully-correct
      // match. Gated on EXACT full coverage (not "high enough") specifically
      // to not reopen the two regressions this rule originally fixed
      // (control-noise and an unrelated German-query resume both matched on
      // ONE word out of several — coverage well under 1 in both cases, so
      // neither would qualify here either).
      const textCorroborates = extra.text_score !== undefined &&
        (textTier === 'and' || (textTier === 'or' && textCoverage === 1));
      const corroboratingArms = (extra.semantic_score !== undefined ? 1 : 0) + (textCorroborates ? 1 : 0);
      return {
        ...rest,
        ...extra,
        rrf_score: rrfScore,
        relevance,
        confidence: confidenceFor(relevance, corroboratingArms as 0 | 1 | 2),
        matched_by,
        text_tier: textTier,
        corroboratingArms,
      };
    })
    // Sorting by rrf_score alone can rank a weak hit above a moderate one
    // even with no tie at all — rrf_score only fuses rank position, it
    // knows nothing about confidence (measured live, twice). The displayed
    // order must never contradict the confidence label an agent is told to
    // act on, so confidence tier is the primary key; within a tier, more
    // corroborating arms first (not just how many fields are present —
    // see corroboratingArms above), then relevance, then rrf_score as the
    // final tiebreak for genuinely identical cases.
    .sort((a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      b.corroboratingArms - a.corroboratingArms ||
      b.relevance - a.relevance ||
      b.rrf_score - a.rrf_score
    )
    // corroboratingArms was only needed to drive confidence/sort — not part
    // of the public shape (matched_by + text_tier already expose the same
    // information more precisely, per-arm rather than as one number).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ corroboratingArms: _corroboratingArms, ...rest }) => rest);
}

const CONFIDENCE_RANK: Record<Confidence, number> = { strong: 0, moderate: 1, weak: 2 };

type FtsRow = { id: string; title: string; tags: string[]; folder_id: string | null; rank: number; headline: string };
type NoteRow = { id: string; title: string; content: string; tags: string[] };

/**
 * A ts_headline snippet that looks like loose table-cell fragments (at
 * least a couple of `|` delimiters) with no separator row anywhere in it.
 * Deliberately NOT line-anchored like TABLE_ROW_RE/TABLE_SEPARATOR_RE:
 * ts_headline crops at word boundaries (MaxWords=45, migration 009), not
 * cell boundaries, so a genuinely broken snippet routinely has NO full
 * `|...|`-shaped line at all — the row's own opening pipe falls before the
 * crop, its closing one after. A real live case: `without prefix −0.004) |
 * range 0.60–0.68 ... |` starts and ends mid-cell, no line passes
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

// Words worth re-querying on individually — websearch_to_tsquery ANDs every
// term in the original query, so a natural-language question (7+ words) can
// require literal co-occurrence of words that were never meant as a single
// phrase and come back empty. 3 chars is the same floor the overhaul uses
// elsewhere for "significant" — short enough to keep real content words
// ("dns", "kmv") while dropping prepositions/particles in RU/EN/DE, the
// languages this vault actually configures (settings.fts_languages).
//
// Known scope limitation, flagged rather than silently left implicit
// (pre-publication review): word length is language-dependent, and this
// cutoff was originally a cascade-triggering heuristic only — since step 3b
// it also PRE-FILTERS which words computeTextCoverage's real, language-
// aware significance test (numnode() against the configured FTS languages)
// ever gets to see, making a length-3 floor load-bearing in a way it wasn't
// before. German compounds ("Rechnungsnummer") clear it easily; a CJK
// vault, where content words routinely run 1-2 characters, would have
// significant words silently dropped before the language-aware test ever
// ran. Not fixed here: this vault's configured languages (russian,
// english, and optionally german) are all space-delimited with multi-
// character words, so the gap is real but doesn't fire on any language
// this instance is actually configured for. A genuinely language-aware
// tokenizer (leaning on Postgres's own parser rather than a fixed-length
// JS regex split) is a bigger redesign than this review pass covers —
// belongs in the roadmap as a known limitation for a CJK-configured vault,
// not something to guess a fix for unmeasured.
const MIN_SIGNIFICANT_WORD_LEN = 3;

function significantWords(query: string): string[] {
  return query.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= MIN_SIGNIFICANT_WORD_LEN);
}

/**
 * Query-coverage discount (2026-08-14 search-relevance overhaul, step 3b): what fraction of
 * the query's significant lexemes are actually present in a given hit,
 * independent of ts_rank entirely. Needed because step 4's relative-to-best
 * normalization (rank / max(rank)) always hands the top hit of a result set
 * relevance 1.0 — including a set where the "top hit" only matched one word
 * out of five and nothing else came close (measured live: a 5-word nonsense
 * query's best OR-cascade hit read `relevance: 1`).
 *
 * "Significant" is decided the same way Postgres itself decides it for
 * ranking — a word counts only if at least one of the vault's configured
 * FTS languages (settings.fts_languages, same list search_notes_fts reads)
 * doesn't reduce it to nothing. 'simple' is deliberately excluded from that
 * test: it has no stopword dictionary at all, so including it would make
 * every word "significant" and erase the whole distinction. 'simple' IS
 * included on the matching side below — a hit that only matched via an
 * unstemmed identifier form shouldn't be penalized for it, matching
 * search_notes_fts's own tsq construction.
 *
 * A ratio of query lexemes to document lexemes, not a cosine or ts_rank
 * value — comparable across any corpus, language, or model, same reasoning
 * as relevance itself (see semanticSearch/textSearch). No new vault-tuned
 * constant.
 *
 * Fails open: if the coverage query itself errors (e.g. a stale/invalid
 * language in settings.fts_languages the write-side trigger already
 * tolerates but this ad hoc query doesn't), or nothing survives the
 * significance test, callers get `null` and apply no discount rather than
 * losing the search results entirely over a debug signal.
 */
async function computeTextCoverage(words: string[], ids: string[]): Promise<Map<string, number> | null> {
  if (words.length === 0 || ids.length === 0) return null;
  const uniqueWords = [...new Set(words)];

  try {
    const languages = await getFtsLanguages();
    if (languages.length === 0) return null;

    const sigRows = await dbQuery<{ word: string; significant: boolean }>(
      `select w.word, bool_or(numnode(websearch_to_tsquery(l.lang::regconfig, w.word)) > 0) as significant
       from unnest($1::text[]) as w(word)
       cross join unnest($2::text[]) as l(lang)
       group by w.word`,
      [uniqueWords, languages]
    );
    const significantWordList = sigRows.filter((r) => r.significant).map((r) => r.word);
    if (significantWordList.length === 0) return null;

    const langExprs = languages.map((_, i) => `websearch_to_tsquery($${i + 2}::regconfig, wt.word)`);
    const tsqExpr = [`websearch_to_tsquery('simple', wt.word)`, ...langExprs].join(' || ');
    const idsParamIndex = languages.length + 2;
    const rows = await dbQuery<{ id: string; matched: number; total: number }>(
      `with word_tsq as (
         select word, (${tsqExpr}) as tsq
         from unnest($1::text[]) as wt(word)
       )
       select n.id,
         count(*) filter (where n.search_vector @@ wt.tsq)::int as matched,
         (select count(*) from word_tsq)::int as total
       from notes n
       cross join word_tsq wt
       where n.id = any($${idsParamIndex}::uuid[])
       group by n.id`,
      [significantWordList, ...languages, ids]
    );

    const coverage = new Map<string, number>();
    for (const r of rows) coverage.set(r.id, r.total > 0 ? r.matched / r.total : 1);
    return coverage;
  } catch (err) {
    console.warn('[search] coverage computation failed, no discount applied:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Full-text search with ru+en morphology via the search_notes_fts RPC
 * (uses the bilingual GIN index from migration 001). Three passes, each
 * only run if the previous left too little to work with:
 *
 *  1. Strict — the query as-is (AND semantics via websearch_to_tsquery).
 *  2. OR — if the strict pass came back short, re-run the same RPC (no new
 *     SQL, no migration) with the query's significant words joined by the
 *     literal word "or", which websearch_to_tsquery already parses as its
 *     OR operator. Weaker by construction (matches on any one term, not
 *     all of them) — appended after the strict rows, never reordered above
 *     them, and deduplicated against what the strict pass already found.
 *  3. substringSearch — only once both of the above are empty. Partial
 *     words and code fragments like "kmv" or "tsconfig" don't survive
 *     stemming at all.
 */
// Product of every matching tag's weight, 1 for a tag with no entry — an
// empty settings map (the default) makes this 1 for everything, a true
// no-op on the multiply below. Product, not max/average: independent
// multiplicative signals compound naturally (two mildly-boosted tags lean
// further up than one; a boosted and a demoted tag partially cancel)
// without needing a rule for which tag "wins" when they conflict.
function weightForTags(tags: string[], weights: TagWeights): number {
  return tags.reduce((acc, t) => acc * (weights[t] ?? 1), 1);
}

// Exact folder_id match only, same as SearchFilters.folderId's own semantics
// (filteredNoteIds above) — no subtree recursion. A vault that wants a
// whole book tree downweighted sets the weight on each folder in it; adding
// recursion would need walking the folders table for every search call for
// a case the roadmap didn't ask for.
function weightForFolder(folderId: string | null | undefined, weights: FolderWeights): number {
  return folderId ? (weights[folderId] ?? 1) : 1;
}

export async function textSearch(query: string, limit = 10, filters?: SearchFilters): Promise<SearchResult[]> {
  const fetchLimit = overfetchLimit(limit, filters);
  const [rows, tagWeights, folderWeights] = await Promise.all([
    dbQuery<FtsRow>('select * from search_notes_fts($1, $2)', [query, fetchLimit]),
    getTagWeights(),
    getFolderWeights(),
  ]);

  let orRows: FtsRow[] = [];
  const words = significantWords(query);
  // >2 words: with 1-2 words an OR pass is identical to (or looser than
  // pointless versus) the strict AND pass already run.
  if (rows.length < limit && words.length > 2) {
    const seen = new Set(rows.map((r) => r.id));
    const orAll = await dbQuery<FtsRow>(
      'select * from search_notes_fts($1, $2)',
      [words.join(' or '), fetchLimit]
    );
    orRows = orAll.filter((r) => !seen.has(r.id));
  }

  if (rows.length === 0 && orRows.length === 0) {
    return enrichResults(await substringSearch(query, limit, filters));
  }

  // n.rank is Postgres's actual ts_rank for this query — a genuine
  // relevance signal, unlike the positional score substringSearch falls
  // back to below (there is no rank for a plain substring match). Scored
  // relative to this query's own best rank, not a fixed anchor — same
  // reasoning as semanticSearch's cosine (see there): ts_rank is a
  // per-query, dimensionless value, there is no absolute number that means
  // the same thing across two different queries. Both RPC calls already
  // order by rank desc, so each list's own head is that list's best.
  // Tag and folder weight both multiply the raw rank, before normalization —
  // never relevance itself. relevance's 0..1 range is what confidenceFor()'s
  // thresholds are calibrated against; multiplying it post-hoc could push
  // a hit above 1.0 or silently shift which confidence band it lands in.
  // Multiplying the raw score instead keeps relevance exactly what it's
  // always been ("how this compares to the best hit in this response") —
  // weight just gets a say in which hit that is. At the default empty
  // weights maps this is `n.rank * 1 * 1` for every row, i.e. unchanged.
  const weightedRank = (n: FtsRow) => n.rank * weightForTags(n.tags, tagWeights) * weightForFolder(n.folder_id, folderWeights);
  const best = Math.max(0, ...rows.map(weightedRank), ...orRows.map(weightedRank));
  // Coverage only applies to the 'or' tier — an 'and' hit already matched
  // EVERY term websearch_to_tsquery's own parser produced for the strict
  // query, by construction (that's what AND semantics means), so it's
  // fully covered regardless of what coverage would compute. Deliberately
  // not "compute it anyway, it'll come out 1.0" — measured live 2026-08-14:
  // a hostname query ("host1.example.cloud") is one lexeme to Postgres's
  // own tokenizer (its dotted-host special case), but significantWords()
  // (a plain JS regex split on non-letters) naively cut it into three —
  // "host1"/"example"/"cloud" — and testing those as three separate
  // lexemes against a vector that stored it as one dropped a correct,
  // exact-match AND hit from relevance 1.0 to 0.33. Two different
  // tokenizers must never be asked to agree on the same string; scoping the
  // discount to the tier that's actually the overhaul's failure mode (OR found
  // one word out of N) sidesteps the disagreement entirely instead of
  // trying to make the two tokenizers consistent.
  const coverageMap = await computeTextCoverage(words, orRows.map((n) => n.id));
  const toResult = (n: FtsRow, tier: 'and' | 'or') => {
    // Order matters: coverage multiplies the ALREADY-normalized rank, never
    // the other way around. Applying it before dividing by the set's max
    // would cancel out whenever every hit in the set shares the same
    // coverage (the common case for an OR-cascade result: everything
    // matched on one word out of N) — the multiplier would divide by
    // itself and the top hit would land back at 1.0, silently undoing the
    // whole point (2026-08-14 search-relevance overhaul, step 3b).
    const normalized = best > 0 ? weightedRank(n) / best : 0;
    const coverage = tier === 'and' ? 1 : (coverageMap?.get(n.id) ?? 1);
    const relevance = normalized * coverage;
    // Standalone (no semantic arm to corroborate with): an 'and' hit is one
    // real signal (1 arm); an 'or' hit found nothing under the strict
    // query, so it has zero corroborating arms — confidenceFor forces it
    // to `weak` regardless of how high its own relevance looks (which can
    // be misleadingly high: it's "best of the loosened set", not "best of
    // a query that actually matched").
    const confidence = confidenceFor(relevance, tier === 'and' ? 1 : 0);
    return {
      id:      n.id,
      title:   n.title,
      excerpt: n.headline.replace(/<\/?b>/g, ''),
      tags:    n.tags,
      score:   n.rank,
      relevance,
      confidence,
      text_tier: tier,
      coverage,
    };
  };
  const results = [...rows.map((n) => toResult(n, 'and')), ...orRows.map((n) => toResult(n, 'or'))]
    // confidence first, relevance only as the tiebreak within a tier — the
    // SQL order (by raw rank, then 'and' rows before 'or' rows) no longer
    // guarantees this once coverage can push an 'or' hit's relevance above
    // an 'and' hit's, and a caller reading top-to-bottom must never see
    // `weak` above `moderate` (the search-relevance overhaul step 2a's invariant, restated for
    // this arm's own output, not just rrfMerge's).
    .sort((a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] || b.relevance - a.relevance);
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
      // The loosest tier — zero corroborating arms, same reasoning as an
      // 'or' hit in textSearch: nothing solid behind it on its own.
      confidence: confidenceFor(relevance, 0),
      text_tier: 'substring' as const,
    };
  });
  return applyFilters(results, limit, filters);
}

/**
 * Chunk-based semantic search: each note is indexed as per-section vectors
 * (see lib/indexing.ts), match_chunks returns up to 2 chunks per note
 * (migration 017), so the excerpt is the actually-relevant section, not the
 * document head — and a note with two genuinely on-topic passages can
 * surface both (deduplicated back to one result each below).
 *
 * Two separate jobs, deliberately not one absolute threshold doing both
 * (2026-08-14 measurement — a single cosine floor can't be both a junk gate
 * and a relevance judgment: lowering it to catch more true positives always
 * let more noise in too, on this vault and by construction on anyone else's):
 *
 *  1. Recall — getMinSimilarity() is a low, permissive junk gate applied
 *     INSIDE match_chunks at the CHUNK level (migration 002). Everything
 *     back from the RPC is merely a *candidate*.
 *  2. Relevance — among those candidates, keep only ones within 0.75x of
 *     this query's own best hit, then score relevance = similarity / best.
 *     A ratio, not a cosine — comparable across models and corpora, unlike
 *     any fixed cosine number could be. Top hit is always exactly 1.0.
 *
 * NOTE: in hybridSearch the FTS/text arm is NOT cosine-filtered, so a
 * hybrid result CAN have no semantic_score at all when it entered via the
 * text pass only — that's why the combined output shows notes a pure-
 * semantic pass would have dropped.
 */
export async function semanticSearch(query: string, limit = 10, filters?: SearchFilters): Promise<SearchResult[]> {
  const [embedding, floor] = await Promise.all([
    getEmbedding(query, 'query'),
    getMinSimilarity(),
  ]);

  const fetchLimit = overfetchLimit(limit, filters);
  const data: Record<string, unknown>[] = await dbQuery(
    'select * from match_chunks($1::vector, $2, $3)',
    [toVector(embedding), fetchLimit, floor]
  );

  // match_chunks orders by similarity desc, so the first row is this
  // query's best hit — the reference point relevance is measured against.
  const best = (data[0]?.similarity as number | undefined) ?? 0;

  // Degenerate set: the top hit barely cleared the floor at all. On a
  // model whose noise and signal cosines sit close together (measured live
  // on nomic-embed-text: noise ~0.66, signal ~0.68 — a ~0.02 gap), the
  // floor alone can't keep noise out, and the 0.75x-of-best cutoff below
  // makes it worse, not better: it would call this "best" result 1.0
  // relevance and hand it out as if it meant something. If nothing cleared
  // the floor by a real margin, there's no genuine signal to rank — same
  // "nothing relevant reads as empty" preference the floor itself already
  // encodes (lib/embeddings.ts), just applied to the case a flat floor
  // can't catch on its own.
  if (best > 0 && best - floor < signalMargin(floor)) {
    return [];
  }

  const candidates = best > 0 ? data.filter((n) => (n.similarity as number) >= 0.75 * best) : data;

  // match_chunks can return up to 2 chunks per note (migration 017) — one
  // note can genuinely occupy 2 slots of `candidates`. Good for corroborating
  // that a large document has real on-topic content, bad for a caller-facing
  // result list: a `limit: 3` call returning the same note twice leaves only
  // 2 actual documents represented with no signal in the response shape that
  // that's what happened (measured live 2026-08-14: a long natural-language
  // query against a job-vacancy note returned it twice in
  // 3 slots). Keep one entry per note — the first, since `data` is already
  // ordered by similarity desc, so it's that note's best-matching chunk —
  // the same "first occurrence wins" rule rrfMerge already applies across
  // arms, applied here within a single arm's own list.
  const seenNoteIds = new Set<string>();
  const dedupedCandidates = candidates.filter((n) => {
    const id = n.id as string;
    if (seenNoteIds.has(id)) return false;
    seenNoteIds.add(id);
    return true;
  });

  const results = dedupedCandidates.map((n) => {
    const heading = n.heading as string | null;
    // Drop the chunk's own `# Heading` line so it isn't repeated by the
    // `[heading]` context prefix below.
    const excerpt = makeExcerpt(stripLeadingHeading(n.chunk_content as string), query);
    const relevance = (n.similarity as number) / best;
    return {
      id:      n.id as string,
      title:   n.title as string,
      excerpt: heading ? `[${heading}] ${excerpt}` : excerpt,
      tags:    n.tags as string[],
      score:   n.similarity as number,
      relevance,
      confidence: confidenceFor(relevance, 1),
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
