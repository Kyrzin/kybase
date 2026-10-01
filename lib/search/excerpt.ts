import { query as dbQuery } from '../db';
import { TABLE_ROW_RE, TABLE_SEPARATOR_RE, unpairedFenceIndex, extractHeadings } from '../markdown';
import type { SearchResult } from './types';
import { LEGACY_EXCERPT } from './config';
import { MIN_SIGNIFICANT_WORD_LEN } from './signals';

const EXCERPT_LENGTH = 300;

// How far a cut may move to land on whitespace; long unbroken runs keep a hard cut.
const EXCERPT_SNAP_WINDOW = 24;

// Cap on content fetches per search for repairing table snippets from ts_headline.
const MAX_TABLE_REPAIR_FETCHES = 3;

/** Drops a chunk's leading `# Heading` line; the heading travels as `section`. */
export function stripLeadingHeading(content: string): string {
  return content.replace(/^\s*#{1,6}[ \t]+.*(?:\r?\n)+/, '');
}

/**
 * When `offset` lands inside a markdown table body, returns the header and
 * separator rows (ready to prepend) and where they start; otherwise null.
 * Uses the same row shapes as the markdown renderer.
 */
export function tableHeaderAbove(content: string, offset: number): { text: string; offset: number } | null {
  const lines = content.split('\n');
  const starts: number[] = [];
  let pos = 0;
  for (const line of lines) { starts.push(pos); pos += line.length + 1; }

  const i0 = starts.findIndex((s, idx) => s <= offset && (idx === lines.length - 1 || starts[idx + 1] > offset));
  if (i0 === -1 || !TABLE_ROW_RE.test(lines[i0])) return null;

  // A pipe-looking line inside a fenced code block is code, not a table.
  const unpaired = unpairedFenceIndex(lines);
  let inFence = false;
  for (let k = 0; k <= i0; k++) {
    if (k !== unpaired && /^```/.test(lines[k].trim())) inFence = !inFence;
  }
  if (inFence) return null;

  // Walk up through consecutive row-shaped lines to the top of this table.
  let i = i0;
  while (i > 0 && TABLE_ROW_RE.test(lines[i - 1])) i--;
  if (i + 1 >= lines.length || !TABLE_SEPARATOR_RE.test(lines[i + 1])) return null;

  return { text: `${lines[i]}\n${lines[i + 1]}\n`, offset: starts[i] };
}

/**
 * The line where the query's words are densest — where to centre an excerpt
 * when the query does not occur verbatim. Lexical and line-granular: it only
 * picks which part of an already chosen passage to show. Words of three or
 * more characters match as case-insensitive substrings, which tolerates
 * inflection without a stemmer. Ties go to the earlier line.
 */
export function bestPassageOffset(content: string, query: string): { start: number; end: number } | null {
  const words = [...new Set(
    query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= MIN_SIGNIFICANT_WORD_LEN)
  )];
  if (words.length === 0) return null;

  const lines = content.split('\n');
  const lower = lines.map((l) => l.toLowerCase());

  // Distinct words, weighted by length.
  const scoreOf = (hay: string) => {
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length;
    return score;
  };

  let best: { start: number; end: number; score: number } | null = null;
  let bestHeading: { start: number; end: number; score: number } | null = null;
  let offset = 0;
  for (const [i, line] of lines.entries()) {
    const score = scoreOf(lower[i]);
    if (score > 0) {
      const here = { start: offset, end: offset + line.length, score };
      // Body text beats a heading; a heading is only the fallback anchor.
      if (/^\s*#{1,6}\s/.test(line)) {
        if (!bestHeading || score > bestHeading.score) bestHeading = here;
      } else if (!best || score > best.score) {
        best = here;
      }
    }
    offset += line.length + 1;
  }
  const chosen = best ?? bestHeading;
  return chosen ? { start: chosen.start, end: chosen.end } : null;
}

/**
 * A short excerpt: one contiguous window centred on the query (or, failing a
 * verbatim match, on bestPassageOffset), cut on whitespace, with "…" where text
 * was dropped. A window opening inside a table gets the table's header row
 * prepended, taken out of the same length budget.
 */
export function makeExcerpt(content: string, query?: string, maxLen = EXCERPT_LENGTH): string {
  if (content.length <= maxLen) return content;

  let start = 0;
  let matchEnd = 0; // end of the actual match text — the tail shave below must never cut into it
  if (query) {
    const idx = content.toLowerCase().indexOf(query.toLowerCase());
    if (idx > 0) {
      start = Math.max(0, idx - Math.floor((maxLen - query.length) / 2));
      matchEnd = idx + query.length;
    } else if (idx === -1 && !LEGACY_EXCERPT) {
      const anchor = bestPassageOffset(content, query);
      if (anchor) {
        start = Math.max(0, anchor.start - Math.floor((maxLen - (anchor.end - anchor.start)) / 2));
        matchEnd = anchor.end;
      }
    }
  }
  let end = Math.min(content.length, start + maxLen);

  // Snap the start forward to just after the next whitespace, and the end back
  // to just before the last whitespace, so neither edge splits a word.
  if (start > 0) {
    const ws = content.slice(start, start + EXCERPT_SNAP_WINDOW).search(/\s/);
    if (ws !== -1) start += ws + 1;
  }

  let tableHeader = '';
  let pinnedToMatchEnd = false;
  if (start > 0) {
    const header = tableHeaderAbove(content, start);
    if (header && header.offset + header.text.length <= start) {
      tableHeader = header.text;
      const shaved = Math.max(start, end - tableHeader.length);
      // Never shave into the match itself, and then skip the end snap too.
      if (shaved < matchEnd) { end = matchEnd; pinnedToMatchEnd = true; }
      else { end = shaved; }
    }
  }

  if (end < content.length && !pinnedToMatchEnd) {
    const from = Math.max(start + 1, end - EXCERPT_SNAP_WINDOW);
    const ws = content.slice(from, end).search(/\s\S*$/); // start of the last (partial) word
    if (ws !== -1) end = from + ws;
  }

  const body = content.slice(start, end).trim();
  return tableHeader + (start > 0 ? '…' : '') + body + (end < content.length ? '…' : '');
}

export type NoteRow = { id: string; title: string; content: string; tags: string[] };

/**
 * A ts_headline snippet that looks like table cells (two or more pipes) with no
 * separator row. Not line-anchored: ts_headline crops at words, not cells.
 * Errs toward over-flagging; a false positive costs one capped fetch.
 */
function looksLikeBrokenTableExcerpt(excerpt: string): boolean {
  const pipeCount = (excerpt.match(/\|/g) ?? []).length;
  if (pipeCount < 2) return false;
  return !/\|[ \t]*:?-{2,}:?[ \t]*\|/.test(excerpt);
}

/**
 * Prepends the table header to flagged ts_headline snippets, locating each
 * snippet in its note's content. Mutates `results`; leaves a snippet as is
 * when it cannot be located.
 */
export async function repairBrokenTableExcerpts(results: SearchResult[]): Promise<void> {
  const candidates = results.filter((r) => looksLikeBrokenTableExcerpt(r.excerpt));
  if (candidates.length === 0) return;
  const toFix = candidates.slice(0, MAX_TABLE_REPAIR_FETCHES);
  if (candidates.length > toFix.length) {
    console.warn(
      `[search] table-header repair: ${candidates.length} broken excerpts this call, ` +
      `fixing only ${toFix.length} (MAX_TABLE_REPAIR_FETCHES)`
    );
  }

  const rows = await dbQuery<{ id: string; content: string }>(
    'select id, content from notes where id = any($1)',
    [toFix.map((r) => r.id)]
  );
  const contentById = new Map(rows.map((r) => [r.id, r.content]));

  for (const r of toFix) {
    const content = contentById.get(r.id);
    if (!content) continue;
    const firstLine = r.excerpt.split('\n')[0];
    const idx = content.indexOf(firstLine);
    if (idx === -1) continue;
    const header = tableHeaderAbove(content, idx);
    if (header && header.offset + header.text.length <= idx) {
      r.excerpt = header.text + r.excerpt;
    }
  }
}

// Shorter excerpt anchors are not trusted to locate a section.
const MIN_SECTION_MATCH_LEN = 8;

/**
 * Sets `section` from the heading above the excerpt's real position in the
 * note. Chunks can merge several small sections under the first one's heading,
 * so this overrides the stored chunk heading, which stays as the fallback.
 * One batched fetch; a result that cannot be located is left unchanged.
 */
export async function attachSections(results: Pick<SearchResult, 'id' | 'excerpt' | 'section'>[], query?: string): Promise<void> {
  const candidates = results
    .filter((r) => !LEGACY_EXCERPT || !r.section)
    .map((r) => ({
      r,
      pattern: r.excerpt.split('\n')[0].replace(/^(\.\.\.|…)/, '').replace(/(\.\.\.|…)$/, '').trim(),
    }))
    .filter((c) => c.pattern.length >= MIN_SECTION_MATCH_LEN);
  if (candidates.length === 0) return;

  const rows = await dbQuery<{ id: string; content: string }>(
    'select id, content from notes where id = any($1)',
    [candidates.map((c) => c.r.id)]
  );
  const contentById = new Map(rows.map((r) => [r.id, r.content]));

  for (const { r, pattern } of candidates) {
    const content = contentById.get(r.id);
    if (!content) continue;
    const idx = content.indexOf(pattern);
    if (idx === -1) continue;
    // Take the heading above the query-relevant line, not above the window start.
    const span = content.slice(idx, idx + r.excerpt.length);
    const anchor = query && !LEGACY_EXCERPT ? bestPassageOffset(span, query) : null;
    const target = idx + (anchor?.start ?? 0);
    // The last heading at or before the target owns it, whatever its level.
    const headings = extractHeadings(content);
    let heading: string | null = null;
    for (const h of headings) {
      if (h.offset > target) break;
      heading = h.text;
    }
    if (heading) r.section = heading;
  }
}
