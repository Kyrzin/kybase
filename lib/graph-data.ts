// lib/graph-data.ts — the DB-backed knowledge graph shared by GET /api/graph
// and the MCP get_graph tool (previously duplicated in both). Server-only:
// imports the pg-backed db layer, so never import this from a client module —
// use lib/graph.ts for the pure edge builder instead.
import { query } from './db';
import { getSemanticEdges, type SemanticEdge } from './semantic-edges';
import { buildWikilinkEdges, dedupeEdges, type GraphNode, type GraphEdge } from './graph';

// Semantic edges: undirected embedding-similarity pairs. Same parameters the
// API route and MCP tool used before this was unified.
const SEMANTIC_THRESHOLD = 0.75;
const SEMANTIC_MAX_NEIGHBORS = 5;

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; semantic_edges: SemanticEdge[] };

export async function buildGraph(): Promise<Graph> {
  const notes = await query<{ id: string; title: string; content: string }>(
    'select id, title, content from notes'
  );
  const nodes = notes.map(n => ({ id: n.id, title: n.title }));
  // Dedupe to one edge per (from, to) pair — the server graph has always been
  // unique-per-pair (it built edges from unique wikilink targets per note).
  const edges = dedupeEdges(buildWikilinkEdges(notes));

  // Second edge source — must never take down the wikilink graph if it fails.
  let semantic_edges: SemanticEdge[] = [];
  try {
    semantic_edges = await getSemanticEdges(SEMANTIC_THRESHOLD, SEMANTIC_MAX_NEIGHBORS);
  } catch (err) {
    console.error('[graph] semantic edges:', err instanceof Error ? err.message : err);
  }

  return { nodes, edges, semantic_edges };
}
