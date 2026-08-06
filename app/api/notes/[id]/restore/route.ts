// POST /api/notes/[id]/restore — undo a soft delete (see lib/trash.ts).
import { NextRequest, NextResponse } from 'next/server';
import { isUniqueViolation } from '@/lib/db';
import { restoreNote } from '@/lib/trash';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let restored: boolean;
  try {
    restored = await restoreNote(id);
  } catch (err) {
    // A live note claimed this title while the original was trashed (the
    // partial unique index — migration 011 — only applies to deleted_at is
    // null rows, so that's allowed right up until the moment of restore).
    // Swallowing this into the generic 404 below would tell the user their
    // note isn't in the trash when it plainly is — the real, fixable
    // problem is the title, so say that instead.
    if (isUniqueViolation(err)) {
      return NextResponse.json({ error: 'A note with this title already exists — rename or remove it first' }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : 'Restore failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
  if (!restored) return NextResponse.json({ error: 'Not in trash' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
