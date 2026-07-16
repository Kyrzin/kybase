// POST /api/auth/check — validate the user's secret password
// Returns {ok: true} on match, 401 on mismatch
// Not protected by middleware — this IS the auth endpoint
import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/auth';
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
  return NextResponse.json({ ok: true });
}
