// GET /api/changes — every note's history in one feed, newest first
// (lib/history.ts). ?limit=1..100 (default 50), ?offset=, ?actor= to keep
// one writer's changes only.
import { NextRequest, NextResponse } from 'next/server';
import { listChanges, pageParams } from '@/lib/history';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const { limit, offset } = pageParams(searchParams);
  try {
    return NextResponse.json(await listChanges(limit, offset, searchParams.get('actor') || null));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Query failed' }, { status: 500 });
  }
}
