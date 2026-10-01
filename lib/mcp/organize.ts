import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query, queryOne, withTransaction, isUniqueViolation, FOLDER_REPARENT_LOCK_KEY } from '../db';
import { trashFolderNotes } from '../trash';
import { buildFolderPathMap, folderPathMap, type FolderRow } from '../folders';
import { uuid, morePage } from './shared';

export function registerOrganizeTools(server: McpServer, actor: () => string): void {
  // ── list_tags ────────────────────────────────────────────────────────────
  server.tool(
    'list_tags',
    // Why to reuse a tag rather than coin a near-duplicate is in the server
    // instructions: it is a rule about writing, not about this tool.
    'Tags in use with the number of notes carrying each, most-used first. The default limit cuts ' +
    'off the one-off tail — a tag used once is not one worth reusing — so raise it to see those.',
    {
      limit: z.number().int().min(1).max(1000).default(40).describe('Max tags to return, most-used first'),
    },
    async ({ limit }) => {
      const rows = await query<{ tag: string; count: number }>(
        `select unnest(tags) as tag, count(*)::int as count
         from notes where deleted_at is null group by 1 order by count desc, tag limit $1`,
        [limit]
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows) }] };
    }
  );

  // ── list_folders ─────────────────────────────────────────────────────────
  server.tool(
    'list_folders',
    'List folders with the full path already resolved — no need to walk parent_id yourself. Pass a ' +
    'folder\'s own id as parent_id to create_folder/update_folder to nest under it. Sorted by path, ' +
    'so a page is a contiguous slice of the tree read top to bottom; the reply is ' +
    '`{folders, has_more, next_offset?}`.',
    {
      limit:  z.number().int().min(1).max(1000).default(200)
        .describe('Folders per page'),
      offset: z.number().int().min(0).default(0)
        .describe('Skip this many folders — pass back next_offset from the previous page'),
    },
    async ({ limit, offset }) => {
      // The whole tree is fetched whatever the page: a path is built from a
      // folder's ancestors, so a LIMIT in SQL would resolve the paths of a
      // page against a tree it only half has. Folders are orders of magnitude
      // fewer than notes, so the bound that matters is on the reply.
      const data = await query<FolderRow>('select id, name, parent_id from folders');
      const paths = buildFolderPathMap(data);
      // parent_id dropped: path already encodes the full chain, and creating
      // a subfolder only ever needs a folder's own id, never its parent's.
      // name stays — folder names aren't barred from containing "/", so a
      // literal one there would be indistinguishable from a path separator.
      const all = data
        .map((f) => ({ id: f.id, name: f.name, path: paths.get(f.id) ?? f.name }))
        .sort((a, b) => a.path.localeCompare(b.path));
      const page = all.slice(offset, offset + limit);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ folders: page, ...morePage(offset + page.length < all.length, limit, offset) }),
        }],
      };
    }
  );

  // ── create_folder ────────────────────────────────────────────────────────
  server.tool(
    'create_folder',
    'Create a new folder. Optionally nested under a parent.',
    {
      name:      z.string().min(1).max(255)
        .describe('Folder name. Unique among its siblings — the same name under a different parent is fine'),
      parent_id: uuid().nullable().optional()
        .describe('Parent folder UUID. Omit or pass null to create it at the top level'),
    },
    async ({ name, parent_id }) => {
      let data;
      try {
        data = await queryOne(
          'insert into folders (name, parent_id) values ($1, $2) returning *',
          [name, parent_id ?? null]
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new Error(`A folder named "${name}" already exists in this location`);
        throw err;
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    }
  );

  // ── update_folder ────────────────────────────────────────────────────────
  server.tool(
    'update_folder',
    'Rename a folder and/or move it under a different parent (set parent_id to null for top level). ' +
    'Provide at least one of name/parent_id. The response includes the resolved `path` so a rename or ' +
    'move can be confirmed without a follow-up list_folders call.',
    {
      id:        uuid().describe('UUID of the folder to rename or move'),
      name:      z.string().min(1).max(255).optional()
        .describe('New name. Must stay unique among this folder\'s siblings'),
      parent_id: uuid().nullable().optional()
        .describe('New parent folder UUID; null moves it to the top level. Moving a folder into its own descendant is refused'),
    },
    async ({ id, name, parent_id }) => {
      if (parent_id !== undefined && parent_id === id) {
        throw new Error('Folder cannot be its own parent');
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (name      !== undefined) set('name', name);
      if (parent_id !== undefined) set('parent_id', parent_id);
      if (sets.length === 0) throw new Error('Provide name and/or parent_id');
      params.push(id);

      const data = await withTransaction(async (client) => {
        if (parent_id !== undefined && parent_id !== null) {
          // Same advisory lock as the REST folder route: only reparenting
          // can create a cycle, and the check + write must be serialized
          // against ANY concurrent reparent — REST or MCP — or two moves
          // that each read a cycle-free tree can together create a real one.
          await client.query('select pg_advisory_xact_lock($1)', [FOLDER_REPARENT_LOCK_KEY]);
          const { rows: cycleRows } = await client.query<{ id: string }>(
            `WITH RECURSIVE ancestors AS (
               SELECT id, parent_id FROM folders WHERE id = $1
               UNION
               SELECT f.id, f.parent_id FROM folders f
               INNER JOIN ancestors a ON f.id = a.parent_id
             )
             SELECT id FROM ancestors WHERE id = $2`,
            [parent_id, id]
          );
          if (cycleRows.length > 0) throw new Error('Cannot move a folder into its own descendant');
        }
        const { rows } = await client.query(
          `update folders set ${sets.join(', ')} where id = $${params.length} returning *`,
          params
        );
        return rows[0] ?? null;
      });
      if (!data) throw new Error('Folder not found');
      // The rename/move itself may have changed this folder's own path, or —
      // for a reparent — its position in the tree, so the map is built fresh
      // from the post-write state rather than reused from before the call.
      const paths = await folderPathMap();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, path: paths.get(data.id) ?? data.name }) }] };
    }
  );

  // ── delete_folder ────────────────────────────────────────────────────────
  server.tool(
    'delete_folder',
    'Delete a folder and its full subtree of child folders (cascade). Every note inside — including ' +
    'notes in nested subfolders — is soft-deleted into the trash along with it (see delete_note), ' +
    'recoverable via restore_note within the retention window. To preserve organization instead, ' +
    'move notes/subfolders out first.',
    { id: uuid()
      .describe('UUID of the folder to delete along with its subfolders. Notes inside are moved to the trash, not destroyed') },
    async ({ id }) => {
      // One transaction: notes in the subtree must land in the trash
      // together with the folder disappearing, not one without the other.
      const trashed = await withTransaction(async (client) => {
        const count = await trashFolderNotes(id, client);
        // Confirm the row existed: an agent told "deleted" when nothing was
        // deleted plans its next steps on a false premise.
        const deleted = await client.query('delete from folders where id = $1 returning id', [id]);
        if (deleted.rows.length === 0) throw new Error('Folder not found');
        return count;
      }, { actor: actor() });
      return {
        content: [{
          type: 'text' as const,
          text: `Folder ${id} deleted. ${trashed} note${trashed === 1 ? '' : 's'} moved to trash.`,
        }],
      };
    }
  );
}
