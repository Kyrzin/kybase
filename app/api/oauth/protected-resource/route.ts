// Protected-resource metadata, RFC 9728 — served at
// /.well-known/oauth-protected-resource via a rewrite (next.config.ts), the
// same way the authorization-server document is.
//
// This is the document an MCP client reads first: it asks the resource which
// authorization servers it trusts instead of assuming they share its origin,
// then reads that server's metadata. Without it (and the WWW-Authenticate
// header on a 401 from /api/mcp) a client cannot find the registration endpoint.
import { NextRequest, NextResponse } from 'next/server';
import { oauthIssuer } from '@/lib/oauth-issuer';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  // authorization_servers must equal the issuer exactly.
  const origin = oauthIssuer(req);
  return NextResponse.json({
    // The resource identifier is the MCP endpoint itself, not the origin —
    // that is the URL a token issued here is meant to be presented to.
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/Kyrzin/kybase',
  });
}
