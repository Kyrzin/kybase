// lib/graph.ts — pure knowledge-graph helpers, safe to import from both the
// server (API route, MCP tool) and the client (no DB import, so no `pg` in
// the browser bundle). The DB-backed graph builder lives in lib/graph-data.ts.
import { extractAllWikilinks } from './wikilinks';

export type GraphNode = { id: string; title: string };
export type GraphEdge = { from: string; to: string };

/**
 * Directed edges from [[wikilinks]]: titles resolve case-insensitively,
 * self-links are skipped, and repeated links to the same target from one
 * note count once (extractAllWikilinks returns unique targets per note).
 */
export function buildWikilinkEdges(
  notes: { id: string; title: string; content: string }[]
): GraphEdge[] {
  const titleToId = new Map(notes.map(n => [n.title.toLowerCase(), n.id]));
  const edges: GraphEdge[] = [];
  for (const note of notes) {
    for (const target of extractAllWikilinks(note.content)) {
      const targetId = titleToId.get(target.toLowerCase());
      if (targetId && targetId !== note.id) edges.push({ from: note.id, to: targetId });
    }
  }
  return edges;
}
