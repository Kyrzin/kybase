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

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; semantic_edges: SemanticEdge[]; unresolved_links: string[] };

export type BuildGraphOptions = {
  /** Restrict to notes inside this folder and its descendant folders. */
  folderId?: string;
  /** Neighborhood mode: keep only nodes within `depth` wikilink-hops of this note (case-insensitive). */
  rootTitle?: string;
  /** BFS hop count for rootTitle. Ignored without rootTitle. */
  depth?: number;
  /** Include semantic_edges at all. Default true (matches prior unconditional behavior). */
  includeSemantic?: boolean;
  /** Cosine floor for semantic_edges — lower to see more (and noisier) edges, raise to cut noise. */
  minScore?: number;
};

type TitledNote = { id: string; title: string };

/**
 * Resolve root_title the same forgiving way get_note/get_backlinks do
 * (findNoteByTitle in mcp-server.ts): exact, then unique prefix, then unique
 * substring — case-insensitive. In-memory because buildGraph already loaded
 * every note. Throws with candidates on ambiguity, or a clear miss otherwise,
 * so a partial title stops failing where it succeeds elsewhere.
 */
function resolveRootTitle<T extends TitledNote>(notes: T[], rootTitle: string, folderId?: string): T {
  const q = rootTitle.toLowerCase();
  const exact = notes.find((n) => n.title.toLowerCase() === q);
  if (exact) return exact;

  for (const test of [
    (t: string) => t.startsWith(q),
    (t: string) => t.includes(q),
  ]) {
    const hits = notes.filter((n) => test(n.title.toLowerCase()));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new Error(
        `root_title "${rootTitle}" matches ${hits.length} notes — pass a fuller title:\n` +
        JSON.stringify(hits.map(({ id, title }) => ({ id, title })))
      );
    }
  }
  throw new Error(`No note titled "${rootTitle}" found${folderId ? ' within the given folder' : ''}`);
}

export async function buildGraph(opts: BuildGraphOptions = {}): Promise<Graph> {
  const { folderId, rootTitle, depth = 2, includeSemantic = true, minScore = SEMANTIC_THRESHOLD } = opts;

  let notes = await query<{ id: string; title: string; content: string; folder_id: string | null }>(
    'select id, title, content, folder_id from notes where deleted_at is null'
  );

  if (folderId) {
    const folders = await query<{ id: string; parent_id: string | null }>('select id, parent_id from folders');
    const subtreeIds = new Set<string>([folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parent_id && subtreeIds.has(f.parent_id) && !subtreeIds.has(f.id)) {
          subtreeIds.add(f.id);
          grew = true;
        }
      }
    }
    notes = notes.filter((n) => n.folder_id !== null && subtreeIds.has(n.folder_id));
  }

  let nodes = notes.map((n) => ({ id: n.id, title: n.title }));
  const built = buildWikilinkEdges(notes);
  // Dedupe to one edge per (from, to) pair — the server graph has always been
  // unique-per-pair (it built edges from unique wikilink targets per note).
  let edges = dedupeEdges(built.edges);
  let unresolved = built.unresolved;

  if (rootTitle) {
    const root = resolveRootTitle(notes, rootTitle, folderId);
    // BFS over wikilink edges, treated as undirected for neighborhood purposes
    // (a note two hops away via an inbound link is still "nearby").
    const adjacency = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      adjacency.get(a)!.add(b);
    };
    edges.forEach((e) => { link(e.from, e.to); link(e.to, e.from); });

    const keep = new Set<string>([root.id]);
    let frontier = [root.id];
    for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbor of adjacency.get(id) ?? []) {
          if (!keep.has(neighbor)) { keep.add(neighbor); next.push(neighbor); }
        }
      }
      frontier = next;
    }
    nodes = nodes.filter((n) => keep.has(n.id));
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    unresolved = unresolved.filter((u) => keep.has(u.from));
  }

  // Second edge source — must never take down the wikilink graph if it fails.
  let semantic_edges: SemanticEdge[] = [];
  if (includeSemantic) {
    try {
      const nodeIds = new Set(nodes.map((n) => n.id));
      const raw = await getSemanticEdges(minScore, SEMANTIC_MAX_NEIGHBORS);
      // Folder/neighborhood scoping narrows nodes, not the semantic_edges RPC
      // itself — drop any edge that fell outside the already-filtered set.
      semantic_edges = raw.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
    } catch (err) {
      console.error('[graph] semantic edges:', err instanceof Error ? err.message : err);
    }
  }

  return { nodes, edges, semantic_edges, unresolved_links: [...new Set(unresolved.map((u) => u.target))] };
}
