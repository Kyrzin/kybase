import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { consumeCode } from '@/lib/auth-codes';
import { safeEqual } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method === 'S256') {
    const hash = crypto.createHash('sha256').update(verifier).digest('base64url');
    return hash === challenge;
  }
  return verifier === challenge;
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
      return NextResponse.json({ error: 'invalid_grant' }, { status: 400 });
    }
    if (entry.redirectUri !== redirectUri) {
      return NextResponse.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, { status: 400 });
    }
    if (!verifyPkce(codeVerifier, entry.codeChallenge, entry.codeChallengeMethod)) {
      return NextResponse.json({ error: 'invalid_grant', error_description: 'pkce verification failed' }, { status: 400 });
    }

    return NextResponse.json({ access_token: secret, token_type: 'bearer', expires_in: 3600 });
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
      return NextResponse.json({ error: 'invalid_client' }, { status: 401 });
    }
    return NextResponse.json({ access_token: secret, token_type: 'bearer', expires_in: 3600 });
  }

  return NextResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
}
