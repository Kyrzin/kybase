// lib/mcp-server.ts — MCP server factory with 18 tools
// Uses @modelcontextprotocol/sdk McpServer (high-level API)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query, queryOne, withTransaction, isUniqueViolation, FOLDER_REPARENT_LOCK_KEY } from './db';
import { softDeleteNote, restoreNote, trashFolderNotes, TRASH_RETENTION_DAYS } from './trash';
import { escapeLike } from './sql';
import { backlinksTo, neighborsOf } from './note-links';
import { searchWithDiagnostics, SearchUnavailableError, type SearchResult, type HybridSearchResult, type SearchDiagnostics } from './search';
import { indexNoteAsync } from './indexing';
import { extractAllWikilinks } from './wikilinks';
import { rewriteBacklinks } from './rename-links';
import { buildGraph } from './graph-data';
import { indexedForm } from './graph';
import { extractHeadings, type Heading } from './markdown';
import { getSemanticProfile } from './embeddings';
import { MAX_NOTE_CONTENT_CHARS, stripNulBytes } from './types';

/**
 * A UUID parameter.
 *
 * Not `uuid()`, which emits `format: "uuid"` AND a 166-character
 * `pattern` restating it — seventeen times across this server's tools, 706
 * tokens of identical machine-generated regex an agent reads on every
 * session and learns nothing from. The refinement validates exactly what
 * that pattern did (verified against it, nil UUID included) and is invisible
 * to JSON Schema, so `format` is declared explicitly and carries the meaning
 * on its own.
 */
const UUID_RE = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const uuid = () => z.string().refine((v) => UUID_RE.test(v), 'must be a UUID').meta({ format: 'uuid' });



// get_note(title=...) is the shortcut past search_notes, but real titles are long
// and composite (" — Kybase: Move-folder + sidebar UX polish"), and
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

/**
 * The folder id for a human-written path like "Projects/Kybase", matched
 * case-insensitively and forgiving of leading/trailing slashes.
 *
 * Exists so a caller with a path in hand does not have to fetch the whole
 * folder tree just to translate it into a UUID — the round-trip every
 * folder-scoped search used to start with. Throws with real examples rather
 * than returning null: a mistyped path that silently searched the whole vault
 * would look like a working search with wrong results.
 */
async function folderIdFromPath(folderPath: string): Promise<string> {
  const paths = await folderPathMap();
  const norm = (p: string) => p.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  const wanted = norm(folderPath);
  for (const [id, p] of paths.entries()) if (norm(p) === wanted) return id;
  const available = Array.from(paths.values()).filter(Boolean).slice(0, 10).join('", "');
  throw new Error(`Folder path "${folderPath}" not found. Available folders include: "${available}"`);
}

/**
 * What search_notes says when its query is missing or empty. The rule is not
 * the interesting part — where to go instead is, and an agent that wanted
 * "every note tagged X" would otherwise read a type error and give up on the
 * whole idea rather than move one tool over.
 */
const QUERY_REQUIRED =
  'query is required — search ranks text against text. To list or filter notes by folder, tag or ' +
  'recency with no keywords, use list_notes instead.';

/**
 * Whether more hits exist past this page, and where the next one starts.
 *
 * Shipped as a flag rather than a total: the only number a hybrid search
 * could give is its own capped candidate pool, and for the semantic arm
 * "how many match" has no answer at all — every note has a vector. A capped
 * pool size named total_hits would be read as a fact about the vault. What a
 * caller needs is whether five hits were five of five or five of many.
 */
function morePage(hasMore: boolean, limit: number, offset: number) {
  return hasMore ? { has_more: true, next_offset: offset + limit } : { has_more: false };
}

/**
 * A JSON-Schema fragment the zod shape itself cannot express, merged into the
 * schema this tool publishes.
 *
 * "id or title" is the case that forced this: every address-taking tool
 * enforces it at runtime, but server.tool() derives `required` from the shape
 * alone, where both fields are optional — so the rule reached the client as
 * nothing at all and the call failed a network round trip later than it had
 * to. registerTool() takes a whole ZodObject, so .meta() rides into the
 * emitted schema. The handler's own throw stays the authority; this only
 * lets a validating client catch the same mistake first.
 *
 * $schema is pinned to draft-07 because registerTool would otherwise emit
 * 2020-12, and a surface that declares two dialects across eighteen tools is
 * a worse thing to ship than the pin.
 */
function withSchemaRule<T extends z.ZodRawShape>(shape: T, rule: Record<string, unknown>) {
  return z.object(shape).meta({ $schema: 'http://json-schema.org/draft-07/schema#', ...rule });
}

/** Addressed by either field, never neither — get_note and everything shaped like it. */
const ID_OR_TITLE = { anyOf: [{ required: ['id'] }, { required: ['title'] }] };

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
  // Text and slug are matched together, not one after the other, and the
  // question asked is how many HEADINGS the string picks out — not whether
  // some heading matches it.
  //
  // A note repeating a heading — "Setup" under both Windows and Linux — is
  // ordinary, not pathological, and taking the first match was the one failure
  // in this file that silently wrote to the wrong place:
  // an append aimed at section "Setup" landed under Windows when Linux was
  // meant, with nothing in the response suggesting a choice had been made.
  //
  // Matching in two passes does NOT fix that, which is worth recording because
  // it looks like it should: the first duplicate's slug ("setup") is its own
  // lowercased text, so a slug-first pass resolves the ambiguous string before
  // any ambiguity check runs. Only the union answers correctly. The later
  // duplicates keep distinct slugs ("setup-2") and stay addressable; the first
  // one does not, and the error says so rather than guessing.
  const matched = headings.filter(h => norm(h.text) === wanted || norm(h.slug) === wanted);
  let i = matched.length === 1 ? headings.indexOf(matched[0]) : -1;
  if (matched.length > 1) return null;
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

/**
 * Why a section did not resolve, and what to pass instead.
 *
 * Lists every heading as "text (slug)" rather than text alone, because the
 * text is not always an answer: when a note repeats a heading, the slug is the
 * only thing that picks one of them, and a caller refused for ambiguity needs
 * the handle that resolves it — not the ambiguous name repeated back.
 */
function sectionNotResolved(section: string, headings: Heading[]): string {
  const available = headings.map(h => `${h.text} (${h.slug})`).join(' | ') || '(this note has no headings)';
  return `No single section matches "${section}" in this note — it is missing, or it picks out more than one heading. ` +
    `Repeated headings are addressable by their distinct slugs ("setup-2"); the FIRST of a repeated pair is not, ` +
    `because its slug is the same ambiguous string — rename it, or read the note and use offset/limit. ` +
    `Refusing rather than choosing: writing to the wrong section cannot be undone by the caller noticing later. ` +
    `Available: ${available}`;
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
    throw new Error(sectionNotResolved(section, headings));
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

/** Shape every tool handler returns; enough of it to log an outcome. */
type ToolReply = { isError?: boolean; content?: { text?: string }[] };

/**
 * One stderr line per tool call: what was called, whether it worked, how much
 * came back, how long it took.
 *
 * Nothing on this path used to log at all, which made every "how often does
 * this actually happen" question unanswerable — the size of a reply, the rate
 * of refusals and which tools agents reach for were all invisible to the
 * person running the server. `docker logs` is where that belongs.
 *
 * Wrapped at the server rather than at each registration so a tool added
 * later is logged without anyone remembering to, and so the eighteen call
 * sites below stay about the tools instead of about logging.
 *
 * Deliberately never logs arguments or reply text — a query string and a note
 * body are the two things most worth not writing to a log file. Length is the
 * part that answers the question. stderr, because in stdio mode stdout
 * carries JSON-RPC framing and nothing else.
 */
function logToolCalls(server: McpServer): void {
  const wrap = (register: (...a: unknown[]) => unknown) => (...args: unknown[]) => {
    const name = String(args[0]);
    const last = args.length - 1;
    const handler = args[last];
    if (typeof handler === 'function') {
      const inner = handler as (...a: unknown[]) => Promise<ToolReply>;
      args[last] = async (...callArgs: unknown[]): Promise<ToolReply> => {
        const started = Date.now();
        const done = (outcome: string, chars: number) =>
          console.error(`[mcp] ${name} ${outcome} ${chars}ch ${Date.now() - started}ms`);
        try {
          const reply = await inner(...callArgs);
          const chars = reply?.content?.reduce((n, c) => n + (c.text?.length ?? 0), 0) ?? 0;
          done(reply?.isError ? 'error' : 'ok', chars);
          return reply;
        } catch (err) {
          // A throw becomes an isError reply one layer up, so it is the same
          // event to a caller and has to read the same way here — including
          // its size. A refusal that lists every heading in a note is not a
          // cheap reply, and a log that called every error 0ch would hide
          // exactly the ones worth finding.
          done('error', err instanceof Error ? err.message.length : 0);
          throw err;
        }
      };
    }
    return register.apply(server, args);
  };
  const s = server as unknown as Record<string, (...a: unknown[]) => unknown>;
  s.tool = wrap(s.tool.bind(server));
  s.registerTool = wrap(s.registerTool.bind(server));
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'kybase', version: '1.0.0' },
    {
      instructions:
        'Kybase is a personal knowledge base of interlinked markdown notes. Notes reference ' +
        'each other with [[Title]] wikilinks; those links form the knowledge graph.\n\n' +
        'When creating a note or substantially rewriting one:\n' +
        '1. First call search_notes with the note\'s topic to find related existing notes.\n' +
        '2. If genuinely related notes exist, include [[wikilinks]] to the 2-5 most relevant ones in the ' +
        'note body — inline where natural, or as a final "Related: [[A]], [[B]]" line.\n' +
        '3. Copy linked titles VERBATIM from any tool result in this conversation. Never write a ' +
        '[[link]] to a title you have not seen in one — invented ' +
        'or misremembered titles produce broken links. A write that introduces one comes back ' +
        'with `unresolved_links` naming it — fix it there, not hours later.\n' +
        '4. Do not force links: if nothing is related, create the note without any.\n\n' +
        'Tagging: new tags are lowercase, kebab-case, and follow the language already in use. Call ' +
        'list_tags first and reuse an existing tag when one fits, rather than coining a duplicate.\n\n' +
        'To add to a note use append_to_note, not update_note: resending whole content to add a ' +
        'paragraph costs the note twice and overwrites what another session wrote meanwhile. When ' +
        'you do rewrite whole content, pass the updated_at you read as expected_updated_at.\n\n' +
        'Paging: `limit` and `offset` count whatever that tool returns — characters in get_note, ' +
        'hits in search_notes, notes in list_notes, linking notes in get_backlinks. A partial reply ' +
        'always says so, in one of three ways: `has_more` with `next_offset` when there is another ' +
        'page but no honest total; `total` above the rows you got when the real count is knowable; ' +
        '`truncated: true` when a ceiling cut the reply, which means narrow the request rather than ' +
        'raise the ceiling. None of the three present means you have everything there is.\n\n' +
        // Lives here, not in search_notes: it governs every tool that ranks or
        // walks rather than reads, and a rule repeated in three descriptions is
        // paid for in every request instead of once per session.
        'Retrieval is not an answer. search_notes, get_neighbors and get_backlinks return ' +
        'candidates. Before stating something as fact, quote the text you actually read — a ' +
        'relevance value, a similarity or a rerank score is never evidence that a note says what ' +
        'you asked.',
    }
  );

  // Before any registration below — it wraps the registration methods.
  logToolCalls(server);

  // ── list_notes ───────────────────────────────────────────────────────────
  server.tool(
    'list_notes',
    'List notes newest first, filtered by folder, tag or date. This is the tool for "what is new" ' +
    'and "what changed lately": search_notes ranks by relevance and never by recency.\n\n' +
    'created_* is when a note was made, updated_* when its own text last changed — a rename ' +
    'elsewhere rewriting a [[link]] inside it does not count as an edit here. Each row carries ' +
    'content_length, so you can tell a long note from a short one before spending a get_note call. ' +
    'With trashed:true the other filters are ignored.',
    {
      folder_id: uuid().optional().describe('Filter by folder UUID — that folder itself, not its subfolders'),
      folder_path: z.string().optional()
        .describe('Same filter by path (e.g. "Projects/Kybase") instead of UUID — that folder itself, not its subfolders'),
      tag:       z.string().optional().describe('Filter by tag'),
      created_after:  z.string().optional().describe('ISO timestamp — only notes created at or after this'),
      created_before: z.string().optional().describe('ISO timestamp — only notes created at or before this'),
      updated_after:  z.string().optional().describe('ISO timestamp — only notes whose own content actually changed at or after this'),
      updated_before: z.string().optional().describe('ISO timestamp — only notes whose own content actually changed at or before this'),
      sort:      z.enum(['created', 'updated']).default('updated').describe('Which date drives the ordering'),
      limit:     z.number().int().min(1).max(200).default(20)
        .describe('Maximum notes to return per page. Applies in trashed mode too'),
      offset:    z.number().int().min(0).default(0)
        .describe('Skip this many notes — pass back next_offset from the previous page'),
      trashed:   z.boolean().default(false).describe('List soft-deleted notes instead of live ones'),
    },
    async ({ folder_id, folder_path, tag, created_after, created_before, updated_after, updated_before, sort, limit, offset, trashed }) => {
      // Same either/or as search_notes: two spellings of one filter, and
      // accepting both would leave the caller guessing which one won.
      if (folder_id && folder_path) throw new Error('Provide either folder_id or folder_path, not both');
      // limit + 1 rather than a second count(*): the only question the caller
      // has is "is there more", and one extra row answers it for the cost of
      // one extra row. Both branches build the same envelope — a shape that
      // changed between trashed and live modes would be a worse trap than the
      // bare array it replaces.
      if (trashed) {
        const rows = await query<{ id: string; title: string; folder_id: string | null; deleted_at: string }>(
          'select id, title, folder_id, deleted_at from notes where deleted_at is not null order by deleted_at desc limit $1 offset $2',
          [limit + 1, offset]
        );
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ notes: rows.slice(0, limit), ...morePage(rows.length > limit, limit, offset) }),
          }],
        };
      }

      const conds: string[] = ['deleted_at is null'];
      const params: unknown[] = [];
      const folderId = folder_path ? await folderIdFromPath(folder_path) : folder_id;
      if (folderId) { params.push(folderId); conds.push(`folder_id = $${params.length}`); }
      if (tag)       { params.push([tag]);     conds.push(`tags @> $${params.length}`); }
      if (created_after)  { params.push(created_after);  conds.push(`created_at >= $${params.length}`); }
      if (created_before) { params.push(created_before); conds.push(`created_at <= $${params.length}`); }
      // content_updated_at, not updated_at: a rename elsewhere rewriting a
      // [[link]] inside this note still moves updated_at (expected_updated_at's
      // guard needs that), but must not make this note look freshly edited —
      // see migration 020.
      if (updated_after)  { params.push(updated_after);  conds.push(`content_updated_at >= $${params.length}`); }
      if (updated_before) { params.push(updated_before); conds.push(`content_updated_at <= $${params.length}`); }
      params.push(limit + 1);
      const limitParam = params.length;
      params.push(offset);
      const offsetParam = params.length;
      // sort is a fixed 2-value enum from zod, not user-supplied text — safe
      // to interpolate as a column name.
      const orderCol = sort === 'created' ? 'created_at' : 'content_updated_at';
      const [rows, paths] = await Promise.all([
        query<{ id: string; title: string; folder_id: string | null; tags: string[]; created_at: string; updated_at: string; content_updated_at: string; content_length: number }>(
          `select id, title, folder_id, tags, created_at, updated_at, content_updated_at, length(content) as content_length from notes
           where ${conds.join(' and ')}
           order by ${orderCol} desc limit $${limitParam} offset $${offsetParam}`,
          params
        ),
        folderPathMap(),
      ]);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            notes: rows.slice(0, limit).map((n) => withFolderPath(n, paths)),
            ...morePage(rows.length > limit, limit, offset),
          }),
        }],
      };
    }
  );

  // ── get_note ─────────────────────────────────────────────────────────────
  server.registerTool(
    'get_note',
    {
      description:
    'Read one note, by id or title.\n\n' +
    // Both limits stay, and stay apart: a `+` between two interpolated
    // template literals drops the left one's trailing text in the Next build,
    // which once shipped "default 200004000 chars" to every agent.
    `- Long notes come back windowed — ${DEFAULT_CONTENT_LIMIT} chars by default: check ` +
    '`content_truncated` and pass `next_offset` back as `offset` for the rest. A windowed reply ' +
    'carries `headings` — the H1–H3 outline with character offsets — so name one in `section` to ' +
    'get that heading and its body alone instead of paging through the note.\n' +
    '- `resolve_links:true` also returns the notes this one links to, id/title only unless you add ' +
    `include_content:true, whose text is capped at ${LINKED_NOTE_CONTENT_LIMIT} chars — call get_note on ` +
    'an id for the whole of one. Targets that match no note are listed as unresolved.\n' +
    '- Pass the `updated_at` you read back as `expected_updated_at` when you write. ' +
    '`content_updated_at` is the one that moves only on a real edit to this note: a rename ' +
    'elsewhere rewriting a [[link]] inside it touches `updated_at` but not that.',
      inputSchema: withSchemaRule({
      id:      uuid().optional()
        .describe('The note\'s UUID. Live notes only — a trashed note is not found until restore_note brings it back'),
      title:   z.string().optional()
        .describe('Alternative to id: exact match first, then unique prefix, then unique substring. An ambiguous title comes back as the candidate list to retry with'),
      section: z.string().optional()
        .describe('Return only this section (heading text or slug, case-insensitive) and its body'),
      offset:  z.number().int().min(0).default(0).describe('Character offset into content to start from'),
      limit:   z.number().int().min(1000).max(200_000).default(DEFAULT_CONTENT_LIMIT)
        .describe('Max characters of content to return'),
      resolve_links:   z.boolean().default(false)
        .describe('Also resolve [[wikilinks]] inside the note one level deep'),
      include_content: z.boolean().default(false)
        .describe('With resolve_links: include full text of linked notes, not just id/title/folder_path'),
      }, ID_OR_TITLE),
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
          throw new Error(sectionNotResolved(section, headings));
        }
        // offset/limit now page within the section, not the whole note.
        body = { ...data, content: data.content.slice(range.start, range.end) };
        // The caller already named the section they want — the rest of the
        // note's outline is dead weight here, and could outweigh the section
        // body itself (measured: ~967 content chars vs
        // ~2500 headings chars on one real note). Scope to headings that
        // fall within the section, re-based to the section's own start so
        // they stay usable as the next `offset` — offset/limit above already
        // switched to that same section-local coordinate system.
        responseHeadings = headings
          .filter(h => h.offset >= range.start && h.offset < range.end)
          .map(h => ({ ...h, offset: h.offset - range.start }));
      }
      const windowed = withFolderPath(windowContent(body, offset, limit), paths);
      // The outline earns its place only where the text cannot serve as one.
      // On a whole note every `## Heading` line is already in `content`,
      // verbatim and in order, so shipping the parsed outline alongside pays
      // twice for the same knowledge. It stays in the three cases where it is
      // the only source: a windowed reply (what did not arrive is invisible
      // otherwise), a `section` reply (the caller is navigating by heading),
      // and a note that repeats a heading text — there the slug is the only
      // way to name the second one, and the slug appears nowhere in the
      // note's own text.
      const repeatedHeadingText = new Set(headings.map((h) => h.text)).size !== headings.length;
      const includeHeadings = windowed.content_truncated || section !== undefined || repeatedHeadingText;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...windowed,
            ...(includeHeadings ? { headings: responseHeadings } : {}),
            ...linkFields,
          }),
        }],
      };
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
      title:       z.string().trim().min(1).max(500)
        .describe('Unique across live notes, case-insensitively; a clash is refused rather than merged. This is the string other notes link to as [[Title]]'),
      content:     z.string().max(MAX_NOTE_CONTENT_CHARS).default('')
        .describe('Markdown body. Empty by default, so a note can be created first and filled with append_to_note'),
      folder_id:   uuid().nullable().optional()
        .describe('Folder UUID. Omit or pass null for the vault root; use folder_path instead when you have the path rather than the id'),
      folder_path: z.string().optional()
        .describe('Folder path (e.g. "Projects/Kybase") as alternative to folder_id'),
      tags:        z.array(z.string()).default([])
        .describe('Tags for the new note: lowercase, kebab-case, in the language already in use. Call list_tags first and reuse an existing tag where one fits'),
    },
    async ({ title, content: rawContent, folder_id: rawFolderId, folder_path, tags }) => {
      if (rawFolderId && folder_path) {
        throw new Error('Provide either folder_id or folder_path, not both');
      }
      const paths = await folderPathMap();
      let folder_id = rawFolderId ?? null;
      if (folder_path) {
        try {
          folder_id = await folderIdFromPath(folder_path);
        } catch (err) {
          // A writer that names a folder which does not exist can simply make
          // it, which a reader cannot — so this path keeps that hint.
          throw new Error(`${(err as Error).message} (or create it with create_folder)`);
        }
      }
      const content = stripNulBytes(rawContent);
      // Echoing the content back would double its cost for nothing — the
      // caller just sent it and knows what it is. length(content) lets it
      // confirm the write landed intact without paying for the text again.
      let note: { id: string; title: string; folder_id: string | null; tags: string[]; created_at: string; content_length: number } | null;
      try {
        note = await queryOne<{ id: string; title: string; folder_id: string | null; tags: string[]; created_at: string; content_length: number }>(
          `insert into notes (title, content, folder_id, tags, embedding_pending)
           values ($1, $2, $3, $4, true)
           returning id, title, folder_id, tags, created_at, length(content) as content_length`,
          [title, content, folder_id, tags]
        );
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
      id:        uuid()
        .describe('The note\'s UUID. Live notes only; a note in the trash has to be restored before it can be edited'),
      title:     z.string().trim().min(1).max(500).optional()
        .describe('New title. Renaming rewrites every [[link]] pointing here in other notes'),
      content:   z.string().max(MAX_NOTE_CONTENT_CHARS).optional()
        .describe('Replaces the whole body. To add to a note use append_to_note, to change part of one use replace_in_note — both leave the rest untouched'),
      folder_id: uuid().nullable().optional()
        .describe('Move the note to this folder; null moves it to the vault root. Omit to leave it where it is'),
      tags:      z.array(z.string()).optional()
        .describe('Replaces the entire tag list — anything left out is removed. To add one tag, send the existing tags plus the new one'),
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
          // sync with the new title. Only fix it
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
    'and running lists. A blank line separates your text from what was there. The note is locked ' +
    'for the read-modify-write, so two sessions appending at the same moment keep both additions ' +
    'instead of the later one overwriting the earlier. Re-embeds in the background like any ' +
    'content change.',
    {
      id:      uuid().optional().describe('The note\'s UUID. Alternative to title'),
      title:   z.string().optional().describe('Alternative to id; resolved like get_note'),
      content: z.string().min(1).max(MAX_NOTE_CONTENT_CHARS)
        .describe('Text to add. Trailing whitespace is trimmed and a blank line is inserted before it, so the addition never runs into the preceding paragraph'),
      section: z.string().optional()
        .describe('Target this section (heading text or slug) instead of the whole note. Valid values come from a search hit\'s `section`, get_note\'s `headings`, or a heading line in the note\'s own text — the slug form is only needed when two headings share a text'),
      at: z.enum(['note_end', 'note_start', 'section_end', 'section_start', 'before_section', 'after_section'])
        .optional()
        .describe(
          'Where the text lands. Defaults to section_end when section is given, else note_end. ' +
          'note_end: the very end. ' +
          'note_start: above the first heading nested under the opening one — NOT offset 0, except ' +
          'on a note with no headings at all, where it is; on a note whose only heading is the ' +
          'opening one it falls to the end instead. ' +
          'before_section: above the section\'s own heading line. ' +
          'section_start: directly under that heading line, above the section\'s body. ' +
          'section_end: after the section and everything nested inside it. ' +
          'after_section: the same position as section_end. ' +
          'The four section-relative values require `section` and are refused without it.'
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
  server.registerTool(
    'replace_in_note',
    {
      description:
    'Replace exact text in a note without resending the rest. Either find/replace or ' +
    'old_string/new_string — the same pair, either spelling.\n\n' +
    'For several replacements pass `edits` rather than the singular fields (one lock and one ' +
    're-embed for the batch, not one per call); the two forms cannot be combined in one call. ' +
    'Edits apply in order, and each `find` is matched against the note as the edits before it ' +
    'already changed it — an earlier edit can create the text a later one needs, or destroy it, so ' +
    'sequence them. If any step\'s count is wrong the whole batch is refused and the note is left ' +
    'untouched, and the error names the failing index.',
      // Two independent requirements, so allOf rather than one anyOf: a call
      // has to name a note AND carry at least one edit. Nine optional fields
      // with no rule at all made the empty call schema-valid, and the server
      // then refused it three different ways depending on which half was
      // missing. The mutual exclusion of `edits` and the singular fields is
      // deliberately NOT expressed here — it is a conflict between two valid
      // forms, and the handler's message names which one it took.
      inputSchema: withSchemaRule({
      id:      uuid().optional().describe('The note\'s UUID. Alternative to title'),
      title:   z.string().optional().describe('Alternative to id; resolved like get_note'),
      ...editItemShape,
      expected_count: z.number().int().min(1).optional()
        .describe('How many times `find` is expected to occur (default 1). The edit is refused if the real count differs, so a loose `find` cannot quietly rewrite more than intended'),
      edits: z.array(z.object(editItemShape)).min(1).max(50).optional()
        .describe('Multiple find/replace steps applied in order in a single call — see main description.'),
      expected_updated_at: z.string().optional()
        .describe('ISO updated_at from when you read the note; refuses the write if it changed since'),
      }, {
        allOf: [
          { anyOf: [{ required: ['id'] }, { required: ['title'] }] },
          { anyOf: [{ required: ['edits'] }, { required: ['find'] }, { required: ['old_string'] }] },
        ],
      }),
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
    { id: uuid()
      .describe('The note\'s UUID. An unknown or already-trashed id is refused rather than reported as deleted') },
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
    { id: uuid()
      .describe('UUID of a note currently in the trash — the same id delete_note was given') },
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
  //.
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
    // Same "only ever true" rule: this note lists your question without
    // answering it, so its match is about the string, not the content.
    if (r.question_echo) out.question_echo = true;
    // The note's own text is current; only its vectors are still rebuilding,
    // so this excerpt may be from the previous version. get_note returns the
    // live text.
    //
    // Both of these carry their own instruction rather than relying on the
    // tool description to have explained them in advance: the rule costs
    // nothing on the responses where the condition never fires, which is
    // nearly all of them, instead of riding in every request forever.
    if (r.index_pending) {
      out.index_pending = true;
      out.hint = 'Excerpt is from a previous version of this note; read it with get_note before quoting.';
    }
    if (r.section) out.section = r.section;
    if (r.content_length !== undefined) out.content_length = r.content_length;
    // Where the excerpt sits, for a note long enough that reading it whole is
    // not an option. Absent on short notes and whenever the position could not
    // be established exactly.
    if (r.excerpt_offset !== undefined) out.excerpt_offset = r.excerpt_offset;
    // Shipped without explain, unlike the raw arm scores: when a cross-encoder
    // reordered the page, this is the number that decided the order the
    // caller is reading, and the order is not explainable from the other
    // fields. Absent whenever reranking did not run.
    if (r.rerank_score !== undefined) out.rerank_score = round3(r.rerank_score);
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
    // Kept deliberately short. Everything here is a rule the caller can act on
    // with a field name to act through; what a field MEANS travels with the
    // field (toDisplayResult's hints), and what applies to more than this tool
    // lives in the server instructions. Algorithm internals — rank fusion, the
    // cross-encoder, how coverage is derived — are not here at all: they change
    // no decision a caller makes, and this text is re-sent on every request.
    'Search notes: hybrid (keyword + meaning) by default. Returns ranked excerpts, not whole notes.\n\n' +
    '- Use type="text" for an exact identifier, filename, code symbol or quoted phrase; "hybrid" ' +
    'for questions and topics.\n' +
    '- READ THE SECTION, NOT THE NOTE. A hit\'s `section` is the heading its excerpt came from — ' +
    'pass that string to get_note\'s `section` to get that part alone. If a long hit has no ' +
    '`section`, get_note with limit:1000 returns its `headings` outline; pick one and re-read with ' +
    '`section`. For prose without headings, a hit\'s `excerpt_offset` goes to get_note as `offset`.\n' +
    '- A hit is a candidate, not an answer. `relevance` is relative to the best hit in this ' +
    'response, so the top result always reads 1.0 — an ordering, not a verdict; `best_score` is ' +
    'that hit\'s own raw similarity. `matched_by` says which arms found it: semantic_score ' +
    'alone means "about something similar", never that it confirms your question. Quote the excerpt ' +
    'or open the note — a score is never evidence. `exact:true` means the query occurs verbatim in ' +
    'that note; `text_tier` of "or" or "substring" means the strict words missed and a looser pass ' +
    'filled in — recall, not confirmation.\n' +
    '- Dates here filter, they do not rank. For "what changed lately" use list_notes, which sorts ' +
    'by recency; it is also how you browse by folder or tag, since a query is required here.\n' +
    '- `has_more` with `next_offset` pages the results.',
    {
      // The message matters more than the rule: an agent that wanted "every
      // note tagged X" hits this and needs to be told where that lives, not
      // that a string was expected.
      query:          z.string({ error: QUERY_REQUIRED }).min(1, QUERY_REQUIRED)
        .describe('What to look for: words or a question for hybrid/semantic, an exact identifier, path or phrase for type "text"'),
      type:           z.enum(['text', 'semantic', 'hybrid']).default('hybrid')
        .describe('"hybrid" fuses keyword and meaning-based matching and is the right default; "text" is keyword-only and exact; "semantic" is meaning-only'),
      limit:          z.number().int().min(1).max(50).default(5)
        .describe('Hits per page. Prefer has_more with offset over asking for one large page'),
      offset:         z.number().int().min(0).default(0)
        .describe('Skip this many hits — with has_more in the response, how you read past the first page'),
      folder_id:      uuid().optional().describe('Restrict to notes in this folder itself, not its subfolders'),
      folder_path:    z.string().optional()
        .describe('Same restriction by path (e.g. "Projects/Kybase") instead of UUID — that folder itself, not its subfolders'),
      tag:            z.string().optional().describe('Restrict to notes with this tag'),
      created_after:  z.string().optional().describe('ISO timestamp — only notes created at or after this'),
      created_before: z.string().optional().describe('ISO timestamp — only notes created at or before this'),
      updated_after:  z.string().optional().describe('ISO timestamp — only notes whose own content actually changed at or after this'),
      updated_before: z.string().optional().describe('ISO timestamp — only notes whose own content actually changed at or before this'),
      rerank:         z.boolean().default(true)
        .describe('Set false to skip the cross-encoder and answer from the fused order — several times faster, and not measurably worse. Applies to type "hybrid" only: text and semantic never rerank, and this flag changes nothing there'),
      explain:        z.boolean().default(false).describe('Include raw per-arm scores and created_at for debugging ranking'),
    },
    async ({ query: q, type, limit, offset, folder_id, folder_path, tag, created_after, created_before, updated_after, updated_before, rerank, explain }) => {
      if (folder_id && folder_path) throw new Error('Provide either folder_id or folder_path, not both');
      const filters = {
        folderId: folder_path ? await folderIdFromPath(folder_path) : folder_id,
        tag,
        createdAfter: created_after, createdBefore: created_before,
        updatedAfter: updated_after, updatedBefore: updated_before,
      };
      // One run through the same entry point the UI and REST use, with the
      // diagnostics of that same execution — rather than three direct calls
      // plus a second embedding of the query (bestSemanticScore) that ran
      // unfiltered and could report a best score from outside the folder the
      // caller asked about.
      let results: SearchResult[];
      let diagnostics: SearchDiagnostics;
      try {
        ({ results, diagnostics } = await searchWithDiagnostics(q, { mode: type, limit, offset, filters, rerank, explain }));
      } catch (err) {
        // Every arm is down. An empty result list here would be a claim about
        // the vault; this is a claim about the service.
        if (err instanceof SearchUnavailableError) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'search_unavailable',
              message: 'No search backend is currently answering — this is a service failure, not an empty vault.',
              arms_unavailable: err.failures,
            }, null, 2) }],
          };
        }
        throw err;
      }

      const displayResults = results.map((r) => toDisplayResult(r, explain));

      if (type === 'text') {
        // Always {results: [...]}, same top-level shape as hybrid/semantic
        // below — a caller no longer needs a type-keyed branch just to read
        // the hit list (found independently by both an
        // external audit and an independent-agent test).
        return { content: [{ type: 'text' as const, text: JSON.stringify({
          results: displayResults,
          ...morePage(diagnostics.has_more, limit, offset),
        }, null, 2) }] };
      }

      // best_score returned unconditionally, not just on an empty result —
      // relevance is only ever relative to the best hit IN THIS RESPONSE
      // (semanticSearch/rrfMerge), so an agent has no way to tell "a
      // confident 0.85 cosine" from "the least-bad of a weak field" without
      // this number to compare against.
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            results: displayResults,
            ...morePage(diagnostics.has_more, limit, offset),
            // null = no automatic cutoff is configured, so an empty result
            // means the index returned nothing — not that something was
            // filtered out. Reported as null rather than 0 because zero reads
            // like a measured boundary that happens to admit everything.
            threshold: diagnostics.semantic_threshold === null ? null : round2(diagnostics.semantic_threshold),
            best_score: diagnostics.best_semantic_score === null ? null : round3(diagnostics.best_semantic_score),
            pending_embeddings: diagnostics.index.pending,
            // Chunks still holding vectors from a previous embedding model.
            // They are excluded from semantic results (migration 028) rather
            // than compared against a query from a different geometry, so a
            // non-zero value here explains a thin semantic arm without the
            // agent having to guess.
            stale_generation_chunks: diagnostics.index.stale_generation,
            embedding_model: diagnostics.embedding_model,
            // Which arms actually answered. A semantic/hybrid response built
            // from the text arm alone is a degraded result, not a verdict
            // about the vault.
            arms_used: diagnostics.arms_used,
            ...(diagnostics.arms_unavailable.length > 0
              ? { arms_unavailable: diagnostics.arms_unavailable }
              : {}),
            // Whether a cross-encoder decided this order instead of rank
            // fusion. Absent on a vault with no reranker installed, so those
            // responses stay the size they were. Present and false only when
            // one is switched on and did not answer — a fault worth seeing,
            // because the results are then the un-reranked ones.
            ...(diagnostics.rerank.enabled ? { reranked: diagnostics.reranked } : {}),
          }, null, 2),
        }],
      };
    }
  );

  // ── indexing_status ──────────────────────────────────────────────────────
  server.tool(
    'indexing_status',
    // search_notes already reports pending_embeddings and
    // stale_generation_chunks on every semantic response, so this is the
    // deliberate second look, not the only way to learn the index is behind.
    'Semantic index progress: total/indexed/pending, complete=true when pending is 0. Pending notes ' +
    'are still found by text search; ones never embedded stay out of semantic results until the ' +
    'background pass reaches them.\n\n' +
    'Also names the active embedding model and the configured similarity cutoff ' +
    '(`semantic_min_similarity`, null when there is none — the default, meaning nothing is refused ' +
    'for being too dissimilar). Cosines are not comparable between models, which is why the model ' +
    'is named rather than left to be guessed from a score.',
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
    // Why to reuse a tag rather than coin a near-duplicate is in the server
    // instructions: it is a rule about writing, not about this tool.
    'Tags in use with the number of notes carrying each, most-used first. The default limit cuts ' +
    'off the one-off tail — a tag used once is not one worth reusing — so raise it to see those.',
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
    'List folders with the full path already resolved — no need to walk parent_id yourself. Pass a ' +
    'folder\'s own id as parent_id to create_folder/update_folder to nest under it. Sorted by path, ' +
    'so a page is a contiguous slice of the tree read top to bottom; the reply is ' +
    '`{folders, has_more, next_offset?}`.',
    {
      limit:  z.number().int().min(1).max(1000).default(200)
        .describe('Folders per page'),
      offset: z.number().int().min(0).default(0)
        .describe('Skip this many folders — pass back next_offset from the previous page'),
    },
    async ({ limit, offset }) => {
      // The whole tree is fetched whatever the page: a path is built from a
      // folder's ancestors, so a LIMIT in SQL would resolve the paths of a
      // page against a tree it only half has. Folders are orders of magnitude
      // fewer than notes, so the bound that matters is on the reply.
      const data = await query<FolderRow>('select id, name, parent_id from folders');
      const paths = buildFolderPathMap(data);
      // parent_id dropped: path already encodes the full chain, and creating
      // a subfolder only ever needs a folder's own id, never its parent's.
      // name stays — folder names aren't barred from containing "/", so a
      // literal one there would be indistinguishable from a path separator.
      const all = data
        .map((f) => ({ id: f.id, name: f.name, path: paths.get(f.id) ?? f.name }))
        .sort((a, b) => a.path.localeCompare(b.path));
      const page = all.slice(offset, offset + limit);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ folders: page, ...morePage(offset + page.length < all.length, limit, offset) }),
        }],
      };
    }
  );

  // ── create_folder ────────────────────────────────────────────────────────
  server.tool(
    'create_folder',
    'Create a new folder. Optionally nested under a parent.',
    {
      name:      z.string().min(1).max(255)
        .describe('Folder name. Unique among its siblings — the same name under a different parent is fine'),
      parent_id: uuid().nullable().optional()
        .describe('Parent folder UUID. Omit or pass null to create it at the top level'),
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
      id:        uuid().describe('UUID of the folder to rename or move'),
      name:      z.string().min(1).max(255).optional()
        .describe('New name. Must stay unique among this folder\'s siblings'),
      parent_id: uuid().nullable().optional()
        .describe('New parent folder UUID; null moves it to the top level. Moving a folder into its own descendant is refused'),
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
    { id: uuid()
      .describe('UUID of the folder to delete along with its subfolders. Notes inside are moved to the trash, not destroyed') },
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
  server.registerTool(
    'get_backlinks',
    {
      description:
    'Notes that link to this one via [[Title]] wikilinks, by id or title. Each comes back as ' +
    'id/title/folder_path plus a snippet around the link; include_content:true returns their full ' +
    'text instead, which is expensive when many notes link here — prefer get_note on the ids you ' +
    'actually want. offset and limit count notes, not characters.',
      inputSchema: withSchemaRule({
      id:              uuid().optional()
        .describe('UUID of the note whose incoming links you want'),
      title:           z.string().optional()
        .describe('Alternative to id; resolved like get_note (exact, then prefix, then substring)'),
      include_content: z.boolean().default(false)
        .describe('Return each linking note\'s full text instead of a snippet around the link. Expensive when many notes link here'),
      limit:           z.number().int().min(1).max(200).default(50)
        .describe('Linking notes per page. Several links from the same note count as one'),
      offset:          z.number().int().min(0).default(0)
        .describe('Skip this many linking notes — pass back next_offset from the previous page'),
      }, ID_OR_TITLE),
    },
    async ({ id, title, include_content, limit, offset }) => {
      if (!id && !title) throw new Error('Provide either id or title');
      // Backlinks are found by matching [[Title]] text in other notes'
      // content, so both paths need one lookup first to know the note's
      // real title — findNoteByTitle gives a partial/fuzzy title the same
      // exact->prefix->substring forgiveness get_note already has (and
      // throws its own "matches N notes"/"not found" error on the way).
      const noteId = id
        ? (await queryOne<{ id: string }>('select id from notes where id = $1 and deleted_at is null', [id]))?.id
        : (await findNoteByTitle<{ id: string }>(title!, 'id')).id;
      if (!noteId) throw new Error('Note not found');

      // Link occurrences come from the stored index (migration 031), so this
      // no longer loads and re-parses the content of every note that happens
      // to contain the bracket text. Several links from the same note are
      // collapsed to one result carrying the first one's surrounding text —
      // the previous shape, which callers page through.
      const [links, paths] = await Promise.all([backlinksTo(noteId), folderPathMap()]);
      const firstPerNote = new Map<string, string | null>();
      for (const l of links) {
        if (!firstPerNote.has(l.source_note_id)) firstPerNote.set(l.source_note_id, l.context);
      }

      const total = firstPerNote.size;
      const pageIds = [...firstPerNote.keys()].slice(offset, offset + limit);
      const notes = pageIds.length === 0 ? [] : await query<{ id: string; title: string; content: string; folder_id: string | null }>(
        `select id, title, ${include_content ? 'content' : "'' as content"}, folder_id
         from notes where id = any($1::uuid[]) and deleted_at is null`,
        [pageIds]
      );
      const byId = new Map(notes.map((n) => [n.id, n]));
      const results = pageIds.flatMap((nid) => {
        const n = byId.get(nid);
        if (!n) return [];
        const base = withFolderPath({ id: n.id, title: n.title, folder_id: n.folder_id }, paths);
        return [include_content
          ? { ...base, content: n.content }
          : { ...base, snippet: firstPerNote.get(nid) ?? '' }];
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

  // ── get_neighbors ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_neighbors',
    {
      description:
    'What is around ONE note in the [[wikilink]] graph, out to `depth` hops: a flat list of titles, ' +
    'no node indices to decode and no whole-vault payload. For the shape of that neighbourhood — ' +
    'which of them link to each other — use get_graph with root_title instead.\n\n' +
    'Traversal is undirected: a note linking HERE counts as much as one linked FROM here. ' +
    '`links_out`/`links_in` describe the direct relation and appear only at depth 1 — two hops out, ' +
    '"which way does the arrow point" has no answer. Each note appears once, at the shortest depth ' +
    'that reaches it.\n\n' +
    'These are links people wrote, not similarity: a note on the same subject that nobody linked is ' +
    'not here, and an empty result is a fact about the writing rather than about the topic. Rows ' +
    'carry the title, which is what get_note, get_backlinks and this tool all take.',
      inputSchema: withSchemaRule({
      id:    uuid().optional()
        .describe('UUID of the note whose surroundings you want'),
      title: z.string().optional()
        .describe('Alternative to id; resolved like get_note (exact, then prefix, then substring)'),
      depth: z.number().int().min(1).max(3).default(1)
        .describe('Hops to walk. 1 = directly linked notes; each extra hop widens the set fast'),
      limit: z.number().int().min(1).max(500).default(100)
        .describe('Maximum neighbours to return, nearest depth first. `total` still counts them all'),
      }, ID_OR_TITLE),
    },
    async ({ id, title, depth, limit }) => {
      if (!id && !title) throw new Error('Provide either id or title');
      const noteId = id
        ? (await queryOne<{ id: string }>('select id from notes where id = $1 and deleted_at is null', [id]))?.id
        : (await findNoteByTitle<{ id: string }>(title!, 'id')).id;
      if (!noteId) throw new Error('Note not found');

      const neighbors = await neighborsOf(noteId, depth);
      // Counted before the slice, or `total` would just restate how many rows
      // are below it and the caller could never tell a full neighbourhood
      // from a page of one. neighborsOf already orders by (depth, title), so
      // the prefix a limit keeps is the nearest hops, deterministically.
      const total = neighbors.length;
      const page = neighbors.slice(0, limit);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            neighbors: page.map((n) => ({
              title: n.title, depth: n.depth,
              // Only ever shipped when true — "false" on both flags is the
              // ordinary state at depth 2 and says nothing worth the bytes.
              ...(n.links_out ? { links_out: true } : {}),
              ...(n.links_in ? { links_in: true } : {}),
            })),
            total,
            ...(total > page.length ? { truncated: true } : {}),
          }),
        }],
      };
    }
  );

  // ── get_graph ─────────────────────────────────────────────────────────────
  server.tool(
    'get_graph',
    // The positional edge encoding stays, and so does the sentence explaining
    // it: this is the tool that can return hundreds of nodes, where repeating
    // a title on both ends of every edge costs more than the decoding does.
    // get_neighbors is the title-addressed answer for the common case.
    'Many notes at once and the edges between them — the heavy graph tool, and the only one that ' +
    'reaches for the whole vault. For one note\'s surroundings use get_neighbors; for who links to ' +
    'it, get_backlinks.\n\n' +
    'Nodes are `{t}` (t = title). Edges reference nodes BY POSITION in the `nodes` array: ' +
    '`edges[0] = [2, 5]` means nodes[2] links to nodes[5]. semantic_edges are undirected and come ' +
    'from embedding similarity rather than written links, with the cosine as a third number. ' +
    '`unresolved_links` are [[wikilink]] targets matching no note title — dangling, so they have no ' +
    'node index.\n\n' +
    'Unscoped this reaches for the ENTIRE vault and stops at max_nodes: `truncated: true` means you ' +
    'hold a recency-ordered prefix, NOT the shape of the vault. Scope with folder_id or ' +
    'root_title+depth rather than raising the cap.',
    {
      folder_id:        uuid().optional()
        .describe('Restrict to notes in this folder and its descendant folders'),
      root_title:       z.string().optional()
        .describe('Keep only nodes within `depth` wikilink-hops of this note — resolved like get_note: exact, then unique prefix, then unique substring, case-insensitive'),
      depth:            z.number().int().min(1).max(10).default(2)
        .describe('Hop count for root_title; ignored without it'),
      include_semantic: z.boolean().default(true).describe('Include semantic_edges at all'),
      min_score:        z.number().min(0).max(1).default(0.75)
        .describe('Cosine floor for semantic_edges — lower to see more (noisier) edges'),
      unresolved_only:  z.boolean().default(false)
        .describe('If true, return only { unresolved_links } without nodes and edges (fast check for broken links)'),
      max_nodes:        z.number().int().min(1).max(5000).default(500)
        .describe('Ceiling on nodes returned, most recently edited first. The reply says `truncated: true` when it applies — scope with folder_id or root_title instead of raising this'),
    },
    async ({ folder_id, root_title, depth, include_semantic, min_score, unresolved_only, max_nodes }) => {
      const graph = await buildGraph({
        folderId: folder_id,
        rootTitle: root_title,
        depth,
        includeSemantic: unresolved_only ? false : include_semantic,
        minScore: min_score,
        maxNodes: max_nodes,
      });
      if (unresolved_only) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ unresolved_links: graph.unresolved_links }),
          }],
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(indexedForm(graph)) }] };
    }
  );

  return server;
}
