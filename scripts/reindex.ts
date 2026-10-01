#!/usr/bin/env tsx
/**
 * scripts/reindex.ts — re-embed all notes (run after switching EMBEDDING_PROVIDER)
 *
 * Usage:
 *   npx tsx scripts/reindex.ts           # re-embed only embedding_pending=true
 *   npx tsx scripts/reindex.ts --all     # re-embed every note
 *
 * Requires .env.local (or env vars) with DATABASE_URL,
 * EMBEDDING_PROVIDER (+ provider-specific keys).
 */

import { config } from 'dotenv';
import path from 'path';

// Load .env.local from project root
config({ path: path.resolve(process.cwd(), '.env.local') });

import { query, getPool } from '../lib/db';
import { indexNote } from '../lib/indexing';

const reindexAll = process.argv.includes('--all');

async function main() {
  console.log(`[reindex] provider=${process.env.EMBEDDING_PROVIDER ?? 'ollama'} mode=${reindexAll ? 'all' : 'pending'}`);

  // Fetch notes to process
  const notes = await query<{ id: string; title: string; content: string }>(
    `select id, title, content from notes
     ${reindexAll ? '' : 'where embedding_pending = true'}
     order by created_at`
  ).catch((err: Error) => { console.error('[reindex] fetch error:', err.message); process.exit(1); });
  if (!notes || notes.length === 0) { console.log('[reindex] nothing to reindex'); return; }

  console.log(`[reindex] ${notes.length} notes to process`);

  let ok = 0, fail = 0;
  for (const note of notes) {
    try {
      await indexNote(note.id, note.title, note.content);
      ok++;
      process.stdout.write(`\r[reindex] ${ok + fail}/${notes.length} — ✓ ${note.title.slice(0, 40)}`);
    } catch (err) {
      fail++;
      console.error(`\n[reindex] ✗ ${note.id} (${note.title}):`, (err as Error).message);
    }
  }

  console.log(`\n[reindex] done: ${ok} ok, ${fail} failed`);
  await getPool().end();
  if (fail > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
