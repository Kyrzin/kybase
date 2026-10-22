import { NextRequest, NextResponse } from 'next/server';
import { oauthIssuer } from '@/lib/oauth-issuer';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const origin = oauthIssuer(req);
  return NextResponse.json({
    issuer: origin,
    // /authorize returns `iss` with every code, and its errors never redirect
    // to the client. ChatGPT uses its fixed callback only when this is true.
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    // Hosted MCP clients refuse a server whose metadata lacks this.
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
