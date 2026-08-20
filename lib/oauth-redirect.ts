// lib/oauth-redirect.ts — what this server will accept as an OAuth callback.
//
// Shared between /authorize (which checks the URI a flow was started with) and
// the registration endpoint (which checks the URIs a client asks to register),
// so the two can't drift into disagreeing about the same string. A client that
// registers successfully must never then be refused at authorize time, and a
// URI refused at registration must never sneak in through authorize.

// claude.ai's connector callback, observed on a real authorization against a
// live instance (2026-08-20) rather than guessed — an exact-match rule built
// on a guessed URI locks every user out with an opaque error.
// KYBASE_OAUTH_REDIRECT_URIS adds more for anyone running a different client.
const DEFAULT_REDIRECT_URIS = ['https://claude.ai/api/mcp/auth_callback'];

// Compared through the URL parser rather than as raw text so two spellings of
// the same callback (a trailing slash, a needlessly percent-encoded character)
// don't read as different URIs. Both sides go through the same normalization;
// nothing is loosened by it — path, query and port all still have to match.
export function normalizeRedirectUri(uri: string): string | null {
  try {
    return new URL(uri).href;
  } catch {
    return null;
  }
}

function configuredRedirectUris(): string[] {
  const extra = (process.env.KYBASE_OAUTH_REDIRECT_URIS ?? '')
    .split(',')
    .map(u => normalizeRedirectUri(u.trim()))
    .filter((u): u is string => u !== null);
  return [...DEFAULT_REDIRECT_URIS, ...extra];
}

export function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/**
 * The server-wide gate every callback must pass, registered or not.
 *
 * The code (and with it access to the whole vault) is sent wherever
 * redirect_uri points, so this is the one check standing between a phishing
 * link and a full-access token. Requiring https is not enough, and neither is
 * trusting the host: an attacker builds their own PKCE pair and mails a victim
 * a link to this server's REAL /authorize with a redirect_uri they control —
 * the victim sees the real domain, submits the real secret, and the code lands
 * on the attacker's server via the 303, PKCE untouched because the attacker
 * holds the matching code_verifier.
 *
 * This gate is why open client registration doesn't reopen that hole. RFC 7591
 * registration cannot be authenticated — a hosted client has no credential
 * before it registers — so without it, anyone could register a client whose
 * callback is their own server and undo the pinning entirely. Registration
 * decides WHICH of the acceptable callbacks a given client may use; it never
 * decides what is acceptable.
 *
 * Loopback is the standard's own exception (RFC 8252): a native client listens
 * on a port that cannot be known in advance, and the code goes back to the
 * machine that started the flow, never to a third party.
 */
export function parseRedirectUri(uri: string): URL | null {
  const normalized = normalizeRedirectUri(uri);
  if (!normalized) return null;
  const url = new URL(normalized);
  if (isLoopback(url)) return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  if (url.protocol !== 'https:') return null;
  return configuredRedirectUris().includes(normalized) ? url : null;
}
