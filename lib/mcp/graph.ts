import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query, queryOne } from '../db';
import { backlinksTo, neighborsOf } from '../note-links';
import { buildGraph } from '../graph-data';
import { indexedForm } from '../graph';
import { folderPathMap } from '../folders';
import { uuid, findNoteByTitle, withSchemaRule, ID_OR_TITLE, withFolderPath } from './shared';

export function registerGraphTools(server: McpServer): void {
  // ── get_backlinks ────────────────────────────────────────────────────────
  server.registerTool(
    'get_backlinks',
    {
      description:
    'Notes that link to this one via [[Title]] wikilinks, by id or title. Each comes back as ' +
    'id/title/folder_path plus a snippet around the link; include_content:true returns their full ' +
    'text instead, which is expensive when many notes link here — prefer get_note on the ids you ' +
    'actually want. offset and limit count notes, not characters.',
      inputSchema: withSchemaRule({
      id:              uuid().optional()
        .describe('UUID of the note whose incoming links you want'),
      title:           z.string().optional()
        .describe('Alternative to id; resolved like get_note (exact, then prefix, then substring)'),
      include_content: z.boolean().default(false)
        .describe('Return each linking note\'s full text instead of a snippet around the link. Expensive when many notes link here'),
      limit:           z.number().int().min(1).max(200).default(50)
        .describe('Linking notes per page. Several links from the same note count as one'),
      offset:          z.number().int().min(0).default(0)
        .describe('Skip this many linking notes — pass back next_offset from the previous page'),
      }, ID_OR_TITLE),
    },
    async ({ id, title, include_content, limit, offset }) => {
      if (!id && !title) throw new Error('Provide either id or title');
      // Backlinks are found by matching [[Title]] text in other notes'
      // content, so both paths need one lookup first to know the note's
      // real title — findNoteByTitle gives a partial/fuzzy title the same
      // exact->prefix->substring forgiveness get_note already has (and
      // throws its own "matches N notes"/"not found" error on the way).
      const noteId = id
        ? (await queryOne<{ id: string }>('select id from notes where id = $1 and deleted_at is null', [id]))?.id
        : (await findNoteByTitle<{ id: string }>(title!, 'id')).id;
      if (!noteId) throw new Error('Note not found');

      // Link occurrences come from the stored index (migration 031), so this
      // no longer loads and re-parses the content of every note that happens
      // to contain the bracket text. Several links from the same note are
      // collapsed to one result carrying the first one's surrounding text —
      // the previous shape, which callers page through.
      const [links, paths] = await Promise.all([backlinksTo(noteId), folderPathMap()]);
      const firstPerNote = new Map<string, string | null>();
      for (const l of links) {
        if (!firstPerNote.has(l.source_note_id)) firstPerNote.set(l.source_note_id, l.context);
      }

      const total = firstPerNote.size;
      const pageIds = [...firstPerNote.keys()].slice(offset, offset + limit);
      const notes = pageIds.length === 0 ? [] : await query<{ id: string; title: string; content: string; folder_id: string | null }>(
        `select id, title, ${include_content ? 'content' : "'' as content"}, folder_id
         from notes where id = any($1::uuid[]) and deleted_at is null`,
        [pageIds]
      );
      const byId = new Map(notes.map((n) => [n.id, n]));
      const results = pageIds.flatMap((nid) => {
        const n = byId.get(nid);
        if (!n) return [];
        const base = withFolderPath({ id: n.id, title: n.title, folder_id: n.folder_id }, paths);
        return [include_content
          ? { ...base, content: n.content }
          : { ...base, snippet: firstPerNote.get(nid) ?? '' }];
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            results,
            total,
            ...(offset + limit < total ? { next_offset: offset + limit } : {}),
          }),
        }],
      };
    }
  );

  // ── get_neighbors ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_neighbors',
    {
      description:
    'What is around ONE note in the [[wikilink]] graph, out to `depth` hops: a flat list of titles, ' +
    'no node indices to decode and no whole-vault payload. For the shape of that neighbourhood — ' +
    'which of them link to each other — use get_graph with root_title instead.\n\n' +
    'Traversal is undirected: a note linking HERE counts as much as one linked FROM here. ' +
    '`links_out`/`links_in` describe the direct relation and appear only at depth 1 — two hops out, ' +
    '"which way does the arrow point" has no answer. Each note appears once, at the shortest depth ' +
    'that reaches it.\n\n' +
    'These are links people wrote, not similarity: a note on the same subject that nobody linked is ' +
    'not here, and an empty result is a fact about the writing rather than about the topic. Rows ' +
    'carry the title, which is what get_note, get_backlinks and this tool all take.',
      inputSchema: withSchemaRule({
      id:    uuid().optional()
        .describe('UUID of the note whose surroundings you want'),
      title: z.string().optional()
        .describe('Alternative to id; resolved like get_note (exact, then prefix, then substring)'),
      depth: z.number().int().min(1).max(3).default(1)
        .describe('Hops to walk. 1 = directly linked notes; each extra hop widens the set fast'),
      limit: z.number().int().min(1).max(500).default(100)
        .describe('Maximum neighbours to return, nearest depth first. `total` still counts them all'),
      }, ID_OR_TITLE),
    },
    async ({ id, title, depth, limit }) => {
      if (!id && !title) throw new Error('Provide either id or title');
      const noteId = id
        ? (await queryOne<{ id: string }>('select id from notes where id = $1 and deleted_at is null', [id]))?.id
        : (await findNoteByTitle<{ id: string }>(title!, 'id')).id;
      if (!noteId) throw new Error('Note not found');

      const neighbors = await neighborsOf(noteId, depth);
      // Counted before the slice, or `total` would just restate how many rows
      // are below it and the caller could never tell a full neighbourhood
      // from a page of one. neighborsOf already orders by (depth, title), so
      // the prefix a limit keeps is the nearest hops, deterministically.
      const total = neighbors.length;
      const page = neighbors.slice(0, limit);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            neighbors: page.map((n) => ({
              title: n.title, depth: n.depth,
              // Only ever shipped when true — "false" on both flags is the
              // ordinary state at depth 2 and says nothing worth the bytes.
              ...(n.links_out ? { links_out: true } : {}),
              ...(n.links_in ? { links_in: true } : {}),
            })),
            total,
            ...(total > page.length ? { truncated: true } : {}),
          }),
        }],
      };
    }
  );

  // ── get_graph ─────────────────────────────────────────────────────────────
  server.tool(
    'get_graph',
    // The positional edge encoding stays, and so does the sentence explaining
    // it: this is the tool that can return hundreds of nodes, where repeating
    // a title on both ends of every edge costs more than the decoding does.
    // get_neighbors is the title-addressed answer for the common case.
    'Many notes at once and the edges between them — the heavy graph tool, and the only one that ' +
    'reaches for the whole vault. For one note\'s surroundings use get_neighbors; for who links to ' +
    'it, get_backlinks.\n\n' +
    'Nodes are `{t}` (t = title). Edges reference nodes BY POSITION in the `nodes` array: ' +
    '`edges[0] = [2, 5]` means nodes[2] links to nodes[5]. semantic_edges are undirected and come ' +
    'from embedding similarity rather than written links, with the cosine as a third number. ' +
    '`unresolved_links` are [[wikilink]] targets matching no note title — dangling, so they have no ' +
    'node index.\n\n' +
    'Unscoped this reaches for the ENTIRE vault and stops at max_nodes: `truncated: true` means you ' +
    'hold a recency-ordered prefix, NOT the shape of the vault. Scope with folder_id or ' +
    'root_title+depth rather than raising the cap.',
    {
      folder_id:        uuid().optional()
        .describe('Restrict to notes in this folder and its descendant folders'),
      root_title:       z.string().optional()
        .describe('Keep only nodes within `depth` wikilink-hops of this note — resolved like get_note: exact, then unique prefix, then unique substring, case-insensitive'),
      depth:            z.number().int().min(1).max(10).default(2)
        .describe('Hop count for root_title; ignored without it'),
      include_semantic: z.boolean().default(true).describe('Include semantic_edges at all'),
      min_score:        z.number().min(0).max(1).default(0.75)
        .describe('Cosine floor for semantic_edges — lower to see more (noisier) edges'),
      unresolved_only:  z.boolean().default(false)
        .describe('If true, return only { unresolved_links } without nodes and edges (fast check for broken links)'),
      max_nodes:        z.number().int().min(1).max(5000).default(500)
        .describe('Ceiling on nodes returned, most recently edited first. The reply says `truncated: true` when it applies — scope with folder_id or root_title instead of raising this'),
    },
    async ({ folder_id, root_title, depth, include_semantic, min_score, unresolved_only, max_nodes }) => {
      const graph = await buildGraph({
        folderId: folder_id,
        rootTitle: root_title,
        depth,
        includeSemantic: unresolved_only ? false : include_semantic,
        minScore: min_score,
        maxNodes: max_nodes,
      });
      if (unresolved_only) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ unresolved_links: graph.unresolved_links }),
          }],
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(indexedForm(graph)) }] };
    }
  );
}
