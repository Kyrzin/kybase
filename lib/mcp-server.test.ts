import { describe, it, expect, vi } from 'vitest';

// windowContent is pure — mock everything mcp-server.ts imports so this file
// never touches a real DB or embedding provider.
vi.mock('./db', () => ({ query: vi.fn(), queryOne: vi.fn(), withTransaction: vi.fn(), isUniqueViolation: vi.fn() }));
vi.mock('./search', () => ({ textSearch: vi.fn(), semanticSearch: vi.fn(), hybridSearch: vi.fn() }));
vi.mock('./indexing', () => ({ indexNoteAsync: vi.fn() }));
vi.mock('./semantic-edges', () => ({ getSemanticEdges: vi.fn() }));

import { windowContent } from './mcp-server';

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
