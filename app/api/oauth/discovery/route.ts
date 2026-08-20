import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const host  = req.headers.get('x-forwarded-host') ?? new URL(req.url).host;
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0] ?? 'https';
  const origin = `${proto}://${host}`;
  return NextResponse.json({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    // Hosted MCP clients read this document and refuse the server outright
    // when registration_endpoint is missing — measured live 2026-08-20:
    // "Incompatible auth server: does not support dynamic client
    // registration", raised before the consent page is ever requested.
    registration_endpoint: `${origin}/api/oauth/register`,
    // 'none' belongs here because the authorization_code grant takes no client
    // secret at all (app/api/oauth/token/route.ts) — it is a public client
    // authenticated by PKCE. Advertising only the two secret-bearing methods
    // described a server this one never was.
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    grant_types_supported: ['authorization_code', 'client_credentials'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
  });
}
