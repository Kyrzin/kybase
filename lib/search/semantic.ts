import { query as dbQuery, toVector } from '../db';
import { getEmbedding, getMinSimilarity, embeddingModelKey } from '../embeddings';
import { getEmbeddingConfig } from '../settings';
import type { SearchFilters, SearchResult } from './types';
import { SEMANTIC_TRIM, SEMANTIC_TRIM_RATIO } from './config';
import { applyFilters, enrichResults, overfetchLimit, resolveScope, scopeParam } from './results';
import { attachSections, makeExcerpt, stripLeadingHeading } from './excerpt';
import { computeTextCoverage, significantWords } from './signals';

// The configured similarity floor, exactly as applied (null when unset).
export async function effectiveSemanticThreshold(): Promise<number | null> {
  return getMinSimilarity();
}

/**
 * Chunk-based semantic search. Candidates pass the optional similarity floor,
 * then those under 0.75x the query's best hit are dropped; relevance is
 * similarity / best. One result per note, its best chunk as the excerpt.
 */
export async function semanticSearch(query: string, limit = 10, filters?: SearchFilters, allowedIds?: Set<string>): Promise<SearchResult[]> {
  return (await semanticRun(query, limit, filters, allowedIds)).results;
}

/** The embedded query, so later steps can measure chunks against it without embedding it again. */
export type QueryVector = { vector: string; modelKey: string };

/** semanticSearch plus the best raw similarity and the query vector, from the same run. */
export async function semanticRun(query: string, limit = 10, filters?: SearchFilters, allowedIds?: Set<string>, deferSections = false): Promise<{ results: SearchResult[]; best: number | null; queryVector: QueryVector }> {
  const [embedding, floor, scope, modelKey] = await Promise.all([
    getEmbedding(query, 'query'),
    getMinSimilarity(),
    resolveScope(filters, allowedIds),
    getEmbeddingConfig().then(embeddingModelKey),
  ]);
  const fetchLimit = overfetchLimit(limit, filters);
  const vec = toVector(embedding);
  // match_chunks applies scope and the current model generation before ranking.
  const rawData: Record<string, unknown>[] = await dbQuery(
    'select * from match_chunks($1::vector, $2, 0, $3, $4)',
    [vec, fetchLimit, scopeParam(scope), modelKey]
  );
  const data = floor === null ? rawData : rawData.filter((n) => (n.similarity as number) >= floor);

  const best = (data[0]?.similarity as number | undefined) ?? 0;

  const candidates = SEMANTIC_TRIM && best > 0
    ? data.filter((n) => (n.similarity as number) >= SEMANTIC_TRIM_RATIO * best)
    : data;

  // Keep one entry per note: its first, best-scoring chunk.
  const seenNoteIds = new Set<string>();
  const dedupedCandidates = candidates.filter((n) => {
    const id = n.id as string;
    if (seenNoteIds.has(id)) return false;
    seenNoteIds.add(id);
    return true;
  });

  const results = dedupedCandidates.map((n) => {
    const heading = n.heading as string | null;
    const excerpt = makeExcerpt(stripLeadingHeading(n.chunk_content as string), query);
    const relevance = best > 0 ? (n.similarity as number) / best : 0;
    return {
      id:      n.id as string,
      title:   n.title as string,
      excerpt,
      tags:    n.tags as string[],
      score:   n.similarity as number,
      relevance,
      ...(heading ? { section: heading } : {}),
    };
  });
  const filtered = await applyFilters(results, limit, filters, scope);

  // Coverage is reported, never used to reject: whether the asked-about words
  // appear in the note at all.
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
  if (!deferSections) await attachSections(filtered, query);

  // `best` is taken before the trim and the page cut; null means nothing to compare.
  return { results: await enrichResults(filtered), best: data.length > 0 ? best : null, queryVector: { vector: vec, modelKey } };
}

/** Best chunk similarity ignoring the configured floor. */
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
