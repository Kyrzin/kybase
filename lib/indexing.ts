// lib/indexing.ts — single entry point for (re)indexing a note:
// whole-note embedding + per-chunk embeddings. Used by the notes API,
// the MCP server, the admin reindex endpoint, and scripts/reindex.ts.
import { getPool, toVector } from './db';
import { getEmbedding } from './embeddings';
import { chunkNote } from './chunking';

// Cap concurrent embedding requests per note so bulk reindexing doesn't
// blast the provider's rate limit — fetchWithRetry's backoff handles the
// occasional 429, but a fully-parallel note with many chunks would trigger
// them constantly instead of rarely.
const EMBED_CONCURRENCY = 4;

// The whole-note embedding sees only the head of very long notes — the
// chunks cover the rest. The provider's context window depends on server
// config we can't see (Ollama defaults to 2048 tokens ≈ 4000 chars of dense
// Cyrillic), and overflow hard-fails (400: "input length exceeds the context
// length") — which used to abort indexNote before any chunks were written,
// silently dropping long notes from semantic search entirely. So: start
// with an 8000-char head and halve until the provider accepts it.
const NOTE_EMBED_MAX_CHARS = 8000;
const NOTE_EMBED_MIN_CHARS = 1000;

function isContextOverflow(err: unknown): boolean {
  return err instanceof Error && /context length|maximum context|too (long|large)|token/i.test(err.message);
}

async function embedNoteHead(title: string, content: string): Promise<number[]> {
  const full = `${title}\n\n${content}`;
  for (let budget = NOTE_EMBED_MAX_CHARS; ; budget = Math.floor(budget / 2)) {
    try {
      return await getEmbedding(full.slice(0, budget), 'document');
    } catch (err) {
      if (budget <= NOTE_EMBED_MIN_CHARS || !isContextOverflow(err)) throw err;
    }
  }
}

/**
 * Embed a note and its chunks, then persist both.
 * All embeddings are computed before any rows are touched, so a provider
 * failure leaves the previous index intact (embedding_pending stays true).
 */
export async function indexNote(id: string, title: string, content: string): Promise<void> {
  const noteEmbedding = await embedNoteHead(title, content);

  const chunks = chunkNote(content);
  const chunkRows = [];
  for (let i = 0; i < chunks.length; i += EMBED_CONCURRENCY) {
    const batch = chunks.slice(i, i + EMBED_CONCURRENCY);
    const embedded = await Promise.all(batch.map(async (chunk) => {
      const context = chunk.heading ? `${title} › ${chunk.heading}` : title;
      const embedding = await getEmbedding(`${context}\n\n${chunk.content}`, 'document');
      return {
        note_id:     id,
        chunk_index: chunk.index,
        heading:     chunk.heading,
        content:     chunk.content,
        embedding,
      };
    }));
    chunkRows.push(...embedded);
  }

  // One transaction: a failure mid-way leaves the previous index intact.
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('delete from note_chunks where note_id = $1', [id]);
    for (const row of chunkRows) {
      await client.query(
        `insert into note_chunks (note_id, chunk_index, heading, content, embedding)
         values ($1, $2, $3, $4, $5::vector)`,
        [row.note_id, row.chunk_index, row.heading, row.content, toVector(row.embedding)]
      );
    }
    await client.query(
      'update notes set embedding = $1::vector, embedding_pending = false where id = $2',
      [toVector(noteEmbedding), id]
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** Fire-and-forget variant — note saving must not block on the embedding provider. */
export function indexNoteAsync(id: string, title: string, content: string): void {
  indexNote(id, title, content).catch(err => {
    console.error(`[index] note ${id}:`, err instanceof Error ? err.message : err);
  });
}
