// lib/history.ts — reading note history (migration 032) and reverting to it.
//
// Revision rows are written by triggers on notes, never from here. This
// module reads them, and adds the two writes history needs: putting a note's
// title and content back the way a revision recorded them, and removing a
// revision for good.
import { query, queryOne, withTransaction, isUniqueViolation } from './db';
import { rewriteBacklinks } from './rename-links';
import { indexNoteAsync } from './indexing';
import type { ChangeEntry, ChangePage, Note, RevisionDetail, RevisionKind, RevisionPage, RevisionSummary } from './types';

// The columns the note routes return, so a revert answers with the same shape
// as a PATCH.
const NOTE_SELECT = 'id, title, content, folder_id, tags, embedding_pending, created_at, updated_at';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

/** limit (1–100, default 50) and offset (0 or more) from a query string. */
export function pageParams(params: URLSearchParams): { limit: number; offset: number } {
  const limit = parseInt(params.get('limit') ?? '', 10);
  const offset = parseInt(params.get('offset') ?? '', 10);
  return {
    limit: Number.isNaN(limit) ? DEFAULT_PAGE : Math.min(Math.max(limit, 1), MAX_PAGE),
    offset: Number.isNaN(offset) ? 0 : Math.max(offset, 0),
  };
}

/** Revision ids are bigserial; anything else cannot name one. */
export function isRevisionId(value: string): boolean {
  return /^\d{1,18}$/.test(value);
}

/** Rows fetched with limit + 1: the extra one only says whether there is a next page. */
function page<T>(rows: T[], limit: number, offset: number): { items: T[]; has_more: boolean; next_offset?: number } {
  return rows.length > limit
    ? { items: rows.slice(0, limit), has_more: true, next_offset: offset + limit }
    : { items: rows, has_more: false };
}

/**
 * A note's history, newest first, or null when there is no such note. A
 * trashed note still has its history — including who deleted it.
 */
export async function listRevisions(noteId: string, limit: number, offset: number): Promise<RevisionPage | null> {
  const note = await queryOne('select id from notes where id = $1', [noteId]);
  if (!note) return null;
  const rows = await query<RevisionSummary>(
    `select id::text as id, kind, changed_by, changed_at, title, length(content) as content_length
     from note_revisions where note_id = $1
     order by changed_at desc, id desc
     limit $2 offset $3`,
    [noteId, limit + 1, offset]
  );
  const { items, ...more } = page(rows, limit, offset);
  return { revisions: items, ...more };
}

type RevisionRow = {
  id: string;
  note_id: string;
  kind: RevisionKind;
  changed_by: string;
  changed_at: string;
  title: string | null;
  content: string | null;
  folder_id: string | null;
  tags: string[] | null;
};

/**
 * What a change produced. Each snapshot is the note right before the change
 * that follows it, so that is the next newer snapshot (edits coalesced into
 * this one included) — or the note itself when nothing later was kept. The
 * comparison stays in SQL: changed_at carries microseconds, which a JS Date
 * round trip would truncate.
 */
async function stateAfter(noteId: string, revisionId: string): Promise<RevisionDetail['after']> {
  const next = await queryOne<{ title: string; content: string }>(
    `select n.title, n.content
     from note_revisions r
     join note_revisions n on n.note_id = r.note_id
     where r.id = $1 and n.content is not null and (n.changed_at, n.id) > (r.changed_at, r.id)
     order by n.changed_at, n.id
     limit 1`,
    [revisionId]
  );
  if (next) return { ...next, source: 'revision' };
  const current = await queryOne<{ title: string; content: string }>(
    'select title, content from notes where id = $1',
    [noteId]
  );
  return current ? { ...current, source: 'current' } : null;
}

/**
 * One revision with the state it was replaced by, for a diff. Null when the
 * revision does not exist or belongs to another note.
 */
export async function getRevision(noteId: string, revisionId: string): Promise<RevisionDetail | null> {
  const rev = await queryOne<RevisionRow>(
    `select id::text as id, note_id, kind, changed_by, changed_at, title, content, folder_id, tags
     from note_revisions where id = $1 and note_id = $2`,
    [revisionId, noteId]
  );
  if (!rev) return null;
  const { id, note_id, kind, changed_by, changed_at } = rev;
  if (rev.content !== null && rev.title !== null) {
    const before = { title: rev.title, content: rev.content, folder_id: rev.folder_id, tags: rev.tags ?? [] };
    return { id, note_id, kind, changed_by, changed_at, before, after: await stateAfter(noteId, revisionId) };
  }
  // Events keep no snapshot. A create is shown as what it created: the
  // note's first version.
  return {
    id, note_id, kind, changed_by, changed_at, before: null,
    after: kind === 'create' ? await stateAfter(noteId, revisionId) : null,
  };
}

/**
 * Remove one revision from history for good — for text that must not live
 * on in a snapshot, such as a secret pasted into a note and then deleted.
 * No trace is kept. False when the revision does not exist or belongs to
 * another note.
 */
export async function deleteRevision(noteId: string, revisionId: string): Promise<boolean> {
  const rows = await query('delete from note_revisions where id = $1 and note_id = $2 returning id', [revisionId, noteId]);
  return rows.length > 0;
}

/**
 * The whole vault's history, newest first, optionally narrowed to one actor.
 * note_title is the note's title now, not at the time of the change.
 */
export async function listChanges(limit: number, offset: number, actor: string | null): Promise<ChangePage> {
  const [rows, actors] = await Promise.all([
    query<ChangeEntry>(
      `select r.id::text as revision_id, r.note_id, n.title as note_title,
              n.deleted_at is not null as note_deleted, r.kind, r.changed_by, r.changed_at
       from note_revisions r
       join notes n on n.id = r.note_id
       where $1::text is null or r.changed_by = $1
       order by r.changed_at desc, r.id desc
       limit $2 offset $3`,
      [actor, limit + 1, offset]
    ),
    query<{ changed_by: string }>('select distinct changed_by from note_revisions order by changed_by'),
  ]);
  const { items, ...more } = page(rows, limit, offset);
  return { changes: items, actors: actors.map((a) => a.changed_by), ...more };
}

export type RevertOutcome =
  | { status: 'ok'; note: Note }
  | { status: 'not_found' }
  | { status: 'no_content' }
  | { status: 'conflict'; updated_at: string }
  | { status: 'title_taken' };

/**
 * Set a live note's title and content back to what `revisionId` recorded;
 * folder and tags stay as they are. The revert is a change like any other:
 * the state it replaces is kept as a 'revert' revision, so nothing in the
 * history is ever lost to it.
 *
 * Restoring an older title is a rename, and is handled as the PATCH route
 * handles one — other notes' [[links]] follow it, in the same transaction.
 */
export async function revertToRevision(
  noteId: string,
  revisionId: string,
  expectedUpdatedAt: string,
  actor: string
): Promise<RevertOutcome> {
  let outcome: RevertOutcome;
  let reindex = false;
  try {
    outcome = await withTransaction<RevertOutcome>(async (client) => {
      const { rows: [note] } = await client.query<{ title: string; content: string; updated_at: Date }>(
        'select title, content, updated_at from notes where id = $1 and deleted_at is null for update',
        [noteId]
      );
      if (!note) return { status: 'not_found' };
      const { rows: [rev] } = await client.query<{ title: string | null; content: string | null }>(
        'select title, content from note_revisions where id = $1 and note_id = $2',
        [revisionId, noteId]
      );
      if (!rev) return { status: 'not_found' };
      if (rev.content === null || rev.title === null) return { status: 'no_content' };

      // The row is locked, so the check cannot go stale before the write.
      // Compared at millisecond precision, the precision the caller was given.
      if (new Date(note.updated_at).getTime() !== new Date(expectedUpdatedAt).getTime()) {
        return { status: 'conflict', updated_at: new Date(note.updated_at).toISOString() };
      }

      const titleChanged = rev.title !== note.title;
      const changed = titleChanged || rev.content !== note.content;
      const { rows: [updated] } = await client.query<Note>(
        `update notes set title = $1, content = $2${changed ? ', embedding_pending = true' : ''}
         where id = $3
         returning ${NOTE_SELECT}`,
        [rev.title, rev.content, noteId]
      );
      if (titleChanged) await rewriteBacklinks(client, note.title, rev.title);
      reindex = changed;
      return { status: 'ok', note: updated };
    }, { actor, kind: 'revert' });
  } catch (err) {
    if (isUniqueViolation(err)) return { status: 'title_taken' };
    throw err;
  }

  // The same follow-up as a PATCH that changed title or content.
  if (outcome.status === 'ok' && reindex) indexNoteAsync(noteId, outcome.note.title, outcome.note.content);
  return outcome;
}
