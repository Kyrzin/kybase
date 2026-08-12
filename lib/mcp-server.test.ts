import { describe, it, expect, vi } from 'vitest';

// windowContent is pure — mock everything mcp-server.ts imports so this file
// never touches a real DB or embedding provider.
vi.mock('./db', () => ({ query: vi.fn(), queryOne: vi.fn(), withTransaction: vi.fn(), isUniqueViolation: vi.fn() }));
vi.mock('./search', () => ({ textSearch: vi.fn(), semanticSearch: vi.fn(), hybridSearch: vi.fn() }));
vi.mock('./indexing', () => ({ indexNoteAsync: vi.fn() }));
vi.mock('./semantic-edges', () => ({ getSemanticEdges: vi.fn() }));

import { windowContent, resolveInsertOffset, insertAddition } from './mcp-server';
import { extractHeadings } from './markdown';

describe('windowContent', () => {
  it('leaves a note that fits within the default limit untouched', () => {
    const note = { id: '1', content: 'short note' };
    const out = windowContent(note, 0, 20_000);
    expect(out.content).toBe('short note');
    expect(out.content_truncated).toBe(false);
    expect(out.content_total_length).toBe(10);
    expect(out.next_offset).toBeUndefined();
  });

  it('truncates content longer than limit and reports next_offset', () => {
    const content = 'a'.repeat(50_000);
    const note = { id: '1', content };
    const out = windowContent(note, 0, 20_000);
    expect(out.content).toHaveLength(20_000);
    expect(out.content_truncated).toBe(true);
    expect(out.content_total_length).toBe(50_000);
    expect(out.next_offset).toBe(20_000);
  });

  it('paging with next_offset eventually reaches the end', () => {
    const content = 'x'.repeat(45_000);
    const note = { id: '1', content };
    let offset = 0;
    let reassembled = '';
    for (let i = 0; i < 10; i++) {
      const out = windowContent(note, offset, 20_000);
      reassembled += out.content;
      if (!out.content_truncated || out.next_offset === undefined) break;
      offset = out.next_offset;
    }
    expect(reassembled).toBe(content);
  });

  it('a non-zero offset counts as truncated even if it reaches the end', () => {
    const note = { id: '1', content: 'a'.repeat(25_000) };
    const out = windowContent(note, 20_000, 20_000);
    expect(out.content).toHaveLength(5_000);
    expect(out.content_truncated).toBe(true);
    expect(out.next_offset).toBeUndefined(); // nothing left to fetch
  });

  it('preserves other fields on the note', () => {
    const note = { id: '1', title: 'Hello', content: 'body', tags: ['a'] };
    const out = windowContent(note, 0, 20_000);
    expect(out.id).toBe('1');
    expect(out.title).toBe('Hello');
    expect(out.tags).toEqual(['a']);
  });
});

describe('resolveInsertOffset', () => {
  const NOTE = ['# Title', 'intro', '', '## Alpha', 'alpha body', '', '## Beta', 'beta body'].join('\n');
  const headings = () => extractHeadings(NOTE);

  it('note_end is always content.length', () => {
    expect(resolveInsertOffset(NOTE, headings(), 'note_end', undefined)).toBe(NOTE.length);
  });

  it('note_start lands before the first heading nested under the H1, not offset 0', () => {
    expect(resolveInsertOffset(NOTE, headings(), 'note_start', undefined)).toBe(NOTE.indexOf('## Alpha'));
  });

  it('note_start falls back to the end of the note with only one heading', () => {
    const one = '# Only\nprose';
    expect(resolveInsertOffset(one, extractHeadings(one), 'note_start', undefined)).toBe(one.length);
  });

  it('note_start is offset 0 on a note with no headings at all', () => {
    const none = 'just prose';
    expect(resolveInsertOffset(none, extractHeadings(none), 'note_start', undefined)).toBe(0);
  });

  it('before_section lands at the section\'s own heading — first section boundary', () => {
    expect(resolveInsertOffset(NOTE, headings(), 'before_section', 'Alpha')).toBe(NOTE.indexOf('## Alpha'));
  });

  it('before_section works the same at the last section boundary', () => {
    expect(resolveInsertOffset(NOTE, headings(), 'before_section', 'Beta')).toBe(NOTE.indexOf('## Beta'));
  });

  it('section_end and after_section both land past the whole section, at the next heading', () => {
    expect(resolveInsertOffset(NOTE, headings(), 'section_end', 'Alpha')).toBe(NOTE.indexOf('## Beta'));
    expect(resolveInsertOffset(NOTE, headings(), 'after_section', 'Alpha')).toBe(NOTE.indexOf('## Beta'));
  });

  it('section_end on the last section lands at the end of the note', () => {
    expect(resolveInsertOffset(NOTE, headings(), 'section_end', 'Beta')).toBe(NOTE.length);
  });

  it('section_start lands right after the heading line, before its body', () => {
    const offset = resolveInsertOffset(NOTE, headings(), 'section_start', 'Alpha');
    expect(NOTE.slice(0, offset)).toBe('# Title\nintro\n\n## Alpha\n');
    expect(NOTE.slice(offset)).toBe('alpha body\n\n## Beta\nbeta body');
  });

  it('a section-relative at without a section throws instead of guessing', () => {
    expect(() => resolveInsertOffset(NOTE, headings(), 'before_section', undefined)).toThrow('requires section');
  });

  it('an unresolvable section throws the same available-sections message sectionRange callers rely on', () => {
    expect(() => resolveInsertOffset(NOTE, headings(), 'before_section', 'Nope')).toThrow('Alpha');
  });

  it('resolves a section across Unicode normal forms, same as sectionRange', () => {
    const note = '# Intro\nx\n\n## Café\naccent body\n';
    const nfd = 'Café'; // e + combining acute — same word, different encoding
    expect(resolveInsertOffset(note, extractHeadings(note), 'before_section', nfd)).toBe(note.indexOf('## Café'));
  });

  it('resolves a section in a CRLF note', () => {
    const note = '# Title\r\nintro\r\n\r\n## Alpha\r\nbody\r\n';
    expect(resolveInsertOffset(note, extractHeadings(note), 'before_section', 'Alpha')).toBe(note.indexOf('## Alpha'));
  });
});

describe('insertAddition', () => {
  it('reproduces the original whole-note append shape (offset = content.length)', () => {
    const out = insertAddition('existing text', 'existing text'.length, 'new text');
    expect(out).toBe('existing text\n\nnew text\n');
  });

  it('reproduces the original section-append shape (offset mid-content, tail follows)', () => {
    const content = 'head\n\n## Next\ntail body';
    const out = insertAddition(content, content.indexOf('## Next'), 'inserted');
    expect(out).toBe('head\n\ninserted\n\n## Next\ntail body');
  });

  it('trims trailing whitespace from the head before splicing', () => {
    const content = 'head   \n\n\ntail';
    expect(insertAddition(content, content.indexOf('tail'), 'x')).toBe('head\n\nx\n\ntail');
  });

  it('does not add a trailing blank block when there is no tail', () => {
    expect(insertAddition('head', 4, 'x')).toBe('head\n\nx\n');
  });
});
