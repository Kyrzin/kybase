// lib/settings.ts — DB-backed settings with env var fallback
import { query, queryOne } from './db';
import { encryptWithSecret, decryptWithSecret, isEncrypted } from './secret-box';

export type EmbeddingProvider = 'ollama' | 'google' | 'openai';

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  googleApiKey?: string;
  openaiApiKey?: string;
  ollamaModel?: string;
}

// Provider API keys are encrypted at rest (lib/secret-box.ts) — a DB dump
// alone shouldn't hand over working Google/OpenAI credentials. Other
// settings (provider choice, model name) aren't secret and stay plaintext.
const ENCRYPTED_SETTING_KEYS = new Set(['google_api_key', 'openai_api_key']);

function requireSecret(): string {
  const secret = process.env.KYBASE_SECRET;
  if (!secret) throw new Error('KYBASE_SECRET env var is missing');
  return secret;
}

// Tolerant read: a DB hiccup falls back to env vars (same contract the
// UI and embedding pipeline always had) instead of failing the caller.
async function getSetting(key: string): Promise<string | null> {
  try {
    const row = await queryOne<{ value: string }>(
      'select value from settings where key = $1',
      [key]
    );
    if (!row) return null;
    // A key entered before encryption shipped is still plain text in the
    // DB — read it as-is rather than failing; it's re-encrypted the next
    // time it's written (setSetting always encrypts going forward).
    if (ENCRYPTED_SETTING_KEYS.has(key) && isEncrypted(row.value)) {
      return decryptWithSecret(row.value, requireSecret());
    }
    return row.value;
  } catch (err) {
    console.warn(`[settings] read '${key}' failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  const stored = ENCRYPTED_SETTING_KEYS.has(key) ? encryptWithSecret(value, requireSecret()) : value;
  await query(
    `insert into settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, stored]
  );
  // Simplest correct invalidation: any settings write drops the whole
  // cache, not just the key that changed. setSetting isn't on a hot path
  // (a handful of calls per session, from the settings UI/API), unlike
  // getEmbeddingConfig() below.
  cachedEmbeddingConfig = null;
}

// Which text search configs notes_search_vector_trigger/search_notes_fts
// combine on top of 'simple' (migration 016) — comma-separated, e.g.
// 'russian,english,german'. Defaults match the hardcoded pair migration
// 013 shipped with, so an install that never touches this setting behaves
// exactly as before; adding a language is a data change (this key), not a
// migration or a fork.
const DEFAULT_FTS_LANGUAGES = ['russian', 'english'];

export async function getFtsLanguages(): Promise<string[]> {
  const raw = await getSetting('fts_languages');
  if (!raw) return DEFAULT_FTS_LANGUAGES;
  const langs = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return langs.length ? langs : DEFAULT_FTS_LANGUAGES;
}

// Comma-separated, matching the trigger's own parsing (string_to_array on
// ',') — no per-language validation here; an unregistered Postgres text
// search config is caught and skipped per-language inside the trigger
// itself (it must not be able to break every note write on a typo).
export async function setFtsLanguages(languages: string[]): Promise<void> {
  await setSetting('fts_languages', languages.map((s) => s.trim()).filter(Boolean).join(','));
}

// getEmbeddingConfig is on the hot path — every embed call (getEmbedding,
// getMinSimilarity) reads it, and the OR-cascade (search-relevance overhaul step 3) can
// mean multiple search_notes_fts calls per request, each one re-deriving
// the same 4 settings rows with zero chance they changed mid-request.
// Short TTL rather than "forever until invalidated": a stale read is
// bounded to a few seconds even if some future write path forgets to
// clear the cache, instead of serving last session's provider config
// indefinitely (2026-08-14 search-relevance overhaul, step 7 — measured cost, not
// hypothetical: unbounded before this).
const EMBEDDING_CONFIG_CACHE_TTL_MS = 5_000;
let cachedEmbeddingConfig: { value: EmbeddingConfig; expiresAt: number } | null = null;

export async function getEmbeddingConfig(): Promise<EmbeddingConfig> {
  if (cachedEmbeddingConfig && Date.now() < cachedEmbeddingConfig.expiresAt) {
    return cachedEmbeddingConfig.value;
  }

  const [provider, googleApiKey, openaiApiKey, ollamaModel] = await Promise.all([
    getSetting('embedding_provider'),
    getSetting('google_api_key'),
    getSetting('openai_api_key'),
    getSetting('ollama_model'),
  ]);

  const cfg: EmbeddingConfig = {
    provider: (provider ?? process.env.EMBEDDING_PROVIDER ?? 'ollama') as EmbeddingProvider,
    googleApiKey:  googleApiKey  ?? process.env.GOOGLE_API_KEY,
    openaiApiKey:  openaiApiKey  ?? process.env.OPENAI_API_KEY,
    ollamaModel:   ollamaModel   ?? process.env.OLLAMA_MODEL ?? 'embeddinggemma',
  };
  cachedEmbeddingConfig = { value: cfg, expiresAt: Date.now() + EMBEDDING_CONFIG_CACHE_TTL_MS };
  return cfg;
}
