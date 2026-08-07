// lib/mcp-server.ts — MCP server factory with 16 tools
// Uses @modelcontextprotocol/sdk McpServer (high-level API)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query, queryOne, withTransaction, isUniqueViolation } from './db';
import { softDeleteNote, restoreNote, trashFolderNotes, TRASH_RETENTION_DAYS } from './trash';
import { escapeLike } from './sql';
import { textSearch, semanticSearch, hybridSearch, makeExcerpt, bestSemanticScore, type SearchResult } from './search';
import { getMinSimilarity } from './embeddings';
import { indexNoteAsync } from './indexing';
import { extractAllWikilinks } from './wikilinks';
import { buildGraph } from './graph-data';
import { extractHeadings, type Heading } from './markdown';
import { MAX_NOTE_CONTENT_CHARS } from './types';


// get_note(title=...) is the shortcut past search_notes, but real titles are long
// and composite ("2026-07-24 — Kybase: Move-folder + UX-полировка сайдбара"), and
// an agent almost never reproduces one verbatim from memory. Exact-only matching
// made that shortcut a coin flip: title "Kybase" returned a bare "Note not found"
// while seven notes started with "Kybase — ". An exact (case-insensitive) hit
// still wins outright; only when there is none do we widen to prefix, then
// substring — resolving when exactly one note matches and listing the candidates
// when several do. Wikilink resolution stays exact: a fuzzy match there would
// wire up an edge the author never wrote.
const TITLE_CANDIDATE_LIMIT = 10;
const TITLE_HINT_LIMIT = 5;

type TitleCandidate = { id: string; title: string };

/** Titles sharing a significant word with the query — a "did you mean" for a total miss. */
async function nearestTitles(title: string): Promise<string[]> {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4).slice(0, TITLE_HINT_LIMIT);
  if (!words.length) return [];
  const params: unknown[] = words.map((w) => `%${escapeLike(w)}%`);
  params.push(TITLE_HINT_LIMIT);
  const rows = await query<{ title: string }>(
    `select title from notes where (${words.map((_, i) => `title ilike $${i + 1}`).join(' or ')})
     and deleted_at is null
     order by updated_at desc limit $${params.length}`,
    params
  );
  return rows.map((r) => r.title);
}

/** Resolve a note by title: exact, then prefix, then substring. Throws if ambiguous or missing. */
async function findNoteByTitle<T>(title: string, cols: string): Promise<T> {
  const escaped = escapeLike(title);
  const exact = await queryOne<T>(`select ${cols} from notes where title ilike $1 and deleted_at is null`, [escaped]);
  if (exact) return exact;

  for (const pattern of [`${escaped}%`, `%${escaped}%`]) {
    const rows = await query<T & TitleCandidate>(
      `select ${cols} from notes where title ilike $1 and deleted_at is null order by length(title), updated_at desc limit $2`,
      [pattern, TITLE_CANDIDATE_LIMIT]
    );
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) {
      const candidates = rows.map(({ id, title: t }) => ({ id, title: t }));
      throw new Error(
        `"${title}" matches ${rows.length} notes — call get_note again with a full title or an id:\n` +
        JSON.stringify(candidates, null, 2)
      );
    }
  }

  const hints = await nearestTitles(title);
  throw new Error(
    `Note not found: no title matches "${title}" exactly, by prefix, or by substring.` +
    (hints.length ? ` Closest titles: ${JSON.stringify(hints)}.` : '') +
    ' Use search_notes to find a note by content.'
  );
}

// A note's full content used to go out unconditionally — a ~60k-char note
// (~25k+ tokens, worse for dense Cyrillic) hard-fails the MCP host's
// response-size limit with no way to retrieve the rest. 20000 chars keeps
// the JSON response comfortably under that even for Cyrillic-heavy text;
// most notes are far smaller and pass through untouched.
const DEFAULT_CONTENT_LIMIT = 20_000;
// get_note_with_links can pull in many linked notes at once — each is capped
// tighter than a standalone get_note so a handful of large linked notes
// can't blow the response budget by themselves. Call get_note on a specific
// link for its full content.
const LINKED_NOTE_CONTENT_LIMIT = 4_000;

// A bare folder_id UUID tells an agent nothing — it had to call list_folders
// and join client-side just to know where a note lives. Folder counts are
// tiny, so building the full id->path map once per call (rather than a
// per-row join) is cheap and handles nesting correctly.
type FolderRow = { id: string; name: string; parent_id: string | null };

async function folderPathMap(): Promise<Map<string, string>> {
  const folders = await query<FolderRow>('select id, name, parent_id from folders');
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  const resolve = (id: string): string => {
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    const f = byId.get(id);
    if (!f) return '';
    const path = f.parent_id ? `${resolve(f.parent_id)}/${f.name}` : f.name;
    paths.set(id, path);
    return path;
  };
  folders.forEach((f) => resolve(f.id));
  return paths;
}

function withFolderPath<T extends { folder_id: string | null }>(
  row: T,
  paths: Map<string, string>
): T & { folder_path: string | null } {
  return { ...row, folder_path: row.folder_id ? paths.get(row.folder_id) ?? null : null };
}

/**
 * Span of a section: its heading line through everything beneath it, ending
 * at the next heading of the same or higher rank. Matches on heading text or
 * slug, case-insensitively, so a caller can pass back either what it read in
 * `headings` or the anchor half of a [[Title#Section]] link.
 */
export function sectionRange(
  headings: Heading[],
  total: number,
  section: string
): { start: number; end: number } | null {
  const wanted = section.trim().toLowerCase();
  const i = headings.findIndex(
    h => h.text.toLowerCase() === wanted || h.slug.toLowerCase() === wanted
  );
  if (i === -1) return null;
  const next = headings.slice(i + 1).find(h => h.level <= headings[i].level);
  return { start: headings[i].offset, end: next ? next.offset : total };
}

export function windowContent<T extends { content: string }>(
  note: T,
  offset: number,
  limit: number
): Omit<T, 'content'> & {
  content: string;
  content_total_length: number;
  content_truncated: boolean;
  next_offset?: number;
} {
  const total = note.content.length;
  const end = Math.min(total, offset + limit);
  const truncated = end < total || offset > 0;
  return {
    ...note,
    content: note.content.slice(offset, end),
    content_total_length: total,
    content_truncated: truncated,
    ...(end < total ? { next_offset: end } : {}),
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'kybase', version: '1.0.0' },
    {
      instructions:
        'Kybase is a personal knowledge base of interlinked markdown notes. Notes reference ' +
        'each other with [[Title]] wikilinks; those links form the knowledge graph.\n\n' +
        'When creating a note or substantially rewriting one:\n' +
        '1. First call search_notes (type "hybrid") with the note\'s topic to find related existing notes.\n' +
        '2. If genuinely related notes exist, include [[wikilinks]] to the 2-5 most relevant ones in the ' +
        'note body — inline where natural, or as a final "Related: [[A]], [[B]]" line.\n' +
        '3. Copy linked titles VERBATIM from tool results (search_notes, list_notes, get_graph). Never ' +
        'write a [[link]] to a title you have not seen in a tool result in this conversation — invented ' +
        'or misremembered titles produce broken links.\n' +
        '4. Do not force links: if nothing is related, create the note without any.\n\n' +
        'Tagging: new tags are English, lowercase, kebab-case. Call list_tags first and reuse an ' +
        'existing tag when one fits, rather than coining an RU/EN or case-variant duplicate.\n\n' +
        'House rules: a vault may carry its own conventions — folder meanings, naming, where new ' +
        'notes belong. If list_tags shows a "conventions" tag, read those notes once at the start ' +
        'of a session (list_notes with tag "conventions") and follow them; they outrank the general ' +
        'guidance above. No such tag means this vault has none.\n\n' +
        'Adding to an existing note: use append_to_note, not update_note. Resending whole content ' +
        'to add a paragraph costs the note twice in tokens and overwrites whatever another session ' +
        'wrote meanwhile. When you do rewrite whole content, pass the updated_at you read as ' +
        'expected_updated_at so a concurrent edit is refused rather than silently lost.',
    }
  );

  // ── list_notes ───────────────────────────────────────────────────────────
  server.tool(
    'list_notes',
    'List notes, newest first. Optional filters: folder_id, tag, updated_after/updated_before, ' +
    'limit (max 200). updated_after answers "what changed since I was last here" without needing ' +
    'a search term. Pass trashed:true to see soft-deleted notes instead (deleted via delete_note, ' +
    'recoverable with restore_note until they age out of the trash) — other filters are ignored ' +
    'in that mode.',
    {
      folder_id: z.string().uuid().optional().describe('Filter by folder UUID'),
      tag:       z.string().optional().describe('Filter by tag'),
      updated_after:  z.string().optional().describe('ISO timestamp — only notes updated at or after this'),
      updated_before: z.string().optional().describe('ISO timestamp — only notes updated at or before this'),
      limit:     z.number().int().min(1).max(200).default(50),
      trashed:   z.boolean().default(false).describe('List soft-deleted notes instead of live ones'),
    },
    async ({ folder_id, tag, updated_after, updated_before, limit, trashed }) => {
      if (trashed) {
        const data = await query<{ id: string; title: string; folder_id: string | null; deleted_at: string }>(
          'select id, title, folder_id, deleted_at from notes where deleted_at is not null order by deleted_at desc limit $1',
          [limit]
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
      }

      const conds: string[] = ['deleted_at is null'];
      const params: unknown[] = [];
      if (folder_id) { params.push(folder_id); conds.push(`folder_id = $${params.length}`); }
      if (tag)       { params.push([tag]);     conds.push(`tags @> $${params.length}`); }
      if (updated_after)  { params.push(updated_after);  conds.push(`updated_at >= $${params.length}`); }
      if (updated_before) { params.push(updated_before); conds.push(`updated_at <= $${params.length}`); }
      params.push(limit);
      const [data, paths] = await Promise.all([
        query<{ id: string; title: string; folder_id: string | null; tags: string[]; updated_at: string }>(
          `select id, title, folder_id, tags, updated_at from notes
           where ${conds.join(' and ')}
           order by updated_at desc limit $${params.length}`,
          params
        ),
        folderPathMap(),
      ]);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data.map((n) => withFolderPath(n, paths)), null, 2) }] };
    }
  );

  // ── get_note ─────────────────────────────────────────────────────────────
  server.tool(
    'get_note',
    'Get full note content by id or title. Title matching is case-insensitive and forgiving: an ' +
    'exact match wins, otherwise it falls back to prefix then substring, so a unique partial title ' +
    'resolves. An ambiguous title returns the candidate list (id + title) to retry with. Large ' +
    `notes are windowed: content is capped at ${DEFAULT_CONTENT_LIMIT} chars by default (see limit/offset) — check ` +
    'content_truncated and content_total_length in the response, and pass next_offset back as ' +
    '`offset` to fetch the rest. Every response carries `headings` (the note\'s H1–H3 outline with ' +
    'character offsets), so on a truncated note you can see what is in the part you did not get ' +
    'and jump to it — either by passing that offset, or by naming it in `section`, which returns ' +
    'that heading and everything under it and nothing else.',
    {
      id:      z.string().uuid().optional(),
      title:   z.string().optional(),
      section: z.string().optional()
        .describe('Return only this section (heading text or slug, case-insensitive) and its body'),
      offset:  z.number().int().min(0).default(0).describe('Character offset into content to start from'),
      limit:   z.number().int().min(1000).max(200_000).default(DEFAULT_CONTENT_LIMIT)
        .describe('Max characters of content to return'),
    },
    async ({ id, title, section, offset, limit }) => {
      if (!id && !title) throw new Error('Provide either id or title');
      const cols = 'id, title, content, folder_id, tags, created_at, updated_at';
      // findNoteByTitle escapes %/_ at every stage, so wildcards in a real
      // title can't widen the match beyond the step being attempted.
      const [data, paths] = await Promise.all([
        id
          ? queryOne<{ content: string; folder_id: string | null }>(`select ${cols} from notes where id = $1 and deleted_at is null`, [id])
          : findNoteByTitle<{ content: string; folder_id: string | null }>(title!, cols),
        folderPathMap(),
      ]);
      if (!data) throw new Error('Note not found');

      // The outline travels with every response: on a windowed note it is the
      // only way to know what sits in the part that did not come back.
      const headings = extractHeadings(data.content);
      let body = data;
      if (section !== undefined) {
        const range = sectionRange(headings, data.content.length, section);
        if (!range) {
          const available = headings.map(h => h.text).join(' | ') || '(this note has no headings)';
          throw new Error(`No section "${section}" in this note. Available: ${available}`);
        }
        // offset/limit now page within the section, not the whole note.
        body = { ...data, content: data.content.slice(range.start, range.end) };
      }
      const windowed = withFolderPath(windowContent(body, offset, limit), paths);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...windowed, headings }, null, 2) }] };
    }
  );

  // ── create_note ──────────────────────────────────────────────────────────
  server.tool(
    'create_note',
    'Create a new note. Embedding is generated automatically in the background. ' +
    'Before creating, search_notes for the topic and include [[wikilinks]] to related existing notes ' +
    '(copy titles exactly from tool results — never invent them). Before adding tags, call list_tags ' +
    'and reuse an existing tag if one matches — do not create RU/EN duplicates.',
    {
      title:     z.string().trim().min(1).max(500),
      content:   z.string().max(MAX_NOTE_CONTENT_CHARS).default(''),
      folder_id: z.string().uuid().nullable().optional(),
      tags:      z.array(z.string()).default([]),
    },
    async ({ title, content, folder_id, tags }) => {
      let note;
      try {
        note = await queryOne<{ id: string }>(
          `insert into notes (title, content, folder_id, tags, embedding_pending)
           values ($1, $2, $3, $4, true)
           returning id, title, content, folder_id, tags, created_at`,
          [title, content, folder_id ?? null, tags]
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new Error(`A note titled "${title}" already exists — update it or pick another title`);
        throw err;
      }
      if (!note) throw new Error('Insert failed');

      // background index (note embedding + chunks)
      indexNoteAsync(note.id, title, content);

      return { content: [{ type: 'text' as const, text: JSON.stringify(note, null, 2) }] };
    }
  );

  // ── update_note ──────────────────────────────────────────────────────────
  server.tool(
    'update_note',
    'Update note fields. Re-embeds if title or content changed. Updates wikilinks if title changed. ' +
    'When substantially rewriting content, consider adding [[wikilinks]] to related notes found via ' +
    'search_notes (copy titles exactly from tool results). Before adding tags, call list_tags and ' +
    'reuse an existing tag if one matches — do not create RU/EN duplicates. ' +
    'Pass expected_updated_at (the updated_at you read) to be refused instead of overwriting a ' +
    'change someone else made in the meantime — worth it whenever you send whole content back.',
    {
      id:        z.string().uuid(),
      title:     z.string().trim().min(1).max(500).optional(),
      content:   z.string().max(MAX_NOTE_CONTENT_CHARS).optional(),
      folder_id: z.string().uuid().nullable().optional(),
      tags:      z.array(z.string()).optional(),
      expected_updated_at: z.string().optional()
        .describe('ISO updated_at from when you read the note; refuses the write if it changed since'),
    },
    async ({ id, title, content, folder_id, tags, expected_updated_at }) => {
      const existing = await queryOne<{ title: string; content: string; updated_at: string }>(
        'select title, content, updated_at from notes where id = $1 and deleted_at is null', [id]
      );
      if (!existing) throw new Error('Note not found');

      // Two sessions editing the same note otherwise silently overwrite one
      // another — the loser's text is gone with nothing to say it happened.
      if (expected_updated_at !== undefined) {
        const seen = new Date(expected_updated_at).getTime();
        const current = new Date(existing.updated_at).getTime();
        if (Number.isNaN(seen)) throw new Error('expected_updated_at is not a valid timestamp');
        if (seen !== current) {
          throw new Error(
            `Note changed since you read it (now ${new Date(current).toISOString()}). ` +
            're-read it with get_note and reapply your edit'
          );
        }
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (title     !== undefined) set('title', title);
      if (content   !== undefined) set('content', content);
      if (folder_id !== undefined) set('folder_id', folder_id);
      if (tags      !== undefined) set('tags', tags);
      if (sets.length === 0) throw new Error('Provide at least one field to update');

      // Compare values, not presence: agents routinely resend the whole note
      // to edit one tag, and re-embedding unchanged text costs a paid call.
      const changed =
        (title   !== undefined && title   !== existing.title) ||
        (content !== undefined && content !== existing.content);
      if (changed) sets.push('embedding_pending = true');

      params.push(id);
      let note;
      try {
        // One transaction: a rename must never land without its backlink
        // rewrite — a failure between the two leaves [[OldTitle]] links broken.
        note = await withTransaction(async (client) => {
          const { rows } = await client.query(
            `update notes set ${sets.join(', ')} where id = $${params.length} and deleted_at is null
             returning id, title, content, folder_id, tags, updated_at`,
            params
          );
          if (title && title !== existing.title && rows[0]) {
            await client.query('select update_wikilinks($1, $2)', [existing.title, title]);
          }
          return rows[0] ?? null;
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new Error(`A note titled "${title}" already exists — update it or pick another title`);
        throw err;
      }
      if (!note) throw new Error('Note not found');
      if (changed) {
        indexNoteAsync(id, title ?? existing.title, content ?? existing.content);
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(note, null, 2) }] };
    }
  );

  // ── append_to_note ───────────────────────────────────────────────────────
  server.tool(
    'append_to_note',
    'Add text to the end of a note, or to the end of one section, without resending the rest. ' +
    'Prefer this over update_note for journals, logs and running lists: rewriting whole content to ' +
    'add a line costs the note twice over in tokens and silently overwrites anything another ' +
    'session wrote in between. A blank line is inserted between the old text and yours. ' +
    'Re-embeds in the background like any content change.',
    {
      id:      z.string().uuid().optional(),
      title:   z.string().optional().describe('Alternative to id; resolved like get_note'),
      content: z.string().min(1).max(MAX_NOTE_CONTENT_CHARS),
      section: z.string().optional()
        .describe('Append at the end of this section (heading text or slug) instead of the note'),
    },
    async ({ id, title, content, section }) => {
      if (!id && !title) throw new Error('Provide either id or title');
      const cols = 'id, title, content';
      const existing = id
        ? await queryOne<{ id: string; title: string; content: string }>(
            `select ${cols} from notes where id = $1 and deleted_at is null`, [id])
        : await findNoteByTitle<{ id: string; title: string; content: string }>(title!, cols);
      if (!existing) throw new Error('Note not found');

      const addition = content.trimEnd();
      let next: string;
      if (section === undefined) {
        next = `${existing.content.trimEnd()}\n\n${addition}\n`;
      } else {
        const headings = extractHeadings(existing.content);
        const range = sectionRange(headings, existing.content.length, section);
        if (!range) {
          const available = headings.map(h => h.text).join(' | ') || '(this note has no headings)';
          throw new Error(`No section "${section}" in this note. Available: ${available}`);
        }
        // Land before the next heading, not after it, or the text reads as
        // part of the following section for everyone who opens the note.
        const head = existing.content.slice(0, range.end).trimEnd();
        const tail = existing.content.slice(range.end);
        next = `${head}\n\n${addition}\n${tail ? `\n${tail}` : ''}`;
      }
      if (next.length > MAX_NOTE_CONTENT_CHARS) {
        throw new Error(`Appending would exceed the ${MAX_NOTE_CONTENT_CHARS}-character limit for a note`);
      }

      const note = await queryOne<{ id: string; title: string; updated_at: string }>(
        `update notes set content = $1, embedding_pending = true
         where id = $2 and deleted_at is null
         returning id, title, updated_at`,
        [next, existing.id]
      );
      if (!note) throw new Error('Note not found');
      indexNoteAsync(existing.id, existing.title, next);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ...note, appended_chars: addition.length, content_total_length: next.length }, null, 2),
        }],
      };
    }
  );

  // ── delete_note ──────────────────────────────────────────────────────────
  server.tool(
    'delete_note',
    `Soft-delete a note by id — it disappears from list_notes/search/get_note/the graph, but is ` +
    `recoverable with restore_note for ${TRASH_RETENTION_DAYS} days before being purged for good. ` +
    'Use list_notes with trashed:true to see what\'s currently in the trash.',
    { id: z.string().uuid() },
    async ({ id }) => {
      const deleted = await softDeleteNote(id);
      if (!deleted) throw new Error('Note not found (already deleted, or no such note)');
      return { content: [{ type: 'text' as const, text: `Note ${id} moved to trash — restore_note undoes this within ${TRASH_RETENTION_DAYS} days.` }] };
    }
  );

  // ── restore_note ─────────────────────────────────────────────────────────
  server.tool(
    'restore_note',
    'Undo delete_note: brings a soft-deleted note back. Errors if the note isn\'t in the trash ' +
    '(never deleted, already restored, or purged past the retention window), or if a live note has ' +
    'since taken the same title (rename one of them first, then retry).',
    { id: z.string().uuid() },
    async ({ id }) => {
      let restored: boolean;
      try {
        restored = await restoreNote(id);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new Error('A live note already has this title — rename or delete_note it, then retry restore_note');
        }
        throw err;
      }
      if (!restored) throw new Error('Note not in trash (never deleted, already restored, or purged)');
      return { content: [{ type: 'text' as const, text: `Note ${id} restored.` }] };
    }
  );

  // ── search_notes ─────────────────────────────────────────────────────────
  server.tool(
    'search_notes',
    'Search notes. type: "text" (fast), "semantic" (meaning-based), "hybrid" (best, uses RRF). ' +
    'Hybrid is the right default; prefer type=text for exact identifiers, code fragments, or quoted ' +
    'phrases, where FTS beats meaning-matching. ' +
    'Returns short excerpts, not full notes — call get_note with the id to read a full note. ' +
    'Every hit carries `relevance` (0..1, normalized against model-calibrated anchors) and ' +
    '`confidence` ("strong" | "moderate" | "weak") — use THESE to decide whether the results ' +
    'suffice to answer: strong hits can be quoted directly, moderate ones deserve a get_note check, ' +
    'an all-weak page means reformulate. Relevance is comparable within one query\'s results, not ' +
    'across queries or models. The raw fields remain for debugging: `score` is RRF rank fusion ' +
    '(hybrid sort order, NOT relevance), text_score is FTS ts_rank, semantic_score is raw cosine. ' +
    'Optional filters (folder_id, tag, updated_after/before) narrow to notes matching ' +
    'ALL given ones. An empty semantic/hybrid result includes threshold/best_score/pending_embeddings ' +
    'so you can tell "nothing this relevant exists" from "just under the threshold" from "embeddings ' +
    'not generated yet" — a bare [] can\'t distinguish those.',
    {
      query:          z.string().min(1),
      type:           z.enum(['text', 'semantic', 'hybrid']).default('hybrid'),
      limit:          z.number().int().min(1).max(50).default(5),
      folder_id:      z.string().uuid().optional().describe('Restrict to notes in this folder'),
      tag:            z.string().optional().describe('Restrict to notes with this tag'),
      updated_after:  z.string().optional().describe('ISO timestamp — only notes updated at or after this'),
      updated_before: z.string().optional().describe('ISO timestamp — only notes updated at or before this'),
    },
    async ({ query: q, type, limit, folder_id, tag, updated_after, updated_before }) => {
      const filters = { folderId: folder_id, tag, updatedAfter: updated_after, updatedBefore: updated_before };
      let results: SearchResult[];
      if      (type === 'semantic') results = await semanticSearch(q, limit, filters);
      else if (type === 'hybrid')   results = await hybridSearch(q, limit, filters);
      else                          results = await textSearch(q, limit, filters);

      if (results.length > 0 || type === 'text') {
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      }

      const [threshold, bestScore, pendingRows] = await Promise.all([
        getMinSimilarity(),
        bestSemanticScore(q),
        query<{ count: number }>('select count(*)::int as count from notes where embedding_pending = true and deleted_at is null'),
      ]);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            results,
            threshold,
            best_score: bestScore,
            pending_embeddings: pendingRows[0]?.count ?? 0,
          }, null, 2),
        }],
      };
    }
  );

  // ── indexing_status ──────────────────────────────────────────────────────
  server.tool(
    'indexing_status',
    'Report semantic-index progress across the vault: how many live notes are embedded vs still ' +
    'pending. Semantic and hybrid search — and the semantic graph edges — only see indexed notes; ' +
    'a pending note is still found by type=text search but is invisible to meaning-based search ' +
    'until it is embedded (automatic in the background after create/update or a provider switch). ' +
    'Use this to tell "still indexing" from "done": complete=true means every note is searchable ' +
    'semantically. A pending count that stays high while nothing is being edited points at an ' +
    'embedding failure (e.g. Ollama unreachable) — check the server logs.',
    {},
    async () => {
      const row = await queryOne<{ total: number; pending: number }>(
        `select count(*)::int as total,
                (count(*) filter (where embedding_pending))::int as pending
         from notes where deleted_at is null`
      );
      const total = row?.total ?? 0;
      const pending = row?.pending ?? 0;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ total, indexed: total - pending, pending, complete: pending === 0 }, null, 2),
        }],
      };
    }
  );

  // ── list_tags ────────────────────────────────────────────────────────────
  server.tool(
    'list_tags',
    'List every tag in use with the number of notes carrying it, most-used first. Call this before ' +
    'tagging a note and reuse an existing tag when one fits, rather than coining a near-duplicate — ' +
    'the vault has no tag synonyms, so "workflow" and "воркфлоу" are two separate tags that fragment ' +
    'the same concept.',
    {},
    async () => {
      const rows = await query<{ tag: string; count: number }>(
        `select unnest(tags) as tag, count(*)::int as count
         from notes where deleted_at is null group by 1 order by count desc, tag`
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    }
  );

  // ── list_folders ─────────────────────────────────────────────────────────
  server.tool(
    'list_folders',
    'List all folders (flat array, use parent_id to reconstruct tree).',
    {},
    async () => {
      const data = await query('select * from folders order by name');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── create_folder ────────────────────────────────────────────────────────
  server.tool(
    'create_folder',
    'Create a new folder. Optionally nested under a parent.',
    {
      name:      z.string().min(1).max(255),
      parent_id: z.string().uuid().nullable().optional(),
    },
    async ({ name, parent_id }) => {
      const data = await queryOne(
        'insert into folders (name, parent_id) values ($1, $2) returning *',
        [name, parent_id ?? null]
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── update_folder ────────────────────────────────────────────────────────
  server.tool(
    'update_folder',
    'Rename a folder and/or move it under a different parent (set parent_id to null for top level). Provide at least one of name/parent_id.',
    {
      id:        z.string().uuid(),
      name:      z.string().min(1).max(255).optional(),
      parent_id: z.string().uuid().nullable().optional(),
    },
    async ({ id, name, parent_id }) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (name      !== undefined) set('name', name);
      if (parent_id !== undefined) {
        if (parent_id === id) {
          throw new Error('Folder cannot be its own parent');
        }
        if (parent_id !== null) {
          const checkCycle = await queryOne<{ id: string }>(
            `WITH RECURSIVE ancestors AS (
               SELECT id, parent_id FROM folders WHERE id = $1
               UNION
               SELECT f.id, f.parent_id FROM folders f
               INNER JOIN ancestors a ON f.id = a.parent_id
             )
             SELECT id FROM ancestors WHERE id = $2`,
            [parent_id, id]
          );
          if (checkCycle) {
            throw new Error('Cannot move a folder into its own descendant');
          }
        }
        set('parent_id', parent_id);
      }
      if (sets.length === 0) throw new Error('Provide name and/or parent_id');

      params.push(id);
      const data = await queryOne(
        `update folders set ${sets.join(', ')} where id = $${params.length} returning *`,
        params
      );
      if (!data) throw new Error('Folder not found');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── delete_folder ────────────────────────────────────────────────────────
  server.tool(
    'delete_folder',
    'Delete a folder and its full subtree of child folders (cascade). Every note inside — including ' +
    'notes in nested subfolders — is soft-deleted into the trash along with it (see delete_note), ' +
    'recoverable via restore_note within the retention window. To preserve organization instead, ' +
    'move notes/subfolders out first.',
    { id: z.string().uuid() },
    async ({ id }) => {
      // One transaction: notes in the subtree must land in the trash
      // together with the folder disappearing, not one without the other.
      const trashed = await withTransaction(async (client) => {
        const count = await trashFolderNotes(id, client);
        // Confirm the row existed: an agent told "deleted" when nothing was
        // deleted plans its next steps on a false premise.
        const deleted = await client.query('delete from folders where id = $1 returning id', [id]);
        if (deleted.rows.length === 0) throw new Error('Folder not found');
        return count;
      });
      return {
        content: [{
          type: 'text' as const,
          text: `Folder ${id} deleted. ${trashed} note${trashed === 1 ? '' : 's'} moved to trash.`,
        }],
      };
    }
  );

  // ── get_backlinks ────────────────────────────────────────────────────────
  server.tool(
    'get_backlinks',
    'Get notes that link to the given note via [[Title]] wikilinks. By default returns id/title/' +
    'folder_path plus a short snippet around the link occurrence, not full content — pass ' +
    'include_content:true for the full text of each (expensive if many notes link here; prefer the ' +
    'default and call get_note on specific ids instead). Paginated like get_note.',
    {
      title:           z.string().min(1),
      include_content: z.boolean().default(false),
      limit:           z.number().int().min(1).max(200).default(50),
      offset:          z.number().int().min(0).default(0),
    },
    async ({ title, include_content, limit, offset }) => {
      const [data, paths] = await Promise.all([
        query<{ id: string; title: string; content: string; folder_id: string | null }>(
          'select id, title, content, folder_id from notes where content ilike $1 and deleted_at is null',
          [`%[[${escapeLike(title)}%`]
        ),
        folderPathMap(),
      ]);

      // Precise filter: ilike is approximate, extractAllWikilinks is exact
      const backlinks = data.filter((n) =>
        extractAllWikilinks(n.content).some(
          (t) => t.toLowerCase() === title.toLowerCase()
        )
      );

      const total = backlinks.length;
      const page = backlinks.slice(offset, offset + limit);
      const results = page.map((n) => {
        const base = withFolderPath({ id: n.id, title: n.title, folder_id: n.folder_id }, paths);
        return include_content
          ? { ...base, content: n.content }
          : { ...base, snippet: makeExcerpt(n.content, `[[${title}`, 200) };
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            results,
            total,
            ...(offset + limit < total ? { next_offset: offset + limit } : {}),
          }, null, 2),
        }],
      };
    }
  );

  // ── get_note_with_links ──────────────────────────────────────────────────
  server.tool(
    'get_note_with_links',
    // The tail below is ONE template literal on purpose: this Next build drops the
    // trailing static text of a template literal that is `+`-concatenated with
    // another interpolated one, which silently shipped "default 200004000 chars"
    // to every agent. Keep the two limits inside a single literal.
    'Get a note and automatically resolve all [[wikilinks]] inside it (1 level deep). Returns the ' +
    'main note plus the content of every linked note found in the knowledge base. Unresolved links ' +
    '(notes not found) are listed separately. The main note is resolved by title exactly like ' +
    'get_note (exact, then prefix, then substring) and its content is windowed the same way ' +
    `(limit/offset, default ${DEFAULT_CONTENT_LIMIT} chars); each linked note is capped at ${LINKED_NOTE_CONTENT_LIMIT} chars — call get_note on its id for the full text.`,
    {
      id:     z.string().uuid().optional(),
      title:  z.string().optional(),
      offset: z.number().int().min(0).default(0).describe('Character offset into the main note\'s content'),
      limit:  z.number().int().min(1000).max(200_000).default(DEFAULT_CONTENT_LIMIT)
        .describe('Max characters of the main note\'s content to return'),
    },
    async ({ id, title, offset, limit }) => {
      if (!id && !title) throw new Error('Provide either id or title');

      // Fetch the main note
      const cols = 'id, title, content, folder_id, tags, created_at, updated_at';
      const [note, paths] = await Promise.all([
        id
          ? queryOne<{ id: string; title: string; content: string; folder_id: string | null }>(
              `select ${cols} from notes where id = $1 and deleted_at is null`, [id])
          : findNoteByTitle<{ id: string; title: string; content: string; folder_id: string | null }>(title!, cols),
        folderPathMap(),
      ]);
      if (!note) throw new Error('Note not found');

      // Extract all wikilink targets
      const linkTargets = extractAllWikilinks(note.content);

      // Resolve each link by title (case-insensitive), skip self
      const resolved: Record<string, unknown>[] = [];
      const missing: string[] = [];
      // [[Guide]] and [[guide]] are one note — titles are unique
      // case-insensitively, so resolve each spelling only once or the agent
      // reads the same note twice and pays for it twice.
      const seen = new Set<string>();

      await Promise.all(
        linkTargets.map(async (target) => {
          const key = target.toLowerCase();
          if (key === note.title.toLowerCase()) return;
          if (seen.has(key)) return;
          seen.add(key);
          const linked = await queryOne<{ content: string; folder_id: string | null }>(
            'select id, title, content, folder_id, tags, updated_at from notes where title ilike $1 and deleted_at is null',
            [escapeLike(target)]
          );
          if (linked) resolved.push(withFolderPath(windowContent(linked, 0, LINKED_NOTE_CONTENT_LIMIT), paths));
          else        missing.push(target);
        })
      );

      const result = {
        note: withFolderPath(windowContent(note, offset, limit), paths),
        linked_notes: resolved,
        unresolved_links: missing,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── get_graph ─────────────────────────────────────────────────────────────
  server.tool(
    'get_graph',
    'Get the knowledge graph: note nodes, directed edges from [[wikilinks]], and undirected ' +
    'semantic_edges (embedding cosine similarity) between related notes that may lack explicit links. ' +
    'Unfiltered, this returns the ENTIRE vault in one response — fine for small vaults, but it will ' +
    'stop fitting in context as the vault grows. Scope it with folder_id (a subtree) or root_title+depth ' +
    '(the neighborhood around one note) when you only need part of the graph. Node titles in the result ' +
    'are valid [[wikilink]] targets — but only within whatever scope you asked for.',
    {
      folder_id:        z.string().uuid().optional()
        .describe('Restrict to notes in this folder and its descendant folders'),
      root_title:       z.string().optional()
        .describe('Keep only nodes within `depth` wikilink-hops of this note (case-insensitive)'),
      depth:            z.number().int().min(1).max(10).default(2)
        .describe('Hop count for root_title; ignored without it'),
      include_semantic: z.boolean().default(true).describe('Include semantic_edges at all'),
      min_score:        z.number().min(0).max(1).default(0.75)
        .describe('Cosine floor for semantic_edges — lower to see more (noisier) edges'),
    },
    async ({ folder_id, root_title, depth, include_semantic, min_score }) => {
      const graph = await buildGraph({
        folderId: folder_id,
        rootTitle: root_title,
        depth,
        includeSemantic: include_semantic,
        minScore: min_score,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(graph, null, 2) }] };
    }
  );

  return server;
}
