// POST /api/notes/[id]/reindex — manually retry embedding a single note
// (lib/indexing.ts). Escape hatch for when the automatic index (fired async
// on every save, see indexNoteAsync) failed silently — a provider error
// (Ollama timeout/restart, or a very long note) leaves embedding_pending
// true with no user-visible signal beyond that flag. Synchronous like the
// Settings "Reindex"/"Reindex all" buttons, so a real failure surfaces here
// instead of being swallowed.
import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { indexNote } from '@/lib/indexing';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const note = await queryOne<{ title: string; content: string }>(
    'select title, content from notes where id = $1 and deleted_at is null',
    [id]
  );
  if (!note) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    await indexNote(id, note.title, note.content);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Reindex failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
