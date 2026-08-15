// lib/route-auth.ts — self-service auth for routes excluded from proxy.ts's
// matcher.
//
// /api/import and /api/notes/import-document are deliberately NOT protected
// by proxy.ts (see its matcher comment): this Next version's
// proxyClientMaxBodySize makes the framework clone and buffer the request
// body before proxy.ts's code ever runs, which means an unauthenticated
// caller could make the server pay for buffering a huge body just to get
// rejected. These two routes authenticate themselves instead, using only
// headers/cookies, before touching any part of the body — mirroring
// proxy.ts's own logic (session cookie, or the master secret — nothing
// else) and the response shapes it already returns, so behavior is
// unchanged from the caller's point of view; only *where* the check
// happens does.
//
// Deliberately NOT accepting a revocable OAuth token (lib/tokens.ts) here,
// even though verifyToken() is one import away: those tokens are scoped to
// the MCP endpoint only (SECURITY.md, "Tokens authenticate only the MCP
// endpoint — they cannot log into the UI, call the REST API..."), and no
// MCP tool calls either of these two routes — accepting a token here would
// silently widen its scope past what's documented, for zero functional
// benefit. Found live during pre-publication review: an earlier version of
// this file DID call verifyToken() here, contradicting both SECURITY.md and
// this file's own "mirrors proxy.ts" claim above (proxy.ts itself never
// calls verifyToken() — check its own auth function to confirm before
// trusting this comment over the code).
//
// Checks the credential before the rate-limit bucket, same as proxy.ts and
// /api/mcp/route.ts: a valid session/secret is never blocked by a bucket
// some other caller filled up. Rate limiting only ever applies to the
// invalid-credential path.
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
