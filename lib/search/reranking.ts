import { query as dbQuery } from '../db';
import { getRerankMinScore } from '../settings';
import { rerankConfig, rerankAvailable, selectPassages, scorePassages, windowsOf, EXCERPT_CHUNK_CAP, type RerankConfig } from '../rerank';
import type { HybridSearchResult } from './types';
import { makeExcerpt, stripLeadingHeading } from './excerpt';
import type { QueryVector } from './semantic';

/**
 * Reorders the top of the fused list by cross-encoder score, before the page
 * is cut. It reorders candidates, never adds one. Verbatim matches are
 * reordered only among themselves. `reranked: false` when nothing was
 * rescored (service off, unreachable or silent).
 */
export async function applyRerank(
  query: string,
  fused: HybridSearchResult[],
  queryVector?: QueryVector
): Promise<{ results: HybridSearchResult[]; reranked: boolean }> {
  const unchanged = { results: fused, reranked: false };
  if (fused.length < 2) return unchanged;
  // Never wait on a probe: an absent service must not cost every search a timeout.
  if (!rerankAvailable()) return unchanged;
  const cfg = await rerankConfig();
  if (!cfg) return unchanged;

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
    // Show the passage that earned the rank.
    r.excerpt = makeExcerpt(stripLeadingHeading(hit.content), query);
  }

  // A note with no scored passage (not embedded yet) keeps its place.
  const seen = head.filter((r) => r.rerank_score !== undefined);
  const order = new Map(head.map((r, i) => [r.id, i]));
  seen.sort((a, b) =>
    Number(b.exact) - Number(a.exact) ||
    (b.rerank_score! - a.rerank_score!) ||
    (order.get(a.id)! - order.get(b.id)!) ||
    a.id.localeCompare(b.id)
  );
  let next = 0;
  for (let i = 0; i < head.length; i++) {
    if (head[i].rerank_score !== undefined) fused[i] = seen[next++];
  }

  // Relevance is recomputed from the score that decided this order.
  const top = seen[0]?.rerank_score;
  if (top !== undefined && top > 0) {
    for (const r of seen) r.relevance = r.rerank_score! / top;
  }

  // Optional floor: keeps only what the reranker scored at or above it,
  // dropping unscored candidates too.
  const floor = await getRerankMinScore();
  if (floor === null) {
    await refineTopExcerpts(query, fused, byNote, cfg);
    return { results: fused, reranked: true };
  }
  const kept = fused.filter((r) => r.rerank_score !== undefined && r.rerank_score >= floor);
  await refineTopExcerpts(query, kept, byNote, cfg);
  return { results: kept, reranked: true };
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
    if (content) r.excerpt = makeExcerpt(stripLeadingHeading(content), query);
  }
}
