// lib/embeddings.ts — embedding provider abstraction (DB settings override env vars)
import { getEmbeddingConfig } from './settings';

export type EmbedTask = 'query' | 'document';

export async function getEmbedding(text: string, task: EmbedTask = 'document'): Promise<number[]> {
  const cfg = await getEmbeddingConfig();
  switch (cfg.provider) {
    case 'ollama': return ollamaEmbed(text, cfg.ollamaModel, task);
    case 'google': return googleEmbed(text, cfg.googleApiKey);
    case 'openai': return openaiEmbed(text, cfg.openaiApiKey);
    default:       throw new Error(`Unknown embedding provider: ${cfg.provider}`);
  }
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

// nomic-embed-text (the shipped default) requires a task instruction prefix
// on every input — without it, query and document embeddings land in the
// same narrow band and cosine similarity stops separating relevant notes
// from noise (verified live: a DIY-speaker note outscored a genuinely
// relevant CV note, both sitting at ~0.7 with MIN_SIMILARITY=0.55 in
// lib/search.ts). Other Ollama embedding models don't share this
// convention, so only apply it when the configured model is nomic's.
// https://docs.nomic.ai/atlas/models/text-embedding — search_query: / search_document:
function nomicPrefix(model: string, task: EmbedTask): string {
  if (!model.includes('nomic-embed-text')) return '';
  return task === 'query' ? 'search_query: ' : 'search_document: ';
}

async function ollamaEmbed(text: string, model: string | undefined, task: EmbedTask): Promise<number[]> {
  const url = process.env.OLLAMA_URL ?? 'http://ollama:11434';
  const resolvedModel = model ?? 'nomic-embed-text';
  const input = nomicPrefix(resolvedModel, task) + text;
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
