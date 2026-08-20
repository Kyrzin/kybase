// POST /api/oauth/register — dynamic client registration, RFC 7591.
//
// Deliberately unauthenticated, because it cannot be otherwise: a hosted MCP
// client has no credential to present before it has registered, which is the
// whole point of the mechanism. What keeps that from being a hole is that
// registration does NOT widen where a code can be sent — every requested
// callback still has to pass the same server-wide gate /authorize applies
// (lib/oauth-redirect.ts). An attacker can register a client; they cannot
// register their own callback, so there is nowhere for a stolen code to go.
//
// Rate-limited all the same: the endpoint writes a row per call, and an open
// write surface with no ceiling is a way to fill a disk even when it isn't a
// way to steal anything.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseRedirectUri, normalizeRedirectUri } from '@/lib/oauth-redirect';
import { registerClient } from '@/lib/oauth-clients';
import { authLimitExceeded, recordAuthFailure } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// RFC 7591 §2: unknown metadata fields are ignored rather than rejected, so a
// client sending the full set it uses elsewhere isn't turned away over a field
// this server has no opinion about.
const RegistrationSchema = z.object({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().max(200).optional(),
}).passthrough();

export async function POST(req: NextRequest) {
  const retryAfter = authLimitExceeded(req, 'oauth-register');
  if (retryAfter > 0) {
    return NextResponse.json(
      { error: 'temporarily_unavailable' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } }
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = RegistrationSchema.safeParse(body);
  if (!parsed.success) {
    recordAuthFailure(req, 'oauth-register');
    return NextResponse.json(
      { error: 'invalid_client_metadata', error_description: 'redirect_uris is required and must be a non-empty array' },
      { status: 400 }
    );
  }

  // Every requested callback, not just the first: a client that registers one
  // acceptable URI alongside one of its own would otherwise walk away with a
  // usable attacker-controlled callback attached to a legitimate client_id.
  const requested = parsed.data.redirect_uris;
  const rejected = requested.filter(uri => parseRedirectUri(uri) === null);
  if (rejected.length > 0) {
    recordAuthFailure(req, 'oauth-register');
    return NextResponse.json(
      {
        error: 'invalid_redirect_uri',
        // Named explicitly — an owner running a client this server doesn't know
        // about has to be able to tell "your URI is not allowed here" from
        // "registration is broken", and the fix is one environment variable.
        error_description:
          'redirect_uri is not an accepted callback for this server. Loopback addresses are always accepted; ' +
          'others must be listed in KYBASE_OAUTH_REDIRECT_URIS.',
      },
      { status: 400 }
    );
  }

  const normalized = requested
    .map(normalizeRedirectUri)
    .filter((u): u is string => u !== null);

  try {
    const client = await registerClient(parsed.data.client_name ?? null, normalized);
    // RFC 7591 §3.2.1: 201 with the issued id and the metadata as registered.
    // No client_secret — the only grant available here is authorization_code
    // with PKCE, i.e. a public client (app/api/oauth/token/route.ts).
    return NextResponse.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: client.redirectUris,
        ...(client.clientName ? { client_name: client.clientName } : {}),
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      { status: 201 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'registration failed';
    return NextResponse.json({ error: 'server_error', error_description: message }, { status: 500 });
  }
}
