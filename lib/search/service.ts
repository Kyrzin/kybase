import { query as dbQuery } from '../db';
import { embeddingModelKey } from '../embeddings';
import { getEmbeddingConfig, getRerankMinScore } from '../settings';
import { rerankConfig, rerankAvailable } from '../rerank';
import type { ArmFailure, HybridSearchResult, SearchFilters, SearchResult } from './types';
import { attachExcerptOffsets, hasFilters } from './results';
import { textSearch } from './text';
import { effectiveSemanticThreshold, semanticRun, semanticSearch } from './semantic';
import { hybridRun, hybridSearch } from './hybrid';

export type SearchMode = 'hybrid' | 'text' | 'semantic';

export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  offset?: number;
  filters?: SearchFilters;
  explain?: boolean;
  /** false skips reranking for this query; it can only decline it, never enable it. */
  rerank?: boolean;
}

/**
 * Facts about this execution, so an empty result can be read: nothing
 * matched, the index is still catching up, or an arm was unavailable.
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
  /** Hits exist past this page. A flag, not a count: the candidate pool is capped. */
  has_more: boolean;
  /** A cross-encoder decided this page's order. false also when it did not answer. */
  reranked: boolean;
  /** Distinguishes no service, switched off, skipped for this query, and not answering. */
  rerank: { available: boolean; enabled: boolean; skipped: boolean; min_score: number | null };
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

/** The search entry point for UI, REST and MCP, with this run's diagnostics. */
export async function searchWithDiagnostics(
  query: string,
  options: SearchOptions = {}
): Promise<{ results: SearchResult[]; diagnostics: SearchDiagnostics }> {
  const { mode = 'hybrid', limit = 10, offset = 0, filters, explain = false, rerank = true } = options;
  const started = Date.now();
  const fetchLimit = limit + offset;

  const modelKey = embeddingModelKey(await getEmbeddingConfig());
  let raw: (SearchResult | HybridSearchResult)[] = [];
  let bestSemantic: number | null = null;
  let armsUsed: ('text' | 'semantic')[] = [];
  let failures: ArmFailure[] = [];
  let reranked = false;

  // One row past the page tells whether there is more; project() drops it.
  let hasMore = false;

  if (mode === 'text') {
    raw = await textSearch(query, fetchLimit + 1, filters);
    hasMore = raw.length > fetchLimit;
    armsUsed = ['text'];
  } else if (mode === 'semantic') {
    const run = await semanticRun(query, fetchLimit + 1, filters);
    raw = run.results;
    hasMore = raw.length > fetchLimit;
    bestSemantic = run.best;
    armsUsed = ['semantic'];
  } else {
    const run = await hybridRun(query, fetchLimit, filters, rerank);
    raw = run.results;
    bestSemantic = run.bestSemantic;
    armsUsed = run.armsUsed;
    failures = run.failures;
    reranked = run.reranked;
    hasMore = run.hasMore;
  }

  const [threshold, index] = await Promise.all([
    mode === 'text' ? Promise.resolve(null) : effectiveSemanticThreshold(),
    indexHealth(modelKey),
  ]);

  const page = project(raw, limit, offset, explain);
  await attachExcerptOffsets(page);

  return {
    results: page,
    diagnostics: {
      mode,
      arms_used: armsUsed,
      arms_unavailable: failures,
      best_semantic_score: bestSemantic,
      semantic_threshold: threshold,
      embedding_model: modelKey,
      index,
      scoped: hasFilters(filters),
      has_more: hasMore,
      reranked,
      rerank: {
        available: rerankAvailable(),
        enabled: (await rerankConfig()) !== null,
        skipped: !rerank,
        min_score: await getRerankMinScore(),
      },
      took_ms: Date.now() - started,
    },
  };
}

/**
 * Search without diagnostics: dispatches by mode (default hybrid), pages with
 * offset, and drops raw arm scores unless `explain` is set.
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
export function project(
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
    // Always shown when present: it explains an order rank fusion did not produce.
    if (r.rerank_score !== undefined) base.rerank_score = r.rerank_score;

    if (explain) {
      if (r.text_score !== undefined) base.text_score = r.text_score;
      if (r.semantic_score !== undefined) base.semantic_score = r.semantic_score;
    }

    return base;
  });
}
