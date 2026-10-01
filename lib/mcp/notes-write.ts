import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { queryOne, queryOneAs, withTransaction, isUniqueViolation } from '../db';
import { softDeleteNote, restoreNote, TRASH_RETENTION_DAYS } from '../trash';
import { indexNoteAsync } from '../indexing';
import { updateNote, type NoteUpdate } from '../notes';
import { extractHeadings } from '../markdown';
import { MAX_NOTE_CONTENT_CHARS, stripNulBytes } from '../types';
import { folderPathMap, folderIdFromPath } from '../folders';
import { uuid, findNoteByTitle, withSchemaRule, withFolderPath, unresolvedWikilinksIn } from './shared';
import { resolveInsertOffset, insertAddition, countOccurrences, truncateForError, type AppendAt, type NoteEdit } from './text-edit';

export function registerNoteWriteTools(server: McpServer, actor: () => string): void {
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
        note = await queryOneAs<{ id: string; title: string; folder_id: string | null; tags: string[]; created_at: string; content_length: number }>(
          actor(),
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

      if (title === undefined && content === undefined && folder_id === undefined && tags === undefined) {
        throw new Error('Provide at least one field to update');
      }

      type UpdatedNote = { id: string; title: string; folder_id: string | null; tags: string[]; updated_at: string; content_length: number };
      let result: NoteUpdate<UpdatedNote> | null;
      try {
        result = await updateNote<UpdatedNote>(id, { title, content, folder_id, tags }, {
          returning: 'id, title, folder_id, tags, updated_at, length(content) as content_length',
          actor: actor(),
          expectedUpdatedAt: expected_updated_at,
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
      }, { actor: actor() });

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
      }, { actor: actor() });

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
      const deleted = await softDeleteNote(id, actor());
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
        restored = await restoreNote(id, actor());
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
}
