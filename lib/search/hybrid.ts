import type { ArmFailure, HybridSearchResult, NamedResultList, SearchFilters } from './types';
import { RRF_CANDIDATE_CAP, RRF_CANDIDATE_FACTOR, RRF_CANDIDATE_FLOOR } from './config';
import { filteredNoteIds, hasFilters } from './results';
import { attachSections } from './excerpt';
import { textSearch } from './text';
import { semanticRun } from './semantic';
import { rrfMerge } from './fusion';
import { applyRerank } from './reranking';

/** Every arm failed. A caller must be able to tell this from an empty result. */
export class SearchUnavailableError extends Error {
  constructor(public readonly failures: ArmFailure[]) {
    super(`Search unavailable: ${failures.map((f) => `${f.arm} (${f.reason})`).join(', ')}`);
  }
}

export const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function hybridSearch(query: string, limit = 10, filters?: SearchFilters): Promise<HybridSearchResult[]> {
  return (await hybridRun(query, limit, filters)).results;
}

/**
 * hybridSearch plus what happened while producing it. The arms are settled
 * independently: one failing degrades to the other; both failing throws.
 */
export async function hybridRun(query: string, limit = 10, filters?: SearchFilters, rerank = true): Promise<{
  results: HybridSearchResult[]; bestSemantic: number | null; failures: ArmFailure[];
  armsUsed: ('text' | 'semantic')[]; reranked: boolean; hasMore: boolean;
}> {
  const candidateLimit = Math.min(RRF_CANDIDATE_CAP, Math.max(RRF_CANDIDATE_FLOOR, limit * RRF_CANDIDATE_FACTOR));
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

  let fused = rrfMerge(lists);
  const queryVector = semanticOutcome.status === 'fulfilled' ? semanticOutcome.value.queryVector : undefined;
  const rr = rerank ? await applyRerank(query, fused, queryVector) : { results: fused, reranked: false };
  fused = rr.results;
  const merged = fused.slice(0, limit);
  // Once, on the returned page — see textSearch's deferSections note.
  await attachSections(merged, query);
  return { results: merged, bestSemantic, failures, armsUsed, reranked: rr.reranked, hasMore: fused.length > limit };
}
