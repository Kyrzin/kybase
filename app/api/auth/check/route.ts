// POST /api/auth/check — validate the user's secret password
// Returns {ok: true} on match, 401 on mismatch
// Not protected by middleware — this IS the auth endpoint
import { NextRequest, NextResponse } from 'next/server';
import { safeEqual } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { secret } = body as { secret?: string };

  const expected = process.env.KYBASE_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }
  if (!secret || !safeEqual(secret, expected)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
