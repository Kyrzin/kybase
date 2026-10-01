import { z } from 'zod';
import { query, queryOne } from '../db';
import { escapeLike } from '../sql';
import { extractAllWikilinks } from '../wikilinks';

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
export const uuid = () => z.string().refine((v) => UUID_RE.test(v), 'must be a UUID').meta({ format: 'uuid' });



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
export async function findNoteByTitle<T>(title: string, cols: string): Promise<T> {
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
export const DEFAULT_CONTENT_LIMIT = 20_000;
// get_note_with_links can pull in many linked notes at once — each is capped
// tighter than a standalone get_note so a handful of large linked notes
// can't blow the response budget by themselves. Call get_note on a specific
// link for its full content.
export const LINKED_NOTE_CONTENT_LIMIT = 4_000;

/**
 * What search_notes says when its query is missing or empty. The rule is not
 * the interesting part — where to go instead is, and an agent that wanted
 * "every note tagged X" would otherwise read a type error and give up on the
 * whole idea rather than move one tool over.
 */
export const QUERY_REQUIRED =
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
export function morePage(hasMore: boolean, limit: number, offset: number) {
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
export function withSchemaRule<T extends z.ZodRawShape>(shape: T, rule: Record<string, unknown>) {
  return z.object(shape).meta({ $schema: 'http://json-schema.org/draft-07/schema#', ...rule });
}

/** Addressed by either field, never neither — get_note and everything shaped like it. */
export const ID_OR_TITLE = { anyOf: [{ required: ['id'] }, { required: ['title'] }] };

export function withFolderPath<T extends { folder_id: string | null }>(
  row: T,
  paths: Map<string, string>
): T & { folder_path: string | null } {
  return { ...row, folder_path: row.folder_id ? paths.get(row.folder_id) ?? null : null };
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
export async function unresolvedWikilinksIn(text: string, selfTitle?: string): Promise<string[]> {
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
