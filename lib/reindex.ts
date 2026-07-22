// lib/reindex.ts — shared "embed everything that's pending" loop, used by
// POST /api/admin/reindex and fired in the background after an import.
import { query } from './db';
import { indexNote } from './indexing';
import { getEmbedConcurrency } from './embeddings';

export type ReindexResult = { reindexed: number; errors: string[]; total: number };

async function reindexRows(rows: { id: string; title: string; content: string }[]): Promise<ReindexResult> {
  // Each note embeds its own chunks concurrently too (lib/indexing.ts), so
  // this multiplies with that — keep it modest, see getEmbedConcurrency.
  const { notes: noteConcurrency } = await getEmbedConcurrency();
  let reindexed = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i += noteConcurrency) {
    const batch = rows.slice(i, i + noteConcurrency);
    await Promise.all(batch.map(async (note) => {
      try {
        await indexNote(note.id, note.title, note.content);
        reindexed++;
      } catch (err) {
        errors.push(`${note.id}: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }));
  }
  return { reindexed, errors, total: rows.length };
}

export async function reindexPending(): Promise<ReindexResult> {
  const pending = await query<{ id: string; title: string; content: string }>(
    'select id, title, content from notes where embedding_pending = true'
  );
  return reindexRows(pending);
}

// Recomputes every note's embedding regardless of embedding_pending — the
// flag only tracks "never embedded" / "provider changed via Settings", not
// "the embedding logic itself changed" (e.g. a new task-prefix convention).
// That case has no automatic signal, so this is the manual escape hatch —
// exposed as the "Reindex all" button in Settings.
export async function reindexAll(): Promise<ReindexResult> {
  const all = await query<{ id: string; title: string; content: string }>(
    'select id, title, content from notes order by created_at'
  );
  return reindexRows(all);
}

/** Fire-and-forget variant for after bulk imports. */
export function reindexPendingAsync(): void {
  reindexPending()
    .then(r => { if (r.total > 0) console.log(`[reindex] ${r.reindexed}/${r.total} notes indexed${r.errors.length ? `, ${r.errors.length} errors` : ''}`); })
    .catch(err => console.error('[reindex]', err instanceof Error ? err.message : err));
}
