// lib/wikilinks.ts — wikilink parsing utilities

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

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

/** Return all unique target note titles found in `text`. */
export function extractAllWikilinks(text: string, knownTitles?: Set<string>): string[] {
  const targets = new Set<string>();
  for (const match of text.matchAll(WIKILINK_RE)) {
    // A same-note anchor like [[#Section]] has no title before the '#' —
    // extractWikilinkTarget yields '', which is not a real note to resolve
    // or offer to create.
    const target = extractWikilinkTarget(match[1], knownTitles);
    if (target) targets.add(target);
  }
  return [...targets];
}
