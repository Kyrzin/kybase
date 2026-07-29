// lib/trash.ts — soft delete for notes (see db/migrations/011).
//
// delete_note used to be instant and permanent, callable by anything holding
// the master secret or an MCP token, with no confirmation. Notes are also
// populated by an agent from external content, so a prompt-injected "clean
// up the vault" instruction could wipe real data with nothing to recover.
// softDeleteNote just hides the row (deleted_at); every read path across the
// app filters deleted_at is null, so a trashed note behaves as gone
// everywhere except restore_note/listTrash. Purge is opportunistic, same
// pattern as lib/tokens.ts's oauth_tokens cleanup — no cron needed.
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
