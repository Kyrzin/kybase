import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { indexNoteAsync } from '@/lib/indexing';
import { z } from 'zod';

const NOTE_SELECT = 'id, title, content, folder_id, tags, embedding_pending, created_at, updated_at';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const data = await queryOne(
    `select ${NOTE_SELECT} from notes where id = $1`,
    [id]
  ).catch(() => null);
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}

const UpdateNoteSchema = z.object({
  title:     z.string().min(1).max(500).optional(),
  content:   z.string().optional(),
  folder_id: z.string().uuid().nullable().optional(),
  tags:      z.array(z.string()).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id }  = await params;
  const body    = await req.json().catch(() => ({}));
  const parsed  = UpdateNoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  // Fetch current to detect changes
  const existing = await queryOne<{ title: string; content: string }>(
    'select title, content from notes where id = $1',
    [id]
  ).catch(() => null);
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const titleChanged   = parsed.data.title   !== undefined && parsed.data.title   !== existing.title;
  const contentChanged = parsed.data.content !== undefined && parsed.data.content !== existing.content;

  const sets: string[] = [];
  const sqlParams: unknown[] = [];
  const set = (col: string, val: unknown) => { sqlParams.push(val); sets.push(`${col} = $${sqlParams.length}`); };
  if (parsed.data.title     !== undefined) set('title', parsed.data.title);
  if (parsed.data.content   !== undefined) set('content', parsed.data.content);
  if (parsed.data.folder_id !== undefined) set('folder_id', parsed.data.folder_id);
  if (parsed.data.tags      !== undefined) set('tags', parsed.data.tags);
  if (sets.length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  if (titleChanged || contentChanged) sets.push('embedding_pending = true');

  sqlParams.push(id);
  let note;
  try {
    note = await queryOne(
      `update notes set ${sets.join(', ')} where id = $${sqlParams.length}
       returning ${NOTE_SELECT}`,
      sqlParams
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Update [[OldTitle]] → [[NewTitle]] in all other notes (case-insensitive)
  if (titleChanged) {
    await query('select update_wikilinks($1, $2)', [existing.title, parsed.data.title!]);
  }

  // Re-index asynchronously (note embedding + chunks)
  if (titleChanged || contentChanged) {
    const newTitle   = parsed.data.title   ?? existing.title;
    const newContent = parsed.data.content ?? existing.content;
    indexNoteAsync(id, newTitle, newContent);
  }

  return NextResponse.json(note);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await query('delete from notes where id = $1', [id]);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
  return new NextResponse(null, { status: 204 });
}
