// lib/reindex.ts — shared "embed everything that's pending" loop, used by
// POST /api/admin/reindex, the hourly sweep (instrumentation.ts), and the
// background pass fired after an import.
import { query } from './db';
import { indexNote } from './indexing';
import { getEmbedConcurrency, EmbedCancelledError } from './embeddings';

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

// A run of consecutive full-retry failures almost always means the
// provider's quota is exhausted for the window (RPM, or the whole day) —
// not that these particular notes are bad. Grinding through the rest of a
// 100+ note batch at 5 retries each just burns time and quota that'll be
// needed once it resets; the hourly sweep (instrumentation.ts) picks up
// whatever's left.
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
        return { ok: false as const, id: note.id, title: note.title, message: err instanceof Error ? err.message : 'unknown error' };
      }
    }));

    for (const r of results) {
      if (r.ok === 'cancelled') continue; // stopped mid-note by the user, not a failure — don't count it either way
      current.done++;
      if (r.ok) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        current.errors.push({ id: r.id, title: r.title, message: r.message });
      }
    }

    if (isCancelled()) return;

    if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      current.stoppedEarly = `Stopped after ${consecutiveFailures} notes failed in a row (likely a quota limit) — ${rows.length - current.done} notes left pending for the next sweep.`;
      return;
    }
  }
}

async function run(current: ReindexProgress, mode: 'pending' | 'all'): Promise<void> {
  const rows = mode === 'all'
    ? await query<{ id: string; title: string; content: string }>(
        'select id, title, content from notes where deleted_at is null order by created_at')
    : await query<{ id: string; title: string; content: string }>(
        'select id, title, content from notes where embedding_pending = true and deleted_at is null');
  current.total = rows.length;
  await reindexRows(current, rows);
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

  run(current, mode)
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
