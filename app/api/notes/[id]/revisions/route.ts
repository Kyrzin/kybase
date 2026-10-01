// GET /api/notes/[id]/revisions — the note's history, newest first
// (lib/history.ts). ?limit=1..100 (default 50), ?offset=.
import { NextRequest, NextResponse } from 'next/server';
import { isInvalidTextRepresentation } from '@/lib/db';
import { listRevisions, pageParams } from '@/lib/history';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { limit, offset } = pageParams(new URL(req.url).searchParams);
  let data;
  try {
    data = await listRevisions(id, limit, offset);
  } catch (err) {
    if (isInvalidTextRepresentation(err)) {
      return NextResponse.json({ error: 'Malformed note id' }, { status: 400 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Query failed' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}
