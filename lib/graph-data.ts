// lib/graph-data.ts — the DB-backed knowledge graph shared by GET /api/graph
// and the MCP get_graph tool (previously duplicated in both). Server-only:
// imports the pg-backed db layer, so never import this from a client module —
// use lib/graph.ts for the pure edge builder instead.
import { query } from './db';
import { getSemanticEdges, type SemanticEdge } from './semantic-edges';
import { dedupeEdges, type GraphNode, type GraphEdge } from './graph';
import { wikilinkEdges } from './note-links';

// Semantic edges: undirected embedding-similarity pairs. Same parameters the
// API route and MCP tool used before this was unified.
const SEMANTIC_THRESHOLD = 0.75;
const SEMANTIC_MAX_NEIGHBORS = 5;

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; semantic_edges: SemanticEdge[]; unresolved_links: string[]; truncated?: boolean };

/**
 * Default ceiling on nodes in one graph. Every other read tool here has a
 * bound; this one had none, so an unfiltered call returned the entire vault
 * and grew linearly with it — on a large vault that stops being expensive and
 * starts being a response nothing can hold. A truncated graph also has to SAY
 * so, or a caller reads a prefix as the whole shape of the vault.
 */
const DEFAULT_MAX_NODES = 500;

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
  /** Hard ceiling on returned nodes; the result carries `truncated` when it bites. */
  maxNodes?: number;
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
  const { folderId, rootTitle, depth = 2, includeSemantic = true, minScore = SEMANTIC_THRESHOLD, maxNodes = DEFAULT_MAX_NODES } = opts;

  // The folder subtree is resolved before the notes are fetched, not after:
  // filtering in memory meant "scope this to one folder" still read every
  // note in the vault first, so the advice to scope a large graph did not
  // reduce the query it was given for.
  let subtreeIds: string[] | null = null;
  if (folderId) {
    const folders = await query<{ id: string; parent_id: string | null }>('select id, parent_id from folders');
    const ids = new Set<string>([folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) {
          ids.add(f.id);
          grew = true;
        }
      }
    }
    subtreeIds = [...ids];
  }

  // Content is no longer selected here: links come from the stored index
  // (lib/note-links.ts), so rendering a graph stops costing a full read of
  // every note's text. On the live vault that was 1.2 MB fetched and
  // re-parsed per call to produce a few hundred edges.
  //
  // rootTitle has to see the whole link graph to walk out from its root, so
  // only the result can be bounded there. Every other call — including the
  // unfiltered one that used to return the entire vault — is bounded by the
  // query itself. Ordering by recency makes the cut deterministic and keeps
  // the half of the vault someone is actually working in.
  const params: unknown[] = [];
  const conds = ['deleted_at is null'];
  if (subtreeIds) { params.push(subtreeIds); conds.push(`folder_id = any($${params.length})`); }
  let sqlLimit = '';
  if (!rootTitle) { params.push(maxNodes + 1); sqlLimit = ` limit $${params.length}`; }
  const notes = await query<{ id: string; title: string; folder_id: string | null }>(
    `select id, title, folder_id from notes
      where ${conds.join(' and ')}
      order by content_updated_at desc, id${sqlLimit}`,
    params
  );

  let nodes = notes.map((n) => ({ id: n.id, title: n.title }));
  const built = await wikilinkEdges(nodes);
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

  // Applied after every scoping step and before semantic edges, which filter
  // against the final node set — capping later would leave edges pointing at
  // nodes no longer in the response.
  let truncated = false;
  if (nodes.length > maxNodes) {
    nodes = nodes.slice(0, maxNodes);
    const kept = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => kept.has(e.from) && kept.has(e.to));
    unresolved = unresolved.filter((u) => kept.has(u.from));
    truncated = true;
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

  return {
    nodes,
    edges,
    semantic_edges,
    unresolved_links: [...new Set(unresolved.map((u) => u.target))],
    ...(truncated ? { truncated: true } : {}),
  };
}
