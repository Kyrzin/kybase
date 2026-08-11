// lib/auth.ts — shared bearer-token auth helpers
// No Node 'crypto' import: kept pure JS so this works identically regardless
// of runtime. Originally required because middleware could run on the Edge
// runtime; as of Next 16, proxy.ts (the renamed convention) is fixed to the
// Node.js runtime, but there's no reason to add the dependency back.

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
