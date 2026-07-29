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
