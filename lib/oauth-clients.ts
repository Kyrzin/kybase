// lib/oauth-clients.ts — clients registered through RFC 7591 (migration 027).
//
// Hosted MCP clients will not authorize against a server without a registration
// endpoint. Registration also gives each client the list of redirect URIs that
// OAuth 2.1 compares against.
import crypto from 'crypto';
import { query as dbQuery } from './db';

export type OAuthClient = {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
};

/**
 * Registers a client and returns its issued id.
 *
 * Callers MUST have already put every URI through parseRedirectUri
 * (lib/oauth-redirect.ts). Registration chooses which acceptable callback a
 * client uses; it does not get to decide what is acceptable — see the note
 * there for why that split is what keeps open registration safe.
 */
export async function registerClient(clientName: string | null, redirectUris: string[]): Promise<OAuthClient> {
  const clientId = crypto.randomBytes(16).toString('base64url');
  await dbQuery(
    'insert into oauth_clients (client_id, client_name, redirect_uris) values ($1, $2, $3)',
    [clientId, clientName, redirectUris]
  );
  return { clientId, clientName, redirectUris };
}

/**
 * A registered client, or null. Null is not an error: unregistered client_ids
 * are still accepted for clients that connected before registration existed.
 * They fall back to the server-wide callback list, the same gate registration
 * enforces, so an unregistered client never reaches a callback a registered
 * one couldn't.
 */
export async function getClient(clientId: string): Promise<OAuthClient | null> {
  if (!clientId) return null;
  try {
    const rows = await dbQuery<{ client_id: string; client_name: string | null; redirect_uris: string[] }>(
      'select client_id, client_name, redirect_uris from oauth_clients where client_id = $1',
      [clientId]
    );
    if (rows.length === 0) return null;
    return { clientId: rows[0].client_id, clientName: rows[0].client_name, redirectUris: rows[0].redirect_uris };
  } catch (err) {
    // A lookup failure must not be readable as "not registered" — that would
    // silently downgrade a registered client to the looser fallback path the
    // moment the database hiccups. Refuse instead.
    throw new Error(`oauth client lookup failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Best-effort: a registration that is never used is prunable, one that is isn't. */
export async function touchClient(clientId: string): Promise<void> {
  try {
    await dbQuery('update oauth_clients set last_used_at = now() where client_id = $1', [clientId]);
  } catch {
    // Bookkeeping only — never fail an authorization over it.
  }
}
