// lib/semantic-edges.ts — semantic graph edges from note-level embeddings.
// Wraps the semantic_edges RPC (004): undirected note pairs whose whole-note
// embeddings are cosine-close. Nothing is stored — edges recompute from
// whatever embeddings indexNote last wrote.
import { query } from './db';

export type SemanticEdge = { from: string; to: string; score: number };

export async function getSemanticEdges(
  minSimilarity = 0.6,
  maxNeighbors = 5
): Promise<SemanticEdge[]> {
  const data = await query<{ from_id: string; to_id: string; similarity: number }>(
    'select * from semantic_edges($1, $2)',
    [minSimilarity, maxNeighbors]
  );
  return data.map((e) => ({
    from: e.from_id,
    to: e.to_id,
    score: Math.round(e.similarity * 1000) / 1000,
  }));
}
