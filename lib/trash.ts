// lib/trash.ts — soft delete for notes (see db/migrations/011).
//
//
// Notes are written by agents from external content, so a prompt-injected
// "clean up the vault" must not be able to destroy data: deleting hides the row
// (deleted_at) and every read path filters deleted_at is null, so a trashed
// note is gone everywhere except restore_note/listTrash.
//
// purgeExpiredTrash runs on every delete and daily from lib/startup.ts, so the
// retention window holds even in a vault where nothing else is deleted.
import { query, queryOne, queryOneAs } from './db';
import { invalidateSemanticEdgesCache } from './semantic-edges';

export const TRASH_RETENTION_DAYS = 30;

/** `actor` is who note history records as having deleted it (lib/db.ts). */
export async function softDeleteNote(id: string, actor: string): Promise<boolean> {
  const row = await queryOneAs<{ id: string }>(
    actor,
    'update notes set deleted_at = now() where id = $1 and deleted_at is null returning id',
    [id]
  );
  invalidateSemanticEdgesCache();
  await purgeExpiredTrash();
  return !!row;
}

export async function restoreNote(id: string, actor: string): Promise<boolean> {
  const row = await queryOneAs<{ id: string }>(
    actor,
    'update notes set deleted_at = null where id = $1 and deleted_at is not null returning id',
    [id]
  );
  invalidateSemanticEdgesCache();
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
 * Soft-deletes every live note in a folder and its whole subtree, before the
 * folder row is deleted and in the same transaction (hence the explicit
 * client: this must not commit unless the folder delete does). The notes go to
 * the trash, recoverable for TRASH_RETENTION_DAYS; already-trashed notes keep
 * their own deleted_at. Note history attributes the deletes to the caller's
 * transaction actor.
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
  invalidateSemanticEdgesCache();
  return rows.length;
}
