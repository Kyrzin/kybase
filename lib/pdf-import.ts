// lib/pdf-import.ts — PDF → Markdown, structure-aware (not just text dump).
//
// Why this exists: pasting PDF-extracted text straight into a note gives
// chunkNote/extractHeadings nothing to work with — no headings means chunks
// split by raw size instead of section, and get_note(section:) has nothing
// to navigate. Worse, some books use a leading `#` in code-comment examples
// ("# Remove stopped containers") which extractHeadings' own H1 regex reads
// as a real markdown heading — verified live on a real book: 91 "headings",
// all fake, none of them an actual chapter title.
//
// Scope, deliberately narrow (verified live against a real 738-page book,
// not just a synthetic one): this module fixes headings and running
// header/footer noise. It does NOT attempt to fix mid-word character
// spacing some PDFs extract with ("std i o . write l n") or reconstruct
// diagrams/figures (they extract as unordered text fragments, sometimes
// literal U+FFFD) — both are real problems, but a different, fuzzier kind
// of fix than "where do headings go", and were explicitly left out of this
// pass rather than bolted on half-working.
import './pdf-polyfills'; // must run before pdfjs-dist — see that file
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export type PdfTextItem = { str: string; fontSize: number; x: number; y: number; width: number };
export type PdfPage = { items: PdfTextItem[]; height: number };
export type Line = { text: string; fontSize: number | null; y: number; wordCount: number };

/**
 * Thin I/O wrapper around pdfjs-dist — not unit tested directly (needs a
 * real PDF), kept minimal so the actual conversion logic below (pure
 * functions over plain data) can be tested without one. No `worker` option
 * is passed — the legacy Node build (pdfjs-dist/legacy/build/pdf.mjs) runs
 * parsing on the main thread by itself when nothing spawns a real Worker,
 * which is the case here (no browser, no separate worker file to point at).
 * Verified live against a 738-page real-world PDF (10s, no worker needed).
 */
export async function extractPdfPages(buffer: Buffer): Promise<PdfPage[]> {
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise;

  const pages: PdfPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: PdfTextItem[] = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const [, , c, d, x, y] = item.transform;
      items.push({ str: item.str, fontSize: Math.hypot(c, d), x, y, width: item.width });
    }
    pages.push({ items, height: viewport.height });
    page.cleanup();
  }
  return pages;
}

// A gap between two items wider than this fraction of the font size is a
// real inter-word space the extractor represented as item positioning
// instead of a literal " " character — verified against real PDFs where
// most inter-word gaps land around 0.25-0.4em. Narrower than that is
// kerning within one run, not a space.
const SPACE_GAP_EM = 0.2;

function joinLineText(items: PdfTextItem[]): string {
  let out = '';
  let prevEnd: number | null = null;
  for (const item of items) {
    if (prevEnd !== null) {
      const gap = item.x - prevEnd;
      if (gap > item.fontSize * SPACE_GAP_EM && !out.endsWith(' ') && !item.str.startsWith(' ')) out += ' ';
    }
    out += item.str;
    prevEnd = item.x + item.width;
  }
  return out.trim();
}

// Items within this many points of each other's y are the same visual line
// — small enough that two genuinely stacked lines never merge, large enough
// to absorb the sub-point rounding jitter pdf.js's transform math produces
// for items that were typeset on the same baseline.
const SAME_LINE_Y_EPSILON = 1.5;

/**
 * Groups a page's positioned text items into visual lines, top to bottom
 * (PDF y grows upward, so descending y). `fontSize` is the line's own size
 * only when every item on it shares one size (uniform) — null when sizes
 * differ, which is how isHeadingCandidate below tells a real heading line
 * apart from a normal sentence with one large emphasized word in it: both
 * can contain a big font size, but only the heading is nothing else.
 */
export function groupLines(items: PdfTextItem[]): Line[] {
  const byY = [...items].sort((a, b) => b.y - a.y);
  const lines: PdfTextItem[][] = [];
  for (const item of byY) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - item.y) <= SAME_LINE_Y_EPSILON) last.push(item);
    else lines.push([item]);
  }
  return lines.map((lineItems) => {
    const sorted = [...lineItems].sort((a, b) => a.x - b.x);
    const sizes = new Set(sorted.map((i) => Math.round(i.fontSize * 100) / 100));
    const text = joinLineText(sorted);
    return {
      text,
      fontSize: sizes.size === 1 ? [...sizes][0] : null,
      y: sorted[0].y,
      wordCount: text.split(/\s+/).filter(Boolean).length,
    };
  }).filter((l) => l.text.length > 0);
}

/** Body text font size: the modal size by character count, not line count — a few short headings must not outvote a page of body text. */
export function bodyFontSize(pages: PdfPage[]): number {
  const charsBySize = new Map<number, number>();
  for (const page of pages) {
    for (const item of page.items) {
      const size = Math.round(item.fontSize * 10) / 10;
      charsBySize.set(size, (charsBySize.get(size) ?? 0) + item.str.length);
    }
  }
  let best = 11;
  let bestChars = -1;
  for (const [size, chars] of charsBySize) {
    if (chars > bestChars) { best = size; bestChars = chars; }
  }
  return best;
}

// A line only counts as running header/footer furniture if it sits in the
// outer 12% of the page — a repeated line in the body (e.g. a recurring
// code snippet) is content, not page decoration, and must survive.
const HEADER_FOOTER_ZONE_FRACTION = 0.12;
// Required on a real majority of pages, not just a handful — a section that
// happens to repeat its own title on 2-3 consecutive pages should stay.
const HEADER_FOOTER_MIN_PAGE_FRACTION = 0.3;

/** Page numbers change per page; strip runs of digits before comparing so "12" and "13" still count as the same recurring header line. */
function normalizeForRepeatDetection(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').trim();
}

/**
 * Text (normalized) of lines that recur, in the header/footer zone, across
 * enough of the document to be page furniture rather than content — see
 * HEADER_FOOTER_* above for the exact bar. Verified against a real book:
 * catches the "12 · Chapter 3 · Section Name" running header pattern
 * without touching a genuinely repeated in-body phrase.
 */
export function findHeaderFooterLines(pages: PdfPage[]): Set<string> {
  const pageCountBySeenLine = new Map<string, Set<number>>();
  pages.forEach((page, pageIndex) => {
    const zone = page.height * HEADER_FOOTER_ZONE_FRACTION;
    for (const line of groupLines(page.items)) {
      const inHeaderZone = line.y >= page.height - zone;
      const inFooterZone = line.y <= zone;
      if (!inHeaderZone && !inFooterZone) continue;
      const key = normalizeForRepeatDetection(line.text);
      if (!key) continue;
      if (!pageCountBySeenLine.has(key)) pageCountBySeenLine.set(key, new Set());
      pageCountBySeenLine.get(key)!.add(pageIndex);
    }
  });
  const threshold = Math.max(3, Math.ceil(pages.length * HEADER_FOOTER_MIN_PAGE_FRACTION));
  const result = new Set<string>();
  for (const [key, pageSet] of pageCountBySeenLine) {
    if (pageSet.size >= threshold) result.add(key);
  }
  return result;
}

// A heading candidate must be at least this much larger than body text —
// verified against a real book where the actual section-heading size sat
// ~20% over body (11pt body, 13.15pt heading); 15% leaves margin without
// catching body-adjacent sizes (e.g. a slightly-larger figure caption).
const HEADING_SIZE_RATIO = 1.15;
// Headings are short by nature. This also rejects the real failure mode
// found live: some books render individual emphasized terms mid-sentence
// in a large display font ("the term function, or recursion, ...") — those
// share a heading-sized font but are never alone on their line once mixed
// with the surrounding 11pt sentence, so they're already excluded by
// `fontSize !== null` (mixed-size lines) before word count is even checked.
// This cap catches the rarer case of a large-font line that IS uniform but
// is a pull-quote/callout sentence, not a heading.
const MAX_HEADING_WORDS = 12;

// A word needs this many actual letters (any script — \p{L} is Unicode-
// general, not tied to Latin/Cyrillic/etc.) to count as "real text" rather
// than layout noise. Formulas, table remnants, and diagram fragments (single
// letters, repeated glyphs, digit runs, stray punctuation) routinely pass
// every other heading check — same isolated-uniform-large-font shape as a
// real heading, verified live on multiple books, different noise each time.
// The one thing they don't have in common with real headings, in any
// language: an actual multi-letter word. "1.1 Introduction" and "1.1 First
// Program" both clear this; "i", "J J J J J J J J", "4<0xFFFD>", "::::: 9.21034."
// don't, regardless of what book they came from.
const MIN_SUBSTANTIAL_WORD_LETTERS = 3;
const REPLACEMENT_CHAR = '�'; // U+FFFD — pdf.js's marker for a glyph with no Unicode mapping; corruption in any language.

function hasSubstantialWord(text: string): boolean {
  return text.split(/\s+/).some((word) => {
    const letters = word.match(/\p{L}/gu);
    return (letters?.length ?? 0) >= MIN_SUBSTANTIAL_WORD_LETTERS;
  });
}

function isHeadingCandidate(line: Line, bodySize: number): boolean {
  return line.fontSize !== null
    && line.fontSize >= bodySize * HEADING_SIZE_RATIO
    && line.wordCount > 0
    && line.wordCount <= MAX_HEADING_WORDS
    && !line.text.includes(REPLACEMENT_CHAR)
    && hasSubstantialWord(line.text);
}

// A real book rarely introduces more than 1-2 new headings on a single
// physical page. Verified live: a page containing a diagram (box labels
// rendered in a large, uniform font — visually nothing like a heading, but
// indistinguishable from one by size+isolation alone) produced 9 heading
// candidates on one page; real content pages in the same book produced 0-1.
// Demoting every candidate on a page that blows past this bar is a blunt
// instrument — it can eat a page with 3 genuinely short subsections back to
// back — but it's the cheap fix: the alternative (actually recognizing
// diagram layout) is real computer-vision-adjacent work, not justified
// until this proves insufficient in practice.
const MAX_HEADING_CANDIDATES_PER_PAGE = 2;

/** Distinct heading sizes (rounded to 0.5pt clusters) mapped largest-first to ##, ###, #### — capped at H4 so a book with many size tiers doesn't run past what get_note's H1-H6 outline usefully shows. */
function headingLevels(sizes: number[]): Map<number, number> {
  const sorted = [...new Set(sizes)].sort((a, b) => b - a);
  const clusters: number[][] = [];
  for (const size of sorted) {
    const cluster = clusters[clusters.length - 1];
    if (cluster && cluster[0] - size <= 0.5) cluster.push(size);
    else clusters.push([size]);
  }
  const levelBySize = new Map<number, number>();
  clusters.forEach((cluster, i) => {
    const level = Math.min(2 + i, 4);
    for (const size of cluster) levelBySize.set(size, level);
  });
  return levelBySize;
}

/**
 * The whole conversion, as one pure function over already-extracted page
 * data — this is what's actually unit tested; extractPdfPages above is the
 * only part that touches pdfjs-dist. Note title is deliberately not
 * derived here (left to the caller, e.g. from the uploaded filename) —
 * guessing it from the biggest heading on page 1 is unreliable (cover pages
 * routinely have author names, series branding, etc. in an even bigger
 * font than the real title).
 */
export function pagesToMarkdown(pages: PdfPage[]): string {
  if (pages.length === 0) return '';
  const bodySize = bodyFontSize(pages);
  const skipLines = findHeaderFooterLines(pages);

  const headingSizes: number[] = [];
  const kept: Line[] = [];
  const demoted = new Set<Line>();
  for (const page of pages) {
    const pageLines = groupLines(page.items).filter(
      (line) => !skipLines.has(normalizeForRepeatDetection(line.text))
    );
    const pageCandidates = pageLines.filter((line) => isHeadingCandidate(line, bodySize));
    if (pageCandidates.length > MAX_HEADING_CANDIDATES_PER_PAGE) {
      for (const line of pageCandidates) demoted.add(line);
    } else {
      for (const line of pageCandidates) headingSizes.push(line.fontSize!);
    }
    kept.push(...pageLines);
  }
  const levelBySize = headingLevels(headingSizes);

  // Paragraph vs. line-wrap: a gap much bigger than the typical line-to-line
  // step within a paragraph signals a real paragraph break. The typical
  // step is measured per-run (reset at each heading) rather than globally,
  // since a page mixing single- and 1.5-spaced blocks would otherwise blur
  // both into one unreliable average.
  const out: string[] = [];
  let paragraph: string[] = [];
  let prevY: number | null = null;
  let stepSamples: number[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
      // A body/code line that happens to start a paragraph with a literal
      // "#" (a shell/Python comment marker, most often) is exactly the bug
      // this whole module exists to fix, just from the PDF-import side
      // instead of copy-paste — verified live: real book code comments
      // ("# Array initialization...") landed at a paragraph's start often
      // enough to matter. extractHeadings/chunkNote read `^#{1,6}\s` as a
      // real heading with no way to know it came from inside a code
      // listing; escaping it here is the same fix a human editor would
      // apply by hand.
      out.push(/^#{1,6}\s/.test(text) ? `\\${text}` : text);
    }
    paragraph = [];
    stepSamples = [];
    prevY = null;
  };

  for (const line of kept) {
    const level = line.fontSize !== null ? levelBySize.get(line.fontSize) : undefined;
    if (level !== undefined && !demoted.has(line) && isHeadingCandidate(line, bodySize)) {
      flushParagraph();
      out.push(`${'#'.repeat(level)} ${line.text}`);
      continue;
    }
    if (prevY !== null) {
      const step = prevY - line.y;
      const typical = stepSamples.length
        ? stepSamples.reduce((a, b) => a + b, 0) / stepSamples.length
        : step;
      if (step > typical * 1.6 && stepSamples.length > 0) flushParagraph();
      else stepSamples.push(step);
    }
    paragraph.push(line.text);
    prevY = line.y;
  }
  flushParagraph();

  return out.join('\n\n');
}

export async function importPdf(buffer: Buffer): Promise<string> {
  const pages = await extractPdfPages(buffer);
  return pagesToMarkdown(pages);
}
