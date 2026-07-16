// instrumentation.ts — runs once when the server starts, before it accepts
// requests (Next.js convention). Applies pending database migrations.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { runMigrationsOrDie } = await import('./lib/migrate');
  await runMigrationsOrDie();
}
