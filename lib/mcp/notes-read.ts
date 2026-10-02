import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { query, queryOne } from '../db';
import { escapeLike } from '../sql';
import { extractAllWikilinks } from '../wikilinks';
import { extractHeadings } from '../markdown';
import { folderPathMap, folderIdFromPath } from '../folders';
import { uuid, findNoteByTitle, DEFAULT_CONTENT_LIMIT, LINKED_NOTE_CONTENT_LIMIT, morePage, withSchemaRule, ID_OR_TITLE, withFolderPath } from './shared';
import { sectionRange, sectionNotResolved, windowContent } from './text-edit';

export function registerNoteReadTools(server: McpServer): void {
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
      // limit + 1 rather than a second count(*): one extra row answers "is there
      // more". Both branches return the same envelope.
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

      // Links are resolved from the note's full content, so a `section` narrows the
      // returned `content` without narrowing which links count.
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
        // Only the headings inside the requested section, re-based to its start so
        // they work as the next section-local `offset`.
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
}
