// lib/types.ts — shared data types (importable from both client and server)

/**
 * Ceiling on a note's content, enforced on every write path (REST and MCP).
 * Nothing bounded it before: the platform's 10 MB request cap happened to
 * stop oversized writes, and raising that cap to 150 MB so real imports could
 * through took the accidental guard away with it. Ten million characters is
 * far past any note a person writes, while keeping a single request from
 * parking a quarter gigabyte in memory and then in the row.
 */
export const MAX_NOTE_CONTENT_CHARS = 10_000_000;

/**
 * Postgres rejects a NUL byte anywhere in a text column ("invalid byte
 * sequence for encoding UTF8: 0x00") — content from imports or raw MCP
 * input isn't guaranteed clean, so strip it on every write path (REST and
 * MCP) before it reaches a query, instead of surfacing that as a 500.
 * Built via fromCharCode (not a literal in source) to sidestep editor/tooling
 * that mishandles a raw NUL byte sitting in a text file.
 */
const NUL_BYTE = String.fromCharCode(0);

export function stripNulBytes(content: string): string {
  return content.split(NUL_BYTE).join('');
}

export type Folder = {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
};

// Shape returned by /api/search — short excerpt instead of full content
export type SearchHit = {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  score: number;
};

export type Note = {
  id: string;
  title: string;
  content: string;
  folder_id: string | null;
  tags: string[];
  embedding_pending: boolean;
  created_at: string;
  updated_at: string;
};
