import type { Heading } from '../markdown';

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
export function sectionNotResolved(section: string, headings: Heading[]): string {
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
export type NoteEdit = { find: string; replace: string; expected_count: number };

/** Keeps a mismatched `find` readable in an error message instead of dumping a whole paragraph. */
export function truncateForError(s: string, max = 80): string {
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
