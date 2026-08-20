// Protected-resource metadata, RFC 9728 — served at
// /.well-known/oauth-protected-resource via a rewrite (next.config.ts), the
// same way the authorization-server document is.
//
// This is the document an MCP client looks for FIRST. It does not guess that
// the MCP endpoint and its authorization server live on the same origin: it
// asks the resource which authorization servers it trusts, and only then reads
// that server's own metadata. Measured live 2026-08-20 against a deployed
// instance: this path returned 404, /api/mcp answered 401 with no
// WWW-Authenticate header to point anywhere, and claude.ai's connector gave up
// with "Automatic client registration isn't supported" — a message about the
// step it never got to, not the step that actually failed. Adding dynamic
// registration alone did not fix it, because the client could not find the
// authorization server that offers the registration in the first place.
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const host  = req.headers.get('x-forwarded-host') ?? new URL(req.url).host;
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0] ?? 'https';
  const origin = `${proto}://${host}`;
  return NextResponse.json({
    // The resource identifier is the MCP endpoint itself, not the origin —
    // that is the URL a token issued here is meant to be presented to.
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/Kyrzin/kybase',
  });
}
