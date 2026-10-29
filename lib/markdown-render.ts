// lib/markdown-render.ts — the note renderer, shared by the app UI
// (components/Editor.tsx) and the public share page (app/share/[token]).
// markdown-it with raw HTML off parses the text, so markup in a note is
// escaped by the parser rather than by a chain of replacements over HTML
// already built. Links and images pass the same allowlist as before
// (safeUrl). Apart from lib/markdown.ts so that the MCP server and the
// kybase-mcp package, which import that file, do not ship a renderer.
// This file is the XSS boundary: any change here needs matching test
// coverage before it ships.
import MarkdownIt from 'markdown-it';
import { escapeAttr, extractHeadings, safeUrl, unpairedFenceIndex } from './markdown';

const md = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false });

// Kept as the rest of Kybase reads a note: the outline, the chunker and
// get_note know only `#` headings, and four leading spaces are not code.
md.disable(['lheading', 'code']);

md.validateLink = (url: string) => safeUrl(url) === url;

// Attribute values also escape brackets: wikilinks are substituted over the
// rendered HTML (renderWithWikilinks), and a [[...]] inside an alt or title
// would put that markup's quotes into the attribute. String(): an ordered
// list's `start` arrives as a number.
md.renderer.renderAttrs = (token) =>
  (token.attrs ?? []).map(([name, value]) => ` ${name}="${escapeAttr(md.utils.escapeHtml(String(value)))}"`).join('');

// Heading ids are the slugs of the outline (extractHeadings), matched by
// line, so a section link lands where the side panel and get_note say.
md.core.ruler.push('kybase_heading_ids', (state) => {
  const ids = (state.env as { headingIds?: Map<number, string> }).headingIds;
  for (const token of state.tokens) {
    const id = token.type === 'heading_open' && token.map ? ids?.get(token.map[0]) : undefined;
    if (id) token.attrSet('id', id);
  }
});

// A list item opening with [ ] or [x] shows a box character, not a control.
md.core.ruler.push('kybase_task_items', (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const first = tokens[i].children?.[0];
    const box = first?.type === 'text' ? /^\[([ xX])\] /.exec(first.content) : null;
    if (!first || !box) continue;
    first.content = `${box[1] === ' ' ? '☐' : '☑'} ${first.content.slice(box[0].length)}`;
    tokens[i - 2].attrJoin('class', 'task');
  }
});

/** Line index of each outline heading. */
function headingIds(text: string): Map<number, string> {
  const lineAt = new Map<number, number>();
  let offset = 0;
  text.split('\n').forEach((line, i) => { lineAt.set(offset, i); offset += line.length + 1; });
  return new Map(extractHeadings(text).map((h) => [lineAt.get(h.offset)!, h.slug]));
}

export function parseMarkdown(text: string): string {
  if (!text) return '';
  // A fence that never closes stays text, as the outline and the chunker
  // read it; markdown-it would turn everything below it into code.
  const lines = text.split('\n');
  const unpaired = unpairedFenceIndex(lines);
  if (unpaired !== -1) lines[unpaired] = lines[unpaired].replace(/[\\`]/g, '\\$&');
  try {
    return md.render(lines.join('\n'), { headingIds: headingIds(text) });
  } catch (err) {
    // One note the renderer cannot handle must not take the page down with
    // it: the editor renders the open note on every load.
    console.error('[markdown] render failed, showing the text as is', err);
    return `<pre>${md.utils.escapeHtml(text)}</pre>`;
  }
}
