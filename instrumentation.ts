// instrumentation.ts — runs once when the server starts, before it accepts
// requests (Next.js convention). Applies pending database migrations, then
// picks up notes whose embedding never completed.
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { runMigrationsOrDie } = await import('./lib/migrate');
  await runMigrationsOrDie();

  // A note stays embedding_pending when its provider call failed (Ollama
  // down, crash mid-index) — without this it silently never enters semantic
  // search. Delayed so a cold Ollama container has time to come up; if it's
  // still down, failures log and the notes stay pending for the next start.
  const { reindexPendingAsync } = await import('./lib/reindex');
  setTimeout(reindexPendingAsync, 15_000);

  // lib/trash.ts also purges expired trash opportunistically on every
  // delete, but that alone doesn't guarantee the "30 days" the Trash UI
  // promises — a vault where nothing else is ever deleted would keep one
  // trashed note forever. A daily interval on this long-running process
  // (Next standalone, single instance — see lib/rate-limit.ts) makes the
  // retention window real regardless of what else happens.
  const { purgeExpiredTrash } = await import('./lib/trash');
  const runPurge = () => purgeExpiredTrash().catch(err => console.error('[trash] purge:', err instanceof Error ? err.message : err));
  runPurge();
  setInterval(runPurge, PURGE_INTERVAL_MS);
}
