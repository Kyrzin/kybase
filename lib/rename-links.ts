// lib/rename-links.ts — rewrite [[Old Title]] backlinks after a rename.
//
// Replaces `select update_wikilinks($1, $2)` (migration 020's SQL function).
// The SQL version ran one regexp_replace across every note's whole content,
// which meant it also rewrote links written inside code blocks — a note
// documenting the link syntax had its examples edited by an unrelated
// rename, invisibly, because migration 020 deliberately suppresses
// content_updated_at for backlink rewrites. See rewriteWikilinkTarget for
// the parsing side; this module is only the database half.
//
// The SQL function is left defined but is no longer called from anywhere.
// Dropping it needs its own migration, and doing that here would break
// exactly one scenario: rolling application code back to a commit that
// still calls it, without rolling the database back too.
import { escapeLike } from './sql';
import { rewriteWikilinkTarget } from './wikilinks';

/** The subset of a pg client this needs — keeps callers free to pass their
 *  own transaction, which they must: the rewrite has to commit or roll back
 *  with the rename that caused it. */
type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: { id: string; content: string }[] }>;
};

/**
 * Repoint every other note's [[oldTitle]] at `newTitle`. Returns how many
 * notes were changed. Must run inside the same transaction as the rename.
 *
 * Soft-deleted notes are rewritten too, matching the SQL function this
 * replaces: a note restored from the trash later should not come back
 * carrying links to a title that stopped existing while it was gone.
 */
export async function rewriteBacklinks(
  client: Queryable,
  oldTitle: string,
  newTitle: string
): Promise<number> {
  if (!oldTitle.trim() || oldTitle === newTitle) return 0;

  // A cheap superset: every note whose text contains "[[" followed by the
  // old title, case-insensitively. rewriteWikilinkTarget then decides
  // precisely — this WHERE only has to avoid loading the whole vault, not
  // to be exact. Same sequential scan the SQL function's ~* did.
  const { rows } = await client.query(
    'select id, content from notes where content ilike $1',
    [`%[[${escapeLike(oldTitle.trim())}%`]
  );

  const edits: { id: string; content: string }[] = [];
  for (const row of rows) {
    const next = rewriteWikilinkTarget(row.content, oldTitle, newTitle);
    if (next !== null && next !== row.content) edits.push({ id: row.id, content: next });
  }
  if (edits.length === 0) return 0;

  // Transaction-scoped flag read by migration 020's notes_content_updated_at
  // trigger: this write is a mechanical link swap, not somebody editing the
  // note, so content_updated_at must not move. updated_at still does — its
  // consumers (expected_updated_at guards, the editor's save-conflict check)
  // need to know the row moved at all. Cleared explicitly afterwards rather
  // than relying on the transaction ending, so a genuine write later in the
  // same transaction is never silently suppressed too.
  await client.query("select set_config('kybase.skip_content_updated_at', 'true', true)");
  try {
    for (const e of edits) {
      await client.query('update notes set content = $1 where id = $2', [e.content, e.id]);
    }
  } finally {
    await client.query("select set_config('kybase.skip_content_updated_at', 'false', true)");
  }
  return edits.length;
}
