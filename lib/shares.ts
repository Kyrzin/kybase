// lib/shares.ts — public read-only share links (see db/migrations/008, 015).
import crypto from 'crypto';
import { query, queryOne } from './db';
import { hashToken } from './tokens';
import { encryptWithSecret, decryptWithSecret, isEncrypted } from './secret-box';

export type Share = { id: string; token: string; note_id: string; created_at: string; expires_at: string | null };
// token is null for a share created before migration 015 — its link can't
// be reconstructed (SQL migrations can't encrypt, see that file's comment)
// so the Access tab can revoke it but not offer Copy. Every share created
// from here on always has one.
export type ShareListItem = { id: string; token: string | null; note_id: string; created_at: string; expires_at: string | null; note_title: string };
export type SharedNote = { title: string; content: string; updated_at: string };

function requireSecret(): string {
  const secret = process.env.KYBASE_SECRET;
  if (!secret) throw new Error('KYBASE_SECRET env var is missing');
  return secret;
}

export async function createShare(noteId: string, expiresInDays?: number): Promise<Share | null> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null;
  const row = await queryOne<{ id: string; note_id: string; created_at: string; expires_at: string | null }>(
    `insert into note_shares (token_hash, token_encrypted, note_id, expires_at)
     select $1, $2, id, $3 from notes where id = $4 and deleted_at is null
     returning id, note_id, created_at, expires_at`,
    [hashToken(token), encryptWithSecret(token, requireSecret()), expiresAt, noteId]
  );
  return row ? { token, ...row } : null; // null when the note doesn't exist (or is trashed)
}

/** shareId is note_shares.id (a uuid, not the secret token) — the token itself never needs to round-trip through a revoke URL. */
export async function revokeShare(noteId: string, shareId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'delete from note_shares where note_id = $1 and id = $2 returning id',
    [noteId, shareId]
  );
  return rows.length > 0;
}

export async function listShares(): Promise<ShareListItem[]> {
  const rows = await query<{ id: string; token_encrypted: string | null; note_id: string; created_at: string; expires_at: string | null; note_title: string }>(
    `select s.id, s.token_encrypted, s.note_id, s.created_at, s.expires_at, n.title as note_title
     from note_shares s join notes n on n.id = s.note_id
     where (s.expires_at is null or s.expires_at > now()) and n.deleted_at is null
     order by s.created_at desc`
  );
  const secret = process.env.KYBASE_SECRET;
  return rows.map(({ token_encrypted, ...rest }) => ({
    token: secret && token_encrypted && isEncrypted(token_encrypted) ? decryptWithSecret(token_encrypted, secret) : null,
    ...rest,
  }));
}

/**
 * The single lookup the public route is allowed to make. Missing, revoked,
 * and expired tokens all take this same path and all return null — the
 * caller can't distinguish them by response or by timing. Only fields safe
 * to show anonymously are selected.
 *
 * n.deleted_at is null matters here specifically: soft-deleting a note no
 * longer cascades away its note_shares row (that only happens on the real,
 * post-retention purge), so without this check a trashed note's share link
 * would keep serving its content to the public indefinitely.
 */
export async function getSharedNote(token: string): Promise<SharedNote | null> {
  if (!token) return null;
  // content_updated_at, not updated_at: a rename elsewhere rewriting a
  // [[link]] inside this note must not make an anonymous viewer see a
  // fresh "last updated" that nobody actually earned (migration 020).
  return queryOne<SharedNote>(
    `select n.title, n.content, n.content_updated_at as updated_at
     from note_shares s join notes n on n.id = s.note_id
     where s.token_hash = $1 and (s.expires_at is null or s.expires_at > now()) and n.deleted_at is null`,
    [hashToken(token)]
  );
}
