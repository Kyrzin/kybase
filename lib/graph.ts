// lib/graph.ts — pure knowledge-graph helpers, safe to import from both the
// server (API route, MCP tool) and the client (no DB import, so no `pg` in
// the browser bundle). The DB-backed graph builder lives in lib/graph-data.ts.

export type GraphNode = { id: string; title: string };
export type GraphEdge = { from: string; to: string };

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * One directed edge per [[wikilink]] occurrence: titles resolve
 * case-insensitively, self-links are skipped. Repeated links to the same
 * target produce repeated edges — this matches the client graph, which
 * counts each occurrence. The server dedupes with dedupeEdges (below); do
 * the same if you need one edge per pair.
 */
export function buildWikilinkEdges(
  notes: { id: string; title: string; content: string }[]
): GraphEdge[] {
  const titleToId = new Map(notes.map(n => [n.title.toLowerCase(), n.id]));
  const edges: GraphEdge[] = [];
  for (const note of notes) {
    for (const m of note.content.matchAll(WIKILINK_RE)) {
      const target = m[1].split(/[|#]/)[0].trim().toLowerCase();
      const targetId = titleToId.get(target);
      if (targetId && targetId !== note.id) edges.push({ from: note.id, to: targetId });
    }
  }
  return edges;
}

/** Collapse repeated (from, to) pairs to one edge, keeping first-seen order. */
export function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const out: GraphEdge[] = [];
  for (const e of edges) {
    const key = `${e.from} ${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
