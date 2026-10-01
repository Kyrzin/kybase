import { NextResponse } from 'next/server';
import { buildGraph } from '@/lib/graph-data';

export async function GET() {
  try {
    return NextResponse.json(await buildGraph());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
