import { getEmbeddingConfig } from '../settings';
import { modelNameOf, type EmbedTask } from './model';
import { EmbedCancelledError } from './transport';
import { ollamaEmbed } from './ollama';
import { googleBatchEmbed, googleEmbed } from './google';
import { openaiEmbed } from './openai';

export async function getEmbedding(text: string, task: EmbedTask = 'document', isCancelled?: () => boolean): Promise<number[]> {
  const cfg = await getEmbeddingConfig();
  switch (cfg.provider) {
    case 'ollama': return ollamaEmbed(text, cfg.ollamaModel, task);
    case 'google': return googleEmbed(text, cfg.googleApiKey, modelNameOf(cfg), cfg.requestedDimensions, task, isCancelled);
    case 'openai': return openaiEmbed(text, cfg.openaiApiKey, modelNameOf(cfg), cfg.requestedDimensions);
    default:       throw new Error(`Unknown embedding provider: ${cfg.provider}`);
  }
}

/** Embeds several texts of one note: one batch request on Google, concurrent calls elsewhere. */
export async function getEmbeddings(
  texts: string[],
  task: EmbedTask = 'document',
  isCancelled?: () => boolean
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const cfg = await getEmbeddingConfig();
  if (cfg.provider === 'google') {
    return googleBatchEmbed(texts, cfg.googleApiKey, modelNameOf(cfg), cfg.requestedDimensions, task, isCancelled);
  }
  const { chunks: chunkConcurrency } = await getEmbedConcurrency();
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += chunkConcurrency) {
    if (isCancelled?.()) throw new EmbedCancelledError();
    const batch = texts.slice(i, i + chunkConcurrency);
    const batchEmbeddings = await Promise.all(
      batch.map((t) => getEmbedding(t, task, isCancelled))
    );
    results.push(...batchEmbeddings);
  }
  return results;
}

export type EmbedConcurrency = { notes: number; chunks: number };

// How many notes and chunks are embedded at once: modest everywhere, since
// Google has a per-minute quota and Ollama often runs on a few CPU cores.
export async function getEmbedConcurrency(): Promise<EmbedConcurrency> {
  const cfg = await getEmbeddingConfig();
  return cfg.provider === 'ollama' ? { notes: 2, chunks: 2 } : { notes: 1, chunks: 2 };
}
