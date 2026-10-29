import type { NextRequest } from 'next/server';

let warnedInvalid = false;

// The address Kybase is reached at, for every URL it hands out: OAuth
// metadata, the MCP sign-in hint, share links. KYBASE_PUBLIC_URL fixes it;
// without it, it comes from the reverse proxy's headers, which anyone who
// reaches Kybase directly can set.
export function publicOrigin(req: NextRequest): string {
  const configured = process.env.KYBASE_PUBLIC_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      // not a URL; falls back below
    }
    if (!warnedInvalid) {
      warnedInvalid = true;
      console.warn('[config] KYBASE_PUBLIC_URL is not an http(s) URL; using the address from the request');
    }
  }
  const host  = req.headers.get('x-forwarded-host') ?? new URL(req.url).host;
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0] ?? 'https';
  return `${proto}://${host}`;
}

// The issuer this server names in its metadata and returns with every
// authorization code (RFC 9207). Clients compare the two exactly, so every
// place that states it takes it from here.
export function oauthIssuer(req: NextRequest): string {
  return publicOrigin(req);
}
