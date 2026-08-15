import { NextRequest, NextResponse } from 'next/server';
import { consumeCode } from '@/lib/auth-codes';
import { safeEqual } from '@/lib/auth';
import { verifyPkce } from '@/lib/pkce';
import { issueToken } from '@/lib/tokens';
import { authLimitExceeded, recordAuthFailure } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Both grants verify a guessable credential (code or client_secret) — keep
// brute force off the table. Credential checked before the bucket, same as
// proxy.ts: called only from a failure branch below, after the credential
// has already been shown invalid, never unconditionally up front — a valid
// code/secret must never be blocked by a bucket some other caller filled up.
function rateLimitedFailure(req: NextRequest, body: Record<string, string>, status: number): NextResponse {
  const retryAfter = authLimitExceeded(req, 'oauth-token');
  if (retryAfter > 0) {
    return NextResponse.json(
      { error: 'slow_down' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } }
    );
  }
  recordAuthFailure(req, 'oauth-token');
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest) {
  const secret = process.env.KYBASE_SECRET;
  if (!secret) return NextResponse.json({ error: 'server_error' }, { status: 500 });

  const contentType = req.headers.get('content-type') ?? '';
  let params: URLSearchParams;

  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => ({}));
    params = new URLSearchParams(body);
  } else {
    params = new URLSearchParams(await req.text());
  }

  const grantType = params.get('grant_type');

  if (grantType === 'authorization_code') {
    const code         = params.get('code') ?? '';
    const codeVerifier = params.get('code_verifier') ?? '';
    const redirectUri  = params.get('redirect_uri') ?? '';

    const entry = consumeCode(code);
    if (!entry) {
      return rateLimitedFailure(req, { error: 'invalid_grant' }, 400);
    }
    if (entry.redirectUri !== redirectUri) {
      return rateLimitedFailure(req, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
    }
    if (!verifyPkce(codeVerifier, entry.codeChallenge, entry.codeChallengeMethod)) {
      return rateLimitedFailure(req, { error: 'invalid_grant', error_description: 'pkce verification failed' }, 400);
    }

    // A real, revocable token — never the master secret (see lib/tokens.ts).
    const { token, expiresAt } = await issueToken(params.get('client_id') ?? 'mcp-client');
    return NextResponse.json({
      access_token: token,
      token_type: 'bearer',
      expires_in: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    });
  }

  if (grantType === 'client_credentials') {
    let clientSecret: string | null = params.get('client_secret');
    if (!clientSecret) {
      const basic = req.headers.get('authorization') ?? '';
      if (basic.startsWith('Basic ')) {
        const decoded = Buffer.from(basic.slice(6), 'base64').toString();
        clientSecret = decoded.split(':')[1] ?? null;
      }
    }
    if (!clientSecret || !safeEqual(clientSecret, secret)) {
      return rateLimitedFailure(req, { error: 'invalid_client' }, 401);
    }
    const { token, expiresAt } = await issueToken(params.get('client_id') ?? 'client-credentials');
    return NextResponse.json({
      access_token: token,
      token_type: 'bearer',
      expires_in: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    });
  }

  return NextResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
}
