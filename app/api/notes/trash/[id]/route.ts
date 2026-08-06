// DELETE /api/notes/trash/[id] — permanently delete a trashed note right
// now, skipping the rest of TRASH_RETENTION_DAYS. Only affects notes
// already in the trash (see lib/trash.ts purgeNote): a live note must go
// through the normal soft delete first.
import { NextRequest, NextResponse } from 'next/server';
import { isInvalidTextRepresentation } from '@/lib/db';
import { purgeNote } from '@/lib/trash';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let purged: boolean;
  try {
    purged = await purgeNote(id);
  } catch (err) {
    // Folding a failed delete into the 404 below told the caller the note was
    // already gone — and the Trash panel, which reads 404 as "nothing left to
    // remove", struck it off the list while the row survived in the database.
    if (isInvalidTextRepresentation(err)) {
      return NextResponse.json({ error: 'Malformed note id' }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
  if (!purged) return NextResponse.json({ error: 'Not in trash' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
