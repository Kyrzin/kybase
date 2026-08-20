// lib/embeddings.ts — embedding provider abstraction (DB settings override env vars)
import { getEmbeddingConfig, getBandOverride, type EmbeddingConfig } from './settings';

export type EmbedTask = 'query' | 'document';

// ── Model profiles ─────────────────────────────────────────────────────────
//
// One number per embedding MODEL: the cosine below which a semantic hit is
// treated as unrelated, and the only absolute number left in search.
//
// Keyed by MODEL, not provider. A provider is not a property of a similarity
// space — an OpenAI-compatible endpoint can serve a different model tomorrow,
// and the threshold would then belong to the wrong geometry.
//
// Honest about what it is: a heuristic measured on a handful of pairs, never
// a probability.
//
// Deriving it from a vault's own contents instead was built, measured and
// abandoned. It does not work, and the reason is structural rather than a
// tuning failure: probes drawn from a collection's own text — titles, or
// sentences out of the documents — outscore the questions people actually
// ask, because everything in one collection resembles everything else in it
// more than an outsider's phrasing ever will. The background such probes
// produce sits ABOVE real searches, so a cutoff derived from it removes
// answers rather than noise. Underneath that: how similar a collection is to
// itself does not answer whether one query-document pair is related.
//
// The geometry of cosine mostly follows the model, so the model carries the
// number. A portable alternative would have to score the (query, document)
// pair directly, or come from a fixed benchmark run once per model — not
// from a fourth way of averaging the corpus.
//
// Measured on live vaults (2026-08-14 gemma/nomic, 2026-08-18 google), noise =
// unrelated passages, signal = a real query against its actual answer:
//   embeddinggemma      noise ~0.08–0.21, signal ~0.38–0.69  — wide gap
//   nomic-embed-text    noise ~0.50–0.66, signal ~0.68–0.72  — compressed
//   text-embedding-004  noise ≤0.552,     signal ≥0.736
//
// The values are the EFFECTIVE thresholds those batteries produced. They used
// to be a base number plus a relative margin computed in lib/search.ts; that
// indirection is gone, because the two together only ever produced one number
// and hid it in two files. What a search applies is what is written here.
//
// Adding a model means measuring it — properly, across several unrelated
// corpora rather than one vault (roadmap).
type ModelProfile = {
  minSimilarity: number;
  /** false = shipped but never actually measured; reported as such. */
  measured: boolean;
};

const MODEL_PROFILES: Record<string, ModelProfile> = {
  'embeddinggemma':     { minSimilarity: 0.349, measured: true },
  'nomic-embed-text':   { minSimilarity: 0.674, measured: true },
  'text-embedding-004': { minSimilarity: 0.582, measured: true },
  // Inherited from the old "everything that is not Google" branch and never
  // measured on anything. Kept so behaviour does not silently change for
  // whoever is using it, and flagged so nobody mistakes it for a result.
  'text-embedding-3':   { minSimilarity: 0.489, measured: false },
};

// An unknown model gets semantic retrieval but no promise of abstention.
// Pretending a stranger's cosines behave like embeddinggemma's is exactly the
// quiet unmeasured claim this file spent a day removing; a user who has
// measured their own model sets `embedding_bands` and gets a threshold back.
const UNPROFILED_MIN_SIMILARITY = 0;

export type SemanticProfile = {
  model: string;
  minSimilarity: number;
  status: 'profiled' | 'unverified' | 'unprofiled' | 'configured';
};

function modelNameOf(cfg: EmbeddingConfig): string {
  if (cfg.provider === 'ollama') return cfg.ollamaModel ?? 'embeddinggemma';
  if (cfg.provider === 'google') return process.env.GOOGLE_MODEL ?? 'text-embedding-004';
  return process.env.OPENAI_MODEL ?? 'text-embedding-3-small';
}

/**
 * The abstention threshold in force, and where it came from. Reported rather
 * than merely applied: a user whose model was never profiled deserves to know
 * that semantic search will not refuse anything on its own.
 */
export async function getSemanticProfile(): Promise<SemanticProfile> {
  const cfg = await getEmbeddingConfig();
  const model = modelNameOf(cfg);
  const override = await getBandOverride(embeddingModelKey(cfg));
  if (override?.gate !== undefined) {
    return { model, minSimilarity: override.gate, status: 'configured' };
  }
  const key = Object.keys(MODEL_PROFILES).find((k) => model.includes(k));
  const profile = key ? MODEL_PROFILES[key] : null;
  if (!profile) return { model, minSimilarity: UNPROFILED_MIN_SIMILARITY, status: 'unprofiled' };
  return { model, minSimilarity: profile.minSimilarity, status: profile.measured ? 'profiled' : 'unverified' };
}

export async function getMinSimilarity(): Promise<number> {
  return (await getSemanticProfile()).minSimilarity;
}

/** Stable key for the active provider+model, used by the bands setting. */
export function embeddingModelKey(cfg: EmbeddingConfig): string {
  return cfg.provider === 'ollama'
    ? `ollama:${cfg.ollamaModel ?? 'embeddinggemma'}`
    : `${cfg.provider}:${cfg.provider === 'google' ? (process.env.GOOGLE_MODEL ?? 'text-embedding-004') : 'default'}`;
}

// A reindex batch (lib/reindex.ts) can be stopped mid-run by the user. The
// only waits long enough to be worth interrupting are Google's — pacing and
// 429 backoff can each run tens of seconds — so this is only honored there;
// Ollama's single 500ms retry and OpenAI's fast path aren't worth the extra
// plumbing.
export class EmbedCancelledError extends Error {
  constructor() { super('Reindex cancelled'); }
}

/**
 * True when an error is the provider refusing on quota rather than failing
 * on this particular input. A 429 that already survived fetchWithRetry's
 * attempts is not a transient burst any more — it's the ceiling, and every
 * further note buys another full ladder of futile requests.
 *
 * Two callers, both of which get it wrong without this distinction:
 *   - lib/reindex.ts counts a quota streak, not any-failure streak, so five
 *     genuinely broken notes in a row don't get reported as "quota".
 *   - lib/indexing.ts's embedNoteHead must NOT mistake this for a context
 *     overflow: its overflow test matches /token/i against the message, and
 *     Google's quota metrics are token-named, so a 429 body could send a
 *     note down the halve-the-budget path and store a silently truncated
 *     embedding. Checked before that test, never after.
 *
 * Message-based by necessity — the provider errors are thrown as strings by
 * each *Embed function — but anchored on 429/RESOURCE_EXHAUSTED markers
 * rather than loose wording.
 */
export function isQuotaExhausted(err: unknown): boolean {
  return err instanceof Error
    && /\(429\)|RESOURCE_EXHAUSTED|exceeded your current quota|rate limit/i.test(err.message);
}

export async function getEmbedding(text: string, task: EmbedTask = 'document', isCancelled?: () => boolean): Promise<number[]> {
  const cfg = await getEmbeddingConfig();
  switch (cfg.provider) {
    case 'ollama': return ollamaEmbed(text, cfg.ollamaModel, task);
    case 'google': return googleEmbed(text, cfg.googleApiKey, isCancelled);
    case 'openai': return openaiEmbed(text, cfg.openaiApiKey);
    default:       throw new Error(`Unknown embedding provider: ${cfg.provider}`);
  }
}

export type EmbedConcurrency = { notes: number; chunks: number };

// How many notes/chunks lib/reindex.ts and lib/indexing.ts embed at once.
// Verified live: the old flat 3 notes × 4 chunks (≤12 concurrent calls) blew
// through Google's free-tier embedding quota during a 90-note reindex —
// hundreds of 429s, each retried up to 5x by fetchWithRetry. Ollama has no
// quota, but it's often a small self-hosted box (single CPU core doing
// inference), not a datacenter — 12-way concurrency there just queues
// requests behind each other rather than speeding anything up, so it gets a
// modest number too, not the old aggressive default.
export async function getEmbedConcurrency(): Promise<EmbedConcurrency> {
  const cfg = await getEmbeddingConfig();
  return cfg.provider === 'ollama' ? { notes: 2, chunks: 2 } : { notes: 1, chunks: 2 };
}

// A hung provider (e.g. a stalled Ollama container) would otherwise block
// note saves and searches forever — the caller sees a TimeoutError and
// embedding_pending stays true for the next reindex.
const EMBED_TIMEOUT_MS = 30_000;

// Google's RESOURCE_EXHAUSTED body carries the real wait in
// error.details[].retryDelay (a "23s"-style string), not a Retry-After
// header — verified live 2026-08-18, this vault's actual 429 body has no
// such header. Safe to try on any provider: returns null on anything that
// isn't this exact shape.
async function parseRetryDelayMs(res: Response): Promise<number | null> {
  try {
    const body = await res.clone().json();
    const info = body?.error?.details?.find((d: { '@type'?: string }) => d['@type']?.includes('RetryInfo'));
    const seconds = typeof info?.retryDelay === 'string' ? parseFloat(info.retryDelay) : NaN;
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

// The 429 backoff/retryDelay wait can run up to 30s per attempt — a plain
// setTimeout would make a Stop click sit unanswered for that long. Polling
// isCancelled in short slices instead means a cancel lands within one slice
// of a click, without needing a real AbortController (there's no in-flight
// fetch during this wait — the previous attempt already got its 429 back).
async function sleepCancellable(ms: number, isCancelled?: () => boolean): Promise<void> {
  const slice = 500;
  for (let remaining = ms; remaining > 0; remaining -= slice) {
    if (isCancelled?.()) throw new EmbedCancelledError();
    await new Promise(r => setTimeout(r, Math.min(slice, remaining)));
  }
  if (isCancelled?.()) throw new EmbedCancelledError();
}

/**
 * Retry on 429 with exponential backoff (honors a body-embedded retryDelay,
 * then Retry-After, then our own backoff) — bulk reindexing bursts past the
 * provider's requests-per-minute limit.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  // `pace` is awaited before EVERY attempt, retries included: a retry is a
  // request like any other and the provider's per-minute meter counts it.
  // Pacing only the first attempt (as this did initially) means a note that
  // hits 429 five times spends five slots' worth of quota while the gate
  // thinks it spent one — the exact shape of the 693-request storm this
  // whole path exists to prevent.
  opts: { attempts?: number; onRateLimited?: () => void; isCancelled?: () => boolean; pace?: () => Promise<void> } = {}
): Promise<Response> {
  const attempts = opts.attempts ?? 5;
  const MAX_WAIT_MS = 30_000; // same ceiling as our own backoff — a quota
  // that's exhausted for the day can hand back a retryDelay measured in
  // minutes/hours; honoring that literally per attempt would stall a single
  // note for as long as the quota window, defeating reindexRows' own
  // consecutive-failure circuit breaker (lib/reindex.ts). Capping it means
  // we still back off, just not indefinitely — the breaker decides when to
  // give up, not the provider's raw hint.
  let delay = 2000;
  for (let i = 0; ; i++) {
    if (opts.isCancelled?.()) throw new EmbedCancelledError();
    if (opts.pace) await opts.pace();
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(EMBED_TIMEOUT_MS) });
    if (res.status !== 429 || i >= attempts - 1) return res;
    opts.onRateLimited?.();
    const bodyDelayMs = await parseRetryDelayMs(res);
    const headerDelayMs = Number(res.headers.get('retry-after')) * 1000;
    const waitMs = bodyDelayMs || (headerDelayMs > 0 ? headerDelayMs : delay);
    await sleepCancellable(Math.min(waitMs, MAX_WAIT_MS), opts.isCancelled);
    delay = Math.min(delay * 2, MAX_WAIT_MS);
  }
}

// Ollama embedding models expect a task-instruction prefix on every input,
// and it materially changes retrieval quality — the wrong prefix (or none)
// collapses cosine separation. Conventions differ per model, so match the
// prefix to the configured model:
//   - embeddinggemma (shipped default): Google's multilingual format. Our
//     document text already carries its title inline, so title: none.
//     Separates RU/DE far better than nomic (verified live: query→CV 0.32
//     vs query→borsch 0.11, a ~0.2 gap, versus nomic's compressed ~0.06).
//     https://ai.google.dev/gemma/docs/embeddinggemma
//   - nomic-embed-text: search_query: / search_document:
//     (kept a narrow high band on RU — see lib/search.ts MIN_SIMILARITY note).
//   - anything else: no prefix.
/**
 * Bump whenever the QUERY-side prompt below changes. Stored query vectors
 * from two versions live in different subspaces and must never be pooled into
 * one distribution — the same trap that made 2026-08-19's first calibration
 * compare document-space against query-space and read 0.3 too high.
 */
export const QUERY_PROMPT_VERSION = 1;

function ollamaPromptInput(model: string, task: EmbedTask, text: string): string {
  if (model.includes('embeddinggemma')) {
    return task === 'query'
      ? `task: search result | query: ${text}`
      : `title: none | text: ${text}`;
  }
  if (model.includes('nomic-embed-text')) {
    return (task === 'query' ? 'search_query: ' : 'search_document: ') + text;
  }
  return text;
}

// A 4xx (bad input, e.g. context-length overflow) won't be fixed by retrying
// the same request — indexNote's own shrink-and-retry loop (embedNoteHead)
// already handles that case at a higher level. Only a network-level failure
// (container mid-restart, connection reset/refused — fetch rejects rather
// than resolving) or a 5xx look like "Ollama isn't ready yet" and are worth
// one retry; unlike fetchWithRetry above, there's no Retry-After to honor
// and no quota to back off from, so this is one short fixed pause, not
// exponential backoff.
const OLLAMA_RETRY_DELAY_MS = 500;

class OllamaRetryableError extends Error {}

async function ollamaEmbedOnce(url: string, model: string, input: string): Promise<number[]> {
  let res: Response;
  try {
    res = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OllamaRetryableError(err instanceof Error ? err.message : 'fetch failed');
  }
  if (!res.ok) {
    // Include the body: Ollama's statusText is just "Bad Request", the real
    // cause ("input length exceeds the context length") is in the JSON.
    const message = `Ollama error (${res.status}): ${(await res.text()).slice(0, 200)}`;
    if (res.status >= 500) throw new OllamaRetryableError(message);
    throw new Error(message);
  }
  const data = await res.json();
  return data.embeddings[0] as number[];
}

async function ollamaEmbed(text: string, model: string | undefined, task: EmbedTask): Promise<number[]> {
  const url = process.env.OLLAMA_URL ?? 'http://ollama:11434';
  const resolvedModel = model ?? 'embeddinggemma';
  const input = ollamaPromptInput(resolvedModel, task, text);
  try {
    return await ollamaEmbedOnce(url, resolvedModel, input);
  } catch (err) {
    if (!(err instanceof OllamaRetryableError)) throw err;
    await new Promise(r => setTimeout(r, OLLAMA_RETRY_DELAY_MS));
    return ollamaEmbedOnce(url, resolvedModel, input);
  }
}

// getEmbedConcurrency's notes:1/chunks:2 only caps how many Google calls run
// at once — it has no idea how many ran in the last minute, so a reindex
// still bursts past the free-tier RPM limit at that concurrency (measured
// live 2026-08-18: 693 requests, 429 on most of them). This paces every
// Google call against a shared minimum gap instead. There's no single
// published RPM figure worth hard-coding (and free-tier limits change), so
// it adapts: back off hard on a 429, ease back down after a run of clean
// calls — an async chain (not a timestamp check-then-set) so two calls
// racing past the gate can't both read the same "next allowed" time.
let googleGapMs = 1100;
let googleNextAt = 0;
let googleChain: Promise<void> = Promise.resolve();
const GOOGLE_MIN_GAP_MS = 250;
const GOOGLE_MAX_GAP_MS = 15_000;

function googlePace(isCancelled?: () => boolean): Promise<void> {
  const p = googleChain.then(async () => {
    const wait = googleNextAt - Date.now();
    if (wait > 0) await sleepCancellable(wait, isCancelled);
    googleNextAt = Date.now() + googleGapMs;
  });
  // Even a cancelled wait must still advance the chain so the next queued
  // call doesn't inherit this one's already-consumed wait.
  googleChain = p.catch(() => {});
  return p;
}

async function googleEmbed(text: string, apiKey?: string, isCancelled?: () => boolean): Promise<number[]> {
  if (!apiKey) throw new Error('Google API key is not configured');
  const model = process.env.GOOGLE_MODEL ?? 'text-embedding-004';
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: `models/${model}`, content: { parts: [{ text }] }, outputDimensionality: 768 }),
    },
    {
      onRateLimited: () => { googleGapMs = Math.min(googleGapMs * 1.5, GOOGLE_MAX_GAP_MS); },
      isCancelled,
      pace: () => googlePace(isCancelled),
    }
  );
  if (!res.ok) throw new Error(`Google embed error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  googleGapMs = Math.max(GOOGLE_MIN_GAP_MS, googleGapMs * 0.9);
  const data = await res.json();
  return data.embedding.values as number[];
}

async function openaiEmbed(text: string, apiKey?: string): Promise<number[]> {
  if (!apiKey) throw new Error('OpenAI API key is not configured');
  const res = await fetchWithRetry('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text, dimensions: 768 }),
  });
  if (!res.ok) throw new Error(`OpenAI embed error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.data[0].embedding as number[];
}
