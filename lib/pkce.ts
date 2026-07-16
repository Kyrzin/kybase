// lib/pkce.ts — PKCE verification (RFC 7636), S256 only.
// 'plain' is rejected: it would put the verifier-equivalent in the authorize
// URL (browser history, proxy logs), and an empty challenge must never verify
// — verifyPkce('', '', 'plain') used to return true, letting a client that
// simply omitted PKCE exchange the code without any verifier.
import crypto from 'crypto';

export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (!verifier || !challenge || method !== 'S256') return false;
  const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
  return hash.length === challenge.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(challenge));
}
