import { describe, it, expect } from 'vitest';
import {
  parseMarkdown, renderWithWikilinks, stripWikilinks, escapeAttr, safeUrl, extractHeadings,
  TABLE_ROW_RE, TABLE_SEPARATOR_RE,
} from './markdown';
import type { WikilinkNote } from './markdown';

const notes: WikilinkNote[] = [];

describe('parseMarkdown — attribute escaping', () => {
  it('rejects a non-http(s) URL outright (safeUrl allowlist)', () => {
    const html = parseMarkdown('[link](" onmouseover="alert(1)")');
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain('href="#"');
  });

  it('escapes quotes that survive within an allowed https URL', () => {
    const html = parseMarkdown('[link](https://x" onmouseover="alert(1))');
    expect(html).not.toMatch(/onmouseover="alert\(1\)"/);
    expect(html).toContain('&quot;');
  });

  it('escapes quotes in image alt text', () => {
    const html = parseMarkdown('![" onerror="alert(1)](https://example.com/x.png)');
    expect(html).not.toMatch(/onerror="alert\(1\)"/);
    expect(html).toContain('&quot;');
  });

  it('blocks javascript: URLs in links', () => {
    const html = parseMarkdown('[link](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:alert(1)"');
    expect(html).toContain('href="#"');
  });

  it('blocks javascript: URLs in images', () => {
    const html = parseMarkdown('![x](javascript:alert(1))');
    expect(html).not.toContain('src="javascript:alert(1)"');
  });

  it('still renders normal https links and images', () => {
    const html = parseMarkdown('[docs](https://example.com) ![alt](https://example.com/x.png)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('src="https://example.com/x.png"');
  });
});

describe('parseMarkdown — fenced code blocks are inert', () => {
  it('keeps newlines in code blocks as text, not <br>/<p>', () => {
    const html = parseMarkdown('```\nline1\n\nline2\n```');
    expect(html).toContain('line1\n\nline2');
    const pre = html.slice(html.indexOf('<pre'), html.indexOf('</pre>'));
    expect(pre).not.toContain('<br>');
    expect(pre).not.toContain('<p>');
  });

  it('does not apply inline markup inside code blocks', () => {
    const html = parseMarkdown('```\n**not bold** `not code` # not heading\n```');
    expect(html).toContain('**not bold**');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<h1>');
  });

  it('still escapes HTML inside code blocks', () => {
    const html = parseMarkdown('```\n<script>alert(1)</script>\n```');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders text around a code block normally', () => {
    const html = parseMarkdown('**bold**\n\n```\ncode\n```\n\nafter');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<pre');
    expect(html).toContain('after');
  });

  it('cannot be forged with a NUL placeholder in content', () => {
    const html = parseMarkdown('\u00000\u0000 text ```\ncode\n```');
    expect(html.match(/<pre/g)?.length ?? 0).toBe(1);
  });
});

describe('parseMarkdown — tables', () => {
  it('renders a header, separator, and body rows as a table', () => {
    const html = parseMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
    expect(html).toContain('<table');
    expect(html).toContain('<th style="border:1px solid #313244;padding:6px 10px;background:#1e1e2e">A</th>');
    expect(html).toContain('<td style="border:1px solid #313244;padding:6px 10px">1</td>');
    expect(html).toContain('<td style="border:1px solid #313244;padding:6px 10px">3</td>');
  });

  it('applies left/center/right alignment from the separator row', () => {
    const html = parseMarkdown('| Def | L | C | R |\n| --- | :--- | :---: | ---: |\n| a | b | c | d |');
    expect(html).toContain('text-align:left');
    expect(html).toContain('text-align:center');
    expect(html).toContain('text-align:right');
    // A bare --- (no colon) has no alignment marker — no explicit text-align
    // for that column, browser default applies.
    const firstTh = html.slice(html.indexOf('<th'), html.indexOf('</th>'));
    expect(firstTh).not.toContain('text-align');
  });

  it('renders a header-only table (no body rows) even with no trailing newline', () => {
    const html = parseMarkdown('| Only header |\n| --- |');
    expect(html).toContain('<thead><tr><th');
    expect(html).toContain('<tbody></tbody>');
  });

  it('does not swallow the paragraph break after a table', () => {
    // The table match must stop before the blank line, or \n\n->paragraph
    // never sees two newlines and degrades to a bare <br>.
    const html = parseMarkdown('| A |\n| --- |\n| 1 |\n\nAfter the table.');
    expect(html).toContain('</table></p><p>After the table.</p>');
  });

  it('renders two tables separated by a blank line as two separate tables', () => {
    const html = parseMarkdown('| A |\n| --- |\n| 1 |\n\n| B |\n| --- |\n| 2 |');
    expect(html.match(/<table/g)?.length ?? 0).toBe(2);
  });

  it('leaves a stray | that is not part of a table as plain text', () => {
    const html = parseMarkdown('this has a | pipe but is not a table');
    expect(html).not.toContain('<table');
    expect(html).toContain('this has a | pipe but is not a table');
  });

  it('does not treat a | inside a fenced code block as table syntax', () => {
    const html = parseMarkdown('```\n| a | b |\n| --- | --- |\n```');
    expect(html).not.toContain('<table');
    expect(html).toContain('<pre');
  });

  it('escapes HTML in a table cell — no script execution from cell content', () => {
    const html = parseMarkdown('| A |\n| --- |\n| <script>alert(1)</script> |');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('applies inline formatting inside table cells', () => {
    const html = parseMarkdown('| A |\n| --- |\n| **bold** and `code` |');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code');
  });

  it('does not need an <ol>/<ul> wrapper to work, matching the rest of the list handling', () => {
    // Documents intent, not a defect: verifies this doesn't regress if a
    // future change adds real list wrappers.
    const html = parseMarkdown('| A |\n| --- |\n| 1 |');
    expect(html).not.toContain('<ul>');
    expect(html).not.toContain('<ol>');
  });

  // TABLE_ROW_RE/TABLE_SEPARATOR_RE are a separate definition from
  // renderTables' own block regex (see the comment above them) — these
  // cases are what actually keeps the two from silently drifting apart.
  // Anything that makes parseMarkdown emit a <table> here must also read as
  // row+separator through the exported regexes, and vice versa.
  describe('TABLE_ROW_RE / TABLE_SEPARATOR_RE agree with what renderTables renders', () => {
    it('classifies a real header + separator pair the same way renderTables treats them', () => {
      const header = '| A | B |', sep = '|---|---|';
      expect(TABLE_ROW_RE.test(header)).toBe(true);
      expect(TABLE_SEPARATOR_RE.test(sep)).toBe(true);
      expect(parseMarkdown(`${header}\n${sep}\n| 1 | 2 |`)).toContain('<table');
    });

    it('rejects a stray | line with no separator, same as renderTables', () => {
      const line = 'this has a | pipe but is not a table';
      expect(TABLE_ROW_RE.test(line)).toBe(false); // no closing |
      expect(parseMarkdown(line)).not.toContain('<table');
    });

    it('accepts alignment markers in the separator, same as renderTables', () => {
      const sep = '|:---|:---:|---:|';
      expect(TABLE_SEPARATOR_RE.test(sep)).toBe(true);
      expect(parseMarkdown(`| A | B | C |\n${sep}\n| 1 | 2 | 3 |`)).toContain('text-align');
    });

    it('does not classify a separator row itself as a plain row match failure', () => {
      // A separator IS also row-shaped (pipes at both ends) — renderTables'
      // block regex relies on exactly this to consume it as the second line.
      expect(TABLE_ROW_RE.test('|---|---|')).toBe(true);
    });
  });
});

describe('renderWithWikilinks — attribute escaping', () => {
  it('escapes quotes in the wikilink title so it cannot break out of data-title', () => {
    const html = renderWithWikilinks('[[foo&quot; onmouseover=&quot;alert(1)]]', notes);
    // parseMarkdown would have already turned a literal " into &quot; before this
    // runs; simulate that upstream escaping and confirm no raw " survives.
    expect(html).not.toMatch(/data-title="[^"]*"[^>]*onmouseover=/);
  });
});

describe('stripWikilinks — public share page renders links as dead text', () => {
  it('renders [[Title]] as the bare title, no element', () => {
    const out = stripWikilinks(parseMarkdown('see [[My Note]] here'));
    expect(out).toContain('see My Note here');
    expect(out).not.toContain('[[');
    expect(out).not.toContain('wikilink');
    expect(out).not.toContain('data-title');
  });

  it('renders [[Title#Section|Alias]] as the alias only', () => {
    const out = stripWikilinks(parseMarkdown('go [[Target#Part|читай тут]]'));
    expect(out).toContain('go читай тут');
    expect(out).not.toContain('Target');
    expect(out).not.toContain('#Part');
  });

  it('renders [[Title#Section]] as the title without the section', () => {
    const out = stripWikilinks(parseMarkdown('[[Target#Deep Section]]'));
    expect(out).toContain('Target');
    expect(out).not.toContain('#Deep Section');
  });

  it('produces identical markup for existing and non-existing targets', () => {
    // No difference in output = no way to probe which titles exist.
    expect(stripWikilinks('[[A]]')).toBe('A');
    expect(stripWikilinks('[[Definitely Missing]]')).toBe('Definitely Missing');
  });
});

describe('escapeAttr / safeUrl', () => {
  it('escapeAttr only touches double quotes', () => {
    expect(escapeAttr('a "b" c')).toBe('a &quot;b&quot; c');
  });

  it('safeUrl allows http(s)/mailto/relative, rejects everything else', () => {
    expect(safeUrl('https://example.com')).toBe('https://example.com');
    expect(safeUrl('http://example.com')).toBe('http://example.com');
    expect(safeUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(safeUrl('/notes/1')).toBe('/notes/1');
    expect(safeUrl('javascript:alert(1)')).toBe('#');
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
  });
});

describe('heading ids and extractHeadings', () => {
  it('puts document-order deduped slug ids on h1-h3', () => {
    const html = parseMarkdown('# Setup\n\n## Setup\n\n### Details');
    expect(html).toContain('<h1 id="setup">Setup</h1>');
    expect(html).toContain('<h2 id="setup-2">Setup</h2>');
    expect(html).toContain('<h3 id="details">Details</h3>');
  });

  it('renders h4-h6 the same way, matching the chunker\'s existing #{1,6} depth', () => {
    const content = '#### Fourth\n\n##### Fifth\n\n###### Sixth';
    const html = parseMarkdown(content);
    expect(html).toContain('<h4 id="fourth">Fourth</h4>');
    expect(html).toContain('<h5 id="fifth">Fifth</h5>');
    expect(html).toContain('<h6 id="sixth">Sixth</h6>');
    expect(extractHeadings(content).map(h => h.level)).toEqual([4, 5, 6]);
  });

  it('does not treat a 7th # as a heading', () => {
    const content = '####### Not a heading';
    expect(extractHeadings(content)).toEqual([]);
    expect(parseMarkdown(content)).not.toContain('<h');
  });

  it('slugifies cyrillic and strips punctuation', () => {
    const html = parseMarkdown('## Открыто — план (приоритет)');
    expect(html).toContain('<h2 id="открыто-план-приоритет">');
  });

  it('gives identical slugs for escaped-entity headings on both paths', () => {
    const content = '# A & B';
    const html = parseMarkdown(content);
    const [h] = extractHeadings(content);
    expect(html).toContain(`<h1 id="${h.slug}">`);
    expect(h.slug).toBe('a-b');
  });

  it('ignores # lines inside fenced code blocks in both paths', () => {
    const content = '# Real\n\n```bash\n# not a heading\n```\n\n## Also real';
    expect(extractHeadings(content)).toEqual([
      { level: 1, text: 'Real', slug: 'real', offset: content.indexOf('# Real') },
      { level: 2, text: 'Also real', slug: 'also-real', offset: content.indexOf('## Also real') },
    ]);
    const html = parseMarkdown(content);
    expect(html).not.toContain('id="not-a-heading"');
    expect(html).toContain('# not a heading');
  });

  it('finds headings in a note that arrived with CRLF line endings', () => {
    // Vaults exported on Windows import this way; `.` never matches \r, so
    // without the optional \r the anchor was unreachable and the outline of
    // every such note came back empty.
    const content = '# Заголовок\r\nтекст\r\n\r\n## Второй\r\nещё';
    const heads = extractHeadings(content);
    expect(heads.map(h => h.text)).toEqual(['Заголовок', 'Второй']);
    expect(content.slice(heads[1].offset)).toMatch(/^## Второй/);
  });

  it('keeps headings after an unclosed fence in both paths', () => {
    // An unpaired ``` is not a code block to the renderer, so the outline
    // must not lose everything below it either.
    const content = '# Real\n\n```\nconsole.log(1)\n\n## Also real';
    expect(extractHeadings(content).map(h => h.text)).toEqual(['Real', 'Also real']);
    expect(parseMarkdown(content)).toContain('id="also-real"');
  });

  it('extractHeadings matches parseMarkdown ids across duplicate mixed levels', () => {
    const content = '### Foo\n\n# Foo\n\n## Bar';
    const heads = extractHeadings(content);
    expect(heads.map(h => h.slug)).toEqual(['foo', 'foo-2', 'bar']);
    const html = parseMarkdown(content);
    expect(html).toContain('<h3 id="foo">');
    expect(html).toContain('<h1 id="foo-2">');
  });

  it('falls back to "section" for a heading with no word characters', () => {
    expect(extractHeadings('# ---')[0].slug).toBe('section');
  });

  it('escapes quotes that survive slugification into the id attribute', () => {
    const html = parseMarkdown('# "quoted"');
    expect(html).toContain('<h1 id="quoted">');
  });
});

describe('parseMarkdown — lists', () => {
  it('renders a numbered list, keeping the number as visible text', () => {
    const html = parseMarkdown('1. First\n2. Second');
    expect(html).toContain('<li style="margin-left:16px;list-style:none">1. First</li>');
    expect(html).toContain('<li style="margin-left:16px;list-style:none">2. Second</li>');
  });

  it('suppresses the default disc marker so no bullet sits next to the number', () => {
    // A bare <li> outside <ul>/<ol> defaults to list-style-type: disc — without
    // an explicit override it would show as "• 1. Item", not "1. Item".
    expect(parseMarkdown('1. Item')).toContain('list-style:none');
  });

  it('indents a nested bullet deeper than its unindented parent', () => {
    const html = parseMarkdown('- Parent\n  - Child');
    expect(html).toContain('<li style="margin-left:16px">Parent</li>');
    expect(html).toContain('<li style="margin-left:32px">Child</li>');
  });

  it('indents nested checkboxes the same way as nested bullets', () => {
    const html = parseMarkdown('- [x] Parent\n  - [ ] Child');
    expect(html).toContain('<li style="margin-left:16px">☑ Parent</li>');
    expect(html).toContain('<li style="margin-left:32px">☐ Child</li>');
  });

  it('indents a nested numbered item, keeping list-style suppressed', () => {
    const html = parseMarkdown('1. Parent\n  1. Child');
    expect(html).toContain('<li style="margin-left:32px;list-style:none">1. Child</li>');
  });
});
