// lib/html-to-markdown.ts — shared conversion for formats that already
// carry real semantic structure (EPUB's XHTML content documents, DOCX via
// mammoth's Heading-style → <h1>-<h6> mapping). Unlike lib/pdf-import.ts,
// nothing here is guessed from font size — the source format already says
// what's a heading, so this is just HTML→Markdown plus one adjustment:
// Kybase's note title fills the H1 slot in the UI, so every heading here
// is demoted one level (h1→h2 … h6 stays h6, already the floor) to avoid
// each chapter's own <h1> competing with the note's title.
import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx' });

export function demoteHeadings(markdown: string): string {
  return markdown.replace(/^(#{1,6})(\s)/gm, (_match, hashes: string, space: string) => {
    const level = Math.min(hashes.length + 1, 6);
    return '#'.repeat(level) + space;
  });
}

export function htmlToMarkdown(html: string): string {
  return demoteHeadings(turndown.turndown(html));
}
