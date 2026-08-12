import { describe, it, expect } from 'vitest';
import { groupLines, bodyFontSize, findHeaderFooterLines, pagesToMarkdown } from './pdf-import';
import type { PdfTextItem, PdfPage } from './pdf-import';

// PDF y grows upward; a "page" here is 792pt tall (US Letter) unless noted.
const PAGE_HEIGHT = 792;

function item(str: string, fontSize: number, x: number, y: number, width?: number): PdfTextItem {
  return { str, fontSize, x, y, width: width ?? str.length * fontSize * 0.5 };
}

function page(items: PdfTextItem[], height = PAGE_HEIGHT): PdfPage {
  return { items, height };
}

describe('groupLines', () => {
  it('merges items sharing a y-coordinate into one line, ordered by x', () => {
    const items = [item('World', 11, 40, 500), item('Hello', 11, 10, 500)];
    const lines = groupLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Hello World');
  });

  it('keeps items with different y as separate lines, top to bottom', () => {
    const items = [item('second', 11, 10, 480), item('first', 11, 10, 500)];
    const lines = groupLines(items);
    expect(lines.map((l) => l.text)).toEqual(['first', 'second']);
  });

  it('reports fontSize only when every item on the line shares one size (mixed = null)', () => {
    const uniform = groupLines([item('Heading', 16, 10, 500)]);
    expect(uniform[0].fontSize).toBe(16);

    const mixed = groupLines([item('normal text ', 11, 10, 500), item('BIG', 17, 90, 500)]);
    expect(mixed[0].fontSize).toBeNull();
  });

  it('inserts a space across a real item gap but not within one glued run', () => {
    // A real inter-word gap (~0.3em) vs. two items butted together (kerning, no gap).
    const items = [
      item('std', 10, 40, 500, 15),
      item('io', 10, 55, 500, 10), // no gap — same word
      item('write', 10, 75, 500, 25), // gapped — new word
    ];
    expect(groupLines(items)[0].text).toBe('stdio write');
  });
});

describe('bodyFontSize', () => {
  it('picks the size with the most characters, not the most lines', () => {
    const pages = [page([
      item('A Big Heading', 24, 40, 700),
      item('one two three four five six seven eight nine ten', 11, 40, 600),
    ])];
    expect(bodyFontSize(pages)).toBe(11);
  });
});

describe('findHeaderFooterLines', () => {
  it('flags a line repeated in the header zone across most pages', () => {
    const pages: PdfPage[] = [];
    for (let p = 1; p <= 5; p++) {
      pages.push(page([
        item(`Chapter 1 · Page ${p}`, 8, 40, 770), // top ~3% — header zone
        item('Regular body text for this page.', 11, 40, 400),
      ]));
    }
    const skip = findHeaderFooterLines(pages);
    expect(skip.has('chapter # · page #')).toBe(true);
  });

  it('does not flag a line repeated in the body of the page', () => {
    const pages: PdfPage[] = [];
    for (let p = 1; p <= 5; p++) {
      pages.push(page([
        item('Note: see appendix for details.', 11, 40, 400), // mid-page, not header/footer zone
      ]));
    }
    const skip = findHeaderFooterLines(pages);
    expect(skip.has('note: see appendix for details.')).toBe(false);
  });

  it('does not flag a header-zone line that only appears once', () => {
    const pages: PdfPage[] = [
      page([item('One-off cover subtitle', 8, 40, 770)]),
      page([item('Body text on page two.', 11, 40, 400)]),
    ];
    const skip = findHeaderFooterLines(pages);
    expect(skip.has('one-off cover subtitle')).toBe(false);
  });
});

describe('pagesToMarkdown — heading detection', () => {
  it('turns an isolated, larger, uniform-size line into a heading', () => {
    const pages = [page([
      item('1.1 A Real Heading', 16, 40, 700),
      item('Body text follows at normal size, several words long here.', 11, 40, 650),
    ])];
    expect(pagesToMarkdown(pages)).toMatch(/^#{2,4} 1\.1 A Real Heading/m);
  });

  it('does not treat a large word embedded mid-sentence as a heading (mixed-size line)', () => {
    // Real failure mode found live: a book emphasizes single terms in a
    // large display font right inside an otherwise-normal sentence.
    const pages = [page([
      item('The system ', 11, 40, 500, 60),
      item('Python', 17, 100, 500, 50), // same line, bigger font — emphasis, not a heading
      item(' is a language.', 11, 150, 500, 90),
    ])];
    const md = pagesToMarkdown(pages);
    expect(md).not.toMatch(/^#/m);
    expect(md).toContain('Python');
  });

  it('demotes every heading candidate on a page with too many of them (diagram noise)', () => {
    // Verified live: a flowchart/diagram page produced 9 short, uniform,
    // large-font fragments that pass every other heading check.
    const items: PdfTextItem[] = [];
    for (let i = 0; i < 5; i++) items.push(item(`Label ${i}`, 15, 40, 700 - i * 20));
    const pages = [page(items)];
    expect(pagesToMarkdown(pages)).not.toMatch(/^#/m);
  });

  it('keeps a heading on a page with only one or two candidates', () => {
    const pages = [page([
      item('1. Introduction', 16, 40, 700),
      item('Body text at normal size to establish the body font.', 11, 40, 650),
    ])];
    expect(pagesToMarkdown(pages)).toMatch(/^#{2,4} 1\. Introduction/m);
  });

  it('rejects isolated, large-font layout noise with no real word in it', () => {
    // General principle, not tuned to one book: formulas, table remnants,
    // and diagram fragments share the exact shape a real heading has
    // (isolated, uniform, larger-than-body font) but never contain an
    // actual multi-letter word. One candidate per page each — below the
    // density filter's threshold, so that filter alone wouldn't catch these.
    const noise = ['i', 'J J J J J J J J', '4�', '::::: 9.21034.', '1 . 4', "' V V V V V \\J"];
    for (const text of noise) {
      const pages = [page([
        item(text, 16, 40, 700),
        item('Body text establishing the normal font size on this page.', 11, 40, 650),
      ])];
      expect(pagesToMarkdown(pages), `expected "${text}" to be rejected`).not.toMatch(/^#/m);
    }
  });

  it('keeps a genuine one-word heading (a real word is enough, no minimum word count)', () => {
    const pages = [page([
      item('Введение', 16, 40, 700),
      item('Body text at normal size to establish the body font.', 11, 40, 650),
    ])];
    expect(pagesToMarkdown(pages)).toMatch(/^#{2,4} Введение/m);
  });

  it('rejects a line containing the PDF "unmapped glyph" replacement character', () => {
    const pages = [page([
      item('Section Title�', 16, 40, 700),
      item('Body text at normal size to establish the body font.', 11, 40, 650),
    ])];
    expect(pagesToMarkdown(pages)).not.toMatch(/^#/m);
  });
});

describe('pagesToMarkdown — the original bug (# read as a heading)', () => {
  it('escapes a body paragraph that starts with a literal "#" (e.g. a code comment)', () => {
    // This is the exact failure this module exists to prevent: a shell/
    // Python comment ("# Remove stopped containers") pasted as plain text
    // is indistinguishable from a markdown heading to extractHeadings'
    // ^#{1,6}\s regex unless something escapes it first.
    const pages = [page([
      item('# Remove stopped containers', 11, 40, 500),
      item('Body text establishing the normal font size around it here.', 11, 40, 300),
    ])];
    const md = pagesToMarkdown(pages);
    expect(md).not.toMatch(/^#{1,6}\s/m);
    expect(md).toContain('\\# Remove stopped containers');
  });
});

describe('pagesToMarkdown — header/footer stripping and paragraphs', () => {
  it('strips a recurring running header before it reaches the output', () => {
    const pages: PdfPage[] = [];
    for (let p = 1; p <= 4; p++) {
      pages.push(page([
        item(`Running Header ${p}`, 8, 40, 770),
        item('Actual page content that should survive.', 11, 40, 400),
      ]));
    }
    const md = pagesToMarkdown(pages);
    expect(md).not.toContain('Running Header');
    expect(md).toContain('Actual page content that should survive.');
  });

  it('joins tightly-spaced lines into one paragraph and splits on a larger gap', () => {
    const pages = [page([
      item('First line of a paragraph', 11, 40, 500),
      item('continues here normally.', 11, 40, 486), // ~14pt step: line wrap
      item('A new paragraph starts after a bigger gap.', 11, 40, 440), // ~46pt step: break
    ])];
    const paragraphs = pagesToMarkdown(pages).split('\n\n');
    expect(paragraphs).toContain('First line of a paragraph continues here normally.');
    expect(paragraphs).toContain('A new paragraph starts after a bigger gap.');
  });
});
