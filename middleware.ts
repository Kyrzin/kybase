// middleware.ts — Bearer token auth for all /api/* except /api/auth and /api/mcp
// /api/auth — handles its own validation (login endpoint)
// /api/mcp  — handles its own auth internally (SSE needs no buffering interference)
import { NextRequest, NextResponse } from 'next/server';
import { bearerToken, safeEqual } from '@/lib/auth';
import { authLimitExceeded, recordAuthFailure } from '@/lib/rate-limit';

export function middleware(req: NextRequest) {
  const token  = bearerToken(req);
  const secret = process.env.KYBASE_SECRET;

  if (!secret) {
    return NextResponse.json(
      { error: 'Server misconfigured: KYBASE_SECRET not set' },
      { status: 500 }
    );
  }
  // Any protected route verifies the same secret, so any of them could be
  // used for brute force — count failed bearer checks like login failures.
  // (If middleware runs in an isolated runtime its counters are separate
  // from the /api/mcp 'bearer' bucket; both still enforce independently.)
  const retryAfter = authLimitExceeded(req, 'bearer');
  if (retryAfter > 0) {
    return NextResponse.json(
      { error: 'Too many failed attempts' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } }
    );
  }
  if (!safeEqual(token, secret)) {
    recordAuthFailure(req, 'bearer');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.next();
}

// Protect /api/* except /api/auth/* (the login endpoint), /api/mcp (handles
// its own auth), and the two public OAuth endpoints. /api/oauth/clients is
// deliberately NOT excluded — listing/revoking tokens requires the master
// secret, so a leaked OAuth token can't enumerate or revoke its peers.
// /authorize is public by location (not under /api).
export const config = {
  matcher: ['/api/((?!auth/|mcp|oauth/token|oauth/discovery).*)'],
};
