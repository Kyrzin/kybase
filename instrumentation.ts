// instrumentation.ts — runs once when the server starts, before it accepts
// requests (Next.js convention). Applies pending database migrations, then
// starts the background upkeep in lib/startup.ts.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { runMigrationsOrDie } = await import('./lib/migrate');
  await runMigrationsOrDie();
  const { startMaintenance } = await import('./lib/startup');
  await startMaintenance();
}
