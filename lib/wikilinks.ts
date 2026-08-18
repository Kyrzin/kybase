// lib/wikilinks.ts — wikilink parsing utilities
import { unpairedFenceIndex } from './markdown';

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

// Inline code: one or more backticks, content without backticks, same run
// again. Covers `code` and ``code`` — a span whose content itself contains a
// backtick is not matched, which leaves a stray delimiter as ordinary text.
// That is the harmless direction: worst case a real link inside such a span
// still counts, never the reverse.
const INLINE_CODE_RE = /(`+)[^`]*?\1/g;

const blank = (s: string) => ' '.repeat(s.length);

/**
 * Blank out code spans so [[...]] written inside them is not read as a link.
 * Replaces content with spaces rather than deleting it, so every character
 * offset in the original text still lines up — a caller that wants match
 * positions keeps getting the real ones.
 *
 * Why this exists: a note documenting the link syntax (this vault has
 * several) puts `[[Title#Section]]` in a code block as an EXAMPLE. Without
 * masking, that example became a graph edge, a dangling "unresolved link"
 * with a made-up target, and — through update_wikilinks — a candidate for
 * silent rewriting when some unrelated note gets renamed.
 *
 * Fence detection mirrors lib/markdown.ts exactly: the same ^``` test and
 * the same unpairedFenceIndex, so this pass, the outline and the chunker
 * agree on where code starts and ends. A dangling fence is ordinary text
 * here too — treating it as an opener would hide every link below it.
 *
 * Indented (4-space) code blocks are deliberately NOT masked: in this
 * codebase's own notes, 4-space indentation is far more often a nested list
 * item than a code block, and masking those would silently drop real links.
 * The false-negative direction is the safe one.
 */
export function maskCode(text: string): string {
  const lines = text.split('\n');
  const unpaired = unpairedFenceIndex(lines);
  let inFence = false;
  return lines
    .map((line, i) => {
      if (i === unpaired) return line.replace(INLINE_CODE_RE, blank);
      if (/^```/.test(line.trim())) { inFence = !inFence; return blank(line); }
      return inFence ? blank(line) : line.replace(INLINE_CODE_RE, blank);
    })
    .join('\n');
}

/**
 * Raw inner text of every [[wikilink]] occurrence, in document order, code
 * excluded. One entry per occurrence — callers that want uniqueness dedupe
 * themselves (extractAllWikilinks does, buildWikilinkEdges deliberately does
 * not, since it counts repeats).
 *
 * The single place the link pattern lives. lib/graph.ts used to carry its
 * own copy of the same regular expression, which is exactly how one of the
 * two passes ends up fixed and the other forgotten.
 */
export function rawWikilinks(text: string): string[] {
  return [...maskCode(text).matchAll(WIKILINK_RE)].map(m => m[1]);
}

/**
 * Extract the target note title from a raw wikilink match.
 *   [[Title#Section|Alias]] → "Title"
 *   [[Title|Alias]]         → "Title"
 *   [[Title#Section]]       → "Title"
 *   [[Title]]               → "Title"
 *
 * A title that itself contains '#' or '|' (e.g. "closed CodeQL #3") is
 * genuinely ambiguous against the section/alias syntax — "Title#3" could be
 * that literal title, or "Title" plus anchor "3". There's no way to tell
 * from the raw string alone, so when the caller can supply the set of real
 * titles it's resolving against (case-insensitive), an exact full-string
 * match against a real title wins over the split — the same "prefer a real
 * thing over a guess" rule findNoteByTitle already applies for prefix
 * matches. Without `knownTitles` (e.g. building index entries with no note
 * list in hand), the split remains the only option and stays the default.
 */
export function extractWikilinkTarget(raw: string, knownTitles?: Set<string>): string {
  const full = raw.trim();
  if (knownTitles?.has(full.toLowerCase())) return full;
  return raw.split(/[#|]/)[0].trim();
}

/**
 * Point every [[Old Title]] in `text` at `newTitle`, preserving each link's
 * own `#section` / `|alias` suffix. Returns null when nothing matched, so a
 * caller can skip the write entirely.
 *
 * Replaces the regexp_replace inside the SQL update_wikilinks (migration
 * 020). Two things that function could not do:
 *
 *   1. It rewrote inside code. A note showing `[[Old Title]]` as an EXAMPLE
 *      had its example silently edited when some unrelated note was renamed
 *      — and migration 020 deliberately suppresses content_updated_at for
 *      backlink rewrites, so the edit left no trace any "what changed" query
 *      could surface. This walks the same link spans maskCode() already
 *      excludes code from.
 *   2. It matched by pattern, so the title had to be regex-escaped on the
 *      way in and the replacement backslash-escaped on the way out — two
 *      escaping layers that migrations 003 and 006 were both bug fixes for.
 *      Here the link is parsed, not matched: nothing is ever interpreted.
 *
 * One deliberate behaviour change: `[[ Old Title ]]` (padded with spaces) is
 * now rewritten too. The SQL pattern required the title to touch the
 * brackets, so a padded link was left pointing at a title that no longer
 * exists — while extractWikilinkTarget trims, meaning the link RESOLVED
 * before the rename and broke after it. Rewriting it keeps resolution and
 * rewriting consistent.
 */
export function rewriteWikilinkTarget(content: string, oldTitle: string, newTitle: string): string | null {
  const oldLower = oldTitle.trim().toLowerCase();
  if (!oldLower) return null;
  const masked = maskCode(content);
  let out = '';
  let cursor = 0;
  let hits = 0;

  for (const m of masked.matchAll(WIKILINK_RE)) {
    const start = m.index;
    const raw = content.slice(start + 2, start + m[0].length - 2);
    const split = splitAtOldTitle(raw, oldLower);
    if (!split) continue;
    out += content.slice(cursor, start) + '[[' + newTitle + split.suffix + ']]';
    cursor = start + m[0].length;
    hits++;
  }
  return hits ? out + content.slice(cursor) : null;
}

/**
 * The link's `#section`/`|alias` tail when its target is `oldLower`, else
 * null. A title containing '#' or '|' itself (e.g. "closed CodeQL #3") is
 * checked whole first, for the same reason extractWikilinkTarget prefers a
 * known title over splitting: a real thing beats a guess.
 */
function splitAtOldTitle(raw: string, oldLower: string): { suffix: string } | null {
  if (raw.trim().toLowerCase() === oldLower) return { suffix: '' };
  const i = raw.search(/[#|]/);
  if (i === -1) return null;
  return raw.slice(0, i).trim().toLowerCase() === oldLower ? { suffix: raw.slice(i) } : null;
}

/** Return all unique target note titles found in `text` (code excluded). */
export function extractAllWikilinks(text: string, knownTitles?: Set<string>): string[] {
  const targets = new Set<string>();
  for (const raw of rawWikilinks(text)) {
    // A same-note anchor like [[#Section]] has no title before the '#' —
    // extractWikilinkTarget yields '', which is not a real note to resolve
    // or offer to create.
    const target = extractWikilinkTarget(raw, knownTitles);
    if (target) targets.add(target);
  }
  return [...targets];
}
