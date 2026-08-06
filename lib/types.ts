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
