// lib/embedding-dim.ts — keeps the pgvector columns as wide as the model
//
// Migrations 001/002 create notes.embedding and note_chunks.embedding as
// vector(768): the width of the shipped default and of Google's
// text-embedding-004. For a model of any other width that is not a
// degradation but a hard stop — Postgres refuses the row outright
// ("expected 768 dimensions, not 1024") — so pointing Ollama at a 1024-dim
// model such as mxbai-embed-large or bge-m3 leaves every note unindexed.
// Hybrid search keeps answering out of its text arm, so the vault looks
// healthy while its semantic half is empty, and the only evidence is a
// Postgres error in the server log.
//
// The width therefore belongs to the configured model rather than to the
// schema, and is reconciled whenever that model changes — which is also the
// only moment it safely can be. Retyping the column requires it to hold no
// vectors of the old width, and a model change is exactly when those vectors
// stop being usable anyway: a query embedded by the new model is not
// comparable to them, and migration 028's generation filter already excludes
// them from every search.
import { getPool, queryOne } from './db';
import { getEmbedding } from './embeddings';

/**
 * pgvector's HNSW limit for the `vector` type. A wider model would have to
 * give up the index — a sequential scan over every chunk on each search — or
 * move the columns to halfvec, so it is refused rather than half-applied.
 */
export const MAX_INDEXABLE_DIMENSIONS = 2000;

/** The columns holding model output, and so the ones that track its width. */
const VECTOR_COLUMNS = ['notes', 'note_chunks'] as const;

export type DimensionOutcome =
  /** Column already matches the model; nothing was touched. */
  | { status: 'ok'; dimensions: number }
  | { status: 'resized'; from: number; to: number; pending: number }
  /** Too wide to index — the schema is left alone and the model is unusable. */
  | { status: 'refused'; dimensions: number; reason: string }
  /** The provider could not be reached; the width is still whatever it was. */
  | { status: 'unknown'; reason: string };

/**
 * Width of a vector column as the database currently has it, or null if the
 * column was declared without one (pgvector allows that, but then rejects
 * every index on it, so nothing here can be concluded safely).
 *
 * pgvector stores the dimension in atttypmod directly, unlike the length
 * types where it carries a header offset.
 */
export async function columnDimension(table: string): Promise<number | null> {
  const row = await queryOne<{ atttypmod: number }>(
    `select a.atttypmod
       from pg_attribute a
      where a.attrelid = $1::regclass and a.attname = 'embedding' and a.attnum > 0`,
    [table]
  );
  if (!row || row.atttypmod < 1) return null;
  return row.atttypmod;
}

/**
 * How many numbers the configured model actually returns.
 *
 * One provider call, and the only authoritative answer: a table of known
 * model widths goes stale the week after it is written, and Ollama in
 * particular will happily serve a model this build has never heard of.
 */
export async function probeModelDimension(): Promise<number> {
  const vector = await getEmbedding('kybase dimension probe', 'query');
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('provider returned an empty embedding');
  }
  return vector.length;
}

/**
 * Bring both vector columns to `dimensions`, discarding the vectors that no
 * longer fit and marking every live note for reindex.
 *
 * One transaction: a failure part-way through would otherwise leave the two
 * columns disagreeing, and a chunk table that cannot accept what the notes
 * table can. Marking pending belongs here rather than in the callers because
 * it is not a policy decision — the vectors are gone, so the notes need
 * rebuilding whatever prompted the resize.
 */
async function resizeColumns(dimensions: number): Promise<number> {
  // A type modifier cannot be a bind parameter, so the width is interpolated.
  // It only ever arrives as an array length, but the check is here rather than
  // in the reader's head.
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_INDEXABLE_DIMENSIONS) {
    throw new Error(`refusing to retype the embedding columns to '${dimensions}'`);
  }
  const client = await getPool().connect();
  try {
    await client.query('begin');
    for (const table of VECTOR_COLUMNS) {
      await client.query(`update ${table} set embedding = null where embedding is not null`);
      await client.query(`alter table ${table} alter column embedding type vector(${dimensions})`);
    }
    const { rows } = await client.query<{ id: string }>(
      'update notes set embedding_pending = true where deleted_at is null returning id'
    );
    await client.query('commit');
    return rows.length;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reconcile the schema with the configured model's width.
 *
 * Call it where the model is known to have changed, not on every start: the
 * probe is a real provider request, and on an unchanged vault it would answer
 * a question nothing asked.
 *
 * Never throws. A provider that cannot be reached leaves the schema as it is
 * and reports 'unknown' — the notes stay pending and the next attempt will
 * try again, which is better than refusing to start the server over a model
 * that may simply be booting alongside it.
 */
export async function reconcileEmbeddingDimension(): Promise<DimensionOutcome> {
  let current: number | null;
  try {
    current = await columnDimension('notes');
  } catch (err) {
    return { status: 'unknown', reason: err instanceof Error ? err.message : String(err) };
  }
  if (current === null) return { status: 'unknown', reason: 'embedding column has no declared width' };

  let probed: number;
  try {
    probed = await probeModelDimension();
  } catch (err) {
    return { status: 'unknown', reason: err instanceof Error ? err.message : String(err) };
  }

  if (probed === current) return { status: 'ok', dimensions: probed };

  if (probed > MAX_INDEXABLE_DIMENSIONS) {
    return {
      status: 'refused',
      dimensions: probed,
      reason: `the model returns ${probed} dimensions, above pgvector's HNSW limit of ${MAX_INDEXABLE_DIMENSIONS}. `
        + `The schema was left at ${current}; choose a narrower model, or one whose output size can be reduced.`,
    };
  }

  try {
    const pending = await resizeColumns(probed);
    return { status: 'resized', from: current, to: probed, pending };
  } catch (err) {
    return { status: 'unknown', reason: err instanceof Error ? err.message : String(err) };
  }
}

/** One line fit for a log or a settings-dialog status message. */
export function describeOutcome(outcome: DimensionOutcome): string {
  switch (outcome.status) {
    case 'ok':       return `embedding width unchanged at ${outcome.dimensions}`;
    case 'resized':  return `embedding width ${outcome.from} -> ${outcome.to}; ${outcome.pending} notes need reindexing`;
    case 'refused':  return `embedding model refused: ${outcome.reason}`;
    case 'unknown':  return `embedding width could not be checked: ${outcome.reason}`;
  }
}
