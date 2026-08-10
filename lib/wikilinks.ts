// lib/wikilinks.ts — wikilink parsing utilities

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Extract the target note title from a raw wikilink match.
 *   [[Title#Section|Alias]] → "Title"
 *   [[Title|Alias]]         → "Title"
 *   [[Title#Section]]       → "Title"
 *   [[Title]]               → "Title"
 */
export function extractWikilinkTarget(raw: string): string {
  return raw.split(/[#|]/)[0].trim();
}

/** Return all unique target note titles found in `text`. */
export function extractAllWikilinks(text: string): string[] {
  const targets = new Set<string>();
  for (const match of text.matchAll(WIKILINK_RE)) {
    // A same-note anchor like [[#Section]] has no title before the '#' —
    // extractWikilinkTarget yields '', which is not a real note to resolve
    // or offer to create.
    const target = extractWikilinkTarget(match[1]);
    if (target) targets.add(target);
  }
  return [...targets];
}
