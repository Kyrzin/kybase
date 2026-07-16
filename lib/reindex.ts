// lib/reindex.ts — shared "embed everything that's pending" loop, used by
// POST /api/admin/reindex and fired in the background after an import.
import { query } from './db';
import { indexNote } from './indexing';

// Reindexing whole notes (each with its own batch of chunk embeddings) is
// heavier than a single chunk, so keep concurrency lower than indexNote's.
const NOTE_CONCURRENCY = 3;

export type ReindexResult = { reindexed: number; errors: string[]; total: number };

export async function reindexPending(): Promise<ReindexResult> {
  const pending = await query<{ id: string; title: string; content: string }>(
    'select id, title, content from notes where embedding_pending = true'
  );
  let reindexed = 0;
  const errors: string[] = [];

  for (let i = 0; i < pending.length; i += NOTE_CONCURRENCY) {
    const batch = pending.slice(i, i + NOTE_CONCURRENCY);
    await Promise.all(batch.map(async (note) => {
      try {
        await indexNote(note.id, note.title, note.content);
        reindexed++;
      } catch (err) {
        errors.push(`${note.id}: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }));
  }
  return { reindexed, errors, total: pending.length };
}

/** Fire-and-forget variant for after bulk imports. */
export function reindexPendingAsync(): void {
  reindexPending()
    .then(r => { if (r.total > 0) console.log(`[reindex] ${r.reindexed}/${r.total} notes indexed${r.errors.length ? `, ${r.errors.length} errors` : ''}`); })
    .catch(err => console.error('[reindex]', err instanceof Error ? err.message : err));
}
