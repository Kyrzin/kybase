import type { EmbedTask } from './model';
import { EmbedCancelledError, fetchWithRetry, sleepCancellable } from './transport';

// Paces every Google call against a shared minimum gap that widens on a 429
// and narrows after clean calls; concurrency limits alone still burst past the
// per-minute quota. An async chain, so two calls cannot claim the same slot.
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
  // A cancelled wait still advances the chain.
  googleChain = p.catch(() => {});
  return p;
}

// Queries and documents use different task types (asymmetric model).
// https://ai.google.dev/api/embeddings#TaskType
function googleTaskType(task: EmbedTask): string {
  return task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
}

/** Spread into a request body: absent entirely when no size was chosen. */
function googleDimensions(dims: number | null): { outputDimensionality?: number } {
  return dims === null ? {} : { outputDimensionality: dims };
}

export async function googleEmbed(text: string, apiKey: string | undefined, model: string, dims: number | null, task: EmbedTask = 'document', isCancelled?: () => boolean): Promise<number[]> {
  if (!apiKey) throw new Error('Google API key is not configured');
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        taskType: googleTaskType(task),
        ...googleDimensions(dims),
      }),
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

const GOOGLE_BATCH_MAX = 100;

export async function googleBatchEmbed(texts: string[], apiKey: string | undefined, model: string, dims: number | null, task: EmbedTask = 'document', isCancelled?: () => boolean): Promise<number[][]> {
  if (!apiKey) throw new Error('Google API key is not configured');
  if (texts.length === 0) return [];

  const allEmbeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += GOOGLE_BATCH_MAX) {
    if (isCancelled?.()) throw new EmbedCancelledError();
    const batchTexts = texts.slice(i, i + GOOGLE_BATCH_MAX);
    const requests = batchTexts.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      taskType: googleTaskType(task),
      ...googleDimensions(dims),
    }));

    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      },
      {
        onRateLimited: () => { googleGapMs = Math.min(googleGapMs * 1.5, GOOGLE_MAX_GAP_MS); },
        isCancelled,
        pace: () => googlePace(isCancelled),
      }
    );
    if (!res.ok) throw new Error(`Google batch embed error (${res.status}): ${(await res.text()).slice(0, 200)}`);
    googleGapMs = Math.max(GOOGLE_MIN_GAP_MS, googleGapMs * 0.9);
    const data = await res.json();
    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new Error('Google batch embed error: missing embeddings array in response');
    }
    for (const item of data.embeddings) {
      allEmbeddings.push(item.values as number[]);
    }
  }

  return allEmbeddings;
}
