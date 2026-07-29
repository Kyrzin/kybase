// middleware.ts — Bearer token auth for all /api/* except /api/auth and /api/mcp
// /api/auth — handles its own validation (login endpoint)
// /api/mcp  — handles its own auth internally (SSE needs no buffering interference)
import { NextRequest, NextResponse } from 'next/server';
import { bearerToken, safeEqual } from '@/lib/auth';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/session';
import { authLimitExceeded, recordAuthFailure } from '@/lib/rate-limit';

export async function middleware(req: NextRequest) {
  const secret = process.env.KYBASE_SECRET;

  if (!secret) {
    return NextResponse.json(
      { error: 'Server misconfigured: KYBASE_SECRET not set' },
      { status: 500 }
    );
  }

  // The browser UI authenticates with a signed session cookie (set by
  // /api/auth/check), never with the master secret itself — unguessable and
  // unrelated to the bearer brute-force budget below, so it's checked first
  // and skips the rate limiter entirely.
  const sessionCookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (sessionCookie && await verifySessionToken(sessionCookie, secret)) {
    return NextResponse.next();
  }

  const token = bearerToken(req);
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
// Every exclusion is anchored ($ or /): a bare prefix like `mcp` would also
// exempt a future /api/mcp2 from auth.
export const config = {
  matcher: ['/api/((?!auth/|mcp$|mcp/|oauth/token$|oauth/discovery$).*)'],
};
