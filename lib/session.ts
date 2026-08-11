// lib/session.ts — stateless, signed UI session cookies.
//
// The browser login used to store KYBASE_SECRET itself in localStorage and
// replay it as the bearer token on every request. Any script running on the
// page (an XSS payload, a compromised dependency) could read it with one
// line, and unlike a session it can't be revoked short of rotating the
// secret and restarting the server. A session token here is instead an
// expiry, HMAC-signed with the server secret, held in a cookie the page's
// own JS can never read (httpOnly) — the worst a leak-that-never-happens
// costs is one 30-day cookie, not the root credential.
//
// No database: proxy.ts verifies this on every protected request and is
// meant to stay independent of the main app (see lib/tokens.ts) — the
// Postgres driver used for revocable OAuth tokens has no place here anyway.
// Web Crypto (crypto.subtle) is a standard global regardless of runtime, so
// this file avoids Node's 'crypto' module the same way lib/auth.ts does.
const SESSION_COOKIE_NAME = 'kybase_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days, fixed (no sliding refresh)

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/** Issues a signed session token. `secret` is always KYBASE_SECRET. */
export async function createSessionToken(secret: string): Promise<string> {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 })));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Verifies signature and expiry. Never throws — malformed input is just invalid. */
export async function verifySessionToken(token: string, secret: string): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;

  let exp: unknown;
  try {
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64Url(signature), new TextEncoder().encode(payload));
    if (!valid) return false;
    ({ exp } = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))));
  } catch {
    return false;
  }
  return typeof exp === 'number' && exp > Date.now();
}

export { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS };
