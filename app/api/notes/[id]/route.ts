import { NextRequest, NextResponse } from 'next/server';
import { queryOne, isUniqueViolation, isInvalidTextRepresentation } from '@/lib/db';
import { indexNoteAsync } from '@/lib/indexing';
import { softDeleteNote } from '@/lib/trash';
import { updateNote, type NoteUpdate } from '@/lib/notes';
import { MAX_NOTE_CONTENT_CHARS, stripNulBytes } from '@/lib/types';
import { requestActor } from '@/lib/route-auth';
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
  expected_updated_at: z.string().optional()
    .describe('ISO updated_at read before this edit; refuses the write (409) if it changed since'),
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
  const { expected_updated_at } = parsed.data;

  // expected_updated_at refuses a write over a change made since it was read
  // (the guarantee is in updateNote's UPDATE); this only validates the input.
  if (expected_updated_at !== undefined && Number.isNaN(new Date(expected_updated_at).getTime())) {
    return NextResponse.json({ error: 'expected_updated_at is not a valid timestamp' }, { status: 400 });
  }

  const patch = {
    title: parsed.data.title,
    content: parsed.data.content,
    folder_id: parsed.data.folder_id,
    tags: parsed.data.tags,
  };
  if (Object.values(patch).every((v) => v === undefined)) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  let result: NoteUpdate<Record<string, unknown>> | null;
  const actor = await requestActor(req);
  try {
    result = await updateNote<Record<string, unknown>>(id, patch, {
      returning: NOTE_SELECT,
      actor,
      expectedUpdatedAt: expected_updated_at,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json({ error: 'A note with this title already exists' }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : 'Update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!result.note) {
    // The row existed when locked, so no match means the guard refused the write.
    if (expected_updated_at !== undefined) {
      return NextResponse.json({ error: 'Note changed since you read it' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Re-index asynchronously (note embedding + chunks)
  if (result.changed) {
    indexNoteAsync(id, result.newTitle, result.newContent);
  }

  return NextResponse.json(result.note);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Soft delete (lib/trash.ts): hides the note rather than destroying it —
  // recoverable via restore_note / POST /api/notes/:id/restore for
  // TRASH_RETENTION_DAYS, after which it's purged for real.
  const deleted = await softDeleteNote(id, await requestActor(req)).catch(() => false);
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
