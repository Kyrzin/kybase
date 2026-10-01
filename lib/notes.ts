import { withTransaction } from './db';
import { rewriteBacklinks } from './rename-links';

export type NotePatch = { title?: string; content?: string; folder_id?: string | null; tags?: string[] };

export type NoteUpdate<R> = {
  // null when `expectedUpdatedAt` no longer matched at write time.
  note: R | null;
  // Title or content actually changed, so the note needs re-indexing.
  changed: boolean;
  newTitle: string;
  newContent: string;
};

/**
 * Applies a non-empty patch to a live note in one transaction. The row is
 * locked first so a concurrent rename cannot leave backlinks pointing at a
 * stale title. A rename also renames the note's own leading `# Old title`
 * line when the patch does not replace the content. With `expectedUpdatedAt`
 * the write lands only if the note is unchanged since (millisecond precision).
 * Resolves to null when no live note has this id.
 */
export async function updateNote<R>(
  id: string,
  patch: NotePatch,
  opts: { returning: string; actor: string; expectedUpdatedAt?: string }
): Promise<NoteUpdate<R> | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (patch.title     !== undefined) set('title', patch.title);
  if (patch.content   !== undefined) set('content', patch.content);
  if (patch.folder_id !== undefined) set('folder_id', patch.folder_id);
  if (patch.tags      !== undefined) set('tags', patch.tags);

  return withTransaction(async (client) => {
    const { rows: lockedRows } = await client.query<{ title: string; content: string }>(
      'select title, content from notes where id = $1 and deleted_at is null for update',
      [id]
    );
    const locked = lockedRows[0];
    if (!locked) return null;

    // Compare values, not presence: resending unchanged text must not re-embed.
    const titleChanged   = patch.title   !== undefined && patch.title   !== locked.title;
    const contentChanged = patch.content !== undefined && patch.content !== locked.content;
    const changed = titleChanged || contentChanged;
    let finalSets = changed ? [...sets, 'embedding_pending = true'] : sets;

    let fixedContent: string | undefined;
    if (titleChanged && patch.content === undefined) {
      const firstLine = locked.content.split('\n', 1)[0];
      if (firstLine === `# ${locked.title}`) {
        fixedContent = `# ${patch.title}` + locked.content.slice(firstLine.length);
        params.push(fixedContent);
        finalSets = [...finalSets, `content = $${params.length}`];
      }
    }

    params.push(id);
    const idParam = params.length;
    // The column keeps microseconds, callers only ever saw milliseconds.
    let guard = '';
    if (opts.expectedUpdatedAt !== undefined) {
      params.push(opts.expectedUpdatedAt);
      guard = `and date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $${params.length}::timestamptz)`;
    }

    const { rows } = await client.query(
      `update notes set ${finalSets.join(', ')}
       where id = $${idParam} and deleted_at is null ${guard}
       returning ${opts.returning}`,
      params
    );
    const note = (rows[0] as R | undefined) ?? null;
    if (titleChanged && note) {
      await rewriteBacklinks(client, locked.title, patch.title!);
    }
    return {
      note,
      changed,
      newTitle: patch.title ?? locked.title,
      newContent: fixedContent ?? patch.content ?? locked.content,
    };
  }, { actor: opts.actor });
}
