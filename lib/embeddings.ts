// lib/embeddings.ts — embedding provider abstraction (DB settings override env vars)
import { getEmbeddingConfig, type EmbeddingConfig } from './settings';

export type EmbedTask = 'query' | 'document';

// Two cosine anchors per model, used to map a raw similarity onto a 0..1
// relevance (lib/search.ts). Both are model-dependent because the query/
// document cosine scale differs by embedding model, just like the task
// prefixes above.
//   - floor  = the search threshold: at or below it a hit is not relevant
//              (relevance 0). Passed to match_chunks as min_similarity.
//   - strong = the cosine of a confident hit: at or above it relevance is 1.
// Verified live on this RU/DE vault (91 notes, embeddinggemma):
//   noise (борщ) ~0.15; barely-relevant ~0.40–0.41; good ~0.42–0.48;
//   a spot-on conceptual match tops out ~0.53. So floor 0.40 / strong 0.55
//   puts real matches in the moderate band and only near-perfect ones strong.
// nomic sits in a compressed high band (~0.6–0.7); Google similar; OpenAI
// unverified here (conservative middle).
export type RelevanceAnchors = { floor: number; strong: number };

function relevanceAnchorsFor(cfg: EmbeddingConfig): RelevanceAnchors {
  if (cfg.provider === 'ollama') {
    if ((cfg.ollamaModel ?? '').includes('nomic-embed-text')) return { floor: 0.55, strong: 0.72 };
    return { floor: 0.40, strong: 0.55 }; // embeddinggemma (default) and other local models
  }
  if (cfg.provider === 'openai') return { floor: 0.45, strong: 0.62 };
  return { floor: 0.55, strong: 0.72 }; // google
}

export async function getRelevanceAnchors(): Promise<RelevanceAnchors> {
  return relevanceAnchorsFor(await getEmbeddingConfig());
}

// The floor is the single source of truth for the search threshold — derive
// it from the same anchors so the two can never drift apart.
export async function getMinSimilarity(): Promise<number> {
  return (await getRelevanceAnchors()).floor;
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

async function ollamaEmbed(text: string, model: string | undefined, task: EmbedTask): Promise<number[]> {
  const url = process.env.OLLAMA_URL ?? 'http://ollama:11434';
  const resolvedModel = model ?? 'embeddinggemma';
  const input = ollamaPromptInput(resolvedModel, task, text);
  const res = await fetch(`${url}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: resolvedModel, input }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  // Include the body: Ollama's statusText is just "Bad Request", the real
  // cause ("input length exceeds the context length") is in the JSON.
  if (!res.ok) throw new Error(`Ollama error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.embeddings[0] as number[];
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
