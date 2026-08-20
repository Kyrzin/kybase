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
  // getEmbeddingConfig()/getTagWeights()/getFolderWeights() below.
  cachedEmbeddingConfig = null;
  cachedTagWeights = null;
  cachedFolderWeights = null;
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

export type BandOverride = { gate?: number };

// Semantic abstention threshold override per embedding model. Empty by
// default: the code ships profiles for the models it measured, and this is
// how someone on an unprofiled model supplies a number without a code change.
// A companion `signalFloor` used to live here and fed a confidence verdict;
// both are gone: see the note above minSimilarityFor in lib/embeddings.ts.
// Original note, kept for the caching rationale:
// Measured noise/signal bands per embedding model, keyed by the provider+model
// string lib/embeddings.ts builds. Empty by default: the code carries the
// bands it has actually measured, and this only overrides them — so measuring
// a new model is a settings write, not a code change and a redeploy.
//
// Cached with the same TTL and for the same reason as the weights below:
// lib/search.ts reads it on every semantic/hybrid call.
const BANDS_CACHE_TTL_MS = 5_000;
let cachedBands: { value: Record<string, BandOverride>; expiresAt: number } | null = null;

/**
 * Every stored band, validated the same way a single lookup is. A settings
 * write needs the full map to merge one model's band in without overwriting
 * the others', and the settings UI needs it to show what is stored.
 */
export async function getEmbeddingBands(): Promise<Record<string, BandOverride>> {
  if (!cachedBands || Date.now() >= cachedBands.expiresAt) {
    cachedBands = { value: await getBandsUncached(), expiresAt: Date.now() + BANDS_CACHE_TTL_MS };
  }
  return cachedBands.value;
}

export async function getBandOverride(modelKey: string): Promise<BandOverride | null> {
  return (await getEmbeddingBands())[modelKey] ?? null;
}

async function getBandsUncached(): Promise<Record<string, BandOverride>> {
  const raw = await getSetting('embedding_bands');
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, BandOverride> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    const band: BandOverride = {};
    // A cosine band only makes sense inside [0, 1), and the floor has to sit
    // ABOVE the gate or the fraction the ladder computes from them inverts.
    // A hand-edited row must degrade to "unmeasured" (the ladder then refuses
    // to claim full corroboration), never to a silently inverted scale.
    if (typeof v.gate === 'number' && Number.isFinite(v.gate) && v.gate >= 0 && v.gate < 1) band.gate = v.gate;
    if (band.gate !== undefined) out[key] = band;
  }
  return out;
}

export async function setEmbeddingBands(bands: Record<string, BandOverride>): Promise<void> {
  await setSetting('embedding_bands', JSON.stringify(bands));
  cachedBands = null;
}

export type TagWeights = Record<string, number>;

// Mechanic lives in code (lib/search.ts multiplies a hit's raw score by
// this before normalizing), vocabulary lives here — empty default, so an
// install that never sets this behaves exactly as before (weight 1 for
// every tag is a no-op on the multiply). No vault-specific tag name is
// hardcoded anywhere: this vault's own canonical/ephemeral split, if the
// owner wants it, is a value in this JSON blob, not a constant in the
// product (per the roadmap's own framing on this file).
// JSON, not comma-separated like fts_languages: this is a map, not a list.
// Cached like getEmbeddingConfig — textSearch reads this on every call, and
// an OR-cascade search can mean two search_notes_fts round trips per
// request, each with zero chance the setting changed mid-request.
const TAG_WEIGHTS_CACHE_TTL_MS = 5_000;
let cachedTagWeights: { value: TagWeights; expiresAt: number } | null = null;

export async function getTagWeights(): Promise<TagWeights> {
  if (cachedTagWeights && Date.now() < cachedTagWeights.expiresAt) {
    return cachedTagWeights.value;
  }
  const weights = await getTagWeightsUncached();
  cachedTagWeights = { value: weights, expiresAt: Date.now() + TAG_WEIGHTS_CACHE_TTL_MS };
  return weights;
}

async function getTagWeightsUncached(): Promise<TagWeights> {
  const raw = await getSetting('tag_weights');
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const weights: TagWeights = {};
  for (const [tag, value] of Object.entries(parsed as Record<string, unknown>)) {
    // A weight has to stay positive and finite: 0 or negative flips a
    // multiplicative score's sign/ordering rather than just nudging it,
    // and a corrupted or hand-edited settings row must not be able to
    // break every search silently — skip that one entry, keep the rest.
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) weights[tag] = value;
  }
  return weights;
}

export async function setTagWeights(weights: TagWeights): Promise<void> {
  await setSetting('tag_weights', JSON.stringify(weights));
}

export type FolderWeights = Record<string, number>;

// Same shape and reasoning as TagWeights above, keyed by folder_id (a
// folder's id is stable across renames; its name isn't, and two sibling
// folders can share a name under different parents — migration 010). Text
// search only, same as tag weights (migration 021's own comment): weighting
// semantic search risks corrupting semanticSearch's best/signalMargin
// absolute noise-floor check.
const FOLDER_WEIGHTS_CACHE_TTL_MS = 5_000;
let cachedFolderWeights: { value: FolderWeights; expiresAt: number } | null = null;

export async function getFolderWeights(): Promise<FolderWeights> {
  if (cachedFolderWeights && Date.now() < cachedFolderWeights.expiresAt) {
    return cachedFolderWeights.value;
  }
  const weights = await getFolderWeightsUncached();
  cachedFolderWeights = { value: weights, expiresAt: Date.now() + FOLDER_WEIGHTS_CACHE_TTL_MS };
  return weights;
}

async function getFolderWeightsUncached(): Promise<FolderWeights> {
  const raw = await getSetting('folder_weights');
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const weights: FolderWeights = {};
  for (const [folderId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) weights[folderId] = value;
  }
  return weights;
}

export async function setFolderWeights(weights: FolderWeights): Promise<void> {
  await setSetting('folder_weights', JSON.stringify(weights));
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
