// POST /api/auth/check — validate the user's secret password
// Returns {ok: true} on match, 401 on mismatch
// Not protected by middleware — this IS the auth endpoint
import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/auth';
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { authLimitExceeded, recordAuthFailure } from '@/lib/rate-limit';

export async function POST(req: NextRequest) {
  const retryAfter = authLimitExceeded(req, 'auth-check');
  if (retryAfter > 0) {
    return NextResponse.json(
      { error: 'Too many attempts, try again later' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } }
    );
  }

  const body = await req.json().catch(() => ({}));
  const { secret } = body as { secret?: string };

  const expected = process.env.KYBASE_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  if (!secret || !safeEqual(secret, expected)) {
    recordAuthFailure(req, 'auth-check');
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  // secure requires HTTPS on the connection the browser actually used. Behind
  // a TLS-terminating reverse proxy (this app's typical deployment) that's
  // x-forwarded-proto, not req.nextUrl.protocol — Next sees the plaintext
  // hop from the proxy. Falls back to nextUrl for direct, unproxied HTTP.
  const isHttps = req.headers.get('x-forwarded-proto') === 'https' || req.nextUrl.protocol === 'https:';
  res.cookies.set(SESSION_COOKIE_NAME, await createSessionToken(expected), {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
