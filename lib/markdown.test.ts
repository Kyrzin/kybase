import { describe, it, expect } from 'vitest';
import { parseMarkdown, renderWithWikilinks, stripWikilinks, escapeAttr, safeUrl, extractHeadings } from './markdown';
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
