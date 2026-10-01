import { query as dbQuery } from '../db';
import type { SearchFilters, SearchResult } from './types';

// Filters are applied inside the RPCs (before ORDER BY / LIMIT); the small
// overfetch is a margin for the substring path, which filters in JS.
const OVERFETCH_FACTOR = 8;

const OVERFETCH_CAP = 300;

export function hasFilters(f?: SearchFilters): f is SearchFilters {
  return !!f && (f.folderId !== undefined || f.tag !== undefined || f.createdAfter !== undefined
    || f.createdBefore !== undefined || f.updatedAfter !== undefined || f.updatedBefore !== undefined);
}

export async function filteredNoteIds(filters: SearchFilters): Promise<Set<string>> {
  const conds: string[] = ['deleted_at is null'];
  const params: unknown[] = [];
  if (filters.folderId)      { params.push(filters.folderId);      conds.push(`folder_id = $${params.length}`); }
  if (filters.tag)           { params.push([filters.tag]);         conds.push(`tags @> $${params.length}`); }
  if (filters.createdAfter)  { params.push(filters.createdAfter);  conds.push(`created_at >= $${params.length}`); }
  if (filters.createdBefore) { params.push(filters.createdBefore); conds.push(`created_at <= $${params.length}`); }
  // content_updated_at: a link rewrite elsewhere must not count as an edit.
  if (filters.updatedAfter)  { params.push(filters.updatedAfter);  conds.push(`content_updated_at >= $${params.length}`); }
  if (filters.updatedBefore) { params.push(filters.updatedBefore); conds.push(`content_updated_at <= $${params.length}`); }
  const rows = await dbQuery<{ id: string }>(
    `select id from notes where ${conds.join(' and ')}`,
    params
  );
  return new Set(rows.map((r) => r.id));
}

export async function applyFilters(
  results: SearchResult[],
  limit: number,
  filters: SearchFilters | undefined,
  allowedIds?: Set<string>
): Promise<SearchResult[]> {
  if (!hasFilters(filters)) return results.slice(0, limit);
  const allowed = allowedIds ?? await filteredNoteIds(filters);
  const filtered = results.filter((r) => allowed.has(r.id)).slice(0, limit);
  // Rescale so the best surviving hit reads 1.0 again.
  const topRelevance = Math.max(0, ...filtered.map((r) => r.relevance));
  if (topRelevance > 0 && topRelevance < 1) {
    filtered.forEach((r) => { r.relevance = r.relevance / topRelevance; });
  }
  return filtered;
}

/** Notes shorter than get_note's default window are read whole; no offset needed. */
export const OFFSET_WORTH_IT_ABOVE = 20_000;

/** Enough of the excerpt to identify one place in a note, not a common phrase. */
export const NEEDLE_CHARS = 60;

/**
 * Sets `excerpt_offset` for long notes on the returned page, so a hit inside
 * a book-length note can be read with one get_note call. Runs after reranking,
 * which may rewrite the excerpt. Omitted when the excerpt is not found verbatim.
 */
export async function attachExcerptOffsets(results: SearchResult[]): Promise<void> {
  const long = results.filter((r) => (r.content_length ?? 0) > OFFSET_WORTH_IT_ABOVE && r.excerpt);
  if (long.length === 0) return;
  const rows = await dbQuery<{ id: string; content: string }>(
    'select id, content from notes where id = any($1) and deleted_at is null',
    [long.map((r) => r.id)]
  );
  const byId = new Map(rows.map((r) => [r.id, r.content]));
  for (const r of long) {
    const content = byId.get(r.id);
    if (!content) continue;
    const needle = r.excerpt.replace(/^[…\s]+/, '').replace(/[…\s]+$/, '').slice(0, NEEDLE_CHARS);
    // A needle this short matches too much to be a position.
    if (needle.length < 20) continue;
    const at = content.indexOf(needle);
    if (at !== -1) r.excerpt_offset = at;
  }
}

/** Adds created_at, content_length and index_pending with one batched lookup. */
export async function enrichResults(results: SearchResult[]): Promise<SearchResult[]> {
  if (results.length === 0) return results;
  const rows = await dbQuery<{ id: string; created_at: string; content_length: number; embedding_pending: boolean }>(
    'select id, created_at, length(content) as content_length, embedding_pending from notes where id = any($1) and deleted_at is null',
    [results.map((r) => r.id)]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return results.map((r) => {
    const row = byId.get(r.id);
    return {
      ...r,
      created_at: row?.created_at,
      content_length: row?.content_length,
      ...(row?.embedding_pending ? { index_pending: true } : {}),
    };
  });
}

export function overfetchLimit(limit: number, filters: SearchFilters | undefined): number {
  return hasFilters(filters) ? Math.min(OVERFETCH_CAP, limit * OVERFETCH_FACTOR) : limit;
}

/** Note ids a filtered call may see, resolved once; undefined means the whole vault. */
export async function resolveScope(
  filters: SearchFilters | undefined,
  allowedIds: Set<string> | undefined
): Promise<Set<string> | undefined> {
  if (allowedIds) return allowedIds;
  return hasFilters(filters) ? filteredNoteIds(filters) : undefined;
}

export const scopeParam = (scope: Set<string> | undefined): string[] | null => (scope ? [...scope] : null);
