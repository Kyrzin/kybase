// lib/reindex.ts — shared "embed everything that's pending" loop, used by
// POST /api/admin/reindex, the hourly sweep (instrumentation.ts), and the
// background pass fired after an import.
import { query, getPool, REINDEX_LOCK_KEY } from './db';
import { indexNote } from './indexing';
import { getEmbedConcurrency, EmbedCancelledError, isQuotaExhausted } from './embeddings';

export type ReindexError = { id: string; title: string; message: string };
export type ReindexProgress = {
  running: boolean;
  mode: 'pending' | 'all';
  done: number;
  total: number;
  errors: ReindexError[];
  stoppedEarly?: string;
  cancelled?: boolean;
  startedAt: number;
  finishedAt?: number;
};

// Single Next.js standalone instance (see lib/rate-limit.ts for the same
// assumption) — in-memory is enough, no DB table needed.
let progress: ReindexProgress | null = null;

export function getReindexProgress(): ReindexProgress | null {
  return progress;
}

// A run of consecutive QUOTA failures means the provider's ceiling for the
// window (RPM, or the whole day) is reached — not that these particular
// notes are bad. Grinding through the rest of a 100+ note batch at 5
// retries each just burns time and quota that'll be needed once it resets;
// the hourly sweep (instrumentation.ts) picks up whatever's left.
//
// Only quota refusals count, and any other failure resets the streak: five
// genuinely broken notes in a row (bad input, a DB hiccup) say nothing
// about the provider, and stopping the run on them — while reporting
// "likely a quota limit" — would be both wrong and misleading.
const CONSECUTIVE_FAILURE_LIMIT = 5;

async function reindexRows(current: ReindexProgress, rows: { id: string; title: string; content: string }[]): Promise<void> {
  const { notes: noteConcurrency } = await getEmbedConcurrency();
  const isCancelled = () => current.cancelled === true;
  let consecutiveFailures = 0;

  for (let i = 0; i < rows.length; i += noteConcurrency) {
    if (isCancelled()) return;
    const batch = rows.slice(i, i + noteConcurrency);
    const results = await Promise.all(batch.map(async (note) => {
      try {
        await indexNote(note.id, note.title, note.content, isCancelled);
        return { ok: true as const };
      } catch (err) {
        if (err instanceof EmbedCancelledError) return { ok: 'cancelled' as const };
        return {
          ok: false as const,
          id: note.id,
          title: note.title,
          message: err instanceof Error ? err.message : 'unknown error',
          quota: isQuotaExhausted(err),
        };
      }
    }));

    for (const r of results) {
      if (r.ok === 'cancelled') continue; // stopped mid-note by the user, not a failure — don't count it either way
      current.done++;
      if (r.ok) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures = r.quota ? consecutiveFailures + 1 : 0;
        current.errors.push({ id: r.id, title: r.title, message: r.message });
      }
    }

    if (isCancelled()) return;

    if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      current.stoppedEarly = `Stopped after ${consecutiveFailures} notes hit the provider's quota in a row — ${rows.length - current.done} notes left pending for the next sweep.`;
      return;
    }
  }
}

async function run(current: ReindexProgress, mode: 'pending' | 'all'): Promise<void> {
  // "all" flags every note first, then runs the same pending query. Without
  // this the two modes disagree about what "unfinished" means: "all" picked
  // its rows straight from notes and never touched embedding_pending, so an
  // interrupted run — Stop, the quota breaker, or a container restart — left
  // the notes it never reached NOT pending, the hourly sweep skipped them,
  // and they kept their stale embeddings forever while the UI said they were
  // "left pending for the next sweep". One UPDATE makes that sentence true
  // and makes every interruption resumable, in both modes, for free.
  if (mode === 'all') {
    await query('update notes set embedding_pending = true where deleted_at is null');
  }
  const rows = await query<{ id: string; title: string; content: string }>(
    'select id, title, content from notes where embedding_pending = true and deleted_at is null order by created_at'
  );
  current.total = rows.length;
  await reindexRows(current, rows);
}

/**
 * Same run, behind a Postgres advisory lock (lib/db.ts REINDEX_LOCK_KEY).
 * The in-memory `progress` flag above already stops a second run inside
 * THIS process; the lock is what survives the process — a container restart
 * mid-run leaves no in-memory trace, and the sweep firing 15s after boot
 * would happily start a second pass over notes an abandoned run was still
 * embedding. Session-scoped, on its own client, released in a finally: a
 * bulk run is far too long to hold a transaction open for.
 *
 * Losing the race is not an error — it means someone else is already doing
 * this work. The run ends immediately and says so; the client is polling
 * GET anyway and shows it.
 */
async function runLocked(current: ReindexProgress, mode: 'pending' | 'all'): Promise<void> {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [REINDEX_LOCK_KEY]);
    if (!rows[0]?.locked) {
      current.stoppedEarly = 'Another reindex is already running — this one did nothing.';
      return;
    }
    try {
      await run(current, mode);
    } finally {
      await client.query('select pg_advisory_unlock($1)', [REINDEX_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/**
 * Starts a reindex in the background unless one is already running (in
 * which case this just returns the run already in progress — the caller
 * can poll getReindexProgress() either way). Guards against the same storm
 * that used to happen on a double-click, a page reload mid-run, or the
 * hourly sweep landing while a manual "Reindex all" is still going.
 */
export function startReindex(mode: 'pending' | 'all'): { started: boolean; progress: ReindexProgress } {
  if (progress?.running) return { started: false, progress };

  const current: ReindexProgress = { running: true, mode, done: 0, total: 0, errors: [], startedAt: Date.now() };
  progress = current;

  runLocked(current, mode)
    .catch(err => {
      current.errors.push({ id: '-', title: '-', message: err instanceof Error ? err.message : 'unknown error' });
    })
    .finally(() => {
      current.running = false;
      current.finishedAt = Date.now();
      if (current.total > 0) {
        const failed = current.errors.length;
        console.log(`[reindex] ${current.done - failed}/${current.total} notes indexed${failed ? `, ${failed} errors` : ''}${current.stoppedEarly ? ' (stopped early)' : ''}${current.cancelled ? ' (cancelled)' : ''}`);
      }
    });

  return { started: true, progress: current };
}

/** Fire-and-forget variant for the hourly sweep and after bulk imports. */
export function reindexPendingAsync(): void {
  startReindex('pending');
}

/**
 * Signals the running batch to stop after its current note. Returns false
 * if nothing was running. The notes it hadn't reached yet stay
 * embedding_pending — the next manual click or hourly sweep picks them up.
 */
export function cancelReindex(): boolean {
  if (!progress?.running) return false;
  progress.cancelled = true;
  return true;
}
