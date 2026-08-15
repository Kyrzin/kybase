// lib/embeddings.ts — embedding provider abstraction (DB settings override env vars)
import { getEmbeddingConfig, type EmbeddingConfig } from './settings';

export type EmbedTask = 'query' | 'document';

// Semantic-search recall floor — a junk gate, not a relevance judgment.
// Everything at or above this cosine is a *candidate*; how good a candidate
// is gets decided relative to the best hit in its own result set
// (lib/search.ts semanticSearch), not against this absolute number. That
// split is deliberate: a single absolute cosine can't do both jobs at once
// (2026-08-14 measurement — see "наряд на поиск 2026-08-14"). This is
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
//   (наряд-поиск-2026-08-14 методика) on any model change.
function minSimilarityFor(cfg: EmbeddingConfig): number {
  if (cfg.provider === 'ollama') {
    if ((cfg.ollamaModel ?? '').includes('nomic-embed-text')) return 0.65;
    return 0.30; // embeddinggemma (default) and other local models
  }
  return cfg.provider === 'openai' ? 0.45 : 0.55;
}

export async function getMinSimilarity(): Promise<number> {
  return minSimilarityFor(await getEmbeddingConfig());
}

export async function getEmbedding(text: string, task: EmbedTask = 'document'): Promise<number[]> {
  const cfg = await getEmbeddingConfig();
  switch (cfg.provider) {
    case 'ollama': return ollamaEmbed(text, cfg.ollamaModel, task);
    case 'google': return googleEmbed(text, cfg.googleApiKey);
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

/**
 * Retry on 429 with exponential backoff (honors Retry-After) —
 * bulk reindexing bursts past the provider's requests-per-minute limit.
 */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 5): Promise<Response> {
  let delay = 2000;
  for (let i = 0; ; i++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(EMBED_TIMEOUT_MS) });
    if (res.status !== 429 || i >= attempts - 1) return res;
    const retryAfterMs = Number(res.headers.get('retry-after')) * 1000;
    await new Promise(r => setTimeout(r, retryAfterMs > 0 ? retryAfterMs : delay));
    delay = Math.min(delay * 2, 30_000);
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

async function googleEmbed(text: string, apiKey?: string): Promise<number[]> {
  if (!apiKey) throw new Error('Google API key is not configured');
  const model = process.env.GOOGLE_MODEL ?? 'text-embedding-004';
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: `models/${model}`, content: { parts: [{ text }] }, outputDimensionality: 768 }),
    }
  );
  if (!res.ok) throw new Error(`Google embed error (${res.status}): ${(await res.text()).slice(0, 200)}`);
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
