// lib/html-to-markdown.ts — shared conversion for formats that already
// carry real semantic structure (EPUB's XHTML content documents, DOCX via
// mammoth's Heading-style → <h1>-<h6> mapping). Unlike lib/pdf-import.ts,
// nothing here is guessed from font size — the source format already says
// what's a heading, so this is just HTML→Markdown plus two adjustments:
// Kybase's note title fills the H1 slot in the UI, so every heading here
// is demoted one level (h1→h2 … h6 stays h6, already the floor) to avoid
// each chapter's own <h1> competing with the note's title.
import TurndownService from 'turndown';
import { tables } from 'turndown-plugin-gfm';

const turndown = new TurndownService({ headingStyle: 'atx' });
turndown.use(tables);

export function demoteHeadings(markdown: string): string {
  return markdown.replace(/^(#{1,6})(\s)/gm, (_match, hashes: string, space: string) => {
    const level = Math.min(hashes.length + 1, 6);
    return '#'.repeat(level) + space;
  });
}

// An EPUB chapter is a full XHTML document, <head> included — turndown has
// no notion of "not rendered", so a <title>/<meta> in there turns into a
// stray text line ahead of the real content instead of being dropped like
// a browser would. DOCX (via mammoth) never has this problem, it already
// hands back a body-only fragment — stripping a <head> that isn't there is
// a no-op, so this is safe as the shared default rather than an EPUB-only step.
function stripHead(html: string): string {
  return html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, '');
}

export function htmlToMarkdown(html: string): string {
  return demoteHeadings(turndown.turndown(stripHead(html)));
}
