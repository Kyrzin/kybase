// lib/tokens.ts — revocable OAuth access tokens for MCP clients.
//
// Scope, deliberately: these tokens authenticate the MCP endpoint only.
// The browser UI and REST API keep using the master secret (verified in
// middleware, which may run where the database driver can't). The master
// secret is also always accepted at the MCP endpoint, so existing
// deployments keep working untouched.
//
// Only the sha256 of a token is stored — a database dump doesn't contain
// usable credentials. Expiry is sliding: 90 days from last use, extended
// at most once per hour so verification stays read-mostly.
import crypto from 'crypto';
import { query, queryOne } from './db';

const TOKEN_TTL_DAYS = 90;
const EXTEND_THROTTLE_MS = 60 * 60 * 1000;

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function issueToken(clientName?: string): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await query(
    'insert into oauth_tokens (token_hash, client_name, expires_at) values ($1, $2, $3)',
    [hashToken(token), clientName?.slice(0, 200) ?? null, expiresAt]
  );
  // Opportunistic housekeeping — expired rows are useless and unrevokable-looking.
  await query('delete from oauth_tokens where expires_at < now()');
  return { token, expiresAt };
}

export async function verifyToken(token: string): Promise<boolean> {
  if (!token) return false;
  const row = await queryOne<{ id: string; last_used_at: string }>(
    'select id, last_used_at from oauth_tokens where token_hash = $1 and expires_at > now()',
    [hashToken(token)]
  );
  if (!row) return false;
  if (Date.now() - new Date(row.last_used_at).getTime() > EXTEND_THROTTLE_MS) {
    await query(
      `update oauth_tokens set last_used_at = now(),
        expires_at = now() + interval '${TOKEN_TTL_DAYS} days' where id = $1`,
      [row.id]
    );
  }
  return true;
}

export type TokenInfo = {
  id: string;
  client_name: string | null;
  created_at: string;
  last_used_at: string;
  expires_at: string;
};

export async function listTokens(): Promise<TokenInfo[]> {
  return query<TokenInfo>(
    `select id, client_name, created_at, last_used_at, expires_at
     from oauth_tokens where expires_at > now()
     order by last_used_at desc`
  );
}

export async function revokeToken(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>('delete from oauth_tokens where id = $1 returning id', [id]);
  return rows.length > 0;
}
