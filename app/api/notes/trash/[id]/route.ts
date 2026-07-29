// DELETE /api/notes/trash/[id] — permanently delete a trashed note right
// now, skipping the rest of TRASH_RETENTION_DAYS. Only affects notes
// already in the trash (see lib/trash.ts purgeNote): a live note must go
// through the normal soft delete first.
import { NextRequest, NextResponse } from 'next/server';
import { purgeNote } from '@/lib/trash';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const purged = await purgeNote(id).catch(() => false);
  if (!purged) return NextResponse.json({ error: 'Not in trash' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
