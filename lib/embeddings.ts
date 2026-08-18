// lib/embeddings.ts — embedding provider abstraction (DB settings override env vars)
import { getEmbeddingConfig, getBandOverride, type EmbeddingConfig } from './settings';

export type EmbedTask = 'query' | 'document';

// Semantic-search recall floor — a junk gate, not a relevance judgment.
// Everything at or above this cosine is a *candidate*; how good a candidate
// is gets decided relative to the best hit in its own result set
// (lib/search.ts semanticSearch), not against this absolute number. That
// split is deliberate: a single absolute cosine can't do both jobs at once
// (2026-08-14 measurement — see the 2026-08-14 search-relevance overhaul). This is
// still per-model, and still a real number pulled from measurement, not a
// vault-tuned judgment threshold like the old 0.40/0.55 — the reason it
// can't be one flat number for every model is architectural, not this
// vault's content: embeddinggemma and nomic-embed-text distribute cosine
// similarity completely differently regardless of what's being searched.
//
// Measured live 2026-08-14, same-text pairs on both models (noise = two
// genuinely unrelated passages, signal = a real query against its actual
// answer):
//   embeddinggemma:   noise ~0.08–0.18, signal ~0.53–0.69 → wide gap, a
//                      single flat gate works (0.30 sits in the middle).
//   nomic-embed-text: noise ~0.50–0.66, signal ~0.68–0.72 → compressed to
//                      a ~0.02–0.05 gap. A gate here can only sit just
//                      below the observed signal floor; it will still let
//                      some noise through on its own — see
//                      MIN_SIGNAL_MARGIN in lib/search.ts for the second
//                      layer that catches that (a "best" result that only
//                      barely clears this floor isn't a confident one).
//   Only 5 pairs each — enough to show the shapes are genuinely different,
//   not enough to call these final. Re-run the battery
//   (see the 2026-08-14 search-relevance overhaul methodology) on any model change.
function minSimilarityFor(cfg: EmbeddingConfig): number {
  if (cfg.provider === 'ollama') {
    if ((cfg.ollamaModel ?? '').includes('nomic-embed-text')) return 0.65;
    return 0.30; // embeddinggemma (default) and other local models
  }
  // 0.55 for Google confirmed by measurement 2026-08-18, not inherited from
  // the "everything else" branch it used to sit in: the highest noise sample
  // on a live 121-note vault was 0.552, and signalMargin lifts the effective
  // floor to ~0.58, which cleared all five noise probes. See signalFloorFor
  // below for the full battery. OpenAI's 0.45 is still unmeasured.
  return cfg.provider === 'openai' ? 0.45 : 0.55;
}

export async function getMinSimilarity(): Promise<number> {
  return minSimilarityFor(await getEmbeddingConfig());
}

/**
 * Where a model's REAL matches start, as opposed to where its noise stops.
 * minSimilarityFor above is the second number; this is the first.
 *
 * Why both are needed: a raw cosine says nothing on its own, because models
 * do not share a scale — embeddinggemma separates noise (~0.08–0.18) from
 * signal (~0.53–0.69) by a wide gap, nomic-embed-text compresses the same
 * distinction into ~0.02–0.05. So "0.7 is a good match" is meaningless
 * across models, while "70% of the way from this model's noise ceiling to
 * its signal floor" is the same statement for all of them. That fraction is
 * what lib/search.ts's confidence ladder consumes, and it is the only way to
 * judge a hit WITHOUT looking at its neighbours in the same response.
 *
 * null = this model's band was never measured. Deliberately not guessed:
 * the ladder then refuses to treat its cosine as full corroboration rather
 * than inventing a number, which is visible (hits cap at `moderate`) instead
 * of silently wrong. Fix by measuring, not by picking a plausible constant —
 * the procedure is in the "методика оценки embedding-моделей" note, and the
 * result belongs in the `embedding_bands` setting, not here.
 *
 * Ollama values are the 2026-08-14 measurement, 5 pairs per model.
 *
 * Google text-embedding-004 measured 2026-08-18 on a live 121-note RU/DE/EN
 * vault, 11 probes: 5 queries on topics the vault demonstrably does not
 * contain (noise: 0.516, 0.516, 0.533, 0.540, 0.552) and 6 whose correct
 * answer came back first (signal: 0.736, 0.743, 0.787, 0.796, 0.825, 0.844).
 * A wide empty corridor between 0.552 and 0.736 — and three probes landed
 * inside it (0.612, 0.613, 0.625), every one of them a query with no real
 * answer in the vault and an irrelevant top hit. That corridor is exactly
 * what the two numbers are for: the gate keeps recall (0.55 stays, since the
 * degenerate-set margin already lifts the effective floor to ~0.58, above the
 * highest noise sample), while the signal floor decides confidence — so a
 * 0.61 near-miss now comes back as a candidate the ladder marks as NOT full
 * corroboration, instead of either being silently dropped or dressed up as a
 * confident answer.
 *
 * 0.72 rather than the observed 0.736: eleven probes are enough to place the
 * corridor, not enough to pin its edge to three digits. OpenAI stays
 * unmeasured — its hits cap at `moderate` until someone runs the same battery.
 */
function signalFloorFor(cfg: EmbeddingConfig): number | null {
  if (cfg.provider === 'ollama') {
    if ((cfg.ollamaModel ?? '').includes('nomic-embed-text')) return 0.68;
    return 0.53; // embeddinggemma
  }
  return cfg.provider === 'google' ? 0.72 : null;
}

export type EmbeddingBand = { gate: number; signalFloor: number | null };

/**
 * The active model's band, with the `embedding_bands` setting overriding the
 * measured defaults above. A setting rather than a constant so that measuring
 * a new model is a value change, not a code change and a redeploy — rule 2 of
 * the roadmap's own framing ("настройка с разумным дефолтом").
 */
export async function getEmbeddingBand(): Promise<EmbeddingBand> {
  const cfg = await getEmbeddingConfig();
  const override = await getBandOverride(embeddingModelKey(cfg));
  return {
    gate: override?.gate ?? minSimilarityFor(cfg),
    signalFloor: override?.signalFloor ?? signalFloorFor(cfg),
  };
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
