// POST /api/notes/[id]/restore — undo a soft delete (see lib/trash.ts).
import { NextRequest, NextResponse } from 'next/server';
import { restoreNote } from '@/lib/trash';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const restored = await restoreNote(id).catch(() => false);
  if (!restored) return NextResponse.json({ error: 'Not in trash' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
