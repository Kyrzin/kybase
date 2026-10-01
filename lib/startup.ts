// lib/startup.ts — background upkeep for a long-running server, started once
// its migrations are applied: by instrumentation.ts in the app, and by the
// stdio package in the one process that owns its embedded database.
import { query } from './db';
import { describeOutcome, reconcileEmbeddingDimension } from './embedding-dim';
import { embeddingModelKey } from './embeddings';
import { reindexPendingAsync } from './reindex';
import { getEmbeddingConfig, getLastIndexedModel, setLastIndexedModel } from './settings';
import { purgeExpiredTrash } from './trash';

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REINDEX_INTERVAL_MS = 60 * 60 * 1000;

export async function startMaintenance(): Promise<void> {
  // Catches the one path the settings UI's own provider-switch guard
  // (app/api/settings/route.ts's providerChanged) can't see: an env var
  // (EMBEDDING_PROVIDER, OLLAMA_MODEL, GOOGLE_MODEL, OPENAI_MODEL) edited in
  // .env, picked up silently on the restart that follows — getEmbeddingConfig()
  // falls back to process.env.* with nothing in that read path to notice a
  // change. First run ever (nothing recorded yet) just records the current
  // model rather than reindexing — there's no prior model to have drifted
  // from, and the notes already reflect whatever was live before this check
  // existed.
  const currentModelKey = embeddingModelKey(await getEmbeddingConfig());
  const lastModelKey = await getLastIndexedModel();
  let widthSettled = true;
  if (lastModelKey !== currentModelKey) {
    // Runs on the very first start too, where there is no prior model to have
    // drifted from: the schema ships at 768, so a vault configured for a
    // wider model from the outset would otherwise fail every insert before it
    // ever indexed anything (lib/embedding-dim.ts).
    const outcome = await reconcileEmbeddingDimension();
    widthSettled = outcome.status === 'ok' || outcome.status === 'resized';
    (outcome.status === 'ok' ? console.log : console.warn)(`[startup] ${describeOutcome(outcome)}`);
  }
  if (lastModelKey !== null && lastModelKey !== currentModelKey) {
    const marked = await query<{ id: string }>('update notes set embedding_pending = true where deleted_at is null returning id');
    console.warn(`[startup] embedding model changed (${lastModelKey} -> ${currentModelKey}) — marked ${marked.length} notes for reindex`);
  }
  // Withheld when the new model's width could not be established — usually
  // the provider was still starting up alongside us. Recording the key anyway
  // would mark the question answered and never ask again, leaving a vault
  // permanently too narrow for its own model; leaving it unset costs one
  // repeated check per restart until the provider answers.
  if (widthSettled) await setLastIndexedModel(currentModelKey);

  // A note stays embedding_pending when its provider call failed (Ollama
  // down, crash mid-index) — without this it silently never enters semantic
  // search. Delayed so a cold Ollama container has time to come up; if it's
  // still down, failures log and the notes stay pending for the next start.
  // Previously this only ran once at startup and after import, so a note
  // whose embedding failed mid-uptime (e.g. Ollama restarted) stayed pending
  // until the next server restart. An hourly sweep catches it without
  // needing one.
  setTimeout(reindexPendingAsync, 15_000);
  setInterval(reindexPendingAsync, REINDEX_INTERVAL_MS);

  // lib/trash.ts also purges expired trash opportunistically on every
  // delete, but that alone doesn't guarantee the "30 days" the Trash UI
  // promises — a vault where nothing else is ever deleted would keep one
  // trashed note forever. A daily interval on this long-running process
  // (Next standalone, single instance — see lib/rate-limit.ts) makes the
  // retention window real regardless of what else happens.
  const runPurge = () => purgeExpiredTrash().catch(err => console.error('[trash] purge:', err instanceof Error ? err.message : err));
  runPurge();
  setInterval(runPurge, PURGE_INTERVAL_MS);
}
