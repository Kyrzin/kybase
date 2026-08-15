// lib/db.ts — server-side only Postgres pool
// NEVER import from client components (no 'use client' files)
import { Pool } from 'pg';

// Lazy: created on first query, so `next build` needs no DATABASE_URL.
let pool: Pool | undefined;

// Both were unset (0 = no timeout) — a runaway query or a transaction left
// open by a crashed request would otherwise hold its connection forever,
// eventually exhausting the pool. pg applies these via `SET` on each new
// connection, so they don't require touching DATABASE_URL / query strings.
const STATEMENT_TIMEOUT_MS = 30_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL env var is missing');
    pool = new Pool({
      connectionString,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    });
    // node-postgres's own documented gotcha: an idle client whose connection
    // dies underneath it (Postgres restarted, a DBA/pg_terminate_backend
    // killed the backend, a network blip) emits 'error' on the Pool as a
    // plain EventEmitter event, not a rejected query promise anywhere. With
    // no listener, Node's default EventEmitter behavior for an unhandled
    // 'error' event is to throw — crashing the whole process on a transient
    // connection issue that every other client in the pool would have
    // survived. Found live during pre-publication review: surfaced as an
    // uncaught "Connection terminated unexpectedly" exception while fixing
    // an unrelated itest-teardown timing issue (lib/__itest__/db-harness.ts)
    // — a latent gap that had simply never been exercised before, not
    // something specific to the test harness.
    pool.on('error', (err) => {
      console.error('[db] idle client error (connection likely dropped by the server):', err instanceof Error ? err.message : err);
    });
  }
  return pool;
}

/** Run a parameterized query and return the rows. */
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const { rows } = await getPool().query(text, params);
  return rows as T[];
}

/** Like query(), but returns the single row or null. */
export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run `fn` inside a single transaction; rolls back on any throw.
 * Multi-statement invariants (e.g. rename + backlink rewrite) must go
 * through this — two pool queries can interleave or half-fail.
 */
export async function withTransaction<T>(
  fn: (client: import('pg').PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Advisory-lock key serializing folder reparenting (REST and MCP alike).
 * The cycle check (walk ancestors of the proposed parent) and the write that
 * acts on it are two separate statements — without a shared lock, two
 * concurrent moves (e.g. A into B and B into A at the same time) can each
 * read a cycle-free tree and both commit, producing a real A -> B -> A cycle
 * that no single request's check caught. Take with
 * `select pg_advisory_xact_lock($1)` inside the same transaction as the
 * check + write; it releases automatically on commit or rollback.
 */
export const FOLDER_REPARENT_LOCK_KEY = 0x666f6c64; // 'fold'

/** True when the error is a Postgres unique-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * True for a malformed literal — most often an id that is not a uuid.
 * Callers report it as a bad request; letting it surface as 500 would blame
 * the server for a client typo.
 */
export function isInvalidTextRepresentation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '22P02';
}

/**
 * Serialize an embedding for a vector-typed parameter.
 * pgvector accepts the '[0.1,0.2,...]' text form; cast with ::vector in SQL.
 */
export function toVector(embedding: number[]): string {
  return JSON.stringify(embedding);
}

// Re-export shared types (defined in lib/types.ts for client use)
export type { Note, Folder } from './types';
