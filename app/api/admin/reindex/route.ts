import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { indexNote } from '@/lib/indexing';

// Reindexing whole notes (each with its own batch of chunk embeddings) is
// heavier than a single chunk, so keep concurrency lower than indexNote's.
const NOTE_CONCURRENCY = 3;

export async function POST() {
  let pending: { id: string; title: string; content: string }[];
  try {
    pending = await query('select id, title, content from notes where embedding_pending = true');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
  if (pending.length === 0) {
    return NextResponse.json({ reindexed: 0, errors: [], total: 0 });
  }

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

  return NextResponse.json({ reindexed, errors, total: pending.length });
}
