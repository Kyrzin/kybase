// lib/embeddings.ts — embedding provider abstraction (DB settings override env vars)
import { getEmbeddingConfig, type EmbeddingConfig } from './settings';

export type EmbedTask = 'query' | 'document';

// Semantic-search cosine floor, per model — the query/document cosine scale
// differs by embedding model, so this is model-dependent just like the task
// prefixes above. Verified live on this RU/DE vault:
//   - embeddinggemma: wide range, relevant ~0.37–0.64, noise <0.15 → 0.40
//   - nomic-embed-text: compressed high band ~0.6–0.7 → 0.55
//   - Google text-embedding-004: relevant ~0.62–0.74 → 0.55
//   - OpenAI 3-small: unverified here, 0.45 as a conservative middle
// A 2026-08-11 recalibration attempt lowered this to 0.35 (24-query RU
// battery found correct top-1 hits as low as 0.22) but was reverted the same
// day after live testing: a 0.35 floor let genuinely off-topic notes through
// as "weak" hits on queries with no real match in the vault (e.g. cosine
// 0.35 for a firewall-commands note on a VPN-router query) — the vault
// owner prioritizes "nothing relevant" reading as empty over catching a few
// more true positives at the cost of that noise. Keep at 0.40 unless
// re-litigated with the owner.
// Used by lib/search.ts semanticSearch (passed to the match_chunks RPC).
function minSimilarityFor(cfg: EmbeddingConfig): number {
  if (cfg.provider === 'ollama') {
    if ((cfg.ollamaModel ?? '').includes('nomic-embed-text')) return 0.55;
    return 0.40; // embeddinggemma (default) and other local models
  }
  return cfg.provider === 'openai' ? 0.45 : 0.55;
}

export async function getMinSimilarity(): Promise<number> {
  return minSimilarityFor(await getEmbeddingConfig());
}

export type RelevanceAnchors = { floor: number; strong: number };

// Anchors for normalizing a cosine into a 0..1 relevance (lib/search.ts):
// `floor` is the model's search threshold above; `strong` is the cosine of a
// confident hit, read off the same live battery runs the floors came from —
//   - embeddinggemma: precise hits landed ~0.55–0.64 → strong 0.60
//   - nomic-embed-text: its compressed band tops out ~0.76 → strong 0.75
//   - Google text-embedding-004: clear hits ~0.73–0.78 → strong 0.75
//   - OpenAI 3-small: unverified, 0.65 as a conservative middle
// Lowered to 0.55 alongside the floor above on 2026-08-11, reverted the same
// day for the same reason — see minSimilarityFor.
// Like the floors, these are per-model calibration — re-derive both with the
// battery (see the "методика оценки embedding-моделей" note) on model changes.
function strongSimilarityFor(cfg: EmbeddingConfig): number {
  if (cfg.provider === 'ollama') {
    if ((cfg.ollamaModel ?? '').includes('nomic-embed-text')) return 0.75;
    return 0.60; // embeddinggemma (default) and other local models
  }
  return cfg.provider === 'openai' ? 0.65 : 0.75;
}

export async function getRelevanceAnchors(): Promise<RelevanceAnchors> {
  const cfg = await getEmbeddingConfig();
  return { floor: minSimilarityFor(cfg), strong: strongSimilarityFor(cfg) };
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
