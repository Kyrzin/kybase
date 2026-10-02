// lib/pkce.ts — PKCE verification (RFC 7636), S256 only.
// 'plain' is rejected: it would put the verifier-equivalent in the authorize
// URL (browser history, proxy logs). An empty challenge never verifies, so a
// client that omitted PKCE cannot exchange the code without a verifier.
import crypto from 'crypto';

export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (!verifier || !challenge || method !== 'S256') return false;
  const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
  return hash.length === challenge.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(challenge));
}
