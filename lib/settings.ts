// lib/settings.ts — DB-backed settings with env var fallback
import { query, queryOne } from './db';

export type EmbeddingProvider = 'ollama' | 'google' | 'openai';

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  googleApiKey?: string;
  openaiApiKey?: string;
  ollamaModel?: string;
}

// Tolerant read: a DB hiccup falls back to env vars (same contract the
// UI and embedding pipeline always had) instead of failing the caller.
async function getSetting(key: string): Promise<string | null> {
  try {
    const row = await queryOne<{ value: string }>(
      'select value from settings where key = $1',
      [key]
    );
    return row?.value ?? null;
  } catch (err) {
    console.warn(`[settings] read '${key}' failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  await query(
    `insert into settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value]
  );
}

export async function getEmbeddingConfig(): Promise<EmbeddingConfig> {
  const [provider, googleApiKey, openaiApiKey, ollamaModel] = await Promise.all([
    getSetting('embedding_provider'),
    getSetting('google_api_key'),
    getSetting('openai_api_key'),
    getSetting('ollama_model'),
  ]);

  return {
    provider: (provider ?? process.env.EMBEDDING_PROVIDER ?? 'ollama') as EmbeddingProvider,
    googleApiKey:  googleApiKey  ?? process.env.GOOGLE_API_KEY,
    openaiApiKey:  openaiApiKey  ?? process.env.OPENAI_API_KEY,
    ollamaModel:   ollamaModel   ?? process.env.OLLAMA_MODEL ?? 'nomic-embed-text',
  };
}
