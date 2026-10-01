import type { HybridSearchResult, NamedResultList, SearchResult } from './types';
import { DEMOTE_QUESTION_ECHO, FUSION, RRF_K, TEXT_COVERAGE_WEIGHT, type Fusion } from './config';
import { arbiterLead } from './arbiter';

/**
 * Merges the arms' ranked lists into one, deduplicated by id and ordered per
 * `fusion` (see KYBASE_SEARCH_FUSION). Each arm's own score is kept under its
 * field name; `rrf_score` is a rank-fusion diagnostic, not a relevance.
 */
export function rrfMerge(lists: NamedResultList[], fusion: Fusion = FUSION): HybridSearchResult[] {
  const lead = fusion === 'arbiter' ? arbiterLead(lists) : undefined;
  const scoreMap = new Map<string, {
    result: SearchResult; rrfScore: number; relevance: number;
    extra: Partial<SearchResult>; textTier: SearchResult['text_tier'];
    exact: boolean | undefined; textCoverage: number | undefined;
    questionEcho: boolean | undefined;
  }>();

  // An arm may list the same note twice; the first (best) occurrence keeps the
  // excerpt, a later one only adds to rrfScore and can raise relevance.
  for (const { field, results } of lists) {
    results.forEach((item, rank) => {
      const weight = field !== 'text_score' ? 1
        : (DEMOTE_QUESTION_ECHO && item.question_echo) ? 0
        : TEXT_COVERAGE_WEIGHT ? (item.coverage ?? 1)
        : 1;
      const rrfScore = weight / (RRF_K + rank + 1);
      const existing = scoreMap.get(item.id);
      if (existing) {
        existing.rrfScore += rrfScore;
        // Arms corroborate rather than add up: relevance is the best arm's.
        existing.relevance = Math.max(existing.relevance, item.relevance);
        existing.extra[field] = item.score;
        if (field === 'text_score') {
          // Facts about the note's text; kept outside `result`, which may be
          // swapped to the semantic arm's object below.
          existing.textTier = item.text_tier;
          existing.exact = item.exact;
          existing.textCoverage = item.coverage;
          existing.questionEcho = item.question_echo;
        }
        // Show the passage of whichever arm matched this note better.
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
    // A verbatim identifier match sorts first in every mode: Postgres tokenizes
    // a filename or path differently in the query and the note, so no rank can
    // express it. Ties resolve on id for a stable order.
    .sort((a, b) =>
      Number(b.exact ?? false) - Number(a.exact ?? false)
      || Number(b.id === lead) - Number(a.id === lead)
      || (fusion === 'rrf'
        ? (b.rrf_score - a.rrf_score || b.relevance - a.relevance)
        : (b.relevance - a.relevance || b.rrf_score - a.rrf_score))
      || a.id.localeCompare(b.id)
    );
}
