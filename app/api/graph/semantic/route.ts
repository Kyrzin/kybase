import { NextRequest, NextResponse } from 'next/server';
import { getSemanticEdges } from '@/lib/semantic-edges';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const threshold = Math.min(Math.max(parseFloat(searchParams.get('threshold') ?? '0.6') || 0.6, 0), 1);
  const k = Math.min(Math.max(parseInt(searchParams.get('k') ?? '5', 10) || 5, 1), 20);

  try {
    return NextResponse.json(await getSemanticEdges(threshold, k));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Semantic edges failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
