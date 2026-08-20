import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { storeCode } from '@/lib/auth-codes';
import { safeEqual } from '@/lib/auth';
import { authLimitExceeded, recordAuthFailure } from '@/lib/rate-limit';
import { parseRedirectUri, normalizeRedirectUri } from '@/lib/oauth-redirect';
import { getClient, touchClient } from '@/lib/oauth-clients';

export const dynamic = 'force-dynamic';

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Two questions, asked in this order, and both have to answer yes.
//
//  1. Is this callback acceptable to this server at all? — parseRedirectUri
//     (lib/oauth-redirect.ts), the same gate the registration endpoint
//     applies, so a client can never register a URI authorize would refuse.
//  2. Is it one of THIS client's own registered callbacks? — exact match
//     against the row written at registration, which is what OAuth 2.1 and
//     RFC 9700 actually require and what a server-wide list can only
//     approximate.
//
// An unregistered client_id skips step 2 rather than failing it. This server
// accepted an invented client_id long before registration existed, and
// installs that connected under the old scheme still present one; step 1
// still holds for them, so they can never reach a callback a registered
// client couldn't.
async function checkRedirectUri(uri: string, clientId: string): Promise<URL | null> {
  const url = parseRedirectUri(uri);
  if (!url) return null;
  const client = await getClient(clientId);
  if (!client) return url;
  const normalized = normalizeRedirectUri(uri);
  return normalized && client.redirectUris.includes(normalized) ? url : null;
}

function renderForm(params: Record<string, string>, error?: string) {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n      ');

  const redirectHost = parseRedirectUri(params.redirect_uri ?? '')?.host ?? '';

  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kybase — Authorize</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}
    .card{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.12);width:100%;max-width:360px}
    h1{margin:0 0 .5rem;font-size:1.2rem}
    p{color:#555;font-size:.875rem;margin:0 0 1.25rem}
    .error{color:#dc2626;font-size:.875rem;margin-bottom:1rem}
    input[type=password]{width:100%;padding:.6rem .75rem;border:1px solid #d1d5db;border-radius:4px;font-size:1rem;margin-bottom:1rem}
    button{width:100%;padding:.7rem;background:#6366f1;color:#fff;border:none;border-radius:4px;font-size:1rem;cursor:pointer}
    button:hover{background:#4f46e5}
  </style>
</head>
<body>
  <div class="card">
    <h1>Kybase</h1>
    <p>Claude requests access to your Kybase knowledge base. Enter your API key to continue.${redirectHost ? `<br>After sign-in you will be redirected to <strong>${esc(redirectHost)}</strong>.` : ''}</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <form method="POST">
      ${hidden}
      <input type="password" name="secret" placeholder="API key" autofocus>
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`, {
    headers: {
      'Content-Type': 'text/html',
      // The form takes the master secret — never allow it inside a frame.
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
    },
  });
}

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams);
  if (p.response_type !== 'code') {
    return NextResponse.json({ error: 'unsupported_response_type' }, { status: 400 });
  }
  if (!(await checkRedirectUri(p.redirect_uri ?? '', p.client_id ?? ''))) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri must exactly match a registered callback URI (or be a loopback address)' },
      { status: 400 }
    );
  }
  // PKCE is mandatory (S256 only) — without a challenge the code would be
  // exchangeable by anyone who intercepts it.
  if (!p.code_challenge || (p.code_challenge_method ?? 'plain') !== 'S256') {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'PKCE with code_challenge_method=S256 is required' },
      { status: 400 }
    );
  }
  return renderForm(p);
}

export async function POST(req: NextRequest) {
  const body = new URLSearchParams(await req.text());
  const get = (k: string) => body.get(k) ?? '';

  const secret         = process.env.KYBASE_SECRET ?? '';
  const submittedSecret = get('secret');
  const redirectUri    = get('redirect_uri');
  const codeChallenge  = get('code_challenge');
  const codeChallengeMethod = get('code_challenge_method') || 'plain';
  const state          = get('state');
  const clientId       = get('client_id');
  const responseType   = get('response_type');

  const formParams = { client_id: clientId, redirect_uri: redirectUri, code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod, state, response_type: responseType };

  // Credential checked before the bucket — a valid secret must never be
  // blocked by a bucket some other caller filled up (see proxy.ts). The
  // limiter only ever applies once the credential has already failed.
  if (!secret || !safeEqual(submittedSecret, secret)) {
    const retryAfter = authLimitExceeded(req, 'authorize');
    if (retryAfter > 0) {
      return renderForm(formParams, `Too many attempts. Try again in ${retryAfter}s.`);
    }
    recordAuthFailure(req, 'authorize');
    return renderForm(formParams, 'Invalid API key. Please try again.');
  }

  const callbackUrl = await checkRedirectUri(redirectUri, clientId);
  if (!callbackUrl) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri must exactly match a registered callback URI (or be a loopback address)' },
      { status: 400 }
    );
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'PKCE with code_challenge_method=S256 is required' },
      { status: 400 }
    );
  }

  const code = crypto.randomBytes(32).toString('base64url');
  storeCode(code, {
    codeChallenge,
    codeChallengeMethod,
    redirectUri,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  // Marks the registration as actually used, so the ones that were created and
  // abandoned stay distinguishable from the ones in service.
  await touchClient(clientId);

  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', state);

  // 303 See Other forces the OAuth callback to be a GET. Default redirect is
  // 307, which preserves the POST method and makes Claude's callback 405.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: callbackUrl.toString() },
  });
}
