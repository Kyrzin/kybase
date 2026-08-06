// lib/trash.ts — soft delete for notes (see db/migrations/011).
//
// delete_note used to be instant and permanent, callable by anything holding
// the master secret or an MCP token, with no confirmation. Notes are also
// populated by an agent from external content, so a prompt-injected "clean
// up the vault" instruction could wipe real data with nothing to recover.
// softDeleteNote just hides the row (deleted_at); every read path across the
// app filters deleted_at is null, so a trashed note behaves as gone
// everywhere except restore_note/listTrash.
//
// purgeExpiredTrash also runs opportunistically here on every delete (same
// pattern as lib/tokens.ts's oauth_tokens cleanup), but that alone doesn't
// actually guarantee the "30 days" the UI promises: a vault where nothing
// else ever gets deleted would keep one trashed note forever. instrumentation.ts
// also runs it on a daily interval so the retention window is a real
// guarantee, not just a side effect of unrelated activity.
import { query, queryOne } from './db';

export const TRASH_RETENTION_DAYS = 30;

export async function softDeleteNote(id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    'update notes set deleted_at = now() where id = $1 and deleted_at is null returning id',
    [id]
  );
  await purgeExpiredTrash();
  return !!row;
}

export async function restoreNote(id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    'update notes set deleted_at = null where id = $1 and deleted_at is not null returning id',
    [id]
  );
  return !!row;
}

export type TrashedNote = { id: string; title: string; folder_id: string | null; deleted_at: string };

export async function listTrash(): Promise<TrashedNote[]> {
  return query<TrashedNote>(
    `select id, title, folder_id, deleted_at from notes
     where deleted_at is not null
     order by deleted_at desc`
  );
}

/** Hard-deletes notes past the retention window — cascades chunks and shares. */
export async function purgeExpiredTrash(): Promise<number> {
  const rows = await query<{ id: string }>(
    `delete from notes where deleted_at < now() - interval '${TRASH_RETENTION_DAYS} days' returning id`
  );
  return rows.length;
}

/**
 * Immediately and permanently deletes one trashed note, skipping the rest
 * of the retention window — the UI's "Delete forever" action. Only ever
 * targets a note already in the trash: a live note has to go through
 * softDeleteNote first, so "permanent delete" is always a second, deliberate
 * step, never a one-click shortcut past the soft-delete safety net.
 */
export async function purgeNote(id: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    'delete from notes where id = $1 and deleted_at is not null returning id',
    [id]
  );
  return !!row;
}

/**
 * Soft-deletes every live note inside a folder AND its full descendant
 * subtree — called before the folder row itself is deleted, in the same
 * transaction (hence the explicit client: this must not commit unless the
 * folder delete that follows also succeeds). Folders cascade on delete
 * (parent_id references folders(id) on delete cascade) and notes used to
 * just get orphaned to root (folder_id set null) when their folder
 * disappeared; deleting a folder now sends its notes to the trash instead,
 * recoverable for TRASH_RETENTION_DAYS like any other delete. Already-
 * trashed notes in the subtree are left alone (their own deleted_at stands).
 */
export async function trashFolderNotes(
  folderId: string,
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: { id: string }[] }> }
): Promise<number> {
  const { rows } = await client.query(
    // `union`, not `union all`: it dedupes, so a parent_id cycle terminates
    // instead of recursing forever. Cycles are supposed to be impossible —
    // both folder-move paths reject a move into a descendant — but that check
    // is not atomic, and a query that never returns holds its pool connection
    // for good (no statement_timeout is configured anywhere).
    `with recursive subtree as (
       select id from folders where id = $1
       union
       select f.id from folders f join subtree s on f.parent_id = s.id
     )
     update notes set deleted_at = now()
     where folder_id in (select id from subtree) and deleted_at is null
     returning id`,
    [folderId]
  );
  return rows.length;
}
