import { NextResponse } from 'next/server';
import { reindexPending } from '@/lib/reindex';

export async function POST() {
  try {
    return NextResponse.json(await reindexPending());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
