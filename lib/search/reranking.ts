import { query as dbQuery } from '../db';
import { getRerankMinScore } from '../settings';
import { rerankConfig, rerankAvailable, selectPassages, scorePassages, windowsOf, normalizeQuery, blendScores, EXCERPT_CHUNK_CAP, type RerankConfig } from '../rerank';
import type { HybridSearchResult } from './types';
import { makeExcerpt, stripLeadingHeading } from './excerpt';
import type { QueryVector } from './semantic';

/**
 * Reorders the top of the fused list by cross-encoder score, alone or blended
 * with the fused order (RerankMode), before the page is cut. It reorders
 * candidates, never adds one. Verbatim matches are reordered only among
 * themselves. `reranked: false` when nothing was rescored (service off,
 * unreachable or silent).
 */
export async function applyRerank(
  query: string,
  fused: HybridSearchResult[],
  queryVector?: QueryVector
): Promise<{ results: HybridSearchResult[]; reranked: boolean; dropped: number }> {
  const unchanged = { results: fused, reranked: false, dropped: 0 };
  if (fused.length === 0) return unchanged;
  // Never wait on a probe: an absent service must not cost every search a timeout.
  if (!rerankAvailable()) return unchanged;
  const cfg = await rerankConfig();
  if (!cfg) return unchanged;
  // A single candidate has nothing to reorder, but a minimum score still
  // applies to it: unscored, it would pass the floor unjudged and unmarked.
  const floor = await getRerankMinScore();
  if (fused.length < 2 && floor === null) return unchanged;

  const head = fused.slice(0, cfg.topN);
  // Chunk distance to the query lets passage selection find meaning without shared words.
  const chunks = await dbQuery<{ note_id: string; heading: string | null; content: string; distance: number | null }>(
    `select note_id, heading, content,
            case when $2::vector is not null and embedding is not null
                   and (embedding_model is null or embedding_model = $3)
                 then embedding <=> $2::vector end as distance
     from note_chunks
     where note_id = any($1::uuid[]) order by note_id, chunk_index`,
    [head.map((r) => r.id), queryVector?.vector ?? null, queryVector?.modelKey ?? null]
  );
  const byNote = new Map<string, { heading: string | null; content: string; distance: number | null }[]>();
  for (const c of chunks) {
    const list = byNote.get(c.note_id);
    if (list) list.push(c); else byNote.set(c.note_id, [c]);
  }

  const passages = head.flatMap((r) => selectPassages(r.id, byNote.get(r.id) ?? [], query, cfg.perNote));
  const scores = await scorePassages(query, passages, cfg);
  if (!scores) return unchanged;

  for (const r of head) {
    const hit = scores.get(r.id);
    if (!hit) continue;
    r.rerank_score = hit.score;
    // Show the passage that earned the rank, centred on the query as matched:
    // "12 / 34" is found in the text as 12/34.
    r.excerpt = makeExcerpt(stripLeadingHeading(hit.content), normalizeQuery(query));
  }

  // A note with no scored passage (not embedded yet) keeps its place.
  const seen = head.filter((r) => r.rerank_score !== undefined);
  const order = new Map(head.map((r, i) => [r.id, i]));
  // `seen` is still in fused order and its relevance still the fused one.
  const finals = blendScores(seen.map((r) => ({ fused: r.relevance, rerank: r.rerank_score! })), cfg);
  const finalOf = new Map(seen.map((r, i) => [r.id, finals[i]]));
  seen.sort((a, b) =>
    Number(b.exact) - Number(a.exact) ||
    (finalOf.get(b.id)! - finalOf.get(a.id)!) ||
    (order.get(a.id)! - order.get(b.id)!) ||
    a.id.localeCompare(b.id)
  );
  let next = 0;
  for (let i = 0; i < head.length; i++) {
    if (head[i].rerank_score !== undefined) fused[i] = seen[next++];
  }

  // Relevance is recomputed from the score that decided this order;
  // rerank_score stays the model's own.
  const top = seen.length > 0 ? finalOf.get(seen[0].id) : undefined;
  if (top !== undefined && top > 0) {
    for (const r of seen) r.relevance = finalOf.get(r.id)! / top;
  }

  // Optional floor: keeps only what the reranker scored at or above it,
  // dropping unscored candidates too. Verbatim and unique-word matches stay:
  // a cross-encoder cannot judge a name or code it does not know.
  if (floor === null) {
    await refineTopExcerpts(query, fused, byNote, cfg);
    return { results: fused, reranked: true, dropped: 0 };
  }
  const passes = (r: HybridSearchResult) => r.rerank_score !== undefined && r.rerank_score >= floor;
  const kept = fused.filter((r) => r.exact || r.unique || passes(r));
  for (const r of kept) if (!passes(r)) r.weak_match = true;
  await refineTopExcerpts(query, kept, byNote, cfg);
  return { results: kept, reranked: true, dropped: fused.length - kept.length };
}

/**
 * For the first `excerptTop` results, lets the reranker pick which chunk and
 * which window inside it to show. Best-effort: on failure the earlier excerpt
 * stays.
 */
async function refineTopExcerpts(
  query: string,
  results: HybridSearchResult[],
  byNote: Map<string, { heading: string | null; content: string; distance?: number | null }[]>,
  cfg: RerankConfig
): Promise<void> {
  const top = results.slice(0, cfg.excerptTop).filter((r) => r.rerank_score !== undefined);
  if (top.length === 0) return;

  // Which chunk — skipped when the main pass already saw all of them.
  const needChunkPass = top.filter((r) => (byNote.get(r.id)?.length ?? 0) > cfg.perNote);
  const best = new Map<string, string>();
  if (needChunkPass.length > 0) {
    // Chosen by query overlap, not document order.
    const passages = needChunkPass.flatMap((r) =>
      selectPassages(r.id, byNote.get(r.id) ?? [], query, EXCERPT_CHUNK_CAP)
    );
    const scored = await scorePassages(query, passages, cfg);
    if (scored) for (const [id, hit] of scored) best.set(id, hit.content);
  }
  for (const r of top) {
    if (!best.has(r.id)) {
      // Everything this note has was already judged; recover the chunk the
      // current excerpt came from rather than guessing a different one.
      const own = byNote.get(r.id) ?? [];
      const from = own.find((c) => c.content.includes(r.excerpt.slice(0, 40)));
      if (from) best.set(r.id, from.content);
    }
  }
  if (best.size === 0) return;

  // Which window inside it.
  const windows = [...best].flatMap(([noteId, content]) =>
    windowsOf(content).map((w) => ({ noteId, text: w, content: w }))
  );
  const scored = await scorePassages(query, windows, cfg);
  for (const r of top) {
    const win = scored?.get(r.id);
    const content = win?.content ?? best.get(r.id);
    if (content) r.excerpt = makeExcerpt(stripLeadingHeading(content), normalizeQuery(query));
  }
}
