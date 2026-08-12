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

export type IndexedGraph = {
  nodes: { i: number; id: string; t: string }[];
  edges: [number, number][];
  semantic_edges: [number, number, number][];
};

/**
 * Re-shapes a graph for MCP output: edges reference nodes by array index
 * instead of repeating their 36-char UUID twice per edge. Two full UUIDs per
 * edge is most of what get_graph costs — 490 edges on the live vault is
 * ~48KB of ids an agent cannot act on without joining back to nodes anyway.
 * Not used by the REST route or MiniGraph — both key edges by id directly
 * (MiniGraph's hover/layout logic reads edge.from/to as ids throughout), so
 * changing their shape would mean rewriting the renderer for no reader who
 * asked for it. This is purely an MCP tool's own output transform.
 * An edge whose endpoint isn't in `nodes` (shouldn't happen — buildGraph
 * only ever edges within its own node set) is dropped rather than emitted
 * with a dangling index a consumer can't resolve.
 */
export function indexedForm(graph: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  semantic_edges: (GraphEdge & { score: number })[];
}): IndexedGraph {
  const indexById = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const toIndexPair = (e: GraphEdge): [number, number] | null => {
    const from = indexById.get(e.from);
    const to = indexById.get(e.to);
    return from !== undefined && to !== undefined ? [from, to] : null;
  };
  return {
    nodes: graph.nodes.map((n, i) => ({ i, id: n.id, t: n.title })),
    edges: graph.edges.map(toIndexPair).filter((p): p is [number, number] => p !== null),
    semantic_edges: graph.semantic_edges
      .map((e) => {
        const pair = toIndexPair(e);
        return pair ? ([pair[0], pair[1], e.score] as [number, number, number]) : null;
      })
      .filter((t): t is [number, number, number] => t !== null),
  };
}
