// GET /api/notes/[id]/revisions/[revisionId] — one revision and the state
// that replaced it, for a diff. DELETE removes the revision from history for
// good (lib/history.ts).
import { NextRequest, NextResponse } from 'next/server';
import { isInvalidTextRepresentation } from '@/lib/db';
import { deleteRevision, getRevision, isRevisionId } from '@/lib/history';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; revisionId: string }> }
) {
  const { id, revisionId } = await params;
  if (!isRevisionId(revisionId)) {
    return NextResponse.json({ error: 'Malformed revision id' }, { status: 400 });
  }
  let data;
  try {
    data = await getRevision(id, revisionId);
  } catch (err) {
    if (isInvalidTextRepresentation(err)) {
      return NextResponse.json({ error: 'Malformed note id' }, { status: 400 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Query failed' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; revisionId: string }> }
) {
  const { id, revisionId } = await params;
  if (!isRevisionId(revisionId)) {
    return NextResponse.json({ error: 'Malformed revision id' }, { status: 400 });
  }
  let deleted: boolean;
  try {
    deleted = await deleteRevision(id, revisionId);
  } catch (err) {
    if (isInvalidTextRepresentation(err)) {
      return NextResponse.json({ error: 'Malformed note id' }, { status: 400 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Delete failed' }, { status: 500 });
  }
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
