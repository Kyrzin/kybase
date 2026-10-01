// Embeddings: provider clients behind one interface; DB settings override env vars.
export { getSemanticProfile, getMinSimilarity, embeddingModelKey } from './model';
export type { EmbedTask, SemanticProfile } from './model';
export { EmbedCancelledError, isQuotaExhausted } from './transport';
export { getEmbedding, getEmbeddings, getEmbedConcurrency } from './embed';
export type { EmbedConcurrency } from './embed';
