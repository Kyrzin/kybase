// GET /api/shares — every active share link with its note title, so the
// owner can see at a glance what is currently public. Master-secret-
// protected by middleware.
import { NextResponse } from 'next/server';
import { listShares } from '@/lib/shares';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await listShares());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
