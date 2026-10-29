// lib/markdown.ts — what Kybase reads out of a note's Markdown without
// rendering it: headings and their slugs, sections, fences, table rows, and
// the escaping and URL rules the renderer (lib/markdown-render.ts) and the
// wikilink substitution below share. Imported by the MCP server and the
// kybase-mcp package, so it carries no renderer.
// Attribute values built from user text go through escapeAttr(), URLs
// through safeUrl(). Brackets are escaped too: wikilinks are substituted over
// HTML already built, and one matched inside an attribute value would put its
// own quotes there. Any change here needs matching test coverage.

export function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;')
    .replace(/\(/g, '&#40;').replace(/\)/g, '&#41;');
}

/**
 * Slug for a heading's text. A literal entity (&amp;, &lt;, &gt;) counts as
 * the character it names, so "A &amp; B" and "A & B" share a slug. Unicode
 * letters/digits survive (Cyrillic titles are the norm in real vaults);
 * everything else collapses to "-". Duplicate slugs are the CALLER's job
 * (slugDeduper), numbered in document order.
 */
export function slugifyHeading(text: string): string {
  // &amp; unescaped last: doing it first would let a literal "&amp;lt;" in
  // the source cascade into "&lt;" then "<" — a double-decode. Order doesn't
  // change the output here (everything non-alphanumeric collapses to "-"
  // below regardless), but it closes the static-analysis pattern for free.
  const slug = text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

export function slugDeduper(): (slug: string) => string {
  const seen = new Map<string, number>();
  return (slug: string) => {
    const n = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, n);
    return n === 1 ? slug : `${slug}-${n}`;
  };
}

export type Heading = {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  slug: string;
  /** Character offset of the heading line — lets a reader seek to a section. */
  offset: number;
};

/**
 * Index of a ``` that never gets closed, or -1 when every fence is paired.
 * The renderer shows a dangling marker as ordinary text; treating it as an
 * opening fence would hide every heading below it from the chunker and the
 * outline while the reader still sees them. Shared so they cannot drift apart.
 */
export function unpairedFenceIndex(lines: string[]): number {
  const fences = lines.flatMap((l, i) => (/^```/.test(l.trim()) ? [i] : []));
  return fences.length % 2 === 1 ? fences[fences.length - 1] : -1;
}

/**
 * Headings (H1–H6) of a note in document order. The renderer takes its
 * <h1>–<h6> ids from these slugs (lib/markdown-render.ts). Skips headings
 * inside fenced code blocks, as the renderer and the chunker (lib/chunking.ts)
 * do; the chunker splits sections on the same #{1,6} levels.
 */
export function extractHeadings(content: string): Heading[] {
  const out: Heading[] = [];
  const dedupe = slugDeduper();
  let inFence = false;
  const lines = content.split('\n');
  const unpaired = unpairedFenceIndex(lines);
  let offset = 0;
  for (const [i, line] of lines.entries()) {
    const lineStart = offset;
    offset += line.length + 1; // + the '\n' that split() consumed
    if (i !== unpaired && /^```/.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    // \r? before the anchor: notes imported from a vault written on Windows
    // arrive CRLF, and `.` never matches \r, so `$` could not be reached and
    // every heading in such a note was invisible here and to the chunker.
    const m = line.match(/^(#{1,6}) (.+)\r?$/);
    if (!m) continue;
    out.push({
      level: m[1].length as Heading['level'],
      text: m[2].trim(),
      slug: dedupe(slugifyHeading(m[2])),
      offset: lineStart,
    });
  }
  return out;
}

/**
 * The heading a span of `content` sits under: the one over `at` when given
 * (the line a query matched), otherwise the one holding most of the span. A
 * window or an excerpt can cross a heading, and naming it by where it starts
 * names the section it mostly is not. Null when no heading precedes it.
 */
export function sectionOfSpan(content: string, start: number, end: number, at?: number): string | null {
  const headings = extractHeadings(content);
  const headingAt = (pos: number) => {
    let text: string | null = null;
    for (const h of headings) {
      if (h.offset > pos) break;
      text = h.text;
    }
    return text;
  };
  if (at !== undefined) return headingAt(at);
  // Ties keep the earlier section.
  let current = headingAt(start);
  let best = current;
  let bestLength = -1;
  let from = start;
  for (const h of headings) {
    if (h.offset <= start) continue;
    if (h.offset >= end) break;
    if (h.offset - from > bestLength) { best = current; bestLength = h.offset - from; }
    current = h.text;
    from = h.offset;
  }
  if (end - from > bestLength) best = current;
  return best;
}

export function safeUrl(url: string): string {
  return /^(https?:|mailto:|\/|#)/i.test(url.trim()) ? url : '#';
}

// The single definition of "table row" / "separator row" — lib/search's
// excerpt table-header recovery uses these to tell a table's rows apart.
export const TABLE_ROW_RE = /^\|.*\|[ \t]*\r?$/;
export const TABLE_SEPARATOR_RE = /^\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*\r?$/;

export type WikilinkNote = { title: string };

export function renderWithWikilinks(html: string, notes: WikilinkNote[]): string {
  return html.replace(/\[\[([^\]]+)\]\]/g, (_: string, raw: string) => {
    const title = raw.split(/[|#]/)[0].trim();
    const exists = notes.some(n => n.title.toLowerCase() === title.toLowerCase());
    return `<span class="wikilink ${exists ? 'exists' : 'missing'}" data-title="${escapeAttr(title)}">[[${raw}]]</span>`;
  });
}

/**
 * The public share page renders wikilinks as dead text: the alias (or the
 * title) without brackets, no element, no data attributes. A shared note
 * must not let a visitor navigate to — or learn the existence of — any
 * other note.
 */
export function stripWikilinks(html: string): string {
  return html.replace(/\[\[([^\]]+)\]\]/g, (_: string, raw: string) => {
    const [target, alias] = raw.split('|');
    return (alias ?? target.split('#')[0]).trim();
  });
}
