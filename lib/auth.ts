// lib/auth.ts — shared bearer-token auth helpers
// No Node 'crypto' import: middleware.ts still uses the pre-v16 convention,
// which may run on the Edge runtime where Node builtins aren't available.
// This stays pure JS so it works identically in Edge and Node.

/** Constant-time string comparison — avoids timing attacks on KYBASE_SECRET. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function bearerToken(req: { headers: { get(name: string): string | null } }): string {
  const auth = req.headers.get('authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}
