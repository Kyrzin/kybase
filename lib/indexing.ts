// lib/indexing.ts — single entry point for (re)indexing a note:
// whole-note embedding + per-chunk embeddings. Used by the notes API,
// the MCP server, the admin reindex endpoint, and scripts/reindex.ts.
import { getPool, query as dbQuery, toVector } from './db';
import { getEmbedding, getEmbeddings, EmbedCancelledError, isQuotaExhausted, embeddingModelKey } from './embeddings';
import { getEmbeddingConfig } from './settings';
import { chunkNote } from './chunking';
import { invalidateSemanticEdgesCache } from './semantic-edges';

// The whole-note embedding sees only the head of very long notes — the
// chunks cover the rest. The provider's context window depends on server
// config we can't see (Ollama defaults to 2048 tokens ≈ 4000 chars of dense
// Cyrillic), and overflow hard-fails (400: "input length exceeds the context
// length") — which used to abort indexNote before any chunks were written,
// silently dropping long notes from semantic search entirely. So: start
// with an 8000-char head and halve until the provider accepts it.
const NOTE_EMBED_MAX_CHARS = 8000;
const NOTE_EMBED_MIN_CHARS = 1000;

// Deliberately loose (`token` alone matches plenty), because the providers
// word this differently and a missed overflow means a long note silently
// absent from semantic search. The looseness is safe ONLY because
// isQuotaExhausted is consulted first below — Google's 429 bodies name
// token-based quota metrics, so this test matches them too, and without
// that guard a rate-limited note would walk down the halve-the-budget path
// spending four extra requests per note mid-quota-storm, then store a
// truncated embedding on whichever attempt happened to get through.
function isContextOverflow(err: unknown): boolean {
  return err instanceof Error && /context length|maximum context|too (long|large)|token/i.test(err.message);
}

async function embedNoteHead(title: string, content: string, isCancelled?: () => boolean): Promise<number[]> {
  const full = `${title}\n\n${content}`;
  for (let budget = NOTE_EMBED_MAX_CHARS; ; budget = Math.floor(budget / 2)) {
    try {
      return await getEmbedding(full.slice(0, budget), 'document', isCancelled);
    } catch (err) {
      // Order matters: a quota refusal says nothing about this note's size.
      if (isQuotaExhausted(err)) throw err;
      if (budget <= NOTE_EMBED_MIN_CHARS || !isContextOverflow(err)) throw err;
    }
  }
}

/**
 * Thrown when the text this job embedded is no longer the note's current
 * text. Not an error condition: a newer edit already scheduled its own
 * indexing job, and that one owns the result. Callers log it as a skip.
 */
export class StaleIndexError extends Error {
  constructor(id: string) { super(`Note ${id} changed while being indexed — newer version wins`); }
}

/**
 * The revision of `id` whose text is exactly (title, content), or null when
 * the note's stored text no longer matches — the caller's copy was already
 * stale before the first provider call.
 *
 * Matching on the text itself, not just reading the current revision:
 * indexNote is handed a title/content copy by its caller, and between that
 * caller's write and this read another writer may have landed. Reading the
 * revision alone would capture the NEWER one and then happily certify the
 * older text against it at commit — the exact overwrite this guard exists
 * to prevent, just one step further along.
 */
async function revisionOfExactText(id: string, title: string, content: string): Promise<number | null> {
  const rows = await dbQuery<{ content_revision: string }>(
    'select content_revision from notes where id = $1 and title = $2 and content = $3',
    [id, title, content]
  );
  return rows.length > 0 ? Number(rows[0].content_revision) : null;
}

/**
 * Embed a note and its chunks, then persist both.
 * All embeddings are computed before any rows are touched, so a provider
 * failure leaves the previous index intact (embedding_pending stays true).
 *
 * Every row written is stamped with the model that produced it, and the
 * write is refused outright if the note's text changed while the provider
 * was working (see StaleIndexError / migration 028).
 */
export async function indexNote(id: string, title: string, content: string, isCancelled?: () => boolean): Promise<void> {
  const revision = await revisionOfExactText(id, title, content);
  // Already superseded before the first embedding call — the newer edit's own
  // job is the one that should pay for the provider round trips.
  if (revision === null) throw new StaleIndexError(id);
  const modelKey = embeddingModelKey(await getEmbeddingConfig());

  const noteEmbedding = await embedNoteHead(title, content, isCancelled);

  const chunks = chunkNote(content);
  let chunkRows: { note_id: string; chunk_index: number; heading?: string | null; content: string; embedding: number[] }[] = [];

  if (chunks.length > 0) {
    if (isCancelled?.()) throw new EmbedCancelledError();
    const chunkTexts = chunks.map((chunk) => {
      const context = chunk.heading ? `${title} › ${chunk.heading}` : title;
      return `${context}\n\n${chunk.content}`;
    });

    const chunkEmbeddings = await getEmbeddings(chunkTexts, 'document', isCancelled);
    chunkRows = chunks.map((chunk, i) => ({
      note_id:     id,
      chunk_index: chunk.index,
      heading:     chunk.heading,
      content:     chunk.content,
      embedding:   chunkEmbeddings[i],
    }));
  }

  // One transaction: a failure mid-way leaves the previous index intact.
  const client = await getPool().connect();
  try {
    await client.query('begin');
    // Serialize concurrent indexNote() calls for the SAME note. Two
    // overlapping content changes to one note (e.g. two concurrent
    // append_to_note calls) each schedule their own indexNoteAsync —
    // without a lock here, their DELETE-then-INSERT sequences on
    // note_chunks below can interleave: whichever commits second can
    // collide with rows the first one just inserted, throwing
    // note_chunks_note_id_chunk_index_key (measured live, pre-publication
    // review — reproducible with two concurrent append_to_note calls on
    // the same note; the failing call's error is caught and logged by
    // indexNoteAsync, not surfaced anywhere a caller would see it, so the
    // note's semantic index could silently end up reflecting only one of
    // the two edits). xact-scoped, like FOLDER_REPARENT_LOCK_KEY — releases
    // automatically on commit or rollback, and is a no-op wait (near-zero
    // cost) for the overwhelmingly common case of no concurrent index for
    // the same note.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [id]);

    // The lock above serializes two concurrent index writes; it does not
    // order them. Whichever provider call returns second commits last, even
    // when it embedded the older text — so the revision captured before the
    // first embedding call has to still be current here, read under a row
    // lock so no writer can slip in between this check and the commit.
    // Failing it leaves embedding_pending = true and the previous vectors
    // intact: the newer edit's own job supersedes this one.
    const { rows: current } = await client.query<{ content_revision: string }>(
      'select content_revision from notes where id = $1 for update',
      [id]
    );
    // Thrown, not rolled back here — the catch below owns the rollback.
    if (current.length === 0 || Number(current[0].content_revision) !== revision) {
      throw new StaleIndexError(id);
    }

    await client.query('delete from note_chunks where note_id = $1', [id]);
    for (const row of chunkRows) {
      await client.query(
        `insert into note_chunks (note_id, chunk_index, heading, content, embedding, embedding_model)
         values ($1, $2, $3, $4, $5::vector, $6)`,
        [row.note_id, row.chunk_index, row.heading, row.content, toVector(row.embedding), modelKey]
      );
    }
    await client.query(
      'update notes set embedding = $1::vector, embedding_pending = false, embedding_model = $3 where id = $2',
      [toVector(noteEmbedding), id, modelKey]
    );
    await client.query('commit');
    invalidateSemanticEdgesCache(); // this note's embedding just changed
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * How long a note has to be before its indexing is announced. Ordinary notes
 * finish in under a second and would only fill the log; a book takes minutes,
 * during which nothing else says anything at all.
 */
const ANNOUNCE_ABOVE_CHARS = 50_000;

/**
 * Fire-and-forget variant — note saving must not block on the embedding
 * provider.
 *
 * A long note is announced when it starts and when it finishes, because
 * until it commits there is nothing to look at: chunks are written in one
 * transaction at the end, so a job ten minutes from finishing and a job that
 * died look identical from the outside — no rows, no output, embedding_pending
 * still true. That ambiguity cost a full investigation of a working import.
 */
export function indexNoteAsync(id: string, title: string, content: string): void {
  const long = content.length >= ANNOUNCE_ABOVE_CHARS;
  const started = Date.now();
  if (long) console.info(`[index] note ${id}: started, ${content.length} chars`);
  indexNote(id, title, content).then(() => {
    if (long) console.info(`[index] note ${id}: done in ${Math.round((Date.now() - started) / 1000)}s`);
  }).catch(err => {
    // A superseded job is the guard working, not a failure: the newer edit
    // set embedding_pending = true and scheduled its own run.
    if (err instanceof StaleIndexError) {
      console.info(`[index] note ${id}: superseded by a newer edit, skipped`);
      return;
    }
    console.error(`[index] note ${id}:`, err instanceof Error ? err.message : err);
  });
}
