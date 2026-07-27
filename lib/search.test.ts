import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbQuery = vi.fn();
vi.mock('./db', () => ({
  query: (...a: unknown[]) => dbQuery(...a),
  queryOne: vi.fn(),
  toVector: (v: unknown) => v,
}));

const getEmbedding = vi.fn();
const getMinSimilarity = vi.fn();
vi.mock('./embeddings', () => ({
  getEmbedding: (...a: unknown[]) => getEmbedding(...a),
  getMinSimilarity: (...a: unknown[]) => getMinSimilarity(...a),
}));

import { rrfMerge, makeExcerpt, stripLeadingHeading, textSearch, semanticSearch, bestSemanticScore } from './search';

beforeEach(() => {
  dbQuery.mockReset().mockResolvedValue([]);
  getEmbedding.mockReset().mockResolvedValue([0.1, 0.2]);
  getMinSimilarity.mockReset().mockResolvedValue(0.55);
});

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

  it('matched_by lists only the pass(es) that actually contained the note', () => {
    const merged = rrfMerge([text([make('a', 0.9)]), semantic([make('b', 0.72)])]);
    expect(merged.find((r) => r.id === 'a')!.matched_by).toEqual(['text_score']);
    expect(merged.find((r) => r.id === 'b')!.matched_by).toEqual(['semantic_score']);
  });

  it('matched_by lists both passes for a note present in each', () => {
    const merged = rrfMerge([text([make('a', 0.9)]), semantic([make('a', 0.72)])]);
    expect(merged[0].matched_by).toEqual(['text_score', 'semantic_score']);
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

  it('snaps a mid-word cut back to a whitespace boundary at both edges', () => {
    // Real prose (spaces throughout) so the snap can find boundaries.
    const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike';
    const content = words + ' ' + words + ' ' + words;
    const out = makeExcerpt(content, 'hotel india', 60);
    expect(out).toContain('hotel india');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    // Every token between the ellipses is a complete word from the source —
    // neither edge left a half-word dangling against its "…".
    const vocab = new Set(words.split(' '));
    for (const w of out.replace(/^…|…$/g, '').trim().split(/\s+/)) {
      expect(vocab.has(w)).toBe(true);
    }
  });

  it('keeps a hard cut when there is no nearby whitespace to snap to', () => {
    const long = 'a'.repeat(500);
    const out = makeExcerpt(long, undefined, 300);
    expect(out).toBe('a'.repeat(300) + '…'); // unchanged: no boundary within the snap window
  });
});

describe('stripLeadingHeading', () => {
  it('drops a leading markdown heading line', () => {
    expect(stripLeadingHeading('## Раздел\n\nтело секции')).toBe('тело секции');
    expect(stripLeadingHeading('# H\nbody')).toBe('body');
  });

  it('leaves headingless content and mid-text hashes alone', () => {
    expect(stripLeadingHeading('plain body\n# not the first line')).toBe('plain body\n# not the first line');
    expect(stripLeadingHeading('C# is a language')).toBe('C# is a language');
  });
});

describe('textSearch — filters', () => {
  it('without filters, requests exactly `limit` rows and does not query notes for an id set', async () => {
    dbQuery.mockResolvedValueOnce([{ id: 'a', title: 'A', tags: [], rank: 0.5, headline: 'hi' }]);
    const results = await textSearch('q', 5);
    expect(dbQuery.mock.calls[0]).toEqual(['select * from search_notes_fts($1, $2)', ['q', 5]]);
    expect(dbQuery).toHaveBeenCalledTimes(1); // no extra id-set lookup
    expect(results).toHaveLength(1);
  });

  it('with a filter, overfetches then keeps only notes in the filtered id set', async () => {
    dbQuery
      .mockResolvedValueOnce([
        { id: 'a', title: 'A', tags: [], rank: 0.9, headline: 'hi' },
        { id: 'b', title: 'B', tags: [], rank: 0.5, headline: 'hi' },
      ])
      .mockResolvedValueOnce([{ id: 'a' }]); // filteredNoteIds: only 'a' is in the folder
    const results = await textSearch('q', 5, { folderId: 'f1' });

    const [, ftsParams] = dbQuery.mock.calls[0];
    expect(ftsParams[1]).toBe(40); // overfetch: limit(5) * factor(8)
    const [idSql, idParams] = dbQuery.mock.calls[1];
    expect(idSql).toContain('folder_id = $1');
    expect(idParams).toEqual(['f1']);
    expect(results.map((r) => r.id)).toEqual(['a']); // 'b' dropped
  });

  it('combines multiple filters with AND', async () => {
    dbQuery.mockResolvedValueOnce([{ id: 'a', title: 'A', tags: [], rank: 0.9, headline: 'hi' }])
           .mockResolvedValueOnce([{ id: 'a' }]);
    await textSearch('q', 5, { tag: 'x', updatedAfter: '2026-01-01' });
    const [sql, params] = dbQuery.mock.calls[1];
    expect(sql).toContain('tags @> $1');
    expect(sql).toContain('updated_at >= $2');
    expect(params).toEqual([['x'], '2026-01-01']);
  });
});

describe('semanticSearch — filters', () => {
  it('without filters, requests exactly `limit` rows', async () => {
    dbQuery.mockResolvedValueOnce([]);
    await semanticSearch('q', 7);
    const [, params] = dbQuery.mock.calls[0];
    expect(params[1]).toBe(7);
  });

  it('overfetches and filters down when a filter is given', async () => {
    dbQuery
      .mockResolvedValueOnce([
        { id: 'a', title: 'A', chunk_content: 'x', heading: null, tags: [], similarity: 0.8 },
        { id: 'b', title: 'B', chunk_content: 'y', heading: null, tags: [], similarity: 0.7 },
      ])
      .mockResolvedValueOnce([{ id: 'b' }]);
    const results = await semanticSearch('q', 3, { tag: 'work' });
    expect(dbQuery.mock.calls[0][1][1]).toBe(24); // 3 * 8
    expect(results.map((r) => r.id)).toEqual(['b']);
  });

  it('shows the section heading once, not duplicated by the chunk\'s own heading line', async () => {
    dbQuery.mockResolvedValueOnce([{
      id: 'a', title: 'A',
      chunk_content: '## Диагностика\n\nnomic оказалась непригодна на русском',
      heading: 'Диагностика', tags: [], similarity: 0.6,
    }]);
    const [r] = await semanticSearch('nomic русский', 5);
    expect(r.excerpt).toBe('[Диагностика] nomic оказалась непригодна на русском');
    expect(r.excerpt).not.toContain('##'); // markdown heading line stripped from the body
  });
});

describe('bestSemanticScore', () => {
  it('queries match_chunks with min_similarity=0 and returns the top similarity', async () => {
    dbQuery.mockResolvedValueOnce([{ similarity: 0.31 }]);
    const score = await bestSemanticScore('some query');
    expect(dbQuery.mock.calls[0][0]).toContain('match_chunks($1::vector, 1, 0)');
    expect(score).toBe(0.31);
  });

  it('returns null when nothing matches at all', async () => {
    dbQuery.mockResolvedValueOnce([]);
    expect(await bestSemanticScore('q')).toBeNull();
  });
});
