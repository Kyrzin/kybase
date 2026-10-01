// lib/route-auth.ts — self-service auth for routes excluded from proxy.ts's
// matcher.
//
// The import routes are outside proxy.ts's matcher, because the framework
// buffers a request body before proxy code runs; they authenticate here from
// headers and cookies alone, before reading the body. Same rules as proxy.ts:
// session cookie or the instance secret. OAuth tokens are scoped to MCP only
// and are not accepted. Credential first, then the rate-limit bucket.
import { NextRequest, NextResponse } from 'next/server';
import { bearerToken, safeEqual } from './auth';
import { verifySessionToken, SESSION_COOKIE_NAME } from './session';
import { authLimitExceeded, recordAuthFailure } from './rate-limit';

const BUCKET = 'bearer'; // same brute-force budget as proxy.ts and /api/mcp — same secret, same risk.

/**
 * Returns null if the request is authorized, or the NextResponse to send
 * back otherwise (401/429/500). Call this before reading any part of the
 * request body.
 */
export async function requireAuth(req: NextRequest): Promise<NextResponse | null> {
  const secret = process.env.KYBASE_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'Server misconfigured: KYBASE_SECRET not set' },
      { status: 500 }
    );
  }

  // Browser UI credential — unguessable and unrelated to the bearer
  // brute-force budget, so it's checked first and never touches the limiter.
  const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (sessionCookie && await verifySessionToken(sessionCookie, secret)) {
    return null;
  }

  const token = bearerToken(req);
  if (safeEqual(token, secret)) {
    return null;
  }

  const retryAfter = authLimitExceeded(req, BUCKET);
  if (retryAfter > 0) {
    return NextResponse.json(
      { error: 'Too many failed attempts' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } }
    );
  }
  recordAuthFailure(req, BUCKET);
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * Who note history records a REST write as made by, for a request that is
 * already authorized: 'web' for the browser UI's session cookie, 'api' for
 * the master secret. Checked in the same order as the auth itself, so a
 * request carrying both is the browser's.
 */
export async function requestActor(req: NextRequest): Promise<'web' | 'api'> {
  const secret = process.env.KYBASE_SECRET;
  const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  return secret && sessionCookie && await verifySessionToken(sessionCookie, secret) ? 'web' : 'api';
}
