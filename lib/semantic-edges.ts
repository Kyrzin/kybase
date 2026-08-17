// lib/semantic-edges.ts — semantic graph edges from note-level embeddings.
// Wraps the semantic_edges RPC (004): undirected note pairs whose whole-note
// embeddings are cosine-close. Edges depend only on notes.embedding and
// notes.deleted_at, so they're cached here and invalidated on write rather
// than recomputed (HNSW lookups per note) on every graph open — those two
// columns change in exactly four places, each calling
// invalidateSemanticEdgesCache() after its write: indexNote's commit
// (lib/indexing.ts), softDeleteNote, restoreNote, and trashFolderNotes
// (lib/trash.ts). purgeExpiredTrash/purgeNote need no invalidation — that
// row is already excluded by deleted_at is null before it's physically
// removed. Keyed by (minSimilarity, maxNeighbors) since both are caller-
// supplied (get_graph's min_score, the semantic-graph REST route) — the
// whole map is cleared on invalidation rather than tracking per-key
// staleness, since a write can affect any threshold's result set.
//
// TTL is a safety net, not the primary mechanism, matching
// cachedEmbeddingConfig (lib/settings.ts): for this single-instance deploy
// invalidation is always exact and this never fires, but it bounds a
// hypothetical multi-instance deploy's worst case to a minute instead of
// unbounded drift between processes — same trade-off already accepted for
// the settings cache.
import { query } from './db';

export type SemanticEdge = { from: string; to: string; score: number };

const SEMANTIC_EDGES_CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: SemanticEdge[]; expiresAt: number }>();

export function invalidateSemanticEdgesCache(): void {
  cache.clear();
}

export async function getSemanticEdges(
  minSimilarity = 0.6,
  maxNeighbors = 5
): Promise<SemanticEdge[]> {
  const key = `${minSimilarity}:${maxNeighbors}`;
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const data = await query<{ from_id: string; to_id: string; similarity: number }>(
    'select * from semantic_edges($1, $2)',
    [minSimilarity, maxNeighbors]
  );
  const edges = data.map((e) => ({
    from: e.from_id,
    to: e.to_id,
    score: Math.round(e.similarity * 1000) / 1000,
  }));
  cache.set(key, { value: edges, expiresAt: Date.now() + SEMANTIC_EDGES_CACHE_TTL_MS });
  return edges;
}
