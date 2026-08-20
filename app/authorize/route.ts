import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { storeCode } from '@/lib/auth-codes';
import { safeEqual } from '@/lib/auth';
import { authLimitExceeded, recordAuthFailure } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// claude.ai's connector is the only hosted OAuth client this server
// documents — every other client in the README (Claude Code, Claude Desktop,
// Cursor, Windsurf) authenticates with a static Bearer token and never walks
// this flow. The value below is not a guess: it is the redirect_uri observed
// on a real connector authorization, 2026-08-20. KYBASE_OAUTH_REDIRECT_URIS
// adds more without a code change, for anyone running a different client.
const DEFAULT_REDIRECT_URIS = ['https://claude.ai/api/mcp/auth_callback'];

// Compared through the URL parser rather than as raw text so that two
// spellings of the same callback (a trailing slash, a percent-encoded
// character that needn't be) don't read as different URIs. Both sides go
// through the same normalization; nothing about the comparison is loosened —
// path, query and port all still have to match exactly.
function normalizeUri(uri: string): string | null {
  try {
    return new URL(uri).href;
  } catch {
    return null;
  }
}

function allowedRedirectUris(): string[] {
  const extra = (process.env.KYBASE_OAUTH_REDIRECT_URIS ?? '')
    .split(',')
    .map(u => normalizeUri(u.trim()))
    .filter((u): u is string => u !== null);
  return [...DEFAULT_REDIRECT_URIS, ...extra];
}

// The code (and with it the master secret) is sent wherever redirect_uri
// points, so this is the one check standing between a phishing link and a
// full-access token. Requiring https is not enough, and neither is trusting
// the host: an attacker builds their own PKCE pair and mails a victim a link
// to this server's REAL /authorize with a redirect_uri they control — the
// victim sees the real domain, submits the real secret, and the code lands
// on the attacker's server via the 303, PKCE untouched because the attacker
// holds the matching code_verifier. Host-level allowlisting narrows that to
// "any path on an allowed host", which still falls to an open redirect on
// the allowed host itself.
//
// So: the WHOLE redirect_uri must match a registered one, which is what
// OAuth 2.1 and RFC 9700 require and what the MCP spec inherits from them.
//
// Loopback is the standard's own exception (RFC 8252): a native client
// listens on a random port that cannot be registered ahead of time, so there
// the port — and, with no client registration in this server, the path — are
// not pinned. Nothing reaches a third party there: the code goes back to the
// same machine that started the flow.
function parseRedirectUri(uri: string): URL | null {
  const normalized = normalizeUri(uri);
  if (!normalized) return null;
  const url = new URL(normalized);
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (isLoopback) return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  if (url.protocol !== 'https:') return null;
  return allowedRedirectUris().includes(normalized) ? url : null;
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
  if (!parseRedirectUri(p.redirect_uri ?? '')) {
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

  const callbackUrl = parseRedirectUri(redirectUri);
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

  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', state);

  // 303 See Other forces the OAuth callback to be a GET. Default redirect is
  // 307, which preserves the POST method and makes Claude's callback 405.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: callbackUrl.toString() },
  });
}
