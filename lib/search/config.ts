// Search settings read from the environment once, at module load.
//
// KYBASE_SEARCH_FUSION — how hybrid orders the two arms' hits:
//   arbiter (default) relevance first, the top slot decided by arbiterLead;
//   legacy relevance first, RRF as tiebreak; rrf reciprocal rank fusion first.
// KYBASE_ARBITER_SEM_THRESHOLD — raw cosine the semantic top hit needs to take
//   the top slot from a non-verbatim text match. Model-dependent; default 0.40.
// KYBASE_SEARCH_SEMANTIC_TRIM=off — keep semantic candidates under 0.75x the
//   query's best hit instead of dropping them.
// KYBASE_SEARCH_CANDIDATES — per-arm candidate floor (default 30).
// KYBASE_SEARCH_EXCERPT=legacy — previous excerpt placement; presentation only.
// KYBASE_SEARCH_TEXT_WEIGHT=coverage, KYBASE_SEARCH_QUESTION_ECHO=demote —
//   alternative rankings, off by default.

export const RRF_K = 60;

export type Fusion = 'arbiter' | 'legacy' | 'rrf';

export const FUSION: Fusion = process.env.KYBASE_SEARCH_FUSION === 'legacy' ? 'legacy'
  : process.env.KYBASE_SEARCH_FUSION === 'rrf' ? 'rrf'
  : 'arbiter';

export const ARBITER_SEM_THRESHOLD = (() => {
  const n = Number(process.env.KYBASE_ARBITER_SEM_THRESHOLD);
  return process.env.KYBASE_ARBITER_SEM_THRESHOLD && Number.isFinite(n) ? n : 0.40;
})();

export const SEMANTIC_TRIM = process.env.KYBASE_SEARCH_SEMANTIC_TRIM !== 'off';

export const SEMANTIC_TRIM_RATIO = 0.75;

export const LEGACY_EXCERPT = process.env.KYBASE_SEARCH_EXCERPT === 'legacy';

export const TEXT_COVERAGE_WEIGHT = process.env.KYBASE_SEARCH_TEXT_WEIGHT === 'coverage';

export const DEMOTE_QUESTION_ECHO = process.env.KYBASE_SEARCH_QUESTION_ECHO === 'demote';

// Each arm fetches a wider pool than the page so a note ranked just outside
// `limit` in both arms can still win after fusion. The floor keeps small
// pages from starving retrieval.
export const RRF_CANDIDATE_FACTOR = 3;

export const RRF_CANDIDATE_FLOOR = Number(process.env.KYBASE_SEARCH_CANDIDATES ?? 30);

export const RRF_CANDIDATE_CAP = 100;
