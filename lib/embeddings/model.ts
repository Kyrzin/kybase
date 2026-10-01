import { getEmbeddingConfig, getBandOverride, DEFAULT_REQUESTED_DIMENSIONS, type EmbeddingConfig } from '../settings';

export type EmbedTask = 'query' | 'document';

// Optional semantic similarity floor, per embedding model. None ships: a fixed
// cosine cutoff cost recall (notably across languages) without buying
// precision, so there is no cutoff unless one is set in `embedding_bands`.

export type SemanticProfile = {
  model: string;
  /** null = no automatic cutoff. NOT 0: zero looks like a measured bound. */
  minSimilarity: number | null;
  status: 'configured' | 'none';
};

export function modelNameOf(cfg: EmbeddingConfig): string {
  if (cfg.provider === 'ollama') return cfg.ollamaModel ?? 'embeddinggemma';
  if (cfg.provider === 'google') return cfg.googleModel ?? 'gemini-embedding-001';
  return cfg.openaiModel ?? 'text-embedding-3-small';
}

/** The cutoff in force, if any, reported so an empty result can be read. */
export async function getSemanticProfile(): Promise<SemanticProfile> {
  const cfg = await getEmbeddingConfig();
  const model = modelNameOf(cfg);
  const override = await getBandOverride(embeddingModelKey(cfg));
  if (override?.gate !== undefined) {
    return { model, minSimilarity: override.gate, status: 'configured' };
  }
  return { model, minSimilarity: null, status: 'none' };
}

/** null = no cutoff; every candidate the index returns is a candidate. */
export async function getMinSimilarity(): Promise<number | null> {
  return (await getSemanticProfile()).minSimilarity;
}

/**
 * Per-provider version of the request shape, part of the model key: bumping
 * one starts a new index generation (reindex, old vectors excluded). Bump only
 * when the request change moves the vectors. google 2: task types are sent.
 */
const INPUT_VERSION: Record<EmbeddingConfig['provider'], number> = {
  ollama: 1,
  google: 2,
  openai: 1,
};

/**
 * Model-key suffix for a non-default requested width; empty otherwise so
 * existing keys, and so existing indexes, stay valid.
 */
function dimensionSuffix(cfg: EmbeddingConfig): string {
  if (cfg.provider === 'ollama') return '';
  const dims = cfg.requestedDimensions;
  if (dims === DEFAULT_REQUESTED_DIMENSIONS) return '';
  return `#d${dims ?? 'native'}`;
}

/** Stable key for the active provider+model+input shape, used by the bands setting, drift detection and the index generation stamp. */
export function embeddingModelKey(cfg: EmbeddingConfig): string {
  // Version 1 is written without a suffix so existing keys keep their exact
  // stored form — an ollama vault must not reindex over a formatting change.
  const v = INPUT_VERSION[cfg.provider] ?? 1;
  const suffix = (v > 1 ? `@v${v}` : '') + dimensionSuffix(cfg);
  if (cfg.provider === 'ollama') return `ollama:${cfg.ollamaModel ?? 'embeddinggemma'}${suffix}`;
  if (cfg.provider === 'google') return `google:${cfg.googleModel ?? 'gemini-embedding-001'}${suffix}`;
  return `openai:${cfg.openaiModel ?? 'text-embedding-3-small'}${suffix}`;
}
