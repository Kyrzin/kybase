// lib/mcp-server.ts — MCP server factory with 12 tools
// Uses @modelcontextprotocol/sdk McpServer (high-level API)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query, queryOne, withTransaction, isUniqueViolation } from './db';
import { textSearch, semanticSearch, hybridSearch } from './search';
import { indexNoteAsync } from './indexing';
import { extractAllWikilinks } from './wikilinks';
import { getSemanticEdges } from './semantic-edges';

/** Escape ilike wildcards so a title containing %/_ can't widen the match. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (c) => `\\${c}`);
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'kybase', version: '1.0.0' },
    {
      instructions:
        'Kybase is a personal knowledge base of interlinked markdown notes. Notes reference ' +
        'each other with [[Title]] wikilinks; those links form the knowledge graph.\n\n' +
        'When creating a note or substantially rewriting one:\n' +
        '1. First call search_notes (type "hybrid") with the note\'s topic to find related existing notes.\n' +
        '2. If genuinely related notes exist, include [[wikilinks]] to the 2-5 most relevant ones in the ' +
        'note body — inline where natural, or as a final "Related: [[A]], [[B]]" line.\n' +
        '3. Copy linked titles VERBATIM from tool results (search_notes, list_notes, get_graph). Never ' +
        'write a [[link]] to a title you have not seen in a tool result in this conversation — invented ' +
        'or misremembered titles produce broken links.\n' +
        '4. Do not force links: if nothing is related, create the note without any.',
    }
  );

  // ── list_notes ───────────────────────────────────────────────────────────
  server.tool(
    'list_notes',
    'List notes. Optional filters: folder_id, tag, limit (max 200).',
    {
      folder_id: z.string().uuid().optional().describe('Filter by folder UUID'),
      tag:       z.string().optional().describe('Filter by tag'),
      limit:     z.number().int().min(1).max(200).default(50),
    },
    async ({ folder_id, tag, limit }) => {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (folder_id) { params.push(folder_id); conds.push(`folder_id = $${params.length}`); }
      if (tag)       { params.push([tag]);     conds.push(`tags @> $${params.length}`); }
      params.push(limit);
      const data = await query(
        `select id, title, folder_id, tags, updated_at from notes
         ${conds.length ? 'where ' + conds.join(' and ') : ''}
         order by updated_at desc limit $${params.length}`,
        params
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── get_note ─────────────────────────────────────────────────────────────
  server.tool(
    'get_note',
    'Get full note content by id or title (case-insensitive).',
    {
      id:    z.string().uuid().optional(),
      title: z.string().optional(),
    },
    async ({ id, title }) => {
      if (!id && !title) throw new Error('Provide either id or title');
      const cols = 'id, title, content, folder_id, tags, created_at, updated_at';
      const data = id
        ? await queryOne(`select ${cols} from notes where id = $1`, [id])
        : await queryOne(`select ${cols} from notes where title ilike $1`, [title]);
      if (!data) throw new Error('Note not found');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── create_note ──────────────────────────────────────────────────────────
  server.tool(
    'create_note',
    'Create a new note. Embedding is generated automatically in the background. ' +
    'Before creating, search_notes for the topic and include [[wikilinks]] to related existing notes ' +
    '(copy titles exactly from tool results — never invent them).',
    {
      title:     z.string().min(1).max(500),
      content:   z.string().default(''),
      folder_id: z.string().uuid().nullable().optional(),
      tags:      z.array(z.string()).default([]),
    },
    async ({ title, content, folder_id, tags }) => {
      let note;
      try {
        note = await queryOne<{ id: string }>(
          `insert into notes (title, content, folder_id, tags, embedding_pending)
           values ($1, $2, $3, $4, true)
           returning id, title, content, folder_id, tags, created_at`,
          [title, content, folder_id ?? null, tags]
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new Error(`A note titled "${title}" already exists — update it or pick another title`);
        throw err;
      }
      if (!note) throw new Error('Insert failed');

      // background index (note embedding + chunks)
      indexNoteAsync(note.id, title, content);

      return { content: [{ type: 'text' as const, text: JSON.stringify(note, null, 2) }] };
    }
  );

  // ── update_note ──────────────────────────────────────────────────────────
  server.tool(
    'update_note',
    'Update note fields. Re-embeds if title or content changed. Updates wikilinks if title changed. ' +
    'When substantially rewriting content, consider adding [[wikilinks]] to related notes found via ' +
    'search_notes (copy titles exactly from tool results).',
    {
      id:        z.string().uuid(),
      title:     z.string().min(1).max(500).optional(),
      content:   z.string().optional(),
      folder_id: z.string().uuid().nullable().optional(),
      tags:      z.array(z.string()).optional(),
    },
    async ({ id, title, content, folder_id, tags }) => {
      const existing = await queryOne<{ title: string; content: string }>(
        'select title, content from notes where id = $1', [id]
      );
      if (!existing) throw new Error('Note not found');

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (title     !== undefined) set('title', title);
      if (content   !== undefined) set('content', content);
      if (folder_id !== undefined) set('folder_id', folder_id);
      if (tags      !== undefined) set('tags', tags);
      if (sets.length === 0) throw new Error('Provide at least one field to update');

      const changed = title !== undefined || content !== undefined;
      if (changed) sets.push('embedding_pending = true');

      params.push(id);
      let note;
      try {
        // One transaction: a rename must never land without its backlink
        // rewrite — a failure between the two leaves [[OldTitle]] links broken.
        note = await withTransaction(async (client) => {
          const { rows } = await client.query(
            `update notes set ${sets.join(', ')} where id = $${params.length}
             returning id, title, content, folder_id, tags, updated_at`,
            params
          );
          if (title && title !== existing.title && rows[0]) {
            await client.query('select update_wikilinks($1, $2)', [existing.title, title]);
          }
          return rows[0] ?? null;
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new Error(`A note titled "${title}" already exists — update it or pick another title`);
        throw err;
      }
      if (!note) throw new Error('Note not found');
      if (changed) {
        indexNoteAsync(id, title ?? existing.title, content ?? existing.content);
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(note, null, 2) }] };
    }
  );

  // ── delete_note ──────────────────────────────────────────────────────────
  server.tool(
    'delete_note',
    'Delete a note by id.',
    { id: z.string().uuid() },
    async ({ id }) => {
      await query('delete from notes where id = $1', [id]);
      return { content: [{ type: 'text' as const, text: `Note ${id} deleted.` }] };
    }
  );

  // ── search_notes ─────────────────────────────────────────────────────────
  server.tool(
    'search_notes',
    'Search notes. type: "text" (fast), "semantic" (meaning-based), "hybrid" (best, uses RRF). ' +
    'Returns short excerpts, not full notes — call get_note with the id to read a full note.',
    {
      query: z.string().min(1),
      type:  z.enum(['text', 'semantic', 'hybrid']).default('hybrid'),
      limit: z.number().int().min(1).max(50).default(5),
    },
    async ({ query, type, limit }) => {
      let results;
      if      (type === 'semantic') results = await semanticSearch(query, limit);
      else if (type === 'hybrid')   results = await hybridSearch(query, limit);
      else                          results = await textSearch(query, limit);
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    }
  );

  // ── list_folders ─────────────────────────────────────────────────────────
  server.tool(
    'list_folders',
    'List all folders (flat array, use parent_id to reconstruct tree).',
    {},
    async () => {
      const data = await query('select * from folders order by name');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── create_folder ────────────────────────────────────────────────────────
  server.tool(
    'create_folder',
    'Create a new folder. Optionally nested under a parent.',
    {
      name:      z.string().min(1).max(255),
      parent_id: z.string().uuid().nullable().optional(),
    },
    async ({ name, parent_id }) => {
      const data = await queryOne(
        'insert into folders (name, parent_id) values ($1, $2) returning *',
        [name, parent_id ?? null]
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── update_folder ────────────────────────────────────────────────────────
  server.tool(
    'update_folder',
    'Rename a folder and/or move it under a different parent (set parent_id to null for top level). Provide at least one of name/parent_id.',
    {
      id:        z.string().uuid(),
      name:      z.string().min(1).max(255).optional(),
      parent_id: z.string().uuid().nullable().optional(),
    },
    async ({ id, name, parent_id }) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (name      !== undefined) set('name', name);
      if (parent_id !== undefined) {
        if (parent_id === id) {
          throw new Error('Folder cannot be its own parent');
        }
        if (parent_id !== null) {
          const checkCycle = await queryOne<{ id: string }>(
            `WITH RECURSIVE ancestors AS (
               SELECT id, parent_id FROM folders WHERE id = $1
               UNION
               SELECT f.id, f.parent_id FROM folders f
               INNER JOIN ancestors a ON f.id = a.parent_id
             )
             SELECT id FROM ancestors WHERE id = $2`,
            [parent_id, id]
          );
          if (checkCycle) {
            throw new Error('Cannot move a folder into its own descendant');
          }
        }
        set('parent_id', parent_id);
      }
      if (sets.length === 0) throw new Error('Provide name and/or parent_id');

      params.push(id);
      const data = await queryOne(
        `update folders set ${sets.join(', ')} where id = $${params.length} returning *`,
        params
      );
      if (!data) throw new Error('Folder not found');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── delete_folder ────────────────────────────────────────────────────────
  server.tool(
    'delete_folder',
    'Delete a folder. Notes inside are NOT deleted — their folder_id is set to null (they move to the top level). Child folders are cascade-deleted. To preserve organization, move notes/subfolders out first.',
    { id: z.string().uuid() },
    async ({ id }) => {
      await query('delete from folders where id = $1', [id]);
      return { content: [{ type: 'text' as const, text: `Folder ${id} deleted.` }] };
    }
  );

  // ── get_backlinks ────────────────────────────────────────────────────────
  server.tool(
    'get_backlinks',
    'Get all notes that contain [[Title]] wikilinks pointing to the given note.',
    { title: z.string().min(1) },
    async ({ title }) => {
      const data = await query<{ id: string; title: string; content: string }>(
        'select id, title, content from notes where content ilike $1',
        [`%[[${escapeLike(title)}%`]
      );

      // Precise filter: ilike is approximate, extractAllWikilinks is exact
      const backlinks = data.filter((n) =>
        extractAllWikilinks(n.content).some(
          (t) => t.toLowerCase() === title.toLowerCase()
        )
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(backlinks, null, 2) }] };
    }
  );

  // ── get_note_with_links ──────────────────────────────────────────────────
  server.tool(
    'get_note_with_links',
    'Get a note and automatically resolve all [[wikilinks]] inside it (1 level deep). Returns the main note plus the full content of every linked note found in the knowledge base. Unresolved links (notes not found) are listed separately.',
    {
      id:    z.string().uuid().optional(),
      title: z.string().optional(),
    },
    async ({ id, title }) => {
      if (!id && !title) throw new Error('Provide either id or title');

      // Fetch the main note
      const cols = 'id, title, content, folder_id, tags, created_at, updated_at';
      const note = id
        ? await queryOne<{ id: string; title: string; content: string }>(
            `select ${cols} from notes where id = $1`, [id])
        : await queryOne<{ id: string; title: string; content: string }>(
            `select ${cols} from notes where title ilike $1`, [title]);
      if (!note) throw new Error('Note not found');

      // Extract all wikilink targets
      const linkTargets = extractAllWikilinks(note.content);

      // Resolve each link by title (case-insensitive), skip self
      const resolved: Record<string, unknown>[] = [];
      const missing: string[] = [];

      await Promise.all(
        linkTargets.map(async (target) => {
          if (target.toLowerCase() === note.title.toLowerCase()) return;
          const linked = await queryOne(
            'select id, title, content, folder_id, tags, updated_at from notes where title ilike $1',
            [target]
          );
          if (linked) resolved.push(linked);
          else        missing.push(target);
        })
      );

      const result = {
        note,
        linked_notes: resolved,
        unresolved_links: missing,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── get_graph ─────────────────────────────────────────────────────────────
  server.tool(
    'get_graph',
    'Get the knowledge graph: all note nodes, directed edges from [[wikilinks]], and undirected ' +
    'semantic_edges (embedding cosine similarity ≥ 0.75) between related notes that may lack explicit links. ' +
    'The node titles are the complete dictionary of valid [[wikilink]] targets.',
    {},
    async () => {
      const notes = await query<{ id: string; title: string; content: string }>(
        'select id, title, content from notes'
      );

      const nodes = notes.map((n) => ({ id: n.id, title: n.title }));
      const titleToId = new Map(notes.map((n) => [n.title.toLowerCase(), n.id]));
      const edges: { from: string; to: string }[] = [];

      for (const note of notes) {
        for (const target of extractAllWikilinks(note.content)) {
          const targetId = titleToId.get(target.toLowerCase());
          if (targetId && targetId !== note.id) {
            edges.push({ from: note.id, to: targetId });
          }
        }
      }

      // Semantic edges are supplementary — never fail the wikilink graph over them.
      let semantic_edges: { from: string; to: string; score: number }[] = [];
      try {
        semantic_edges = await getSemanticEdges(0.75, 5);
      } catch (err) {
        console.error('[mcp get_graph] semantic edges:', err instanceof Error ? err.message : err);
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ nodes, edges, semantic_edges }, null, 2) }] };
    }
  );

  return server;
}
