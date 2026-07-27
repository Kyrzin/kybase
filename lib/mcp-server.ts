// lib/mcp-server.ts — MCP server factory with 14 tools
// Uses @modelcontextprotocol/sdk McpServer (high-level API)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query, queryOne, withTransaction, isUniqueViolation } from './db';
import { textSearch, semanticSearch, hybridSearch, makeExcerpt, bestSemanticScore, type SearchResult } from './search';
import { getMinSimilarity } from './embeddings';
import { indexNoteAsync } from './indexing';
import { extractAllWikilinks } from './wikilinks';
import { buildGraph } from './graph-data';

/** Escape ilike wildcards so a title containing %/_ can't widen the match. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (c) => `\\${c}`);
}

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
    `select title from notes where ${words.map((_, i) => `title ilike $${i + 1}`).join(' or ')}
     order by updated_at desc limit $${params.length}`,
    params
  );
  return rows.map((r) => r.title);
}

/** Resolve a note by title: exact, then prefix, then substring. Throws if ambiguous or missing. */
async function findNoteByTitle<T>(title: string, cols: string): Promise<T> {
  const escaped = escapeLike(title);
  const exact = await queryOne<T>(`select ${cols} from notes where title ilike $1`, [escaped]);
  if (exact) return exact;

  for (const pattern of [`${escaped}%`, `%${escaped}%`]) {
    const rows = await query<T & TitleCandidate>(
      `select ${cols} from notes where title ilike $1 order by length(title), updated_at desc limit $2`,
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
        'Searching: read each result\'s relevance/confidence to decide whether the hits suffice to ' +
        'answer or you should open a note or refine the query; fall back to the raw scores only for ' +
        'debugging.',
    }
  );

  // ── list_notes ───────────────────────────────────────────────────────────
  server.tool(
    'list_notes',
    'List notes. Optional filters: folder_id, tag, limit (max 200).',
    {
      folder_id: z.string().uuid().optional().describe('Filter by folder UUID'),
      tag:       z.string().optional().describe('Filter by tag'),
      limit:     z.number().int().min(1).max(200).default(50),
    },
    async ({ folder_id, tag, limit }) => {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (folder_id) { params.push(folder_id); conds.push(`folder_id = $${params.length}`); }
      if (tag)       { params.push([tag]);     conds.push(`tags @> $${params.length}`); }
      params.push(limit);
      const [data, paths] = await Promise.all([
        query<{ id: string; title: string; folder_id: string | null; tags: string[]; updated_at: string }>(
          `select id, title, folder_id, tags, updated_at from notes
           ${conds.length ? 'where ' + conds.join(' and ') : ''}
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
    '`offset` to fetch the rest.',
    {
      id:     z.string().uuid().optional(),
      title:  z.string().optional(),
      offset: z.number().int().min(0).default(0).describe('Character offset into content to start from'),
      limit:  z.number().int().min(1000).max(200_000).default(DEFAULT_CONTENT_LIMIT)
        .describe('Max characters of content to return'),
    },
    async ({ id, title, offset, limit }) => {
      if (!id && !title) throw new Error('Provide either id or title');
      const cols = 'id, title, content, folder_id, tags, created_at, updated_at';
      // findNoteByTitle escapes %/_ at every stage, so wildcards in a real
      // title can't widen the match beyond the step being attempted.
      const [data, paths] = await Promise.all([
        id
          ? queryOne<{ content: string; folder_id: string | null }>(`select ${cols} from notes where id = $1`, [id])
          : findNoteByTitle<{ content: string; folder_id: string | null }>(title!, cols),
        folderPathMap(),
      ]);
      if (!data) throw new Error('Note not found');
      return { content: [{ type: 'text' as const, text: JSON.stringify(withFolderPath(windowContent(data, offset, limit), paths), null, 2) }] };
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
      content:   z.string().default(''),
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
    'reuse an existing tag if one matches — do not create RU/EN duplicates.',
    {
      id:        z.string().uuid(),
      title:     z.string().trim().min(1).max(500).optional(),
      content:   z.string().optional(),
      folder_id: z.string().uuid().nullable().optional(),
      tags:      z.array(z.string()).optional(),
    },
    async ({ id, title, content, folder_id, tags }) => {
      const existing = await queryOne<{ title: string; content: string }>(
        'select title, content from notes where id = $1', [id]
      );
      if (!existing) throw new Error('Note not found');

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      if (title     !== undefined) set('title', title);
      if (content   !== undefined) set('content', content);
      if (folder_id !== undefined) set('folder_id', folder_id);
      if (tags      !== undefined) set('tags', tags);
      if (sets.length === 0) throw new Error('Provide at least one field to update');

      const changed = title !== undefined || content !== undefined;
      if (changed) sets.push('embedding_pending = true');

      params.push(id);
      let note;
      try {
        // One transaction: a rename must never land without its backlink
        // rewrite — a failure between the two leaves [[OldTitle]] links broken.
        note = await withTransaction(async (client) => {
          const { rows } = await client.query(
            `update notes set ${sets.join(', ')} where id = $${params.length}
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

  // ── delete_note ──────────────────────────────────────────────────────────
  server.tool(
    'delete_note',
    'Delete a note by id.',
    { id: z.string().uuid() },
    async ({ id }) => {
      await query('delete from notes where id = $1', [id]);
      return { content: [{ type: 'text' as const, text: `Note ${id} deleted.` }] };
    }
  );

  // ── search_notes ─────────────────────────────────────────────────────────
  server.tool(
    'search_notes',
    'Search notes. type: "text" (fast), "semantic" (meaning-based), "hybrid" (best, uses RRF). ' +
    'Hybrid is the right default; prefer type=text for exact identifiers, code fragments, or quoted ' +
    'phrases, where FTS beats meaning-matching. ' +
    'Returns short excerpts, not full notes — call get_note with the id to read a full note. ' +
    'Each result carries relevance (0..1) and confidence ("strong" | "moderate" | "weak") — one ' +
    'comparable measure of match quality: use it to decide whether the results suffice to answer, ' +
    'or whether to open a note / refine the query. It is comparable WITHIN one query\'s results, ' +
    'not across queries or models. The raw per-arm scores stay for debugging: `score` is rank ' +
    'fusion (hybrid) or the raw arm score; text_score is FTS ts_rank; semantic_score is raw cosine. ' +
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
        query<{ count: number }>('select count(*)::int as count from notes where embedding_pending = true'),
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
         from notes group by 1 order by count desc, tag`
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
    'Delete a folder. Notes inside are NOT deleted — their folder_id is set to null (they move to the top level). Child folders are cascade-deleted. To preserve organization, move notes/subfolders out first.',
    { id: z.string().uuid() },
    async ({ id }) => {
      await query('delete from folders where id = $1', [id]);
      return { content: [{ type: 'text' as const, text: `Folder ${id} deleted.` }] };
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
          'select id, title, content, folder_id from notes where content ilike $1',
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
              `select ${cols} from notes where id = $1`, [id])
          : findNoteByTitle<{ id: string; title: string; content: string; folder_id: string | null }>(title!, cols),
        folderPathMap(),
      ]);
      if (!note) throw new Error('Note not found');

      // Extract all wikilink targets
      const linkTargets = extractAllWikilinks(note.content);

      // Resolve each link by title (case-insensitive), skip self
      const resolved: Record<string, unknown>[] = [];
      const missing: string[] = [];

      await Promise.all(
        linkTargets.map(async (target) => {
          if (target.toLowerCase() === note.title.toLowerCase()) return;
          const linked = await queryOne<{ content: string; folder_id: string | null }>(
            'select id, title, content, folder_id, tags, updated_at from notes where title ilike $1',
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
