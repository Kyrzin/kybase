// lib/search.ts — text (FTS + substring fallback), semantic (chunk-based), and hybrid (RRF) search
import { query as dbQuery, toVector } from './db';
import { getEmbedding, getMinSimilarity, embeddingModelKey } from './embeddings';
import { getEmbeddingConfig, getFtsLanguages, getTagWeights, type TagWeights, getFolderWeights, type FolderWeights } from './settings';
import { escapeLike } from './sql';
import { TABLE_ROW_RE, TABLE_SEPARATOR_RE, unpairedFenceIndex, extractHeadings } from './markdown';

export type SearchResult = {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  score: number;
  // How this hit compares to the BEST hit in this same response, 0..1. A
  // ratio, not an absolute score: says nothing about quality on its own (a
  // relevance-1.0 hit can still be the best of a bad set), and is NOT
  // comparable across different queries' results, only within one. Judge a
  // hit by its excerpt; this only orders them. The top hit reads 1.0 unless
  // the whole response is discounted — every hit matching one word out of
  // four caps the set at its coverage. On hybrid results this is the MAX of
  // the contributing arms — arms corroborate a hit, they don't add up.
  relevance: number;
  // Present only on hybrid results, and only for the pass(es) that actually
  // matched this note — text_score is FTS ts_rank (or a positional fallback
  // score for substring matches), semantic_score is raw cosine similarity.
  // `score` itself stays the RRF rank fusion, used for hybrid's own sort
  // order — it is NOT a relevance measure (see rrfMerge); keep using
  // relevance for ordering and these raw fields for debugging.
  text_score?: number;
  semantic_score?: number;
  // The semantic hit expressed in background units: how many IQRs above
  // the median of what THIS query scores against a frozen sample of the
  // vault's own chunks. Raw cosine is not
  // comparable between queries -- measured live 2026-08-19, a correct
  // answer scored 0.443 for one query and 0.686 for another on the same
  // model and vault. Kept OUT of the default response for that reason: a
  // raw cosine handed to a caller invites it to invent its own threshold,
  // which is the mistake this project spent a day removing from its own code.
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
  // confirmation. Exposed as an observed fact so a caller can tell the two
  // apart, rather than being folded invisibly into the ranking.
  text_tier?: 'and' | 'or' | 'substring';
  // textSearch only. The query occurs as a contiguous, case-insensitive
  // substring of this note's title or content. Set only for a whitespace-free
  // query that still splits into several words — a filename, an identifier, a
  // code symbol — never for a phrase or a question (see textSearch for both
  // guards and the counter-test that drew the second one).
  // A fact about the string, NOT a verdict about
  // the note — it earns the upper half of the relevance scale (applyExactBand)
  // and nothing more; two verbatim hits are still ranked against each other by
  // their own text score.
  exact?: boolean;
  // The markdown heading the excerpt was taken from, when it is known — set
  // by the semantic arm, where the chunker already recorded it. Travels with
  // the excerpt it belongs to (rrfMerge keeps the first arm's result object
  // whole), so it never labels one passage with another's heading. Pass it
  // to get_note's `section` to read that part of the note alone: measured
  // 2026-08-20 on a real server note, 681 characters instead of 13035.
  section?: string;
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
  // textSearch only. This note contains the QUESTION, not an answer to it —
  // several of its interrogative lines share the query's words and none of
  // them is followed by an answer (see questionEcho). A fact about the note's
  // structure, reported whether or not the ranking acts on it.
  question_echo?: boolean;
  // This note's semantic index is still being rebuilt: the excerpt above came
  // from the previous version of the text, or the note has never been
  // embedded. Read the note with get_note before quoting it as current —
  // the note row itself always holds the newest text, only the vectors lag.
  // Absent (rather than false) when the index is up to date, so a caller can
  // ignore the field entirely on a healthy vault.
  index_pending?: boolean;
};


// The substring fallback has no rank at all — an exact-substring hit on a
// title is a decent match for identifier-ish queries, one buried in content
// is weaker. Fixed levels, deliberately capped below a full-rank match.
const SUBSTRING_RELEVANCE = { title: 0.65, content: 0.5 };

// The number a caller sees is the number actually applied. It used to be a
// base floor plus a relative margin computed here, which meant the reported
// threshold and the effective one lived in different files and drifted apart
// twice: once when the margin was accidentally disabled, and once when the
// two were merged into a per-model profile and the margin kept being added
// on top of it (live: profile 0.349, effective 0.39, a hit at 0.35 silently
// dropped). One number, one place.
export async function effectiveSemanticThreshold(): Promise<number | null> {
  return getMinSimilarity();
}

const RRF_K = 60;

// ── Retrieval behavior switches ────────────────────────────────────────────
//
// Three ranking questions that were argued on paper and then measured on
// holdout collections never used to tune anything. Each default is the
// variant that won; each switch exists so a deployment can go back without
// downgrading the image. Two of the three defaults are the OPPOSITE of what
// the design argument predicted, which is exactly why they are switches and
// not silent constants.
//
// KYBASE_SEARCH_FUSION=legacy — sort by `relevance` first, RRF only as a
//   tiebreak. `relevance` is each arm's own score over that arm's own best,
//   so both arms put their best hit at exactly 1.0 however good it is, and
//   the maximum of two such numbers is not a ranking function. Rank fusion
//   is the fix, and it measured as a small strict win: same Recall@1 and
//   MRR, ordering constraints 94.7% -> 100%. Defaults to rank fusion.
//
// KYBASE_SEARCH_SEMANTIC_TRIM=off — stop dropping semantic candidates that
//   score under 0.75x this query's best hit. The argument against the trim
//   is sound in principle (a ratio to the best result is not a probability,
//   and nothing downstream can recover a candidate removed here) and it lost
//   on measurement anyway: removing it cost 7 points of Recall@1 (86.2% ->
//   79.3%) and 10 points of ordering, at both candidate widths, because
//   every weak semantic candidate it used to drop still earns an RRF rank
//   contribution. Kept ON, as a candidate-stage precision filter, with no
//   claim that 0.75 means anything about relevance.
//
// KYBASE_SEARCH_CANDIDATES — per-arm candidate floor. 50 was the suggested
//   starting point; measured against 30 it cost 3.4 points of Recall@1
//   (86.2% -> 82.8%) and bought nothing, because candidate recall was
//   already 100% at 30. Widening a pool that already contains the answer
//   only feeds more weak single-arm hits into fusion. NOTE the limitation:
//   the holdout collections hold 12-16 notes each, so neither width is a
//   test of what a large vault needs — this number is a floor chosen not to
//   starve small `limit` values, not a tuned optimum.
// KYBASE_SEARCH_TEXT_WEIGHT=coverage — MEASURED AND REJECTED, off by default.
//   Scale the TEXT arm's rank contribution by how much of the query that hit
//   actually contains. The idea is sound on its face — a note matching one
//   filler word out of five casts the same vote as one matching all of them —
//   and it wins on the oldest holdout (+3.4 points of Recall@1 there). It
//   lost everywhere it had not been looked at first: on a fresh holdout it
//   cost 4.9 points of Recall@1, 7.4 of ordering and 4.9 of excerpt quality.
//
//   The reason is structural, not tuning. Coverage is 1 BY CONSTRUCTION for
//   the strict AND tier, so weighting by it does not demote weak hits — it
//   promotes every AND hit over every OR hit. And the notes that match a
//   user's question at the AND tier with coverage 1 are precisely the FAQ and
//   agenda notes that list questions without answering them. The weight
//   promotes exactly what this ranking stage exists to demote.
//
//   Kept as a switch rather than deleted so the measurement stays repeatable.
//
// KYBASE_SEARCH_QUESTION_ECHO=demote — NOT SHIPPED, off by default.
//   Drops the text contribution of a note that contains the QUESTION rather
//   than an answer to it. Independent of the weight above and not fixable by
//   it: such a note matches at the strict AND tier with coverage 1, so it is
//   already at full weight, and coverage-weighting only raises it further.
//
//   It won on synthetic holdouts — positive on two, neutral on the third,
//   negative on none, with every question-and-answer note keeping its
//   position — and then lost on a real vault, which is the case that decides.
//   There, a note listing questions for an immigration office was the ONLY
//   note in the collection on that subject. Demoting it moved an unrelated
//   note matching a fifth of the query to first place and pushed the one
//   on-topic note off the visible page.
//
//   The defect is in the remedy, not the signal: a weight of zero removes the
//   note from fusion outright, when what is wanted is for it to rank below
//   notes that ANSWER — and above notes that are merely elsewhere. A
//   formulation that only demotes while a non-echo candidate is actually
//   present would express that; it has not been built or measured, so nothing
//   is enabled on a guess.
//
//   The signal itself is computed and reported regardless (`question_echo`
//   on a hit) — a caller told "this note lists your question without
//   answering it" can act on that without the ranking pre-empting the choice.
const LEGACY_FUSION = process.env.KYBASE_SEARCH_FUSION === 'legacy';
const SEMANTIC_TRIM = process.env.KYBASE_SEARCH_SEMANTIC_TRIM !== 'off';
const SEMANTIC_TRIM_RATIO = 0.75;
// KYBASE_SEARCH_EXCERPT=legacy — go back to opening the excerpt at the start
//   of the passage when the query does not occur verbatim, instead of
//   centring it on the passage's most query-relevant line, and go back to
//   trusting a chunk's stored heading over the excerpt's real position.
//   Presentation only: neither setting changes which documents are returned
//   or in what order.
const LEGACY_EXCERPT = process.env.KYBASE_SEARCH_EXCERPT === 'legacy';
const TEXT_COVERAGE_WEIGHT = process.env.KYBASE_SEARCH_TEXT_WEIGHT === 'coverage';
const DEMOTE_QUESTION_ECHO = process.env.KYBASE_SEARCH_QUESTION_ECHO === 'demote';

// hybridSearch feeds each arm's results into RRF fusion. If each arm is
// capped at the final output size, a note ranked just outside `limit` in
// BOTH arms never reaches rrfMerge at all — even though their combined rank
// would place it in the fused top results. Overfetch a wider candidate pool
// per arm, then slice down to `limit` only after fusion.
// A floor, not just a multiple of `limit`: the caller's page size is a
// display decision and says nothing about how deep retrieval has to go to
// find the answer. At the MCP default of limit:5 the old `limit * 3` gave
// each arm fifteen candidates to fuse, so a note that neither arm ranked in
// its own top fifteen could not be recovered by the fusion that exists to
// recover exactly that.
//
// 30, deliberately not the 50 that was proposed: 50 measured WORSE
// (see KYBASE_SEARCH_CANDIDATES above). 30 is the width the winning holdout
// run used at limit:10, so this floor changes only the small-`limit` regime
// — the one that was starved and was never measured as good — and leaves the
// measured-best case exactly as measured.
const RRF_CANDIDATE_FACTOR = 3;
const RRF_CANDIDATE_FLOOR = Number(process.env.KYBASE_SEARCH_CANDIDATES ?? 30);
const RRF_CANDIDATE_CAP = 100;

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

// Filters are resolved to an id set once and handed to the RPCs, which apply
// them BEFORE ORDER BY / LIMIT (migration 028). They used to be applied in JS
// after the RPC had already ranked and truncated over the whole vault, which
// had two consequences a caller could see: an out-of-scope hit consumed a
// candidate slot that an in-scope note needed, and — worse — it set the
// per-query best score that the in-scope notes were then measured against, so
// a strong match in another folder could push a legitimate one out of
// semanticSearch's relative trim entirely. The overfetch below is what made
// the first problem merely unlikely instead of fixed; with the filter inside
// the SQL neither problem exists, and the overfetch is kept only as a small
// margin for the substring path, which still filters in JS.
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
  filters: SearchFilters | undefined,
  allowedIds?: Set<string>
): Promise<SearchResult[]> {
  if (!hasFilters(filters)) return results.slice(0, limit);
  const allowed = allowedIds ?? await filteredNoteIds(filters);
  const filtered = results.filter((r) => allowed.has(r.id)).slice(0, limit);
  // If the filter cut the response's own best hit, the survivors' relevance
  // stays scaled against a max that's no longer in the response — the top
  // hit reads under 1.0 even though it's the best thing the caller gets
  // back. Rescale against the filtered set's own max so relevance keeps
  // meaning "best hit in THIS response", same contract as everywhere else.
  const topRelevance = Math.max(0, ...filtered.map((r) => r.relevance));
  if (topRelevance > 0 && topRelevance < 1) {
    filtered.forEach((r) => { r.relevance = r.relevance / topRelevance; });
  }
  return filtered;
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
  const rows = await dbQuery<{ id: string; created_at: string; content_length: number; embedding_pending: boolean }>(
    'select id, created_at, length(content) as content_length, embedding_pending from notes where id = any($1) and deleted_at is null',
    [results.map((r) => r.id)]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return results.map((r) => {
    const row = byId.get(r.id);
    return {
      ...r,
      created_at: row?.created_at,
      content_length: row?.content_length,
      // Per hit, not just per vault: a search response already reported how
      // many notes were pending overall, which told an agent that something
      // was stale but never whether THIS excerpt was. Free here — the same
      // lookup was already fetching two other columns from the same row.
      ...(row?.embedding_pending ? { index_pending: true } : {}),
    };
  });
}

function overfetchLimit(limit: number, filters: SearchFilters | undefined): number {
  return hasFilters(filters) ? Math.min(OVERFETCH_CAP, limit * OVERFETCH_FACTOR) : limit;
}

/**
 * The note ids a filtered call is allowed to see, resolved once. hybridSearch
 * resolves it for both arms; a direct textSearch/semanticSearch call resolves
 * it here. undefined means "no filter given", which the RPCs read as null and
 * treat as the whole vault.
 */
async function resolveScope(
  filters: SearchFilters | undefined,
  allowedIds: Set<string> | undefined
): Promise<Set<string> | undefined> {
  if (allowedIds) return allowedIds;
  return hasFilters(filters) ? filteredNoteIds(filters) : undefined;
}

const scopeParam = (scope: Set<string> | undefined): string[] | null => (scope ? [...scope] : null);

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
/**
 * Where in `content` the query's own words are densest — the line to centre an
 * excerpt on when the query does not occur verbatim anywhere.
 *
 * Line-granular and purely lexical, on purpose. It is choosing which part of
 * an ALREADY-CHOSEN passage to display, not what to retrieve, so it cannot
 * move a document, change a rank, or cost a model call. Nothing here is a
 * claim that the line answers the question; it is the part of the passage
 * that has most to do with what was asked.
 *
 * Matching is plain case-insensitive substring on words of three characters
 * or more. Deliberately no stemmer: the point is to survive inflection
 * cheaply, and a Russian query word usually appears in the text in a form
 * that contains it or is contained by it ("уборки" in "до уборки"). A
 * stemmer here would have to agree with Postgres's, and two tokenizers that
 * must agree is a bug this file has paid for before — this one is allowed to
 * be approximate because the worst case is the excerpt we already showed.
 *
 * Ties go to the earlier line: with nothing to separate two passages, the one
 * the author wrote first is the less surprising choice.
 */
export function bestPassageOffset(content: string, query: string): { start: number; end: number } | null {
  const words = [...new Set(
    query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= MIN_SIGNIFICANT_WORD_LEN)
  )];
  if (words.length === 0) return null;

  const lines = content.split('\n');
  const lower = lines.map((l) => l.toLowerCase());

  // Distinct words, weighted by length: a long word matching is better
  // evidence than a short one, and that is as much as this needs to know.
  //
  // Discounting words by how many lines of the passage contain them — the
  // same idea as inverse document frequency, scoped locally — was built and
  // measured, and lost: it fixed one case and broke another, ending level on
  // sections and one worse on answers. Not kept. Whatever separates a
  // repeated word like "archive" from a discriminating one, line counts
  // inside a single note are too coarse to be it.
  const scoreOf = (hay: string) => {
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length;
    return score;
  };

  let best: { start: number; end: number; score: number } | null = null;
  let bestHeading: { start: number; end: number; score: number } | null = null;
  let offset = 0;
  for (const [i, line] of lines.entries()) {
    const score = scoreOf(lower[i]);
    if (score > 0) {
      const here = { start: offset, end: offset + line.length, score };
      // A heading is a hint about which section, not the answer itself, so
      // body text always wins over it. It is still kept as a fallback: when a
      // question's only echo in the passage is the heading it lives under
      // ("Следующий шаг" for "какой следующий шаг"), that heading is the one
      // honest anchor available, and ignoring it drops the window back to the
      // start of the passage — the failure this whole function replaces.
      if (/^\s*#{1,6}\s/.test(line)) {
        if (!bestHeading || score > bestHeading.score) bestHeading = here;
      } else if (!best || score > best.score) {
        best = here;
      }
    }
    offset += line.length + 1;
  }
  const chosen = best ?? bestHeading;
  return chosen ? { start: chosen.start, end: chosen.end } : null;
}

export function makeExcerpt(content: string, query?: string, maxLen = EXCERPT_LENGTH): string {
  if (content.length <= maxLen) return content;

  let start = 0;
  let matchEnd = 0; // end of the actual match text — the tail shave below must never cut into it
  if (query) {
    const idx = content.toLowerCase().indexOf(query.toLowerCase());
    if (idx > 0) {
      start = Math.max(0, idx - Math.floor((maxLen - query.length) / 2));
      matchEnd = idx + query.length;
    } else if (idx === -1 && !LEGACY_EXCERPT) {
      // The whole query string is not in the text — the normal case for a
      // question asked in the user's own words. This used to fall straight
      // through to `start = 0` and show the opening of the passage, which for
      // a multi-section note is its introduction: ask when the spraying
      // happens, get "this regulation describes the protection system".
      // Measured on holdout collections: three of forty-one queries ranked
      // the right note first and then showed a part of it that answers
      // nothing.
      const anchor = bestPassageOffset(content, query);
      if (anchor) {
        start = Math.max(0, anchor.start - Math.floor((maxLen - (anchor.end - anchor.start)) / 2));
        matchEnd = anchor.end;
      }
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
    exact: boolean | undefined; textCoverage: number | undefined;
    questionEcho: boolean | undefined;
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
      // Rank still sets the value; the weight only says how much of a vote
      // this arm has earned for this hit. 1 for the semantic arm, 1 for an
      // exact/AND-tier text hit, and the measured coverage for a loose one.
      // An echo hit forfeits its text vote entirely: it does not stop being
      // returned, it stops winning fusion on the strength of quoting the
      // question back.
      const weight = field !== 'text_score' ? 1
        : (DEMOTE_QUESTION_ECHO && item.question_echo) ? 0
        : TEXT_COVERAGE_WEIGHT ? (item.coverage ?? 1)
        : 1;
      const rrfScore = weight / (RRF_K + rank + 1);
      const existing = scoreMap.get(item.id);
      if (existing) {
        existing.rrfScore += rrfScore;
        // Arms corroborate a hit rather than add up: the merged relevance is
        // the best arm's normalized score, so a note that only one arm found
        // keeps that arm's full relevance (unlike its RRF rank, which the
        // single-arm penalty halves).
        existing.relevance = Math.max(existing.relevance, item.relevance);
        existing.extra[field] = item.score;
        if (field === 'text_score') {
          existing.textTier = item.text_tier;
          // exact/coverage are facts about how this note's own text matched
          // the query — independent of which arm's excerpt/section ends up
          // shown below. Tracked here, outside `result`, for the same reason
          // textTier already is: `result` can still be swapped to the
          // semantic arm's object (next block), which carries neither field
          // at all (semanticSearch never sets `exact`) — without this, a
          // verbatim identifier match would silently lose the one fact that
          // proves it, right as it also picks up the semantic arm's
          // normalized relevance and often a #1 rank. Measured live
          // 2026-08-21: "KYBASE_SECRET" against a real vault — a note read
          // `exact: true` from `type: text` and had no `exact` field at all
          // from `type: hybrid`, despite outranking everything.
          existing.exact = item.exact;
          // Prefer the text arm's own coverage over whichever arm's object
          // happens to win the swap below. For an 'and'/exact-tier hit it's
          // fixed at 1 by construction (see toResult in textSearch — AND
          // semantics already means every term matched); for an 'or' hit
          // it's computeTextCoverage's own IDF-weighted number — the exact
          // same function semanticSearch calls for the same note and query,
          // so the two arms' values are expected to agree (spot-checked live
          // 2026-08-21, "PostgreSQL backup and restore": text 0.70 vs
          // semantic 0.70 on the same note — no divergence found). Taking
          // the text arm's number is the documented, tier-consistent one;
          // a semantic-only hit falls through to the winning result's own
          // coverage below, since textCoverage stays undefined for it.
          existing.textCoverage = item.coverage;
          // Same reasoning as exact/coverage: a fact about how this note's
          // own text met the query, which must survive the excerpt swap below.
          existing.questionEcho = item.question_echo;
        }
        // Two arms can hit the same note via genuinely different passages —
        // a text match in one section, a semantic match (match_chunks) in
        // another. Whichever arm ran first used to permanently own the
        // shown excerpt/section regardless of which one actually answers
        // the query; compare against item's own relevance (not the merged
        // max above) so the better-matching arm's passage wins.
        if (item.relevance > existing.result.relevance) {
          existing.result = item;
        }
      } else {
        scoreMap.set(item.id, {
          result: item, rrfScore, relevance: item.relevance,
          extra: { [field]: item.score },
          textTier: field === 'text_score' ? item.text_tier : undefined,
          exact: field === 'text_score' ? item.exact : undefined,
          textCoverage: field === 'text_score' ? item.coverage : undefined,
          questionEcho: field === 'text_score' ? item.question_echo : undefined,
        });
      }
    });
  }

  return [...scoreMap.values()]
    .map(({ result, rrfScore, relevance, extra, textTier, exact, textCoverage, questionEcho }) => {
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
      return {
        ...rest,
        ...extra,
        rrf_score: rrfScore,
        relevance,
        matched_by,
        text_tier: textTier,
        ...(exact !== undefined ? { exact } : {}),
        ...(textCoverage !== undefined ? { coverage: textCoverage } : {}),
        ...(questionEcho ? { question_echo: true } : {}),
      };
    })
    // Ordering is retrieval and fusion, nothing else.
    //
    // Sorted by the RRF score, which is what RRF is for: rank is comparable
    // between arms, score is not. The previous order led with `relevance` —
    // each arm's own score divided by that arm's own best — and used RRF only
    // to break ties, which is not rank fusion at all. Two arms' normalized
    // scores are different quantities: ts_rank/max(ts_rank) and
    // cosine/max(cosine) both put their own best hit at exactly 1.0 no matter
    // how good it is, so leading with the maximum of the two systematically
    // promotes whichever arm found the weaker field. Measured on holdout
    // collections: ordering by relevance made hybrid WORSE than its own
    // semantic arm alone — Recall@1 82.8% against 89.7%, MRR 0.914 against
    // 0.948, which is not a defensible state for a fusion whose whole point
    // is to beat both arms.
    //
    // The one exception is a verbatim match, kept as an explicit rule rather
    // than a score nudge: a query that is a filename, a path or an identifier
    // (see textSearch's two guards) and occurs literally in a note is a fact
    // about the string that neither arm's rank can express — Postgres tokenizes
    // `cleanup-n8n-binary.sh` differently in the query and in the document, so
    // FTS structurally cannot rank it first. Verbatim hits sort above the rest
    // and are ordered among themselves by RRF like everything else; `exact` is
    // only ever set for the narrow identifier shapes textSearch tests for, never
    // for a phrase or a question that a note happens to quote.
    //
    // Ties resolve on id, so two hits with identical scores keep a stable
    // order across otherwise identical calls.
    .sort((a, b) =>
      Number(b.exact ?? false) - Number(a.exact ?? false)
      || (LEGACY_FUSION
        ? (b.relevance - a.relevance || b.rrf_score - a.rrf_score)
        : (b.rrf_score - a.rrf_score || b.relevance - a.relevance))
      || a.id.localeCompare(b.id)
    );
}

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

// A short/empty excerpt-derived pattern would ILIKE-match every chunk of its
// note and silently pick chunk 0's heading regardless of where the real
// match is — this floor stops attachSections from ever reporting a heading
// it didn't actually verify against the excerpt. Not measured, just a sanity
// floor: shorter than this and a literal-substring anchor isn't trustworthy.
const MIN_SECTION_MATCH_LEN = 8;

/**
 * Attaches `section` to any result missing one, by finding the excerpt's own
 * position in the note's real content and reading the nearest `#` heading
 * above it (extractHeadings) — not by joining note_chunks (lib/indexing.ts)
 * as this used to. The chunk join named the wrong heading whenever the real
 * one wasn't the FIRST section a chunk absorbed: chunking.ts merges adjacent
 * small sections up to 2000 chars and keeps only the first section's heading
 * for the whole merged chunk, so an excerpt from the second (or third)
 * section inside that chunk got attributed to the first section's title
 * instead of its own — measured live 2026-08-21 on the real vault:
 * sectionCorrect for textSearch hits was 74.7%, i.e. roughly one in four
 * reported headings didn't actually contain the excerpt shown under it.
 * Reading straight from the note's own content and its own heading offsets
 * can't make that mistake — there's no merged-chunk boundary to lose the
 * heading behind. Roadmap item 56's option (a), revised.
 *
 * One batched query across every candidate (same "single round trip over the
 * whole limit-bounded list" family as enrichResults and
 * repairBrokenTableExcerpts), then position lookup + heading walk in JS per
 * candidate — content is already in hand, no further DB round trips needed.
 *
 * Silent no-op per candidate that doesn't resolve — pattern too short to
 * trust (MIN_SECTION_MATCH_LEN), the note was edited concurrently and the
 * excerpt no longer appears verbatim, or it genuinely precedes every heading
 * (the note's untitled lead-in). No section is no worse than before this ran.
 */
async function attachSections(results: SearchResult[], query?: string): Promise<void> {
  const candidates = results
    // Every result, not only the ones with no section yet. The semantic arm
    // pre-fills `section` from its chunk's stored heading, and a chunk that
    // merged several small sections (lib/chunking.ts step 3) keeps only the
    // FIRST one's heading for all of them — so a short multi-section note
    // reports its opening heading for an excerpt taken from anywhere in it.
    // Reading the heading from where the excerpt actually sits cannot make
    // that mistake, so it decides; the stored heading stays as the fallback
    // for a candidate this cannot locate.
    .filter((r) => !LEGACY_EXCERPT || !r.section)
    .map((r) => ({
      r,
      pattern: r.excerpt.split('\n')[0].replace(/^(\.\.\.|…)/, '').replace(/(\.\.\.|…)$/, '').trim(),
    }))
    .filter((c) => c.pattern.length >= MIN_SECTION_MATCH_LEN);
  if (candidates.length === 0) return;

  const rows = await dbQuery<{ id: string; content: string }>(
    'select id, content from notes where id = any($1)',
    [candidates.map((c) => c.r.id)]
  );
  const contentById = new Map(rows.map((r) => [r.id, r.content]));

  for (const { r, pattern } of candidates) {
    const content = contentById.get(r.id);
    if (!content) continue;
    const idx = content.indexOf(pattern);
    if (idx === -1) continue;
    // The heading that belongs to the ANSWER, not to wherever the 300-char
    // window happened to open. An excerpt centred on a matching line routinely
    // starts inside the section above it, and taking the heading from the
    // window's first character then reports that previous section — the
    // excerpt shows the right text under the wrong label, which is worse than
    // no label. Re-find the query-relevant line inside the excerpt's own span
    // and take the heading above THAT.
    const span = content.slice(idx, idx + r.excerpt.length);
    const anchor = query && !LEGACY_EXCERPT ? bestPassageOffset(span, query) : null;
    const target = idx + (anchor?.start ?? 0);
    // Headings come back in document order; each one owns everything after
    // it until the next heading regardless of level, so the last heading at
    // or before the match's offset is always the one it sits under.
    const headings = extractHeadings(content);
    let heading: string | null = null;
    for (const h of headings) {
      if (h.offset > target) break;
      heading = h.text;
    }
    if (heading) r.section = heading;
  }
}

// Question marks across the scripts this can meet. Not an exhaustive list of
// the world's interrogative punctuation (Greek uses `;`, which is far too
// common in code and prose to test on), and deliberately so: a missed mark
// means the note is simply not flagged, which is the safe direction.
const QUESTION_MARK_RE = /[?？؟]\s*$/;

/**
 * Whether a note contains the QUESTION rather than an answer to it.
 *
 * The failure this exists for: an FAQ or seminar note that lists questions
 * verbatim matches a user's question at the strict AND tier with coverage 1 —
 * a true statement about the string and a false one about the note. Measured
 * on holdout collections, a questions-list note outranked the note that
 * actually answered, which is the single behavior this ranking stage is
 * supposed to get right.
 *
 * The test is structural, not lexical, because the discriminator is not
 * "does the note contain questions" — a real FAQ does too, and must keep its
 * position. It is "is any of the matching questions FOLLOWED by an answer":
 *
 *   - a matching question line is an interrogative line sharing at least one
 *     of the query's significant words;
 *   - it counts as answered when the next non-empty line is not itself
 *     interrogative — in a question-and-answer note that next line is the
 *     answer, in a bare list it is the next question;
 *   - the note echoes only when it has at least two matching question lines
 *     and NONE of them is answered.
 *
 * Two guards, both deliberately conservative. Requiring two matching
 * questions keeps a note that poses one rhetorical question and then answers
 * it from ever being flagged. Requiring none to be answered means a single
 * answered question in the note is enough to clear it — a real FAQ never
 * trips this, at the cost of missing a mixed note that answers some of its
 * questions but not the one asked. Missing a flag costs one badly ordered
 * result; a false flag would demote a legitimate answer, which is worse.
 *
 * No language-specific vocabulary and no list-marker conventions: the only
 * inputs are line breaks, a question mark, and the query's own words.
 */
export function questionEcho(content: string, words: string[]): boolean {
  if (words.length === 0) return false;
  const lower = words.map((w) => w.toLowerCase());
  const lines = content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  let matching = 0;
  let answered = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!QUESTION_MARK_RE.test(lines[i])) continue;
    const haystack = lines[i].toLowerCase();
    if (!lower.some((w) => haystack.includes(w))) continue;
    matching++;
    const next = lines[i + 1];
    if (next !== undefined && !QUESTION_MARK_RE.test(next)) answered++;
  }
  return matching >= 2 && answered === 0;
}

// A note is only worth fetching for the echo test when its own snippet shows
// a question mark — the flag can't fire otherwise. Bounded like the table
// repair pass: a query landing in many question-shaped notes must not turn
// one search into N content fetches.
const MAX_ECHO_FETCHES = 8;

/**
 * Sets `question_echo` on the candidates that could possibly carry it, using
 * one batched content fetch (same shape as attachSections). Runs on the
 * candidate list before fusion rather than on the final page, because the
 * whole point is to change which candidates reach the top.
 */
async function attachQuestionEcho(results: SearchResult[], words: string[]): Promise<void> {
  if (words.length === 0) return;
  const candidates = results.filter((r) => /[?？؟]/.test(r.excerpt)).slice(0, MAX_ECHO_FETCHES);
  if (candidates.length === 0) return;
  const rows = await dbQuery<{ id: string; content: string }>(
    'select id, content from notes where id = any($1)',
    [candidates.map((r) => r.id)]
  );
  const contentById = new Map(rows.map((r) => [r.id, r.content]));
  for (const r of candidates) {
    const content = contentById.get(r.id);
    if (content && questionEcho(content, words)) r.question_echo = true;
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
// How many of a query's words to keep when the strict pass finds nothing and
// the loose one is about to answer with whatever filler word is commonest.
// Two, not one: a question often carries a pair that only means something
// together ("cadvisor docker"), and two rare words still exclude far more
// than they admit.
const ANCHOR_COUNT = 2;

/**
 * The rarest words of a query, by document frequency in this vault. Same
 * statistic the coverage weighting uses, asked a different question: not "how
 * much of the query does this hit contain" but "which part of the query was
 * worth searching for at all".
 *
 * A word that appears in no note at all is dropped rather than ranked first —
 * infinite rarity is not evidence, it is a typo or an invented token, and
 * anchoring on it would return nothing while looking authoritative.
 */
async function rareAnchors(words: string[], languages: string[]): Promise<string[]> {
  const unique = [...new Set(words)];
  if (unique.length < 2 || languages.length === 0) return [];
  const langExprs = languages.map((_, i) => `websearch_to_tsquery($${i + 2}::regconfig, unaccent(wt.word))`);
  const tsqExpr = [`websearch_to_tsquery('simple', unaccent(wt.word))`, ...langExprs].join(' || ');
  try {
    const rows = await dbQuery<{ word: string; df: number }>(
      `with word_tsq as (
         select word, (${tsqExpr}) as tsq
         from unnest($1::text[]) as wt(word)
       )
       select wt.word,
         (select count(*)::int from notes n
           where n.deleted_at is null and n.search_vector @@ wt.tsq) as df
       from word_tsq wt
       order by df asc`,
      [unique, ...languages]
    );
    const found = rows.filter((r) => r.df > 0);
    if (found.length === 0) return [];
    // An anchor has to be meaningfully rarer than the query's commonest word,
    // not merely first after sorting. Without this a query containing a typo
    // (dropped above for having no matches at all) would anchor on whichever
    // filler words remained — measured on a synthetic corpus: an invented token
    // plus three common words picked the two commonest as "anchors".
    // Half is a ratio between two words of the SAME query, not a threshold on
    // any absolute count, so it carries across vaults and languages.
    const commonest = found[found.length - 1].df;
    const anchors = found.filter((r) => r.df * 2 < commonest).slice(0, ANCHOR_COUNT);
    // Narrowing to the whole query narrows nothing — the strict pass already
    // ran that exact query and came back empty.
    if (anchors.length === 0 || anchors.length === unique.length) return [];
    return anchors.map((r) => r.word);
  } catch (err) {
    console.warn('[search] anchor selection failed, loose pass stands alone:', err instanceof Error ? err.message : err);
    return [];
  }
}

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

    // unaccent() to match how search_vector itself is built (migration 022)
    // — a word here that still carries its accent would never match a
    // vector whose source text was unaccented before tokenizing.
    const langExprs = languages.map((_, i) => `websearch_to_tsquery($${i + 2}::regconfig, unaccent(wt.word))`);
    const tsqExpr = [`websearch_to_tsquery('simple', unaccent(wt.word))`, ...langExprs].join(' || ');
    const idsParamIndex = languages.length + 2;
    // Words are weighted by how rare they are in THIS vault, not counted
    // equally. Measured live 2026-08-20: "почему нельзя использовать cadvisor"
    // returned notes matching only "почему"/"нельзя" at coverage 0.75, while
    // the one note containing `cadvisor` — the only word in the query that
    // says anything — sat below them. Counting terms equally hands a natural
    // question to whichever of its filler words is most common in the vault.
    //
    // The weight is inverse document frequency, computed against this vault:
    // ln(1 + N/(1+df)). A word in nearly every note contributes almost
    // nothing; a word in three notes dominates. No stopword list is involved
    // — which matters, because a stopword list is a language, and kybase does
    // not get to assume one.
    const rows = await dbQuery<{ id: string; matched_idf: number; total_idf: number }>(
      `with word_tsq as (
         select word, (${tsqExpr}) as tsq
         from unnest($1::text[]) as wt(word)
       ),
       corpus as (select count(*)::float as n from notes where deleted_at is null),
       weighted as (
         select wt.word, wt.tsq,
                ln(1 + (select n from corpus) / (1 + (
                  select count(*) from notes df
                  where df.deleted_at is null and df.search_vector @@ wt.tsq
                ))) as idf
         from word_tsq wt
       )
       select n.id,
         coalesce(sum(w.idf) filter (where n.search_vector @@ w.tsq), 0) as matched_idf,
         (select coalesce(sum(idf), 0) from weighted) as total_idf
       from notes n
       cross join weighted w
       where n.id = any($${idsParamIndex}::uuid[])
       group by n.id`,
      [significantWordList, ...languages, ids]
    );

    const coverage = new Map<string, number>();
    for (const r of rows) {
      const total = Number(r.total_idf);
      coverage.set(r.id, total > 0 ? Number(r.matched_idf) / total : 1);
    }
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

/**
 * `deferSections` is set by hybridSearch. Resolving a heading needs the note's
 * full content, and an arm is called with the CANDIDATE limit, not the user's
 * — so doing it per arm fetched up to thirty notes' bodies twice per search,
 * which on a vault holding 60 KB notes cost more than the embedding call.
 * Hybrid resolves them once, on the page it is actually going to return.
 */
export async function textSearch(query: string, limit = 10, filters?: SearchFilters, allowedIds?: Set<string>, deferSections = false): Promise<SearchResult[]> {
  const fetchLimit = overfetchLimit(limit, filters);
  const scope = await resolveScope(filters, allowedIds);
  const scopeIds = scopeParam(scope);
  const [rows, tagWeights, folderWeights] = await Promise.all([
    dbQuery<FtsRow>('select * from search_notes_fts($1, $2, $3)', [query, fetchLimit, scopeIds]),
    getTagWeights(),
    getFolderWeights(),
  ]);

  let orRows: FtsRow[] = [];
  let anchorRows: FtsRow[] = [];
  const words = significantWords(query);
  // >2 words: with 1-2 words an OR pass is identical to (or looser than
  // pointless versus) the strict AND pass already run.
  if (rows.length < limit && words.length > 2) {
    const seen = new Set(rows.map((r) => r.id));
    const orAll = await dbQuery<FtsRow>(
      'select * from search_notes_fts($1, $2, $3)',
      [words.join(' or '), fetchLimit, scopeIds]
    );
    orRows = orAll.filter((r) => !seen.has(r.id));
  }

  // A natural question that the strict pass could not satisfy: instead of
  // leaving the answer to whichever filler word is commonest here, search the
  // query's rarest words as a strict query of their own. Measured live
  // 2026-08-20: "почему нельзя использовать cadvisor" returned notes matching
  // only "почему"/"нельзя" while the note containing `cadvisor` never entered
  // the candidate set — and the bare word `cadvisor` found it instantly. The
  // agent had learned to strip its own questions down to keywords before
  // asking; that is work the search should be doing.
  //
  // Only when the strict pass found NOTHING. If it found something, the query
  // as typed already matched and narrowing it would be second-guessing a real
  // result.
  if (rows.length === 0 && words.length > 1) {
    const anchors = await rareAnchors(words, await getFtsLanguages());
    if (anchors.length > 0) {
      const seen = new Set(orRows.map((r) => r.id));
      const anchorAll = await dbQuery<FtsRow>('select * from search_notes_fts($1, $2, $3)', [anchors.join(' '), fetchLimit, scopeIds]);
      anchorRows = anchorAll.filter((r) => !seen.has(r.id));
    }
  }

  // The exact/substring pass used to run ONLY when both FTS passes came back
  // empty, which made it unreachable exactly when it matters most: measured
  // live 2026-08-20, searching for the filename `cleanup-n8n-binary.sh`
  // returned five notes matching the single token "n8n" and never reached the
  // one note that literally contains the filename, because those five counted
  // as "results found". An identifier query is not a fallback for failure — it
  // is its own kind of match, and it now runs alongside rather than instead.
  //
  // A hit that contains the query verbatim is also the top of the lexical
  // evidence order — above a strict-AND match, far above a partial OR one —
  // and it is the one thing FTS structurally cannot say. Measured live
  // 2026-08-20, `cleanup-n8n-binary.sh`: the note holding that filename came
  // back at relevance 0.50 (the flat substring constant) UNDER an unrelated
  // note at 0.52 that had matched the single token "n8n" and repeated it
  // often enough to win on ts_rank. The tokenizers disagree by construction —
  // in the note the string sits inside a longer path, so Postgres stores it
  // as one `file` lexeme, while the bare query parses as a `host` — so no
  // amount of FTS tuning reaches it. Only the literal does.
  //
  // Two guards, each earned by a query that broke without it.
  //
  // More than one significant word — because for a single word the claim is
  // worth nothing: `ilike '%n8n%'` matches every note FTS already found, and
  // calling them all verbatim would collapse the ranking into one flat tie.
  //
  // And NO whitespace: the query has to be one contiguous name that the
  // tokenizer took apart, not a phrase the user typed with spaces. This is
  // the whole failure mode — `cleanup-n8n-binary.sh` and `AGENT_RUN_ID_8832a`
  // are single names to a human and several lexemes to Postgres, which is why
  // FTS cannot reassemble them. A phrase with spaces has no such disagreement:
  // every word is its own lexeme on both sides, and FTS ranks it correctly
  // without help (measured 2026-08-20: `PostgreSQL backup and restore` and
  // `Log Rotation einrichten` were already ordered right before any of this).
  //
  // Without the second guard the rule reaches queries it has no business
  // deciding. Counter-test, measured live: for `как добавить новый инструмент
  // MCP`, a note that merely QUOTES that question in a list of test prompts
  // beat the runbook that answers it — despite the runbook's ts_rank being
  // 4.4x higher. Containing a sentence is not the same as being about it;
  // containing a filename essentially is.
  //
  // A name does not have to split into several words to be a name. Measured
  // 2026-08-20: `build.sh`, `x86-64` and an opaque id like `HL6AjEyrn6xOkSgr`
  // all failed the word-count test — "sh", "64" and the id are one significant
  // word or none — and lost the protection that `cleanup-n8n-binary.sh` got,
  // for no reason a user could see. So the question is asked structurally
  // instead: does this look like an identifier?
  //
  //   - a delimiter inside it (`-_.:/\`) — filenames, versions, code symbols;
  //   - or long enough to be opaque AND mixing letters with digits — the shape
  //     of a generated id, which no prose word has.
  //
  // Both restricted to printable ASCII, and that is a deliberate, narrow
  // limitation rather than an oversight: `какой-то` and `well-known` carry a
  // delimiter too, and promoting an ordinary hyphenated word would hand the
  // top band to every note that happens to use it. Identifiers are ASCII in
  // practice; the multi-word rule above stays language-neutral and is what
  // covers everything else.
  const q = query.trim();
  const asciiToken = /^[\x21-\x7E]+$/.test(q);
  const structured = asciiToken && q.length >= 4 && /[-_.:/\\]/.test(q);
  const opaque = asciiToken && q.length >= 8 && /[0-9]/.test(q) && /[A-Za-z]/.test(q);
  const verbatim = !/\s/.test(q) && (words.length > 1 || structured || opaque);
  const exactHits = (await substringSearch(query, limit, filters, scope))
    .map((r) => (verbatim ? { ...r, exact: true } : r));
  if (rows.length === 0 && orRows.length === 0 && anchorRows.length === 0) {
    return enrichResults(applyExactBand(exactHits));
  }
  const exactIds = new Set(verbatim ? exactHits.map((r) => r.id) : []);

  // n.rank is Postgres's actual ts_rank for this query — a genuine
  // relevance signal, unlike the positional score substringSearch falls
  // back to below (there is no rank for a plain substring match). Scored
  // relative to this query's own best rank, not a fixed anchor — same
  // reasoning as semanticSearch's cosine (see there): ts_rank is a
  // per-query, dimensionless value, there is no absolute number that means
  // the same thing across two different queries. Both RPC calls already
  // order by rank desc, so each list's own head is that list's best.
  // Tag and folder weight both multiply the raw rank, before normalization —
  // never relevance itself. relevance is a ratio against this response's own
  // best hit, so multiplying it post-hoc would push a hit above 1.0 and break
  // the one meaning it has. (It can no longer shift a confidence band — the
  // ladder stopped reading relevance at all — but the ordering ratio still
  // has to stay a ratio.)
  // Multiplying the raw score instead keeps relevance exactly what it's
  // always been ("how this compares to the best hit in this response") —
  // weight just gets a say in which hit that is. At the default empty
  // weights maps this is `n.rank * 1 * 1` for every row, i.e. unchanged.
  const weightedRank = (n: FtsRow) => n.rank * weightForTags(n.tags, tagWeights) * weightForFolder(n.folder_id, folderWeights);
  const best = Math.max(0, ...rows.map(weightedRank), ...orRows.map(weightedRank), ...anchorRows.map(weightedRank));
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
  const coverageMap = await computeTextCoverage(words, [...orRows, ...anchorRows].map((n) => n.id));
  const toResult = (n: FtsRow, tier: 'and' | 'or'): SearchResult => {
    // Order matters: coverage multiplies the ALREADY-normalized rank, never
    // the other way around. Applying it before dividing by the set's max
    // would cancel out whenever every hit in the set shares the same
    // coverage (the common case for an OR-cascade result: everything
    // matched on one word out of N) — the multiplier would divide by
    // itself and the top hit would land back at 1.0, silently undoing the
    // whole point (2026-08-14 search-relevance overhaul, step 3b).
    const normalized = best > 0 ? weightedRank(n) / best : 0;
    const exact = exactIds.has(n.id);
    // A note containing the query verbatim contains every word of it by
    // definition, so a computed coverage below 1 here would be two reported
    // facts contradicting each other.
    const coverage = exact || tier === 'and' ? 1 : (coverageMap?.get(n.id) ?? 1);
    const relevance = normalized * coverage;
    // `tier` and `coverage` travel as observed facts — which cascade level
    // matched and how much of the query it contained. They used to be folded
    // into a verdict; the verdict is gone, the facts stay.
    return {
      id:      n.id,
      title:   n.title,
      excerpt: n.headline.replace(/<\/?b>/g, ''),
      tags:    n.tags,
      score:   n.rank,
      relevance,
      text_tier: tier,
      coverage,
      exact,
    };
  };
  // FTS rows win a duplicate: they carry a real ts_rank, while a substring hit
  // only knows where in the document the literal appeared. The literal itself
  // is not discarded with the row — `exact` above carries it onto the FTS row,
  // so a note found by both keeps its real rank AND the fact that the whole
  // query is in there.
  // Anchor hits are reported as the loose tier they are: they matched part of
  // the query, not the query. Their coverage — now weighted by rarity — is
  // what argues for them, and it argues honestly.
  const ftsResults = [
    ...rows.map((n) => toResult(n, 'and')),
    ...orRows.map((n) => toResult(n, 'or')),
    ...anchorRows.map((n) => toResult(n, 'or')),
  ];
  const ftsIds = new Set(ftsResults.map((r) => r.id));
  const results = applyExactBand([...ftsResults, ...exactHits.filter((r) => !ftsIds.has(r.id))]);
  // Flagged BEFORE the sort below, and before applyFilters' slice: the flag
  // has to be on the candidates the sort is about to order, not only on the
  // page that survived it.
  // Always computed, never conditional on the ranking switch: the flag is a
  // reported fact an agent can act on, and it costs one batched fetch only
  // when a candidate's own snippet contains a question mark.
  await attachQuestionEcho(results, words);
  results
    // Relevance alone: the SQL returns 'and' rows before 'or' rows by raw
    // rank, but coverage can push an 'or' hit above an 'and' one, and the
    // caller reads top to bottom.
    // Echo demotion applies here too, not only in fusion: `type: text` is a
    // caller-visible mode, and the candidate order this produces is what
    // fusion reads ranks from.
    .sort((a, b) =>
      Number(b.exact ?? false) - Number(a.exact ?? false)
      || (DEMOTE_QUESTION_ECHO ? Number(a.question_echo ?? false) - Number(b.question_echo ?? false) : 0)
      || b.relevance - a.relevance);
  const filtered = await applyFilters(results, limit, filters, scope);
  await repairBrokenTableExcerpts(filtered);
  if (!deferSections) await attachSections(filtered, query);
  return enrichResults(filtered);
}

// Verbatim hits take the upper half of the relevance scale, everything else
// the lower half. Only ever applied when something actually matched verbatim —
// for the overwhelmingly common query that matches nothing literally, this is
// the identity function and relevance is exactly what it has always been.
//
// The split exists so "verbatim outranks partial" is true of the NUMBER and
// not only of the sort order: a caller that re-sorts by relevance, or reads it
// to decide how many hits to open, reaches the same conclusion this function
// does. The first attempt at this simply wrote relevance = 1 on every exact
// hit, which ordered them correctly but flattened three genuinely different
// notes into one tie — the same mistake as the confidence label this project
// already removed, of promoting one strong signal to an absolute verdict.
// Within each half the existing scores keep their proportions, so those three
// still read 1.00 / 0.92 / 0.92 by their own ts_rank.
const EXACT_BAND = 0.5;

function applyExactBand<T extends { relevance: number; exact?: boolean }>(results: T[]): T[] {
  const exactScores = results.filter((r) => r.exact).map((r) => r.relevance);
  if (exactScores.length === 0) return results;
  // Guarded: an exact hit whose own rank came out 0 would otherwise divide by
  // zero. It still belongs above every partial match, so it lands on the floor
  // of the upper band rather than being dropped through it.
  const top = Math.max(...exactScores) || 1;
  return results.map((r) => ({
    ...r,
    relevance: r.exact
      ? EXACT_BAND + (1 - EXACT_BAND) * Math.min(1, r.relevance / top)
      : EXACT_BAND * r.relevance,
  }));
}

/** Title matches rank above content matches (queried separately, merged in order). */
async function substringSearch(
  query: string,
  limit: number,
  filters?: SearchFilters,
  allowedIds?: Set<string>
): Promise<SearchResult[]> {
  const cols = 'id, title, content, tags';
  const escapedQuery = escapeLike(query);
  const fetchLimit = overfetchLimit(limit, filters);
  // Without an explicit order, LIMIT over a plain seq/index scan has no
  // guaranteed row order — `score = 1/(i+1)` below would then depend on
  // whatever order Postgres happened to return, silently reshuffling
  // RRF's rank contribution for these hits between otherwise-identical
  // calls. `id` alone is enough for a stable order; it carries no ranking
  // claim of its own; ordering by anything else here (title length,
  // recency, ...) would.
  const [byTitle, byContent] = await Promise.all([
    dbQuery<NoteRow>(`select ${cols} from notes where title ilike $1 and deleted_at is null order by id asc limit $2`, [`%${escapedQuery}%`, fetchLimit]),
    dbQuery<NoteRow>(`select ${cols} from notes where content ilike $1 and deleted_at is null order by id asc limit $2`, [`%${escapedQuery}%`, fetchLimit]),
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
      text_tier: 'substring' as const,
    };
  });
  return applyFilters(results, limit, filters, allowedIds);
}

/**
 * How many notes match `query`, without paying for ranking, excerpts, or a
 * `limit` cutoff — roadmap item 44 ("nothing can be counted"): judging a
 * defect's real scope, or a lexeme's real drop rate, needs a total, and
 * search_notes only ever reports how many it returned, never how many exist.
 *
 * Two modes, each one honest, unambiguous definition — deliberately not a
 * single "did ANY tier match" number, which would silently answer a
 * different question depending on which cascade tier happened to fire:
 *  - 'fts': the same tsquery search_notes_fts itself builds (fts_normalize +
 *    per-language websearch_to_tsquery, OR'd — migration 023) — exactly
 *    textSearch's strict 'and' tier's own match set, counted instead of
 *    ranked.
 *  - 'substring': the same `ilike '%query%'` substringSearch already runs,
 *    counted instead of fetched — literal containment, no tokenizer involved.
 *
 * No semantic mode: nearest-neighbor search has no natural "matched" set
 * without a similarity floor, and getMinSimilarity() is null by default (see
 * effectiveSemanticThreshold) — "how many matched" would silently mean "the
 * whole vault" for the common unconfigured case, a number worse than none.
 *
 * No SearchFilters param (yet): every roadmap use case behind item 44 was a
 * vault-wide question ("how many notes have X"), not a scoped one — add
 * filtering if a real caller needs it rather than guessing the shape now.
 */
export async function countNotes(query: string, mode: 'fts' | 'substring'): Promise<number> {
  if (mode === 'substring') {
    const escapedQuery = escapeLike(query);
    const rows = await dbQuery<{ count: number }>(
      'select count(*)::int as count from notes where deleted_at is null and (title ilike $1 or content ilike $1)',
      [`%${escapedQuery}%`]
    );
    return rows[0]?.count ?? 0;
  }
  const languages = await getFtsLanguages();
  const langExprs = languages.map((_, i) => `websearch_to_tsquery($${i + 2}::regconfig, fts_normalize($1))`);
  const tsqExpr = [`websearch_to_tsquery('simple', fts_normalize($1))`, ...langExprs].join(' || ');
  const rows = await dbQuery<{ count: number }>(
    `select count(*)::int as count from notes where deleted_at is null and search_vector @@ (${tsqExpr})`,
    [query, ...languages]
  );
  return rows[0]?.count ?? 0;
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
 *  1. Recall — match_chunks itself is always called with a hardcoded 0
 *     (migration 002's own chunk-level floor is bypassed entirely, see the
 *     RPC call below); getMinSimilarity() is applied AFTER the RPC returns,
 *     as a low, permissive junk-gate filter in JS. Everything that survives
 *     it is merely a *candidate*.
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
export async function semanticSearch(query: string, limit = 10, filters?: SearchFilters, allowedIds?: Set<string>): Promise<SearchResult[]> {
  return (await semanticRun(query, limit, filters, allowedIds)).results;
}

/**
 * semanticSearch's body, plus the best raw similarity it saw.
 *
 * That number used to be fetched by a SECOND call — lib/mcp-server.ts ran
 * bestSemanticScore(q) after the search to report it, which re-embedded the
 * same query against a different scope (no filters) and gave the provider a
 * fresh chance to fail after the search had already succeeded. Reported from
 * the run that produced the results instead: same embedding, same filters,
 * same index generation, no extra round trip.
 */
async function semanticRun(query: string, limit = 10, filters?: SearchFilters, allowedIds?: Set<string>, deferSections = false): Promise<{ results: SearchResult[]; best: number | null }> {
  const [embedding, floor, scope, modelKey] = await Promise.all([
    getEmbedding(query, 'query'),
    getMinSimilarity(),
    resolveScope(filters, allowedIds),
    getEmbeddingConfig().then(embeddingModelKey),
  ]);
  const fetchLimit = overfetchLimit(limit, filters);
  const vec = toVector(embedding);
  // Scope and model generation are both applied inside match_chunks, before
  // it ranks and truncates (migration 028). Scope, because an out-of-folder
  // hit used to set `best` below and take in-scope notes down with it.
  // Generation, because a query embedded by the current model is not
  // comparable to document vectors left behind by a previous one — during a
  // model change those rows are excluded rather than mixed in, and the text
  // arm carries hybrid search until the reindex catches up.
  //
  // No cutoff unless the owner configured one (lib/embeddings.ts explains at
  // length why the shipped per-model numbers were withdrawn).
  const rawData: Record<string, unknown>[] = await dbQuery(
    'select * from match_chunks($1::vector, $2, 0, $3, $4)',
    [vec, fetchLimit, scopeParam(scope), modelKey]
  );
  const data = floor === null ? rawData : rawData.filter((n) => (n.similarity as number) >= floor);

  // match_chunks orders by similarity desc, so the first row is this
  // query's best hit — the reference point relevance is measured against.
  const best = (data[0]?.similarity as number | undefined) ?? 0;

  const candidates = SEMANTIC_TRIM && best > 0
    ? data.filter((n) => (n.similarity as number) >= SEMANTIC_TRIM_RATIO * best)
    : data;

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
    // Drop the chunk's own `# Heading` line — it travels as `section` instead.
    const excerpt = makeExcerpt(stripLeadingHeading(n.chunk_content as string), query);
    const relevance = best > 0 ? (n.similarity as number) / best : 0;
    return {
      id:      n.id as string,
      title:   n.title as string,
      excerpt,
      tags:    n.tags as string[],
      score:   n.similarity as number,
      relevance,
      // The chunker already splits notes at markdown headings and stores each
      // chunk's own (lib/chunking.ts, note_chunks.heading), so the section a
      // semantic hit landed in costs nothing to report. It used to be glued
      // onto the front of the excerpt as "[Heading] …" — readable, but an
      // agent had to parse it back out of prose to use it, and get_note's
      // `section` argument takes exactly this string. A field, not a prefix.
      ...(heading ? { section: heading } : {}),
    };
  });
  const filtered = await applyFilters(results, limit, filters, scope);

  // Coverage on a semantic hit answers the question the cosine cannot: does
  // the thing you asked about actually APPEAR in this note. Measured
  // 2026-08-20 on a 16-query near-domain battery, half the convincing false
  // positives were of exactly one shape — a query naming a technology the
  // vault has never used, answered with the vault's nearest neighbour at a
  // healthy similarity and no mention of that technology anywhere in it. The
  // cosine ranges of true answers and near-domain misses overlap completely
  // (0.556–0.760 against 0.585–0.684 on that run), so no threshold separates
  // them — but "coverage: 0" separates them by stating a fact.
  //
  // A fact, and deliberately nothing more: nothing here rejects a hit for
  // covering none of the query. Some correct answers legitimately share no
  // vocabulary with the question, which is the entire point of searching by
  // meaning. The caller reads the number and the excerpt and decides.
  const words = significantWords(query);
  if (words.length > 0 && filtered.length > 0) {
    const coverageMap = await computeTextCoverage(words, filtered.map((r) => r.id));
    if (coverageMap) {
      for (const r of filtered) {
        const c = coverageMap.get(r.id);
        if (c !== undefined) r.coverage = c;
      }
    }
  }
  // The chunk's stored heading is only right when the chunk covers exactly
  // one section. A short multi-section note merges into a single chunk that
  // keeps the FIRST heading (lib/chunking.ts step 3), so every excerpt taken
  // from it is labelled with the note's opening heading. Re-deriving the
  // heading from where the excerpt actually sits fixes that, and it has to
  // happen here rather than only in textSearch: a hybrid result usually
  // shows the semantic arm's excerpt, so a section attached only on the text
  // side never reaches it.
  if (!deferSections) await attachSections(filtered, query);

  // `best` is the best similarity BEFORE the display limit and before the
  // relative trim, so it still answers "did anything come close" even when
  // the returned list is empty. Null when the index had nothing to compare
  // at all, which is a different statement from a low number.
  return { results: await enrichResults(filtered), best: data.length > 0 ? best : null };
}

/**
 * Best chunk similarity ignoring the configured floor (call match_chunks with
 * min_similarity=0). Lets a caller distinguish "nothing came close" from
 * "just under the threshold" when a real semantic/hybrid search came back
 * empty — a bare [] can't tell those apart.
 */
export async function bestSemanticScore(query: string, filters?: SearchFilters): Promise<number | null> {
  const [embedding, scope, modelKey] = await Promise.all([
    getEmbedding(query, 'query'),
    resolveScope(filters, undefined),
    getEmbeddingConfig().then(embeddingModelKey),
  ]);
  const [row] = await dbQuery<{ similarity: number }>(
    'select similarity from match_chunks($1::vector, 1, 0, $2, $3)',
    [toVector(embedding), scopeParam(scope), modelKey]
  );
  return row?.similarity ?? null;
}

/** An arm that could not run, and why — surfaced rather than silently dropped. */
export type ArmFailure = { arm: 'text' | 'semantic'; reason: string };

/** Every arm failed. A caller must be able to tell this from an empty result. */
export class SearchUnavailableError extends Error {
  constructor(public readonly failures: ArmFailure[]) {
    super(`Search unavailable: ${failures.map((f) => `${f.arm} (${f.reason})`).join(', ')}`);
  }
}

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function hybridSearch(query: string, limit = 10, filters?: SearchFilters): Promise<HybridSearchResult[]> {
  return (await hybridRun(query, limit, filters)).results;
}

/**
 * hybridSearch plus what happened while producing it.
 *
 * allSettled, not all: the arms are independent, and a hybrid search whose
 * embedding provider is down should degrade to the text arm rather than
 * failing outright — a stopped Ollama container used to take the whole
 * hybrid search with it, including the FTS half that was working fine. Both
 * arms failing is a genuine outage and throws, because returning [] there
 * would tell the caller the vault holds nothing.
 */
async function hybridRun(query: string, limit = 10, filters?: SearchFilters): Promise<{
  results: HybridSearchResult[]; bestSemantic: number | null; failures: ArmFailure[]; armsUsed: ('text' | 'semantic')[];
}> {
  const candidateLimit = Math.min(RRF_CANDIDATE_CAP, Math.max(RRF_CANDIDATE_FLOOR, limit * RRF_CANDIDATE_FACTOR));
  // Resolved once here rather than separately inside each arm — both would
  // otherwise independently call filteredNoteIds() for the same filters and
  // get the same set, a redundant query on every filtered hybrid search.
  const allowedIds = hasFilters(filters) ? await filteredNoteIds(filters) : undefined;
  const [textOutcome, semanticOutcome] = await Promise.allSettled([
    textSearch(query, candidateLimit, filters, allowedIds, true),
    semanticRun(query, candidateLimit, filters, allowedIds, true),
  ]);

  const failures: ArmFailure[] = [];
  const lists: NamedResultList[] = [];
  const armsUsed: ('text' | 'semantic')[] = [];

  if (textOutcome.status === 'fulfilled') {
    lists.push({ field: 'text_score', results: textOutcome.value });
    armsUsed.push('text');
  } else {
    failures.push({ arm: 'text', reason: reasonOf(textOutcome.reason) });
  }

  let bestSemantic: number | null = null;
  if (semanticOutcome.status === 'fulfilled') {
    lists.push({ field: 'semantic_score', results: semanticOutcome.value.results });
    bestSemantic = semanticOutcome.value.best;
    armsUsed.push('semantic');
  } else {
    failures.push({ arm: 'semantic', reason: reasonOf(semanticOutcome.reason) });
  }

  if (lists.length === 0) throw new SearchUnavailableError(failures);

  const merged = rrfMerge(lists).slice(0, limit);
  // Once, on the returned page — see textSearch's deferSections note.
  await attachSections(merged as unknown as SearchResult[], query);
  return { results: merged, bestSemantic, failures, armsUsed };
}

export type SearchMode = 'hybrid' | 'text' | 'semantic';

export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  offset?: number;
  filters?: SearchFilters;
  explain?: boolean;
}

/**
 * What the run itself observed. Every field is a fact about THIS execution —
 * same filters, same model, same index generation as the results above it.
 *
 * Exists so an empty result can be read correctly. Three different things
 * produce zero hits and a caller has to tell them apart: nothing matched
 * (`index.pending` 0, both arms used), the answer is not indexed yet
 * (`index.pending` > 0, or `index.stale_generation` > 0 during a model
 * change), or retrieval itself is degraded (`arms_unavailable` non-empty).
 * No confidence percentage: none of these numbers has been calibrated into
 * one, and inventing one is the mistake this project already removed once.
 */
export type SearchDiagnostics = {
  mode: SearchMode;
  arms_used: ('text' | 'semantic')[];
  arms_unavailable: ArmFailure[];
  /** Best raw similarity this query reached, from the run that produced the results. */
  best_semantic_score: number | null;
  semantic_threshold: number | null;
  embedding_model: string;
  index: {
    total: number;
    pending: number;
    /** Chunks whose vectors came from a different model generation — excluded from semantic results until reindexed. */
    stale_generation: number;
  };
  /** Whether folder/tag/date filters narrowed the searched set. */
  scoped: boolean;
  took_ms: number;
};

async function indexHealth(modelKey: string): Promise<SearchDiagnostics['index']> {
  const [notes] = await dbQuery<{ total: number; pending: number }>(
    `select count(*)::int as total, (count(*) filter (where embedding_pending))::int as pending
     from notes where deleted_at is null`
  );
  const [chunks] = await dbQuery<{ stale: number }>(
    `select count(*)::int as stale from note_chunks c
     join notes n on n.id = c.note_id
     where n.deleted_at is null and c.embedding_model is not null and c.embedding_model <> $1`,
    [modelKey]
  );
  return { total: notes?.total ?? 0, pending: notes?.pending ?? 0, stale_generation: chunks?.stale ?? 0 };
}

/**
 * The one search entry point that UI, REST and MCP all go through, with the
 * diagnostics of the same execution attached.
 *
 * MCP used to call textSearch/semanticSearch/hybridSearch directly and then
 * assemble its own diagnostics from separate queries — including a second
 * embedding of the same query, run unfiltered, which could report a best
 * score from outside the folder the caller had asked about (and fail after
 * the search had already succeeded). One run, one set of numbers.
 */
export async function searchWithDiagnostics(
  query: string,
  options: SearchOptions = {}
): Promise<{ results: SearchResult[]; diagnostics: SearchDiagnostics }> {
  const { mode = 'hybrid', limit = 10, offset = 0, filters, explain = false } = options;
  const started = Date.now();
  const fetchLimit = limit + offset;

  const modelKey = embeddingModelKey(await getEmbeddingConfig());
  let raw: (SearchResult | HybridSearchResult)[] = [];
  let bestSemantic: number | null = null;
  let armsUsed: ('text' | 'semantic')[] = [];
  let failures: ArmFailure[] = [];

  if (mode === 'text') {
    raw = await textSearch(query, fetchLimit, filters);
    armsUsed = ['text'];
  } else if (mode === 'semantic') {
    const run = await semanticRun(query, fetchLimit, filters);
    raw = run.results;
    bestSemantic = run.best;
    armsUsed = ['semantic'];
  } else {
    const run = await hybridRun(query, fetchLimit, filters);
    raw = run.results;
    bestSemantic = run.bestSemantic;
    armsUsed = run.armsUsed;
    failures = run.failures;
  }

  const [threshold, index] = await Promise.all([
    mode === 'text' ? Promise.resolve(null) : effectiveSemanticThreshold(),
    indexHealth(modelKey),
  ]);

  return {
    results: project(raw, limit, offset, explain),
    diagnostics: {
      mode,
      arms_used: armsUsed,
      arms_unavailable: failures,
      best_semantic_score: bestSemantic,
      semantic_threshold: threshold,
      embedding_model: modelKey,
      index,
      scoped: hasFilters(filters),
      took_ms: Date.now() - started,
    },
  };
}

/**
 * Universal search entry point. Thin facade dispatching to textSearch,
 * semanticSearch, or hybridSearch based on mode (default: 'hybrid').
 *
 * Guardrails:
 * - Default mode is ALWAYS 'hybrid' (no word-count auto heuristics).
 * - Preserves functional agent signals (section, matched_by, coverage, exact).
 * - When explain is false/omitted, strips raw internal floating-point scores
 *   (text_score, semantic_score, rrf_score).
 * - Supports offset-based pagination.
 */
export async function universalSearch(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const {
    mode = 'hybrid',
    limit = 10,
    offset = 0,
    filters,
    explain = false,
  } = options;

  const fetchLimit = limit + offset;
  let rawResults: (SearchResult | HybridSearchResult)[] = [];

  if (mode === 'text') {
    rawResults = await textSearch(query, fetchLimit, filters);
  } else if (mode === 'semantic') {
    rawResults = await semanticSearch(query, fetchLimit, filters);
  } else {
    rawResults = await hybridSearch(query, fetchLimit, filters);
  }

  return project(rawResults, limit, offset, explain);
}

/** Offset slice + the strict output whitelist, shared by both entry points. */
function project(
  rawResults: (SearchResult | HybridSearchResult)[],
  limit: number,
  offset: number,
  explain: boolean
): SearchResult[] {
  const sliced = offset > 0
    ? rawResults.slice(offset, offset + limit)
    : rawResults.slice(0, limit);

  return sliced.map((r): SearchResult => {
    const isHybrid = 'rrf_score' in r;
    const rawScore = isHybrid ? r.rrf_score : r.score;

    const base: SearchResult = {
      id: r.id,
      title: r.title,
      excerpt: r.excerpt,
      tags: r.tags,
      score: explain ? rawScore : 0,
      relevance: r.relevance,
    };

    if (r.matched_by !== undefined) base.matched_by = r.matched_by;
    if (r.text_tier !== undefined) base.text_tier = r.text_tier;
    if (r.exact !== undefined) base.exact = r.exact;
    if (r.coverage !== undefined) base.coverage = r.coverage;
    if (r.section !== undefined) base.section = r.section;
    if (r.content_length !== undefined) base.content_length = r.content_length;
    if (r.created_at !== undefined) base.created_at = r.created_at;
    if (r.question_echo !== undefined) base.question_echo = r.question_echo;
    if (r.index_pending !== undefined) base.index_pending = r.index_pending;

    if (explain) {
      if (r.text_score !== undefined) base.text_score = r.text_score;
      if (r.semantic_score !== undefined) base.semantic_score = r.semantic_score;
    }

    return base;
  });
}

