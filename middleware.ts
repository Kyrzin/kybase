// middleware.ts — Bearer token auth for all /api/* except /api/auth and /api/mcp
// /api/auth — handles its own validation (login endpoint)
// /api/mcp  — handles its own auth internally (SSE needs no buffering interference)
import { NextRequest, NextResponse } from 'next/server';
import { bearerToken, safeEqual } from '@/lib/auth';

export function middleware(req: NextRequest) {
  const token  = bearerToken(req);
  const secret = process.env.KYBASE_SECRET;

  if (!secret) {
    return NextResponse.json(
      { error: 'Server misconfigured: KYBASE_SECRET not set' },
      { status: 500 }
    );
  }
  if (!safeEqual(token, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.next();
}

// Protect /api/* except /api/auth/*, /api/mcp, /api/oauth/*
// /authorize is also public (OAuth flow)
export const config = {
  matcher: ['/api/((?!auth/|mcp|oauth/).*)'],
};
