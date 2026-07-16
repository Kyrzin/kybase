import { NextRequest, NextResponse } from 'next/server';
import { textSearch, semanticSearch, hybridSearch } from '@/lib/search';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q     = searchParams.get('q')?.trim();
  const type  = (searchParams.get('type') ?? 'text') as 'text' | 'semantic' | 'hybrid';
  const rawLimit = parseInt(searchParams.get('limit') ?? '10', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 10;

  if (!q) return NextResponse.json({ error: 'Missing ?q= parameter' }, { status: 400 });

  try {
    let results;
    if      (type === 'semantic') results = await semanticSearch(q, limit);
    else if (type === 'hybrid')   results = await hybridSearch(q, limit);
    else                          results = await textSearch(q, limit);
    return NextResponse.json(results);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Search failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
