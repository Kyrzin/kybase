// lib/sql.ts — helpers for building safe SQL fragments.
// Shared so the escaping rules can't drift apart between call sites: the MCP
// title lookup and the substring search each carried their own copy, and the
// search one silently lost the backslash case.

/**
 * Escape ilike wildcards so user text can't widen the match. Postgres treats
 * `\` as the default LIKE escape character, so the backslash itself has to be
 * escaped too — without it, a query containing `\` followed by `%` produces
 * `\\%`, which reads as "a literal backslash, then a wildcard".
 */
export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (c) => `\\${c}`);
}
