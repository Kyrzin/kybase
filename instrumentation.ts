// instrumentation.ts — runs once when the server starts, before it accepts
// requests (Next.js convention). Applies pending database migrations, then
// picks up notes whose embedding never completed.
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
}
