import { NextRequest, NextResponse } from 'next/server';
import { reindexPending, reindexAll } from '@/lib/reindex';

export async function POST(req: NextRequest) {
  const all = new URL(req.url).searchParams.get('mode') === 'all';
  try {
    return NextResponse.json(await (all ? reindexAll() : reindexPending()));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
