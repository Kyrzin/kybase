import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { storeCode } from '@/lib/auth-codes';
import { safeEqual } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderForm(params: Record<string, string>, error?: string) {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n      ');

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
    <p>Claude requests access to your Kybase knowledge base. Enter your API key to continue.</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <form method="POST">
      ${hidden}
      <input type="password" name="secret" placeholder="API key" autofocus>
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`, { headers: { 'Content-Type': 'text/html' } });
}

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams);
  if (p.response_type !== 'code') {
    return NextResponse.json({ error: 'unsupported_response_type' }, { status: 400 });
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

  if (!secret || !safeEqual(submittedSecret, secret)) {
    return renderForm(formParams, 'Invalid API key. Please try again.');
  }

  const code = crypto.randomBytes(32).toString('base64url');
  storeCode(code, {
    codeChallenge,
    codeChallengeMethod,
    redirectUri,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const callback = new URL(redirectUri);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', state);

  // 303 See Other forces the OAuth callback to be a GET. Default redirect is
  // 307, which preserves the POST method and makes Claude's callback 405.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: callback.toString() },
  });
}
