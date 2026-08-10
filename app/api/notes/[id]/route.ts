import { NextRequest, NextResponse } from 'next/server';
import {
  queryOne, withTransaction, isUniqueViolation, isInvalidTextRepresentation
} from '@/lib/db';
import { indexNoteAsync } from '@/lib/indexing';
import { softDeleteNote } from '@/lib/trash';
import { MAX_NOTE_CONTENT_CHARS, stripNulBytes } from '@/lib/types';
import { z } from 'zod';

const NOTE_SELECT = 'id, title, content, folder_id, tags, embedding_pending, created_at, updated_at';

/**
 * A lookup that failed is not a lookup that found nothing: reporting a dead
 * connection as 404 sends the reader hunting for a note they still have.
 */
function lookupFailed(err: unknown): NextResponse {
  if (isInvalidTextRepresentation(err)) {
    return NextResponse.json({ error: 'Malformed note id' }, { status: 400 });
  }
  const message = err instanceof Error ? err.message : 'Query failed';
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let data;
  try {
    data = await queryOne(
      `select ${NOTE_SELECT} from notes where id = $1 and deleted_at is null`,
      [id]
    );
  } catch (err) {
    return lookupFailed(err);
  }
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}

const UpdateNoteSchema = z.object({
  title:     z.string().trim().min(1).max(500).optional(),
  content:   z.string().max(MAX_NOTE_CONTENT_CHARS).optional(),
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
  if (parsed.data.content !== undefined) parsed.data.content = stripNulBytes(parsed.data.content);

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

  type PatchResult = { note: Record<string, unknown> | null; titleChanged: boolean; contentChanged: boolean; newTitle: string; newContent: string };
  let result: PatchResult | null;
  try {
    // Lock the row before reading `existing`: a concurrent rename that reads
    // the same pre-update title, then commits its own update_wikilinks
    // rewrite first, would otherwise make THIS request's update_wikilinks
    // call (keyed on that now-stale title) match nothing — leaving backlinks
    // pointing at whichever title actually landed.
    result = await withTransaction(async (client) => {
      const { rows: existingRows } = await client.query<{ title: string; content: string }>(
        'select title, content from notes where id = $1 and deleted_at is null for update',
        [id]
      );
      const existing = existingRows[0];
      if (!existing) return null;

      const titleChanged   = parsed.data.title   !== undefined && parsed.data.title   !== existing.title;
      const contentChanged = parsed.data.content !== undefined && parsed.data.content !== existing.content;
      const finalSets = titleChanged || contentChanged ? [...sets, 'embedding_pending = true'] : sets;

      const { rows } = await client.query(
        `update notes set ${finalSets.join(', ')} where id = $${sqlParams.length + 1} and deleted_at is null
         returning ${NOTE_SELECT}`,
        [...sqlParams, id]
      );
      const note = rows[0] ?? null;
      if (titleChanged && note) {
        await client.query('select update_wikilinks($1, $2)', [existing.title, parsed.data.title!]);
      }
      return {
        note,
        titleChanged,
        contentChanged,
        newTitle:   parsed.data.title   ?? existing.title,
        newContent: parsed.data.content ?? existing.content,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json({ error: 'A note with this title already exists' }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : 'Update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Trashed or deleted between the existence check and the update: 0 rows
  // changed, so there is nothing to return and nothing to index.
  if (!result || !result.note) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Re-index asynchronously (note embedding + chunks)
  if (result.titleChanged || result.contentChanged) {
    indexNoteAsync(id, result.newTitle, result.newContent);
  }

  return NextResponse.json(result.note);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Soft delete (lib/trash.ts): hides the note rather than destroying it —
  // recoverable via restore_note / POST /api/notes/:id/restore for
  // TRASH_RETENTION_DAYS, after which it's purged for real.
  const deleted = await softDeleteNote(id).catch(() => false);
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
