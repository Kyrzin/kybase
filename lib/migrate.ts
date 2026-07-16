// lib/migrate.ts — applies db/migrations/*.sql in filename order at server
// start (instrumentation.ts), tracked in schema_migrations. Replaces the old
// "apply new files with psql by hand" upgrade step — a `git pull` without it
// used to mean 500s from a schema the code no longer matched.
//
// Databases created before schema_migrations existed get every migration
// replayed once: all shipped migrations are idempotent (if not exists /
// or replace). Future migrations don't need to be — they run exactly once.
// Keep statements transaction-safe (no `create index concurrently`): each
// file runs inside one transaction.
import fs from 'fs';
import path from 'path';
import { getPool } from './db';

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

// App-wide advisory lock so concurrently starting instances don't race.
const MIGRATE_LOCK_KEY = 0x6b796261; // 'kyba'

// The db container may still be starting when the app comes up.
const CONNECT_ATTEMPTS = 15;
const CONNECT_DELAY_MS = 2_000;

/** Sorted .sql files that are not yet recorded as applied. */
export function pendingMigrations(files: string[], applied: Set<string>): string[] {
  return files.filter(f => f.endsWith('.sql') && !applied.has(f)).sort();
}

async function connectWithRetry() {
  for (let i = 1; ; i++) {
    try {
      return await getPool().connect();
    } catch (err) {
      if (i >= CONNECT_ATTEMPTS) throw err;
      console.log(`[migrate] database not ready (attempt ${i}/${CONNECT_ATTEMPTS}), retrying…`);
      await new Promise(r => setTimeout(r, CONNECT_DELAY_MS));
    }
  }
}

/**
 * runMigrations + fail-fast: a failure exits the process — serving traffic
 * on a half-migrated schema would mean silent 500s, the exact failure mode
 * migrations exist to prevent. Lives here (not instrumentation.ts) so the
 * Edge bundle never sees a Node-only API like process.exit.
 */
export async function runMigrationsOrDie(): Promise<void> {
  try {
    await runMigrations();
  } catch (err) {
    console.error('[migrate] FATAL:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

export async function runMigrations(): Promise<void> {
  const files = fs.readdirSync(MIGRATIONS_DIR);
  const client = await connectWithRetry();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
    await client.query(
      `create table if not exists schema_migrations (
         filename   text primary key,
         applied_at timestamptz not null default now()
       )`
    );
    const { rows } = await client.query<{ filename: string }>('select filename from schema_migrations');
    const pending = pendingMigrations(files, new Set(rows.map(r => r.filename)));

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [file]);
        await client.query('commit');
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (pending.length === 0) console.log('[migrate] schema is up to date');
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
