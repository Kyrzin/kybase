// proxy.ts — Bearer token auth for all /api/* except /api/auth, /api/mcp,
// /api/import, and /api/notes/import-document
// (renamed from middleware.ts per Next.js 16; file convention only, behavior
// is unchanged — see node_modules/next/dist/docs/.../proxy.md)
// /api/auth — handles its own validation (login endpoint)
// /api/mcp  — handles its own auth internally (SSE needs no buffering interference)
// /api/import, /api/notes/import-document — handle their own auth internally
// (lib/route-auth.ts) purely so they're excluded from this matcher: while
// proxy is active for a route, this Next version clones and buffers that
// route's request body (up to proxyClientMaxBodySize, next.config.ts) before
// proxy.ts's code ever runs — so even a request with a bad/missing Bearer
// token pays for buffering its whole body before getting rejected. These two
// routes accept large file uploads, so they can't be behind that buffering
// and still authenticate cheaply; excluding them here and checking auth
// themselves on headers alone (before reading the body) closes that gap.
import { NextRequest, NextResponse } from 'next/server';
import { bearerToken, safeEqual } from '@/lib/auth';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/session';
import { authLimitExceeded, recordAuthFailure } from '@/lib/rate-limit';

export async function proxy(req: NextRequest) {
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
  // Credential checked before the bucket: GLOBAL_LIMIT isn't IP-scoped, so
  // checking the bucket first let anyone who could reach this port lock the
  // real secret holder out with a burst of garbage tokens (measured: 35
  // bogus requests -> the valid secret itself gets 429). A valid secret must
  // never be blocked by a bucket some other caller filled up; the limiter
  // only ever applies to the invalid-credential path below.
  if (safeEqual(token, secret)) {
    return NextResponse.next();
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
  recordAuthFailure(req, 'bearer');
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

// Protect /api/* except /api/auth/* (the login endpoint), /api/mcp (handles
// its own auth), /api/import and /api/notes/import-document (handle their
// own auth — see the file header comment), and the two public OAuth
// endpoints. /api/oauth/clients is deliberately NOT excluded —
// listing/revoking tokens requires the master secret, so a leaked OAuth
// token can't enumerate or revoke its peers. /authorize is public by
// location (not under /api).
// Every exclusion is anchored ($ or /): a bare prefix like `mcp` would also
// exempt a future /api/mcp2 from auth.
export const config = {
  // oauth/register joins token and discovery for the same reason they are
  // here: it is part of the flow a client walks BEFORE it has any credential
  // to present. Registration behind the master secret is registration no
  // hosted client can reach, which is the same as not having it — and the
  // endpoint is not therefore unguarded: it rate-limits itself and refuses any
  // callback the server wouldn't accept anyway (app/api/oauth/register).
  matcher: ['/api/((?!auth/|mcp$|mcp/|oauth/token$|oauth/discovery$|oauth/register$|import$|notes/import-document$).*)'],
};
