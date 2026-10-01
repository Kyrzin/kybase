// GET /api/notes/[id]/backlinks — live notes linking here, resolved like MCP get_backlinks.
import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne, isInvalidTextRepresentation } from '@/lib/db';
import { backlinksTo } from '@/lib/note-links';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    // 404 rather than an empty list, as get_backlinks does.
    const note = await queryOne('select id from notes where id = $1 and deleted_at is null', [id]);
    if (!note) return NextResponse.json({ error: 'Note not found' }, { status: 404 });

    const firstContext = new Map<string, string | null>();
    for (const link of await backlinksTo(id)) {
      if (!firstContext.has(link.source_note_id)) firstContext.set(link.source_note_id, link.context);
    }
    const notes = await query<{ id: string; title: string }>(
      'select id, title from notes where id = any($1::uuid[]) and deleted_at is null order by title',
      [[...firstContext.keys()]]
    );
    return NextResponse.json(notes.map((n) => ({ id: n.id, title: n.title, context: firstContext.get(n.id) ?? null })));
  } catch (err) {
    if (isInvalidTextRepresentation(err)) {
      return NextResponse.json({ error: 'Malformed note id' }, { status: 400 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Query failed' }, { status: 500 });
  }
}
