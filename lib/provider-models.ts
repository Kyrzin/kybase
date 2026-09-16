// lib/provider-models.ts — which embedding models a provider actually offers
//
// The settings dialog used to name one model per provider as a fixed caption.
// A caption cannot go stale gracefully: Google withdrew text-embedding-004
// while it was still the shipped default and the only name the dialog showed,
// so the dialog kept advertising a model whose every request answers 404.
//
// Asking the provider is the only thing that cannot drift. Each lookup is one
// authenticated GET, made when the dialog opens, and never on the embedding
// path.
import { getEmbeddingConfig, type EmbeddingProvider } from './settings';

export type ProviderModel = { id: string; note?: string };

export type ModelListing = {
  provider: EmbeddingProvider;
  models: ProviderModel[];
  /** The model this vault is configured to use, listed or not. */
  current: string;
  /** Why the list is empty, in words a person can act on. Never a stack trace. */
  error?: string;
  /** False when the provider cannot say which of its models embed (Ollama). */
  filtered: boolean;
};

const LIST_TIMEOUT_MS = 10_000;

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

/**
 * Google names its embedding models by capability, not by a prefix on the id —
 * gemini-embedding-001 and text-embedding-004 share no naming convention — so
 * the filter is supportedGenerationMethods, which is what the API answers with.
 */
async function googleModels(apiKey: string): Promise<ProviderModel[]> {
  const body = (await getJson(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`
  )) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
  return (body.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('embedContent'))
    // The API returns "models/gemini-embedding-001"; every other part of
    // Kybase stores and sends the bare id.
    .map((m) => ({ id: (m.name ?? '').replace(/^models\//, '') }))
    .filter((m) => m.id.length > 0);
}

/**
 * OpenAI's list says nothing about what a model does, so the id prefix is the
 * only signal available. It is a convention rather than a contract — a model
 * that breaks it simply will not be listed, and the field still accepts a
 * typed-in name.
 */
async function openaiModels(apiKey: string): Promise<ProviderModel[]> {
  const body = (await getJson('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })) as { data?: { id?: string }[] };
  return (body.data ?? [])
    .map((m) => m.id ?? '')
    .filter((id) => id.startsWith('text-embedding'))
    .sort()
    .map((id) => ({ id }));
}

/**
 * Ollama lists what is pulled, not what embeds — a chat model answers
 * /api/embed too, at a width no HNSW index will take. So these are
 * suggestions, `filtered: false` says so, and the width check
 * (lib/embedding-dim.ts) is what actually refuses a bad pick.
 */
async function ollamaModels(): Promise<ProviderModel[]> {
  const url = process.env.OLLAMA_URL ?? 'http://ollama:11434';
  const body = (await getJson(`${url}/api/tags`)) as { models?: { name?: string }[] };
  return (body.models ?? [])
    .map((m) => (m.name ?? '').replace(/:latest$/, ''))
    .filter((id) => id.length > 0)
    .sort()
    .map((id) => ({ id }));
}

/**
 * Never throws: the dialog has to render whether or not the provider answered,
 * and "could not reach it" is itself worth showing next to an empty list.
 */
export async function listEmbeddingModels(provider?: EmbeddingProvider): Promise<ModelListing> {
  const cfg = await getEmbeddingConfig();
  const p = provider ?? cfg.provider;
  const current =
    p === 'ollama' ? cfg.ollamaModel ?? '' : p === 'google' ? cfg.googleModel ?? '' : cfg.openaiModel ?? '';
  const base = { provider: p, current, filtered: p !== 'ollama' };

  try {
    if (p === 'google') {
      if (!cfg.googleApiKey) return { ...base, models: [], error: 'Add a Google API key to list its models.' };
      return { ...base, models: await googleModels(cfg.googleApiKey) };
    }
    if (p === 'openai') {
      if (!cfg.openaiApiKey) return { ...base, models: [], error: 'Add an OpenAI API key to list its models.' };
      return { ...base, models: await openaiModels(cfg.openaiApiKey) };
    }
    return { ...base, models: await ollamaModels() };
  } catch (err) {
    return { ...base, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}
