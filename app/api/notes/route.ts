import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { indexNoteAsync } from '@/lib/indexing';
import { z } from 'zod';

const NOTE_SELECT = 'id, title, content, folder_id, tags, embedding_pending, created_at, updated_at';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const folder_id = searchParams.get('folder_id');
  const tag       = searchParams.get('tag');

  const conds: string[] = [];
  const params: unknown[] = [];
  if (folder_id) { params.push(folder_id); conds.push(`folder_id = $${params.length}`); }
  if (tag)       { params.push([tag]);     conds.push(`tags @> $${params.length}`); }

  try {
    const data = await query(
      `select ${NOTE_SELECT} from notes
       ${conds.length ? 'where ' + conds.join(' and ') : ''}
       order by updated_at desc`,
      params
    );
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const CreateNoteSchema = z.object({
  title:     z.string().min(1).max(500),
  content:   z.string().default(''),
  folder_id: z.string().uuid().nullable().optional(),
  tags:      z.array(z.string()).default([]),
});

export async function POST(req: NextRequest) {
  const body   = await req.json().catch(() => ({}));
  const parsed = CreateNoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const { title, content, folder_id, tags } = parsed.data;
  let note;
  try {
    note = await queryOne<{ id: string; title: string; content: string }>(
      `insert into notes (title, content, folder_id, tags, embedding_pending)
       values ($1, $2, $3, $4, true)
       returning ${NOTE_SELECT}`,
      [title, content, folder_id ?? null, tags]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Insert failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
  if (!note) return NextResponse.json({ error: 'Insert failed' }, { status: 500 });

  // Non-blocking index — failure leaves embedding_pending=true for reindex
  indexNoteAsync(note.id, note.title, note.content);

  return NextResponse.json(note, { status: 201 });
}
