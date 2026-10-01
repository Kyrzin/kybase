// POST /api/auth/logout — clear the UI session cookie.
// Not protected by proxy.ts (same exclusion as /api/auth/check) — a request
// with no valid cookie is a no-op, so no auth is needed to call this.
import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/lib/session';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete({ name: SESSION_COOKIE_NAME, path: '/' });
  return res;
}
