// lib/types.ts — shared data types (importable from both client and server)

/**
 * Ceiling on a note's content, enforced on every write path (REST and MCP).
 * Request bodies may be large for imports, so a note needs its own bound; ten
 * million characters is far past any written note.
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

/** A row of GET /api/notes?content=false. */
export type NoteSummary = Omit<Note, 'content'>;

/** content is null until the note's text has been fetched. */
export type ListedNote = NoteSummary & { content: string | null };

/** A row of GET /api/notes/[id]/backlinks. */
export type Backlink = { id: string; title: string; context: string | null };

/**
 * Note history (migration 032). edit, rename-link and revert rows hold the
 * note as it was BEFORE that change; create, delete and restore are events
 * with no content. rename-link is another note's rename repointing a [[link]]
 * here.
 */
export type RevisionKind = 'create' | 'edit' | 'rename-link' | 'revert' | 'delete' | 'restore';

/** A row of GET /api/notes/[id]/revisions — the content itself is left out. */
export type RevisionSummary = {
  id: string;
  kind: RevisionKind;
  /** 'web', 'api', 'import', 'mcp', 'mcp:<client name>' or 'unattributed'. */
  changed_by: string;
  changed_at: string;
  title: string | null;
  /** Characters in the stored snapshot; null for create/delete/restore. */
  content_length: number | null;
};

export type RevisionPage = {
  revisions: RevisionSummary[];
  has_more: boolean;
  next_offset?: number;
};

/** GET /api/notes/[id]/revisions/[revisionId]. */
export type RevisionDetail = {
  id: string;
  note_id: string;
  kind: RevisionKind;
  changed_by: string;
  changed_at: string;
  /** The note before this change; null for create/delete/restore. */
  before: { title: string; content: string; folder_id: string | null; tags: string[] } | null;
  /**
   * What replaced it: the next newer snapshot of the note, or the note as it
   * is now when there is none. For a create, the note's first version. Null
   * for delete/restore.
   */
  after: { title: string; content: string; source: 'revision' | 'current' } | null;
};

/** A row of GET /api/changes. note_title is the note's current title. */
export type ChangeEntry = {
  revision_id: string;
  note_id: string;
  note_title: string;
  note_deleted: boolean;
  kind: RevisionKind;
  changed_by: string;
  changed_at: string;
};

export type ChangePage = {
  changes: ChangeEntry[];
  /** Every changed_by value in the history, for filtering by actor. */
  actors: string[];
  has_more: boolean;
  next_offset?: number;
};
