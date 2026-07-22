import { describe, it, expect, vi } from 'vitest';

// rrfMerge is pure — mock the DB layer so no pool is ever created
vi.mock('./db', () => ({ query: vi.fn(), queryOne: vi.fn(), toVector: vi.fn() }));
vi.mock('./embeddings', () => ({ getEmbedding: vi.fn() }));

import { rrfMerge, makeExcerpt } from './search';

const make = (id: string, score = 0) => ({ id, title: id, excerpt: '', tags: [] as string[], score });
const text     = (results: ReturnType<typeof make>[]) => ({ field: 'text_score' as const, results });
const semantic = (results: ReturnType<typeof make>[]) => ({ field: 'semantic_score' as const, results });

describe('rrfMerge', () => {
  it('gives higher score to items ranked first in both lists', () => {
    const a = [make('a'), make('b'), make('c')];
    const b = [make('a'), make('c'), make('b')];
    const merged = rrfMerge([text(a), semantic(b)]);
    expect(merged[0].id).toBe('a');
  });

  it('deduplicates items appearing in multiple lists', () => {
    const a = [make('a'), make('b')];
    const b = [make('b'), make('c')];
    const merged = rrfMerge([text(a), semantic(b)]);
    expect(merged.filter((r) => r.id === 'b')).toHaveLength(1);
  });

  it('handles empty lists', () => {
    expect(rrfMerge([text([]), semantic([])])).toEqual([]);
  });

  it('items only in one list still appear in output', () => {
    const merged = rrfMerge([text([make('a')]), semantic([make('b')])]);
    expect(merged).toHaveLength(2);
    expect(merged.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('score is the sum of RRF contributions', () => {
    // single list, rank 0 → score = 1/(60+1) ≈ 0.01639
    const merged = rrfMerge([text([make('x')])]);
    expect(merged[0].score).toBeCloseTo(1 / 61, 5);
  });

  it('preserves each pass\'s own raw score under text_score/semantic_score', () => {
    const merged = rrfMerge([
      text([make('a', 0.9)]),
      semantic([make('a', 0.72)]),
    ]);
    expect(merged[0].text_score).toBe(0.9);
    expect(merged[0].semantic_score).toBe(0.72);
    // score itself stays the RRF fusion, not either raw value
    expect(merged[0].score).toBeCloseTo(1 / 61 + 1 / 61, 5);
  });

  it('a note that only matched one pass has no score for the other', () => {
    const merged = rrfMerge([text([make('a', 0.9)]), semantic([make('b', 0.72)])]);
    const a = merged.find((r) => r.id === 'a')!;
    expect(a.text_score).toBe(0.9);
    expect(a.semantic_score).toBeUndefined();
  });
});

describe('makeExcerpt', () => {
  it('returns short content unchanged', () => {
    expect(makeExcerpt('короткий текст')).toBe('короткий текст');
  });

  it('truncates long content and appends ellipsis', () => {
    const long = 'a'.repeat(500);
    const out = makeExcerpt(long, undefined, 300);
    expect(out.length).toBeLessThanOrEqual(301); // 300 + '…'
    expect(out.endsWith('…')).toBe(true);
  });

  it('window contains the query match when found mid-document', () => {
    const content = 'x'.repeat(1000) + ' ИСКОМАЯ ФРАЗА ' + 'y'.repeat(1000);
    const out = makeExcerpt(content, 'искомая фраза', 200);
    expect(out.toLowerCase()).toContain('искомая фраза');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('match is case-insensitive', () => {
    const content = 'prefix '.repeat(100) + 'OAuth Setup' + ' suffix'.repeat(100);
    const out = makeExcerpt(content, 'oauth setup', 120);
    expect(out).toContain('OAuth Setup');
  });

  it('falls back to head excerpt when query not found', () => {
    const content = 'начало документа ' + 'z'.repeat(500);
    const out = makeExcerpt(content, 'нет такого', 100);
    expect(out.startsWith('начало документа')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('match at the very start has no leading ellipsis', () => {
    const content = 'якорь в начале ' + 'w'.repeat(500);
    const out = makeExcerpt(content, 'якорь', 100);
    expect(out.startsWith('якорь')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles empty content', () => {
    expect(makeExcerpt('')).toBe('');
  });
});
