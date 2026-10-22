import type { NextRequest } from 'next/server';

// The issuer this server names in its metadata and returns with every
// authorization code (RFC 9207). Clients compare the two exactly, so every
// place that states it takes it from here.
export function oauthIssuer(req: NextRequest): string {
  const host  = req.headers.get('x-forwarded-host') ?? new URL(req.url).host;
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0] ?? 'https';
  return `${proto}://${host}`;
}
