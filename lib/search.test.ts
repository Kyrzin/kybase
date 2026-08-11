import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbQuery = vi.fn();
vi.mock('./db', () => ({
  query: (...a: unknown[]) => dbQuery(...a),
  queryOne: vi.fn(),
  toVector: (v: unknown) => v,
}));

const getEmbedding = vi.fn();
const getMinSimilarity = vi.fn();
const getRelevanceAnchors = vi.fn();
vi.mock('./embeddings', () => ({
  getEmbedding: (...a: unknown[]) => getEmbedding(...a),
  getMinSimilarity: (...a: unknown[]) => getMinSimilarity(...a),
  getRelevanceAnchors: (...a: unknown[]) => getRelevanceAnchors(...a),
}));

import { rrfMerge, makeExcerpt, stripLeadingHeading, textSearch, semanticSearch, hybridSearch, bestSemanticScore, normalizeRelevance, confidenceFor } from './search';

beforeEach(() => {
  dbQuery.mockReset().mockResolvedValue([]);
  getEmbedding.mockReset().mockResolvedValue([0.1, 0.2]);
  getMinSimilarity.mockReset().mockResolvedValue(0.55);
  getRelevanceAnchors.mockReset().mockResolvedValue({ floor: 0.55, strong: 0.75 });
});

const make = (id: string, score = 0, relevance = 0.5) =>
  ({ id, title: id, excerpt: '', tags: [] as string[], score, relevance, confidence: confidenceFor(relevance) });
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
  it('without filters, requests exactly `limit` rows and does not query notes for a filter id set', async () => {
    dbQuery
      .mockResolvedValueOnce([{ id: 'a', title: 'A', tags: [], rank: 0.5, headline: 'hi' }])
      .mockResolvedValueOnce([{ id: 'a', created_at: '2026-01-01T00:00:00.000Z' }]); // enrichWithCreatedAt
    const results = await textSearch('q', 5);
    expect(dbQuery.mock.calls[0]).toEqual(['select * from search_notes_fts($1, $2)', ['q', 5]]);
    expect(dbQuery).toHaveBeenCalledTimes(2); // FTS + unconditional created_at lookup, no filter id-set query
    const [enrichSql] = dbQuery.mock.calls[1];
    expect(enrichSql).not.toMatch(/folder_id|tags @>|updated_at|created_at >=/); // not filteredNoteIds
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

  it('filters by createdAfter/createdBefore, symmetric with updatedAfter/updatedBefore', async () => {
    dbQuery.mockResolvedValueOnce([{ id: 'a', title: 'A', tags: [], rank: 0.9, headline: 'hi' }])
           .mockResolvedValueOnce([{ id: 'a' }]);
    await textSearch('q', 5, { createdAfter: '2026-01-01', createdBefore: '2026-12-31' });
    const [sql, params] = dbQuery.mock.calls[1];
    expect(sql).toContain('created_at >= $1');
    expect(sql).toContain('created_at <= $2');
    expect(params).toEqual(['2026-01-01', '2026-12-31']);
  });

  it('attaches created_at to every result via one id = any($1) lookup', async () => {
    dbQuery
      .mockResolvedValueOnce([
        { id: 'a', title: 'A', tags: [], rank: 0.9, headline: 'hi' },
        { id: 'b', title: 'B', tags: [], rank: 0.5, headline: 'hi' },
      ])
      .mockResolvedValueOnce([
        { id: 'a', created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'b', created_at: '2026-02-01T00:00:00.000Z' },
      ]);
    const results = await textSearch('q', 5);
    const [sql, params] = dbQuery.mock.calls[1];
    expect(sql).toBe('select id, created_at from notes where id = any($1)');
    expect(params).toEqual([['a', 'b']]);
    expect(results.map((r) => r.created_at)).toEqual(['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']);
  });

  it('leaves created_at undefined (not throwing) for a result missing from the lookup', async () => {
    // Can happen if the note was deleted in the gap between the FTS query
    // and this lookup — a real but narrow race, not an error.
    dbQuery
      .mockResolvedValueOnce([{ id: 'a', title: 'A', tags: [], rank: 0.9, headline: 'hi' }])
      .mockResolvedValueOnce([]); // 'a' no longer found
    const [result] = await textSearch('q', 5);
    expect(result.created_at).toBeUndefined();
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

  it('skips the created_at lookup entirely on an empty result — no wasted PK query', async () => {
    // match_chunks returns [] whenever nothing clears the similarity floor
    // (no embeddings yet, or everything below threshold) — a common, not
    // exceptional, outcome. enrichWithCreatedAt must not fire a second
    // query for zero ids.
    dbQuery.mockResolvedValueOnce([]); // match_chunks: nothing above the floor
    const results = await semanticSearch('q', 5);
    expect(results).toEqual([]);
    expect(dbQuery).toHaveBeenCalledTimes(1); // match_chunks only, no id = any($1) call
  });

  it('attaches created_at without touching match_chunks itself', async () => {
    dbQuery
      .mockResolvedValueOnce([
        { id: 'a', title: 'A', chunk_content: 'x', heading: null, tags: [], similarity: 0.8 },
      ])
      .mockResolvedValueOnce([{ id: 'a', created_at: '2026-05-01T00:00:00.000Z' }]);
    const [result] = await semanticSearch('q', 5);
    expect(dbQuery.mock.calls[0][0]).toContain('match_chunks'); // unchanged RPC, no migration
    expect(result.created_at).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('hybridSearch — candidate pool', () => {
  it('overfetches each arm beyond the final limit before RRF fusion', async () => {
    // Each arm now also fires its own enrichWithCreatedAt call, and the two
    // arms run concurrently (Promise.all), so their calls can interleave in
    // either order — find each call by its SQL rather than assuming a fixed
    // index.
    dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('search_notes_fts')) return [{ id: 'a', title: 'A', tags: [], rank: 0.5, headline: 'hi' }];
      if (sql.includes('match_chunks')) return [{ id: 'b', title: 'B', chunk_content: 'x', heading: null, tags: [], similarity: 0.8 }];
      return [];
    });

    await hybridSearch('q', 5);

    const ftsCall = dbQuery.mock.calls.find(([sql]) => (sql as string).includes('search_notes_fts'))!;
    const semanticCall = dbQuery.mock.calls.find(([sql]) => (sql as string).includes('match_chunks'))!;
    expect((ftsCall[1] as unknown[])[1]).toBeGreaterThan(5);
    expect((semanticCall[1] as unknown[])[1]).toBeGreaterThan(5);
  });

  it('carries created_at through from the arms — no extra lookup of its own', async () => {
    // Each arm enriches its own candidate list (textSearch/semanticSearch),
    // and rrfMerge's `...result` spread preserves the field through fusion —
    // hybridSearch adding a third id=any($1) call on the already-enriched,
    // deduped set would just re-fetch data that's already there. Dispatches
    // on SQL content rather than call position: textSearch and semanticSearch
    // run concurrently (Promise.all), so their two calls each can interleave
    // in either order — asserting a fixed call index would be testing
    // scheduling, not behavior.
    const createdById: Record<string, string> = { a: '2026-06-01T00:00:00.000Z', b: '2026-06-02T00:00:00.000Z' };
    dbQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('search_notes_fts')) return [{ id: 'a', title: 'A', tags: [], rank: 0.5, headline: 'hi' }];
      if (sql.includes('match_chunks')) return [{ id: 'b', title: 'B', chunk_content: 'x', heading: null, tags: [], similarity: 0.8 }];
      if (sql.includes('id = any')) {
        const ids = params[0] as string[];
        return ids.filter((id) => id in createdById).map((id) => ({ id, created_at: createdById[id] }));
      }
      return [];
    });

    const results = await hybridSearch('q', 5);
    expect(dbQuery).toHaveBeenCalledTimes(4); // 2 per arm (search + enrich), nothing extra at the hybridSearch level
    const byId = Object.fromEntries(results.map((r) => [r.id, r.created_at]));
    expect(byId).toEqual(createdById);
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

describe('relevance normalization', () => {
  it('maps floor to 0, strong to 1, clamps outside', () => {
    const a = { floor: 0.4, strong: 0.6 };
    expect(normalizeRelevance(0.4, a)).toBe(0);
    expect(normalizeRelevance(0.6, a)).toBe(1);
    expect(normalizeRelevance(0.5, a)).toBeCloseTo(0.5, 5);
    expect(normalizeRelevance(0.2, a)).toBe(0);
    expect(normalizeRelevance(0.9, a)).toBe(1);
  });

  it('returns 0 for degenerate anchors instead of dividing by zero', () => {
    expect(normalizeRelevance(0.5, { floor: 0.5, strong: 0.5 })).toBe(0);
  });

  it('confidence bands: >=0.7 strong, >=0.35 moderate, else weak', () => {
    expect(confidenceFor(0.7)).toBe('strong');
    expect(confidenceFor(0.5)).toBe('moderate');
    expect(confidenceFor(0.34)).toBe('weak');
  });

  it('rrfMerge keeps the MAX relevance across arms, not a sum', () => {
    const merged = rrfMerge([
      { field: 'text_score', results: [make('a', 0.09, 0.3)] },
      { field: 'semantic_score', results: [make('a', 0.62, 0.9)] },
    ]);
    expect(merged[0].relevance).toBe(0.9);
    expect(merged[0].confidence).toBe('strong');
  });

  it('a single-arm hit keeps its full relevance despite the RRF rank penalty', () => {
    const merged = rrfMerge([
      { field: 'text_score', results: [make('both', 0.09, 0.6), make('solo-text', 0.05, 0.4)] },
      { field: 'semantic_score', results: [make('both', 0.6, 0.6)] },
    ]);
    const solo = merged.find(r => r.id === 'solo-text')!;
    expect(solo.relevance).toBe(0.4);
    expect(solo.matched_by).toEqual(['text_score']);
  });

  it('semanticSearch normalizes cosine against the model anchors', async () => {
    dbQuery.mockResolvedValue([
      { id: 'n1', title: 'N1', chunk_content: 'body', heading: null, tags: [], similarity: 0.75 },
      { id: 'n2', title: 'N2', chunk_content: 'body', heading: null, tags: [], similarity: 0.55 },
    ]);
    const out = await semanticSearch('q', 5);
    expect(out[0].relevance).toBe(1);
    expect(out[0].confidence).toBe('strong');
    expect(out[1].relevance).toBe(0);
    expect(out[1].confidence).toBe('weak');
    // the RPC still receives the floor as its cosine threshold
    expect(dbQuery.mock.calls[0][1][2]).toBe(0.55);
  });

  it('substring fallback: title hits rate above content hits', async () => {
    // FTS returns nothing → fallback; first query is byTitle, second byContent
    dbQuery
      .mockResolvedValueOnce([])                                              // search_notes_fts
      .mockResolvedValueOnce([{ id: 't', title: 'kmv', content: 'x', tags: [] }])   // ilike title
      .mockResolvedValueOnce([{ id: 'c', title: 'other', content: 'kmv', tags: [] }]); // ilike content
    const out = await textSearch('kmv', 5);
    const byId = Object.fromEntries(out.map(r => [r.id, r]));
    expect(byId['t'].relevance).toBe(0.65);
    expect(byId['c'].relevance).toBe(0.5);
    expect(byId['t'].confidence).toBe('moderate');
  });
});
