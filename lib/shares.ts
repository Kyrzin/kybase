// lib/shares.ts — public read-only share links (see db/migrations/008).
import crypto from 'crypto';
import { query, queryOne } from './db';

export type Share = { token: string; note_id: string; created_at: string; expires_at: string | null };
export type ShareListItem = Share & { note_title: string };
export type SharedNote = { title: string; content: string; updated_at: string };

export async function createShare(noteId: string, expiresInDays?: number): Promise<Share | null> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null;
  const row = await queryOne<Share>(
    `insert into note_shares (token, note_id, expires_at)
     select $1, id, $2 from notes where id = $3
     returning token, note_id, created_at, expires_at`,
    [token, expiresAt, noteId]
  );
  return row; // null when the note doesn't exist
}

export async function revokeShare(noteId: string, token: string): Promise<boolean> {
  const rows = await query<{ token: string }>(
    'delete from note_shares where note_id = $1 and token = $2 returning token',
    [noteId, token]
  );
  return rows.length > 0;
}

export async function listShares(): Promise<ShareListItem[]> {
  return query<ShareListItem>(
    `select s.token, s.note_id, s.created_at, s.expires_at, n.title as note_title
     from note_shares s join notes n on n.id = s.note_id
     where s.expires_at is null or s.expires_at > now()
     order by s.created_at desc`
  );
}

/**
 * The single lookup the public route is allowed to make. Missing, revoked,
 * and expired tokens all take this same path and all return null — the
 * caller can't distinguish them by response or by timing. Only fields safe
 * to show anonymously are selected.
 */
export async function getSharedNote(token: string): Promise<SharedNote | null> {
  if (!token) return null;
  return queryOne<SharedNote>(
    `select n.title, n.content, n.updated_at
     from note_shares s join notes n on n.id = s.note_id
     where s.token = $1 and (s.expires_at is null or s.expires_at > now())`,
    [token]
  );
}
