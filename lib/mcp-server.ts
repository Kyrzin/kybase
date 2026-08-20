// lib/mcp-server.ts — MCP server factory with 18 tools
// Uses @modelcontextprotocol/sdk McpServer (high-level API)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query, queryOne, withTransaction, isUniqueViolation, FOLDER_REPARENT_LOCK_KEY } from './db';
import { softDeleteNote, restoreNote, trashFolderNotes, TRASH_RETENTION_DAYS } from './trash';
import { escapeLike } from './sql';
import { textSearch, semanticSearch, hybridSearch, makeExcerpt, bestSemanticScore, effectiveSemanticThreshold, type SearchResult, type HybridSearchResult } from './search';
import { indexNoteAsync } from './indexing';
import { extractAllWikilinks } from './wikilinks';
import { rewriteBacklinks } from './rename-links';
import { buildGraph } from './graph-data';
import { indexedForm } from './graph';
import { extractHeadings, type Heading } from './markdown';
import { getSemanticProfile } from './embeddings';
import { MAX_NOTE_CONTENT_CHARS, stripNulBytes } from './types';


// get_note(title=...) is the shortcut past search_notes, but real titles are long
// and composite ("2026-07-24 — Kybase: Move-folder + sidebar UX polish"), and
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
        JSON.stringify(candidates)
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

/** Folder id -> full path (cycle-safe — mirrors lib/export.ts's folderPaths). */
function buildFolderPathMap(folders: FolderRow[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  const resolve = (id: string, seen: Set<string>): string => {
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    const f = byId.get(id);
    if (!f || seen.has(id)) return '';
    seen.add(id);
    const path = f.parent_id ? `${resolve(f.parent_id, seen)}/${f.name}` : f.name;
    paths.set(id, path);
    return path;
  };
  folders.forEach((f) => resolve(f.id, new Set()));
  return paths;
}

async function folderPathMap(): Promise<Map<string, string>> {
  const folders = await query<FolderRow>('select id, name, parent_id from folders');
  return buildFolderPathMap(folders);
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
 * `headings` or the anchor half of a [[Title#Section]] link. Exact match
 * wins; failing that, widens to unique prefix then unique substring on the
 * text (same exact→prefix→substring cascade findNoteByTitle applies to note
 * titles, and for the same reason: a heading copied verbatim from `headings`
 * can carry inline markdown — `*emphasis*`, a trailing qualifier — that a
 * caller's best-effort retyping drops). Several candidates at a stage is
 * treated the same as none: resolving to the wrong section silently is worse
 * than the "not found" error the caller already raises, listing every
 * heading to choose from.
 */
export function sectionRange(
  headings: Heading[],
  total: number,
  section: string
): { start: number; end: number } | null {
  // NFC on both sides: "é" has two encodings, and a caller typing a heading
  // from another source can easily send the form the note does not use —
  // macOS filenames are NFD, most editors write NFC. Byte-comparing those
  // reports a section that plainly exists as missing.
  const norm = (s: string) => s.normalize('NFC').trim().toLowerCase();
  const wanted = norm(section);
  let i = headings.findIndex(h => norm(h.text) === wanted || norm(h.slug) === wanted);
  if (i === -1) {
    for (const matches of [
      wanted ? headings.filter(h => norm(h.text).startsWith(wanted)) : [],
      wanted ? headings.filter(h => norm(h.text).includes(wanted)) : [],
    ]) {
      if (matches.length > 1) return null;
      if (matches.length === 1) { i = headings.indexOf(matches[0]); break; }
    }
  }
  if (i === -1) return null;
  const next = headings.slice(i + 1).find(h => h.level <= headings[i].level);
  return { start: headings[i].offset, end: next ? next.offset : total };
}

export type AppendAt = 'note_end' | 'note_start' | 'section_end' | 'section_start' | 'before_section' | 'after_section';

/**
 * Where an addition lands for a given `at`. note_start is NOT offset 0:
 * sectionRange's own end-of-section rule (next heading at the same rank or
 * shallower) applied to the H1 itself would walk past every subsection all
 * the way to the end of the note — a note's H1, and whatever intro sits
 * under it (a format-legend blockquote, say), is the note's own lead-in, not
 * a section to insert above. This lands right before the first heading
 * NESTED under the H1 (a deeper level, not merely the next heading) instead,
 * so a "new entries on top" journal still reads title-first. A note with
 * only one heading, or none at all, has no such boundary — falls back to
 * the end of the note.
 */
export function resolveInsertOffset(
  content: string,
  headings: Heading[],
  at: AppendAt,
  section: string | undefined
): number {
  if (at === 'note_end') return content.length;
  if (at === 'note_start') {
    if (headings.length === 0) return 0;
    const nested = headings.slice(1).find(h => h.level > headings[0].level);
    return nested ? nested.offset : content.length;
  }
  if (!section) throw new Error(`at: "${at}" requires section`);
  const range = sectionRange(headings, content.length, section);
  if (!range) {
    const available = headings.map(h => h.text).join(' | ') || '(this note has no headings)';
    throw new Error(`No section "${section}" in this note. Available: ${available}`);
  }
  if (at === 'before_section') return range.start;
  if (at === 'section_end' || at === 'after_section') return range.end;
  // section_start: right after the heading's own line, before its body/subsections.
  const lineEnd = content.indexOf('\n', range.start);
  return lineEnd === -1 ? content.length : lineEnd + 1;
}

/**
 * Splices `addition` into `content` at `offset`, blank-line-separated from
 * whatever is on either side. Exactly reproduces append_to_note's original
 * two shapes (offset = content.length for a whole-note append, offset =
 * range.end for a section append) as special cases of one rule, so neither
 * had to change to gain the other four `at` positions.
 */
export function insertAddition(content: string, offset: number, addition: string): string {
  const head = content.slice(0, offset).trimEnd();
  const tail = content.slice(offset);
  return `${head}\n\n${addition}\n${tail ? `\n${tail}` : ''}`;
}

/** Non-overlapping literal occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  for (;;) {
    const i = haystack.indexOf(needle, pos);
    if (i === -1) return count;
    count++;
    pos = i + needle.length;
  }
}

/** Text to replace in a note — one step of a replace_in_note batch. */
type NoteEdit = { find: string; replace: string; expected_count: number };

/** Keeps a mismatched `find` readable in an error message instead of dumping a whole paragraph. */
function truncateForError(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
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

/**
 * The [[links]] in `text` that point at no existing note — what a write just
 * broke, reported at the moment it happens instead of surfacing hours later in
 * get_graph. The `[[` guard keeps writes carrying no links from paying for the
 * title scan at all; when there are links, one scan answers all of them, which
 * is why this resolves in memory rather than running a query per target the way
 * get_note's resolve_links does — that one needs each linked note's id and body,
 * this one only needs to know whether the title exists.
 */
async function unresolvedWikilinksIn(text: string, selfTitle?: string): Promise<string[]> {
  if (!text.includes('[[')) return [];
  const rows = await query<{ title: string }>('select title from notes where deleted_at is null');
  const known = new Set(rows.map((r) => r.title.toLowerCase()));
  const self = selfTitle?.toLowerCase();
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const target of extractAllWikilinks(text, known)) {
    // [[Guide]] and [[guide]] are one note: report the miss once, not twice.
    const key = target.toLowerCase();
    if (key === self || known.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(target);
  }
  return missing;
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
        'or misremembered titles produce broken links. A write that introduces one comes back ' +
        'with `unresolved_links` naming it — fix it there, not hours later.\n' +
        '4. Do not force links: if nothing is related, create the note without any.\n\n' +
        'Tagging: new tags are English, lowercase, kebab-case. Call list_tags first and reuse an ' +
        'existing tag when one fits, rather than coining an RU/EN or case-variant duplicate.\n\n' +
        'To add to a note use append_to_note, not update_note: resending whole content to add a ' +
        'paragraph costs the note twice and overwrites what another session wrote meanwhile. When ' +
        'you do rewrite whole content, pass the updated_at you read as expected_updated_at.',
    }
  );

  // ── list_notes ───────────────────────────────────────────────────────────
  server.tool(
    'list_notes',
    'List notes, sorted by recency (newest first). Optional filters: folder_id, tag, ' +
    'created_after/created_before, updated_after/updated_before, limit (max 200). ' +
    'created_after answers "what is new" — a note\'s creation date never changes after it is ' +
    'made. updated_after answers "what changed since I was last here" — it moves only when this ' +
    'note\'s own title/content/folder/tags were actually edited, NOT when renaming some other note ' +
    'rewrote a [[link]] to it in passing (that still touches updated_at, returned separately, but ' +
    'not this filter/sort). They are NOT interchangeable: a note edited today but created months ' +
    'ago matches updated_after, not created_after. sort picks which of the two dates drives the ' +
    'ordering (default "updated"). Each note carries content_length (characters in the full note) ' +
    'so you can tell a long note from a short one before spending a get_note call on it. Pass ' +
    'trashed:true to see soft-deleted notes instead (recoverable with restore_note until they age ' +
    'out of the trash) — other filters are ignored in that mode.',
    {
      folder_id: z.string().uuid().optional().describe('Filter by folder UUID'),
      tag:       z.string().optional().describe('Filter by tag'),
      created_after:  z.string().optional().describe('ISO timestamp — only notes created at or after this'),
      created_before: z.string().optional().describe('ISO timestamp — only notes created at or before this'),
      updated_after:  z.string().optional().describe('ISO timestamp — only notes whose own content actually changed at or after this'),
      updated_before: z.string().optional().describe('ISO timestamp — only notes whose own content actually changed at or before this'),
      sort:      z.enum(['created', 'updated']).default('updated').describe('Which date drives the ordering'),
      limit:     z.number().int().min(1).max(200).default(20),
      trashed:   z.boolean().default(false).describe('List soft-deleted notes instead of live ones'),
    },
    async ({ folder_id, tag, created_after, created_before, updated_after, updated_before, sort, limit, trashed }) => {
      if (trashed) {
        const data = await query<{ id: string; title: string; folder_id: string | null; deleted_at: string }>(
          'select id, title, folder_id, deleted_at from notes where deleted_at is not null order by deleted_at desc limit $1',
          [limit]
        );
        return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
      }

      const conds: string[] = ['deleted_at is null'];
      const params: unknown[] = [];
      if (folder_id) { params.push(folder_id); conds.push(`folder_id = $${params.length}`); }
      if (tag)       { params.push([tag]);     conds.push(`tags @> $${params.length}`); }
      if (created_after)  { params.push(created_after);  conds.push(`created_at >= $${params.length}`); }
      if (created_before) { params.push(created_before); conds.push(`created_at <= $${params.length}`); }
      // content_updated_at, not updated_at: a rename elsewhere rewriting a
      // [[link]] inside this note still moves updated_at (expected_updated_at's
      // guard needs that), but must not make this note look freshly edited —
      // see migration 020.
      if (updated_after)  { params.push(updated_after);  conds.push(`content_updated_at >= $${params.length}`); }
      if (updated_before) { params.push(updated_before); conds.push(`content_updated_at <= $${params.length}`); }
      params.push(limit);
      // sort is a fixed 2-value enum from zod, not user-supplied text — safe
      // to interpolate as a column name.
      const orderCol = sort === 'created' ? 'created_at' : 'content_updated_at';
      const [data, paths] = await Promise.all([
        query<{ id: string; title: string; folder_id: string | null; tags: string[]; created_at: string; updated_at: string; content_updated_at: string; content_length: number }>(
          `select id, title, folder_id, tags, created_at, updated_at, content_updated_at, length(content) as content_length from notes
           where ${conds.join(' and ')}
           order by ${orderCol} desc limit $${params.length}`,
          params
        ),
        folderPathMap(),
      ]);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data.map((n) => withFolderPath(n, paths))) }] };
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
    '`offset` to fetch the rest. Every response carries `headings` — the H1–H3 outline with ' +
    'character offsets, so a truncated note still shows what is in the part you did not get. ' +
    'Jump there with that offset, or name it in `section` to get that heading and its body alone — ' +
    'with `section`, `headings` narrows to that section\'s own subheadings too (offsets re-based to ' +
    'the section\'s own start, matching offset/limit\'s meaning in that mode), not the whole note\'s. ' +
    'Pass `resolve_links: true` to also resolve [[wikilinks]] inside it one level deep — use when ' +
    'you need a note\'s linked context without extra round-trips. Each linked note comes back as ' +
    'id/title/folder_path only by default; pass include_content:true for the full text of each ' +
    `(expensive if the note links to many others), capped at ${LINKED_NOTE_CONTENT_LIMIT} chars — call ` +
    'get_note on a specific id for its full text. `updated_at` moves on any stored change, including ' +
    'another note\'s rename rewriting a [[link]] to this one — pass it back as expected_updated_at ' +
    'on a write. `content_updated_at` only moves when THIS note\'s own title/content/folder/tags ' +
    'were actually edited — that\'s the one that answers "did anyone really touch this". Unresolved ' +
    'links (targets not found) are listed ' +
    'separately.',
    {
      id:      z.string().uuid().optional(),
      title:   z.string().optional(),
      section: z.string().optional()
        .describe('Return only this section (heading text or slug, case-insensitive) and its body'),
      offset:  z.number().int().min(0).default(0).describe('Character offset into content to start from'),
      limit:   z.number().int().min(1000).max(200_000).default(DEFAULT_CONTENT_LIMIT)
        .describe('Max characters of content to return'),
      resolve_links:   z.boolean().default(false)
        .describe('Also resolve [[wikilinks]] inside the note one level deep'),
      include_content: z.boolean().default(false)
        .describe('With resolve_links: include full text of linked notes, not just id/title/folder_path'),
    },
    async ({ id, title, section, offset, limit, resolve_links, include_content }) => {
      if (!id && !title) throw new Error('Provide either id or title');
      const cols = 'id, title, content, folder_id, tags, created_at, updated_at, content_updated_at';
      // findNoteByTitle escapes %/_ at every stage, so wildcards in a real
      // title can't widen the match beyond the step being attempted.
      const [data, paths] = await Promise.all([
        id
          ? queryOne<{ id: string; title: string; content: string; folder_id: string | null }>(`select ${cols} from notes where id = $1 and deleted_at is null`, [id])
          : findNoteByTitle<{ id: string; title: string; content: string; folder_id: string | null }>(title!, cols),
        folderPathMap(),
      ]);
      if (!data) throw new Error('Note not found');

      // Links are resolved from the note's full, unwindowed content — same
      // as the old dedicated tool did — so requesting a `section` narrows
      // what comes back as `content` without narrowing which links count.
      let linkFields: { linked_notes: Record<string, unknown>[]; unresolved_links: string[] } | null = null;
      if (resolve_links) {
        // Titles-only, no content — cheap even on a large vault — so a link
        // target that is itself a literal title containing '#' or '|' (e.g.
        // "closed CodeQL #3") resolves as that title instead of being cut at
        // the character, see extractWikilinkTarget's comment.
        const allTitles = await query<{ title: string }>('select title from notes where deleted_at is null');
        const knownTitles = new Set(allTitles.map((n) => n.title.toLowerCase()));
        const linkTargets = extractAllWikilinks(data.content, knownTitles);
        const resolved: Record<string, unknown>[] = [];
        const missing: string[] = [];
        // [[Guide]] and [[guide]] are one note — titles are unique
        // case-insensitively, so resolve each spelling only once or the
        // agent reads the same note twice and pays for it twice.
        const seen = new Set<string>();
        await Promise.all(
          linkTargets.map(async (target) => {
            const key = target.toLowerCase();
            if (key === data.title.toLowerCase()) return;
            if (seen.has(key)) return;
            seen.add(key);
            const linked = await queryOne<{ id: string; title: string; content: string; folder_id: string | null }>(
              'select id, title, content, folder_id, tags, updated_at from notes where title ilike $1 and deleted_at is null',
              [escapeLike(target)]
            );
            if (!linked) { missing.push(target); return; }
            resolved.push(
              include_content
                ? withFolderPath(windowContent(linked, 0, LINKED_NOTE_CONTENT_LIMIT), paths)
                : withFolderPath(
                    { id: linked.id, title: linked.title, folder_id: linked.folder_id, content_total_length: linked.content.length },
                    paths
                  )
            );
          })
        );
        linkFields = { linked_notes: resolved, unresolved_links: missing };
      }

      // The outline travels with every response: on a windowed note it is the
      // only way to know what sits in the part that did not come back.
      const headings = extractHeadings(data.content);
      let body = data;
      let responseHeadings = headings;
      if (section !== undefined) {
        const range = sectionRange(headings, data.content.length, section);
        if (!range) {
          const available = headings.map(h => h.text).join(' | ') || '(this note has no headings)';
          throw new Error(`No section "${section}" in this note. Available: ${available}`);
        }
        // offset/limit now page within the section, not the whole note.
        body = { ...data, content: data.content.slice(range.start, range.end) };
        // The caller already named the section they want — the rest of the
        // note's outline is dead weight here, and could outweigh the section
        // body itself (measured live 2026-08-17: ~967 content chars vs
        // ~2500 headings chars on one real note). Scope to headings that
        // fall within the section, re-based to the section's own start so
        // they stay usable as the next `offset` — offset/limit above already
        // switched to that same section-local coordinate system.
        responseHeadings = headings
          .filter(h => h.offset >= range.start && h.offset < range.end)
          .map(h => ({ ...h, offset: h.offset - range.start }));
      }
      const windowed = withFolderPath(windowContent(body, offset, limit), paths);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...windowed, headings: responseHeadings, ...linkFields }) }] };
    }
  );

  // ── create_note ──────────────────────────────────────────────────────────
  // create_note and update_note used to restate this server's wikilink and
  // tag rules in full. Those rules are already in `instructions` above, which
  // every client receives once per session, so the copies cost the same bytes
  // on every schema load while saying nothing new. What a tool description
  // still has to carry is the CUE that they apply at this call — that stays.
  server.tool(
    'create_note',
    'Create a new note. Embedding is generated automatically in the background. ' +
    'The server instructions\' wikilink and tag rules apply: search_notes for the topic first and ' +
    'link the related notes it finds, and call list_tags before coining a new tag.',
    {
      title:     z.string().trim().min(1).max(500),
      content:   z.string().max(MAX_NOTE_CONTENT_CHARS).default(''),
      folder_id: z.string().uuid().nullable().optional(),
      tags:      z.array(z.string()).default([]),
    },
    async ({ title, content: rawContent, folder_id, tags }) => {
      const content = stripNulBytes(rawContent);
      // Echoing the content back would double its cost for nothing — the
      // caller just sent it and knows what it is. length(content) lets it
      // confirm the write landed intact without paying for the text again.
      let note: { id: string; title: string; folder_id: string | null; tags: string[]; created_at: string; content_length: number } | null;
      let paths: Map<string, string>;
      try {
        [note, paths] = await Promise.all([
          queryOne<{ id: string; title: string; folder_id: string | null; tags: string[]; created_at: string; content_length: number }>(
            `insert into notes (title, content, folder_id, tags, embedding_pending)
             values ($1, $2, $3, $4, true)
             returning id, title, folder_id, tags, created_at, length(content) as content_length`,
            [title, content, folder_id ?? null, tags]
          ),
          folderPathMap(),
        ]);
      } catch (err) {
        if (isUniqueViolation(err)) throw new Error(`A note titled "${title}" already exists — update it or pick another title`);
        throw err;
      }
      if (!note) throw new Error('Insert failed');

      // background index (note embedding + chunks)
      indexNoteAsync(note.id, title, content);

      const unresolved_links = await unresolvedWikilinksIn(content, title);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...withFolderPath(note, paths), ...(unresolved_links.length ? { unresolved_links } : {}) }) }] };
    }
  );

  // ── update_note ──────────────────────────────────────────────────────────
  server.tool(
    'update_note',
    'Update note fields. Re-embeds if title or content changed. Updates wikilinks if title changed. ' +
    // The cue has to name list_tags explicitly, not just point at the server
    // instructions: an agent about to add a tag reads THIS description, and a
    // pointer it has to follow is a pointer it will skip. Deduplicating the
    // rules is fine; deduplicating the tool name is not.
    'The server instructions\' wikilink and tag rules apply when substantially rewriting — ' +
    'in particular, call list_tags before coining a new tag. ' +
    'Pass expected_updated_at (the updated_at you read) to be refused instead of overwriting a ' +
    'change made in between.',
    {
      id:        z.string().uuid(),
      title:     z.string().trim().min(1).max(500).optional(),
      content:   z.string().max(MAX_NOTE_CONTENT_CHARS).optional(),
      folder_id: z.string().uuid().nullable().optional(),
      tags:      z.array(z.string()).optional(),
      expected_updated_at: z.string().optional()
        .describe('ISO updated_at from when you read the note; refuses the write if it changed since'),
    },
    async ({ id, title, content: rawContent, folder_id, tags, expected_updated_at }) => {
      const content = rawContent !== undefined ? stripNulBytes(rawContent) : undefined;
      const [existing, paths] = await Promise.all([
        queryOne<{ title: string; content: string; updated_at: string }>(
          'select title, content, updated_at from notes where id = $1 and deleted_at is null', [id]
        ),
        folderPathMap(),
      ]);
      if (!existing) throw new Error('Note not found');

      // Two sessions editing the same note otherwise silently overwrite one
      // another — the loser's text is gone with nothing to say it happened.
      // This read only shapes the error message; the guarantee is the
      // condition carried into the UPDATE below, because anything checked
      // here can change before the write lands.
      if (expected_updated_at !== undefined && Number.isNaN(new Date(expected_updated_at).getTime())) {
        throw new Error('expected_updated_at is not a valid timestamp');
      }
      const staleRead = expected_updated_at !== undefined
        && new Date(expected_updated_at).getTime() !== new Date(existing.updated_at).getTime();
      const refuseStale = (): never => {
        throw new Error(
          'Note changed since you read it — re-read it with get_note and reapply your edit'
        );
      };
      if (staleRead) refuseStale();

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (title     !== undefined) set('title', title);
      if (content   !== undefined) set('content', content);
      if (folder_id !== undefined) set('folder_id', folder_id);
      if (tags      !== undefined) set('tags', tags);
      if (sets.length === 0) throw new Error('Provide at least one field to update');

      params.push(id);
      const idParam = params.length;
      // date_trunc to milliseconds: the column keeps microseconds, but the
      // caller only ever saw three decimals, so comparing raw would refuse
      // every honest write whose stored value carries a finer fraction.
      let guard = '';
      if (expected_updated_at !== undefined) {
        params.push(expected_updated_at);
        guard = `and date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $${params.length}::timestamptz)`;
      }
      type UpdateResult = {
        note: { id: string; title: string; folder_id: string | null; tags: string[]; updated_at: string; content_length: number } | null;
        changed: boolean; newTitle: string; newContent: string;
      };
      let result: UpdateResult | null;
      try {
        // One transaction, row locked: a concurrent rename that read the same
        // pre-update title and committed its own update_wikilinks rewrite
        // first would otherwise make THIS call's update_wikilinks (keyed on
        // that now-stale title) match nothing — leaving backlinks broken.
        result = await withTransaction(async (client) => {
          const { rows: lockedRows } = await client.query<{ title: string; content: string }>(
            'select title, content from notes where id = $1 and deleted_at is null for update',
            [id]
          );
          const locked = lockedRows[0];
          if (!locked) return null;

          // Compare values, not presence: agents routinely resend the whole
          // note to edit one tag, and re-embedding unchanged text costs a
          // paid call.
          const changed =
            (title   !== undefined && title   !== locked.title) ||
            (content !== undefined && content !== locked.content);
          let finalSets = changed ? [...sets, 'embedding_pending = true'] : sets;

          // A rename rewrites [[wikilinks]] to this note everywhere ELSE
          // (update_wikilinks below), but never touched this note's own
          // body — the visible `# Old Title` heading silently fell out of
          // sync with the new title (found live 2026-08-17). Only fix it
          // when nobody explicitly rewrote content AND the body's very
          // first line is an exact, unambiguous `# <old title>` — the
          // vault's own convention (see the knowledge-base conventions
          // note, rule #3) — never guess at a heading that doesn't match.
          let fixedContent: string | undefined;
          if (title !== undefined && title !== locked.title && content === undefined) {
            const firstLine = locked.content.split('\n', 1)[0];
            if (firstLine === `# ${locked.title}`) {
              fixedContent = `# ${title}` + locked.content.slice(firstLine.length);
              params.push(fixedContent);
              finalSets = [...finalSets, `content = $${params.length}`];
            }
          }

          const { rows } = await client.query<{ id: string; title: string; folder_id: string | null; tags: string[]; updated_at: string; content_length: number }>(
            `update notes set ${finalSets.join(', ')}
             where id = $${idParam} and deleted_at is null ${guard}
             returning id, title, folder_id, tags, updated_at, length(content) as content_length`,
            params
          );
          const note = rows[0] ?? null;
          if (title && title !== locked.title && note) {
            await rewriteBacklinks(client, locked.title, title);
          }
          return { note, changed, newTitle: title ?? locked.title, newContent: fixedContent ?? content ?? locked.content };
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new Error(`A note titled "${title}" already exists — update it or pick another title`);
        throw err;
      }
      // The note was there a moment ago, so nothing matching now means the
      // guard caught a write that landed in between.
      if (!result?.note && expected_updated_at !== undefined) refuseStale();
      if (!result?.note) throw new Error('Note not found');
      if (result.changed) {
        indexNoteAsync(id, result.newTitle, result.newContent);
      }
      // Only what THIS call wrote: on a title/tags-only update the existing
      // body is not this write's doing, and reporting its old breakage every
      // time would train the reader to ignore the field.
      const unresolved_links = content !== undefined ? await unresolvedWikilinksIn(content, result.newTitle) : [];
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...withFolderPath(result.note, paths), ...(unresolved_links.length ? { unresolved_links } : {}) }) }] };
    }
  );

  // ── append_to_note ───────────────────────────────────────────────────────
  server.tool(
    'append_to_note',
    'Add text to a note without resending the rest — prefer it over update_note for journals, logs ' +
    'and running lists. A blank line separates your text from what was there. Re-embeds in the ' +
    'background like any content change.',
    {
      id:      z.string().uuid().optional(),
      title:   z.string().optional().describe('Alternative to id; resolved like get_note'),
      content: z.string().min(1).max(MAX_NOTE_CONTENT_CHARS),
      section: z.string().optional()
        .describe('Target this section (heading text or slug) instead of the whole note'),
      at: z.enum(['note_end', 'note_start', 'section_end', 'section_start', 'before_section', 'after_section'])
        .optional()
        .describe(
          'Default section_end if section given, else note_end. note_start is after the H1/intro, ' +
          'before its first nested heading — not offset 0.'
        ),
    },
    async ({ id, title, content, section, at }) => {
      if (!id && !title) throw new Error('Provide either id or title');
      const found = id
        ? await queryOne<{ id: string }>(
            'select id from notes where id = $1 and deleted_at is null', [id])
        : await findNoteByTitle<{ id: string }>(title!, 'id');
      if (!found) throw new Error('Note not found');

      const addition = stripNulBytes(content).trimEnd();
      const effectiveAt: AppendAt = at ?? (section !== undefined ? 'section_end' : 'note_end');
      // Read and write inside one transaction with the row locked. Appending
      // is read-modify-write, so two sessions logging at once would otherwise
      // both build on the same text and the first one's line would vanish —
      // exactly the loss this tool exists to prevent.
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ title: string; content: string }>(
          'select title, content from notes where id = $1 and deleted_at is null for update',
          [found.id]
        );
        const existing = rows[0];
        if (!existing) throw new Error('Note not found');

        const headings = extractHeadings(existing.content);
        const offset = resolveInsertOffset(existing.content, headings, effectiveAt, section);
        const next = insertAddition(existing.content, offset, addition);
        if (next.length > MAX_NOTE_CONTENT_CHARS) {
          throw new Error(`Appending would exceed the ${MAX_NOTE_CONTENT_CHARS}-character limit for a note`);
        }

        const updated = await client.query<{ id: string; title: string; updated_at: string }>(
          `update notes set content = $1, embedding_pending = true where id = $2
           returning id, title, updated_at`,
          [next, found.id]
        );
        return { note: updated.rows[0], title: existing.title, next };
      });

      const { note, next } = result;
      indexNoteAsync(found.id, result.title, next);
      const unresolved_links = await unresolvedWikilinksIn(addition, result.title);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ...note, appended_chars: addition.length, content_total_length: next.length, ...(unresolved_links.length ? { unresolved_links } : {}) }),
        }],
      };
    }
  );

  // ── replace_in_note ──────────────────────────────────────────────────────
  const editItemShape = {
    find:       z.string().min(1).optional().describe('Text to replace. Alias: old_string'),
    replace:    z.string().optional().describe('Replacement text. Alias: new_string'),
    old_string: z.string().min(1).optional().describe('Alias for find'),
    new_string: z.string().optional().describe('Alias for replace'),
    expected_count: z.number().int().min(1).default(1),
  };
  server.tool(
    'replace_in_note',
    'Replace exact text in a note without resending the rest. Refuses unless find occurs exactly ' +
    'expected_count times (default 1) — protects against a loose find rewriting more than intended. ' +
    'Accepts either find/replace or old_string/new_string (same pair, either naming works).\n\n' +
    'For several replacements in one note, pass `edits` (array of {find/old_string, replace/new_string, ' +
    'expected_count}) instead of the singular fields — one row lock and one re-embed for the whole ' +
    'batch instead of one per call. Edits apply in order, and each one\'s find is matched against the ' +
    'note as already changed by the edits before it, not the original content — an earlier edit can ' +
    'create the text a later one needs, or remove the text a later one expects to find; sequence them ' +
    'accordingly. If any step\'s count does not match, the whole batch is refused and the note is left ' +
    'completely untouched — the error names which edit index failed and how many times its find text ' +
    'actually occurred. Do not combine `edits` with the singular find/replace/old_string/new_string/' +
    'expected_count fields — use one form or the other.',
    {
      id:      z.string().uuid().optional(),
      title:   z.string().optional().describe('Alternative to id; resolved like get_note'),
      ...editItemShape,
      expected_count: z.number().int().min(1).optional(),
      edits: z.array(z.object(editItemShape)).min(1).max(50).optional()
        .describe('Multiple find/replace steps applied in order in a single call — see main description.'),
      expected_updated_at: z.string().optional()
        .describe('ISO updated_at from when you read the note; refuses the write if it changed since'),
    },
    async ({ id, title, find, replace, old_string, new_string, expected_count, edits, expected_updated_at }) => {
      if (!id && !title) throw new Error('Provide either id or title');

      // Two accepted spellings for the same pair — find/replace (this tool's
      // own convention) and old_string/new_string (Claude Code's Edit tool
      // convention, which agents reach for on autopilot). Whichever half of
      // each pair is present wins; ?? only falls through on undefined, so an
      // intentional empty-string replace (a deletion) still comes through.
      const resolvePair = (f: string | undefined, o: string | undefined, r: string | undefined, n: string | undefined, prefix: string) => {
        const findRaw = f ?? o;
        const replaceRaw = r ?? n;
        if (findRaw === undefined) throw new Error(`${prefix}Provide find (or old_string)`);
        if (replaceRaw === undefined) throw new Error(`${prefix}Provide replace (or new_string) — pass an empty string to delete the matched text`);
        return { find: stripNulBytes(findRaw), replace: stripNulBytes(replaceRaw) };
      };

      let editsList: NoteEdit[];
      if (edits !== undefined) {
        // Silently preferring `edits` over singular fields would drop half of
        // a caller's intent with no signal that anything was ignored — worse
        // than refusing outright.
        if ([find, replace, old_string, new_string, expected_count].some((v) => v !== undefined)) {
          throw new Error('Provide either `edits` or find/replace (old_string/new_string/expected_count) — not both');
        }
        editsList = edits.map((e, i) => ({
          ...resolvePair(e.find, e.old_string, e.replace, e.new_string, `edits[${i}]: `),
          expected_count: e.expected_count,
        }));
      } else {
        editsList = [{
          ...resolvePair(find, old_string, replace, new_string, ''),
          expected_count: expected_count ?? 1,
        }];
      }

      const found = id
        ? await queryOne<{ id: string }>(
            'select id from notes where id = $1 and deleted_at is null', [id])
        : await findNoteByTitle<{ id: string }>(title!, 'id');
      if (!found) throw new Error('Note not found');

      if (expected_updated_at !== undefined && Number.isNaN(new Date(expected_updated_at).getTime())) {
        throw new Error('expected_updated_at is not a valid timestamp');
      }

      // Read and write inside one transaction with the row locked, same as
      // append_to_note — this is read-modify-write too, and find/replace is
      // no safer against a lost concurrent write than a plain append is.
      const result = await withTransaction(async (client) => {
        const { rows } = await client.query<{ title: string; content: string; updated_at: string }>(
          'select title, content, updated_at from notes where id = $1 and deleted_at is null for update',
          [found.id]
        );
        const existing = rows[0];
        if (!existing) throw new Error('Note not found');

        // Optional and secondary to the count check below: the row is
        // already locked at this point, so comparing here (not pushed into
        // the UPDATE's WHERE like update_note's guard) is already atomic —
        // no concurrent write can land between this check and ours.
        if (expected_updated_at !== undefined
            && new Date(expected_updated_at).getTime() !== new Date(existing.updated_at).getTime()) {
          throw new Error('Note changed since you read it — re-read it with get_note and reapply your edit');
        }

        // Applied against the running `current`, not existing.content — each
        // edit sees the note as the edits before it left it. A single-edit
        // call (the common case) keeps the plain, pre-batch error wording;
        // a real batch names the failing step so an agent doesn't have to
        // bisect it by hand.
        const single = editsList.length === 1;
        let current = existing.content;
        const results: { replaced_count: number }[] = [];
        editsList.forEach((edit, i) => {
          const count = countOccurrences(current, edit.find);
          if (count !== edit.expected_count) {
            throw new Error(
              single
                ? (count === 0
                    ? `find text not found in this note (expected ${edit.expected_count} occurrence${edit.expected_count === 1 ? '' : 's'})`
                    : `find text occurs ${count} time${count === 1 ? '' : 's'} in this note, expected ${edit.expected_count} — ` +
                      'narrow find or adjust expected_count')
                : `edits[${i}]: "${truncateForError(edit.find)}" occurs ${count} time${count === 1 ? '' : 's'} ` +
                  `(expected ${edit.expected_count}); note left untouched`
            );
          }
          current = current.split(edit.find).join(edit.replace);
          results.push({ replaced_count: count });
        });

        if (current.length > MAX_NOTE_CONTENT_CHARS) {
          throw new Error(`Replacing would exceed the ${MAX_NOTE_CONTENT_CHARS}-character limit for a note`);
        }

        const updated = await client.query<{ id: string; title: string; updated_at: string }>(
          `update notes set content = $1, embedding_pending = true where id = $2
           returning id, title, updated_at`,
          [current, found.id]
        );
        return { note: updated.rows[0], title: existing.title, next: current, results };
      });

      const { note, next, results } = result;
      indexNoteAsync(found.id, result.title, next);
      const replaced_count = results.reduce((sum, r) => sum + r.replaced_count, 0);
      const unresolved_links = await unresolvedWikilinksIn(editsList.map((e) => e.replace).join('\n'), result.title);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ...note, replaced_count, results, content_length: next.length, ...(unresolved_links.length ? { unresolved_links } : {}) }),
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

  // Rounding for display only — the underlying number is still full
  // precision wherever code (not a human) consumes it. relevance/threshold/
  // best_score are ratios/thresholds (2 decimals is already more precision
  // than the numbers carry any real meaning at); raw scores (ts_rank,
  // cosine, RRF) get 3, since they're compared against each other more than
  // read on their own.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const round3 = (n: number) => Math.round(n * 1000) / 1000;

  // What actually made the old output unreadable wasn't lack of
  // indentation on its own — real newlines inside a JSON string aren't
  // achievable at all (RFC 8259 requires \n escaped), so a markdown table
  // in an excerpt looks the same either way. It was ~41% of every response
  // being debug numbers at 17 significant digits (relevance:
  // 0.9488824385394478, two of which are ever meaningful) that a client
  // showing the raw string — not every MCP client pretty-prints JSON
  // itself — had no way to skip past. Fix: drop rrf_score/text_score/
  // semantic_score/created_at from the default shape (still available via
  // explain:true, for debugging the ranking itself), round what's left,
  // and pretty-print with JSON.stringify(_, null, 2) so a client that
  // doesn't reformat still sees structure. Trimmed debug fields (~40% per
  // measurement) outweigh indentation's own overhead (~25%), so the net
  // response is smaller as well as more readable
  // (2026-08-14 search-relevance overhaul, step 8).
  function toDisplayResult(r: SearchResult | HybridSearchResult, explain: boolean): Record<string, unknown> {
    const hybrid = r as Partial<HybridSearchResult>;
    const out: Record<string, unknown> = {
      id: r.id,
      title: r.title,
      excerpt: r.excerpt,
      tags: r.tags,
      relevance: round2(r.relevance),
    };
    if (hybrid.matched_by) out.matched_by = hybrid.matched_by;
    // Observed facts about the text match: which cascade level found it and
    // how much of the query it contains. Shipped when they say something a
    // reader would not assume — a non-'and' tier or coverage below 1 — and
    // always under explain.
    if (r.text_tier && (explain || r.text_tier !== 'and')) out.text_tier = r.text_tier;
    if (r.coverage !== undefined && (explain || r.coverage < 1)) out.coverage = round2(r.coverage);
    // Only ever shipped as true: `exact: false` on nearly every hit would be
    // noise, and its absence already means "not verbatim".
    if (r.exact) out.exact = true;
    if (r.content_length !== undefined) out.content_length = r.content_length;
    if (explain) {
      // Hybrid results carry text_score/semantic_score directly (rrfMerge
      // sets them per contributing arm). A plain (non-hybrid) result has no
      // such split — its own `score` field IS that one arm's raw number
      // (ts_rank for type:"text", cosine for type:"semantic") — so surface
      // it under the same name the hybrid shape uses, keyed off text_tier
      // (set only by the text arm) to know which. Without this, explain:true
      // on type:"text"/"semantic" showed nothing to debug ranking with at all.
      const plain = r as Partial<SearchResult>;
      if (hybrid.text_score !== undefined) out.text_score = round3(hybrid.text_score);
      else if (plain.score !== undefined && plain.text_tier !== undefined) out.text_score = round3(plain.score);
      if (hybrid.semantic_score !== undefined) out.semantic_score = round3(hybrid.semantic_score);
      else if (plain.score !== undefined && plain.text_tier === undefined) out.semantic_score = round3(plain.score);
      if (hybrid.rrf_score !== undefined) out.rrf_score = round3(hybrid.rrf_score);

      if (r.created_at) out.created_at = r.created_at;
    }
    return out;
  }

  // ── search_notes ─────────────────────────────────────────────────────────
  server.tool(
    'search_notes',
    'Search notes. type: "text" (fast), "semantic" (meaning-based), "hybrid" (best, uses RRF). ' +
    'Hybrid is the right default; prefer type=text for exact identifiers, code fragments, or quoted ' +
    'phrases, where FTS beats meaning-matching. ' +
    'Returns short excerpts, not full notes — call get_note on the top 1-2 hits to read them. ' +
    'Each hit carries `relevance` (0..1, how close to the best hit in THIS response) and ' +
    '`matched_by` (which arms found it). Both describe the response, not ' +
    'the world: relevance orders hits, it does not judge them, and there is deliberately no ' +
    'confidence score. Judge a hit by reading its excerpt.' +
    '\n\nWhat the search DOES decide on its own is whether to answer at all: a semantic hit below ' +
    'the active model\'s minimum similarity is not returned, so an empty result means "nothing here ' +
    'is close enough", not "nothing matched". That threshold is a per-model heuristic measured on ' +
    'a few corpora — see indexing_status for which model is active, the number in force, and ' +
    'whether it was ever measured for that model.' +
    '\n\nA hit found ONLY by the semantic arm (`matched_by` is semantic_score alone) says the ' +
    'passage is ABOUT something similar — never that it confirms what you asked. The two are ' +
    'routinely different: a query about a technology a vault has never used still returns its ' +
    'nearest neighbours, comfortably above threshold, with nothing about that technology in them. ' +
    'So when a hit is semantic-only and its excerpt does not actually contain what you asked ' +
    'about, the honest reading is "no confirmation found" — say that, or open the note to check. ' +
    'Do not report it as evidence the thing exists.' +
    '\n\n`text_tier`, `coverage` and `exact` are observed facts about the text match, shipped when ' +
    'they say something you would not assume. A tier of "or"/"substring" means the strict query ' +
    'found nothing and a looser pass filled in — recall, not confirmation. Coverage below 1 is the ' +
    'fraction of the query\'s significant words the hit actually contains. `exact: true` is the ' +
    'one thing FTS cannot express, and it means exactly this and nothing more: the query occurs ' +
    'as a contiguous, case-insensitive substring of that note (wildcards escaped — `A_B` does not ' +
    'match `AxB`). It is set only for a whitespace-free query that still splits into several ' +
    'words — a filename, an identifier, a code symbol, the case where the tokenizer takes one ' +
    'name apart and cannot put it back. Never for a phrase or a question: a note QUOTING your ' +
    'question is not a note answering it. Such hits take the top half of the relevance scale, ' +
    'ranked among themselves by their own text score. Neither tier nor coverage is comparable ' +
    'across different queries, only within one response. ' +
    'Filters: folder_id, tag, created_after/before (when a note was made), updated_after/before ' +
    '(when its own content/title/folder/tags last actually changed — a rename elsewhere rewriting ' +
    'a [[link]] to this note does not count) — these are NOT interchangeable. ' +
    'Every semantic/hybrid response includes threshold/best_score/pending_embeddings so you can ' +
    'tell "nothing relevant" from "just under threshold" from "embeddings not generated yet", even ' +
    'when results came back non-empty. ' +
    'Pass explain:true to also see each hit\'s raw text_score/semantic_score/rrf_score and created_at ' +
    '— only useful for debugging the ranking itself, omitted by default to keep responses short.',
    {
      query:          z.string().min(1),
      type:           z.enum(['text', 'semantic', 'hybrid']).default('hybrid'),
      limit:          z.number().int().min(1).max(50).default(5),
      folder_id:      z.string().uuid().optional().describe('Restrict to notes in this folder'),
      tag:            z.string().optional().describe('Restrict to notes with this tag'),
      created_after:  z.string().optional().describe('ISO timestamp — only notes created at or after this'),
      created_before: z.string().optional().describe('ISO timestamp — only notes created at or before this'),
      updated_after:  z.string().optional().describe('ISO timestamp — only notes whose own content actually changed at or after this'),
      updated_before: z.string().optional().describe('ISO timestamp — only notes whose own content actually changed at or before this'),
      explain:        z.boolean().default(false).describe('Include raw per-arm scores and created_at for debugging ranking'),
    },
    async ({ query: q, type, limit, folder_id, tag, created_after, created_before, updated_after, updated_before, explain }) => {
      const filters = {
        folderId: folder_id, tag,
        createdAfter: created_after, createdBefore: created_before,
        updatedAfter: updated_after, updatedBefore: updated_before,
      };
      let results: SearchResult[] | HybridSearchResult[];
      if      (type === 'semantic') results = await semanticSearch(q, limit, filters);
      else if (type === 'hybrid')   results = await hybridSearch(q, limit, filters);
      else                          results = await textSearch(q, limit, filters);

      const displayResults = results.map((r) => toDisplayResult(r, explain));

      if (type === 'text') {
        // Always {results: [...]}, same top-level shape as hybrid/semantic
        // below — a caller no longer needs a type-keyed branch just to read
        // the hit list (found live 2026-08-17, independently by both an
        // external audit and an independent-agent test). text has no
        // threshold/best_score/pending_embeddings of its own (those are
        // semantic-search concepts — cosine floor, embedding backlog), so it
        // just omits them rather than sending meaningless zeros.
        return { content: [{ type: 'text' as const, text: JSON.stringify({ results: displayResults }, null, 2) }] };
      }

      // best_score returned unconditionally, not just on an empty result —
      // relevance is only ever relative to the best hit IN THIS RESPONSE
      // (semanticSearch/rrfMerge), so an agent has no way to tell "a
      // confident 0.85 cosine" from "the least-bad of a weak field" without
      // this number to compare against (2026-08-14 search-relevance overhaul, step 2).
      const [threshold, bestScore, pendingRows] = await Promise.all([
        effectiveSemanticThreshold(),
        bestSemanticScore(q),
        query<{ count: number }>('select count(*)::int as count from notes where embedding_pending = true and deleted_at is null'),
      ]);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            results: displayResults,
            threshold: round2(threshold),
            best_score: bestScore === null ? null : round3(bestScore),
            pending_embeddings: pendingRows[0]?.count ?? 0,
          }, null, 2),
        }],
      };
    }
  );

  // ── indexing_status ──────────────────────────────────────────────────────
  server.tool(
    'indexing_status',
    'Semantic-index progress: total/indexed/pending notes, complete=true when pending=0. Pending ' +
    'notes are still found by text search but not semantic/hybrid until embedded (automatic, ' +
    'background). Stuck pending count while nothing is being edited = check Ollama/server logs.\n' +
    'Also names the active embedding model and the semantic cutoff in force. ' +
    'semantic_min_similarity is the cosine below which a semantic hit is not returned at all, and ' +
    'semantic_profile says where that number came from: "profiled" (measured for this model), ' +
    '"unverified" (shipped but never actually measured), "configured" (set by hand in settings), ' +
    'or "unprofiled" — no threshold for this model, so semantic search returns its nearest ' +
    'matches and refuses nothing. Raw cosines are NOT comparable between models: a number that ' +
    'means a good match on one means noise on another, which is why the model is named here ' +
    'rather than left to be inferred from the score.',
    {},
    async () => {
      const row = await queryOne<{ total: number; pending: number }>(
        `select count(*)::int as total,
                (count(*) filter (where embedding_pending))::int as pending
         from notes where deleted_at is null`
      );
      const total = row?.total ?? 0;
      const pending = row?.pending ?? 0;
      const profile = await getSemanticProfile();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total, indexed: total - pending, pending, complete: pending === 0,
            embedding_model: profile.model,
            semantic_min_similarity: profile.minSimilarity,
            semantic_profile: profile.status,
          }),
        }],
      };
    }
  );

  // ── list_tags ────────────────────────────────────────────────────────────
  server.tool(
    'list_tags',
    'List tags in use with the number of notes carrying each, most-used first, capped at `limit` ' +
    '(default 40). Call this before tagging a note and reuse an existing tag when one fits, rather ' +
    'than coining a near-duplicate (a translation, transliteration, or plural of an existing tag) — ' +
    'the vault has no tag synonyms, so near-duplicates fragment the same concept into separate tags. ' +
    'The default cuts off the one-off tail: a tag ' +
    'used once is not one worth reusing, so it is not shown unless you raise limit.',
    {
      limit: z.number().int().min(1).max(1000).default(40).describe('Max tags to return, most-used first'),
    },
    async ({ limit }) => {
      const rows = await query<{ tag: string; count: number }>(
        `select unnest(tags) as tag, count(*)::int as count
         from notes where deleted_at is null group by 1 order by count desc, tag limit $1`,
        [limit]
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows) }] };
    }
  );

  // ── list_folders ─────────────────────────────────────────────────────────
  server.tool(
    'list_folders',
    'List all folders (flat array) with the full path already resolved — no need to walk parent_id ' +
    'yourself. Pass a folder\'s own id as parent_id to create_folder/update_folder to nest under it.',
    {},
    async () => {
      const data = await query<FolderRow>('select id, name, parent_id from folders order by name');
      const paths = buildFolderPathMap(data);
      // parent_id dropped: path already encodes the full chain, and creating
      // a subfolder only ever needs a folder's own id, never its parent's.
      // name stays — folder names aren't barred from containing "/", so a
      // literal one there would be indistinguishable from a path separator.
      const result = data.map((f) => ({ id: f.id, name: f.name, path: paths.get(f.id) ?? f.name }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
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
      let data;
      try {
        data = await queryOne(
          'insert into folders (name, parent_id) values ($1, $2) returning *',
          [name, parent_id ?? null]
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new Error(`A folder named "${name}" already exists in this location`);
        throw err;
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    }
  );

  // ── update_folder ────────────────────────────────────────────────────────
  server.tool(
    'update_folder',
    'Rename a folder and/or move it under a different parent (set parent_id to null for top level). ' +
    'Provide at least one of name/parent_id. The response includes the resolved `path` so a rename or ' +
    'move can be confirmed without a follow-up list_folders call.',
    {
      id:        z.string().uuid(),
      name:      z.string().min(1).max(255).optional(),
      parent_id: z.string().uuid().nullable().optional(),
    },
    async ({ id, name, parent_id }) => {
      if (parent_id !== undefined && parent_id === id) {
        throw new Error('Folder cannot be its own parent');
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (name      !== undefined) set('name', name);
      if (parent_id !== undefined) set('parent_id', parent_id);
      if (sets.length === 0) throw new Error('Provide name and/or parent_id');
      params.push(id);

      const data = await withTransaction(async (client) => {
        if (parent_id !== undefined && parent_id !== null) {
          // Same advisory lock as the REST folder route: only reparenting
          // can create a cycle, and the check + write must be serialized
          // against ANY concurrent reparent — REST or MCP — or two moves
          // that each read a cycle-free tree can together create a real one.
          await client.query('select pg_advisory_xact_lock($1)', [FOLDER_REPARENT_LOCK_KEY]);
          const { rows: cycleRows } = await client.query<{ id: string }>(
            `WITH RECURSIVE ancestors AS (
               SELECT id, parent_id FROM folders WHERE id = $1
               UNION
               SELECT f.id, f.parent_id FROM folders f
               INNER JOIN ancestors a ON f.id = a.parent_id
             )
             SELECT id FROM ancestors WHERE id = $2`,
            [parent_id, id]
          );
          if (cycleRows.length > 0) throw new Error('Cannot move a folder into its own descendant');
        }
        const { rows } = await client.query(
          `update folders set ${sets.join(', ')} where id = $${params.length} returning *`,
          params
        );
        return rows[0] ?? null;
      });
      if (!data) throw new Error('Folder not found');
      // The rename/move itself may have changed this folder's own path, or —
      // for a reparent — its position in the tree, so the map is built fresh
      // from the post-write state rather than reused from before the call.
      const paths = await folderPathMap();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, path: paths.get(data.id) ?? data.name }) }] };
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
    'default and call get_note on specific ids instead). Paginated like get_note. Takes id or title, ' +
    'like get_note — title resolves the same forgiving way (exact, then prefix, then substring).',
    {
      id:              z.string().uuid().optional(),
      title:           z.string().optional(),
      include_content: z.boolean().default(false),
      limit:           z.number().int().min(1).max(200).default(50),
      offset:          z.number().int().min(0).default(0),
    },
    async ({ id, title, include_content, limit, offset }) => {
      if (!id && !title) throw new Error('Provide either id or title');
      // Backlinks are found by matching [[Title]] text in other notes'
      // content, so both paths need one lookup first to know the note's
      // real title — findNoteByTitle gives a partial/fuzzy title the same
      // exact->prefix->substring forgiveness get_note already has (and
      // throws its own "matches N notes"/"not found" error on the way).
      const resolvedTitle = id
        ? (await queryOne<{ title: string }>('select title from notes where id = $1 and deleted_at is null', [id]))?.title
        : (await findNoteByTitle<{ title: string }>(title!, 'title')).title;
      if (!resolvedTitle) throw new Error('Note not found');

      const [data, paths] = await Promise.all([
        query<{ id: string; title: string; content: string; folder_id: string | null }>(
          'select id, title, content, folder_id from notes where content ilike $1 and deleted_at is null',
          [`%[[${escapeLike(resolvedTitle)}%`]
        ),
        folderPathMap(),
      ]);

      // Precise filter: ilike is approximate, extractAllWikilinks is exact.
      // Pass the title itself as the known-titles set so a link written as
      // the literal title "closed CodeQL #3" isn't cut at the '#' before
      // the comparison — see extractWikilinkTarget's comment.
      const knownTitles = new Set([resolvedTitle.toLowerCase()]);
      const backlinks = data.filter((n) =>
        extractAllWikilinks(n.content, knownTitles).some(
          (t) => t.toLowerCase() === resolvedTitle.toLowerCase()
        )
      );

      const total = backlinks.length;
      const page = backlinks.slice(offset, offset + limit);
      const results = page.map((n) => {
        const base = withFolderPath({ id: n.id, title: n.title, folder_id: n.folder_id }, paths);
        return include_content
          ? { ...base, content: n.content }
          : { ...base, snippet: makeExcerpt(n.content, `[[${resolvedTitle}`, 200) };
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            results,
            total,
            ...(offset + limit < total ? { next_offset: offset + limit } : {}),
          }),
        }],
      };
    }
  );

  // ── get_graph ─────────────────────────────────────────────────────────────
  server.tool(
    'get_graph',
    'Get the knowledge graph: note nodes, directed edges from [[wikilinks]], and undirected ' +
    'semantic_edges (embedding cosine similarity) between related notes that may lack explicit links. ' +
    'Nodes are `{id, t}` (t = title); edges and semantic_edges reference nodes by their position in ' +
    'the `nodes` array (not id) — `["edges"][0] = [2, 5]` means nodes[2] links to nodes[5], and a ' +
    'semantic_edges triple\'s third ' +
    'number is the cosine score. `unresolved_links` lists [[wikilink]] targets in this scope that ' +
    'match no note title — dangling links, not edges (no node index, since there is no node to point ' +
    'at); rename the target or fix the link text to resolve one. Unfiltered, this returns the ENTIRE ' +
    'vault in one response — fine for small vaults, but it will stop fitting in context as the vault ' +
    'grows. Scope it with folder_id (a subtree) or root_title+depth (the neighborhood around one note) ' +
    'when you only need part of the graph. Node titles in the result are valid [[wikilink]] targets — ' +
    'but only within whatever scope you asked for.',
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
      return { content: [{ type: 'text' as const, text: JSON.stringify(indexedForm(graph)) }] };
    }
  );

  return server;
}
