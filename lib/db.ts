// lib/db.ts — server-side only Postgres pool
// NEVER import from client components (no 'use client' files)
import { Pool } from 'pg';

// Lazy: created on first query, so `next build` needs no DATABASE_URL.
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL env var is missing');
    pool = new Pool({ connectionString });
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
 * Serialize an embedding for a vector-typed parameter.
 * pgvector accepts the '[0.1,0.2,...]' text form; cast with ::vector in SQL.
 */
export function toVector(embedding: number[]): string {
  return JSON.stringify(embedding);
}

// Re-export shared types (defined in lib/types.ts for client use)
export type { Note, Folder } from './types';
