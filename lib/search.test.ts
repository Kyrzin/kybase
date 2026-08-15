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

const getFtsLanguages = vi.fn();
vi.mock('./settings', () => ({
  getFtsLanguages: (...a: unknown[]) => getFtsLanguages(...a),
}));

import { rrfMerge, makeExcerpt, tableHeaderAbove, stripLeadingHeading, textSearch, semanticSearch, hybridSearch, bestSemanticScore, confidenceFor, effectiveSemanticThreshold } from './search';

beforeEach(() => {
  dbQuery.mockReset().mockResolvedValue([]);
  getEmbedding.mockReset().mockResolvedValue([0.1, 0.2]);
  getMinSimilarity.mockReset().mockResolvedValue(0.55);
  getFtsLanguages.mockReset().mockResolvedValue(['russian', 'english']);
});

// text_tier: 'and' by default — most rrfMerge tests are exercising fusion
// logic, not the cascade-tier discount, so they should represent a normal
// strict text match unless a test overrides it (rrfMerge only reads this
// off text_score-field items; harmless on semantic_score ones).
const make = (id: string, score = 0, relevance = 0.5, textTier: 'and' | 'or' | 'substring' = 'and') =>
  ({ id, title: id, excerpt: '', tags: [] as string[], score, relevance, confidence: confidenceFor(relevance), text_tier: textTier });
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

  it('rrf_score is the sum of RRF contributions', () => {
    // single list, rank 0 → rrf_score = 1/(60+1) ≈ 0.01639
    const merged = rrfMerge([text([make('x')])]);
    expect(merged[0].rrf_score).toBeCloseTo(1 / 61, 5);
  });

  it('preserves each pass\'s own raw score under text_score/semantic_score', () => {
    const merged = rrfMerge([
      text([make('a', 0.9)]),
      semantic([make('a', 0.72)]),
    ]);
    expect(merged[0].text_score).toBe(0.9);
    expect(merged[0].semantic_score).toBe(0.72);
    // rrf_score itself stays the RRF fusion, not either raw value
    expect(merged[0].rrf_score).toBeCloseTo(1 / 61 + 1 / 61, 5);
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

  it('never sorts a weak hit above a moderate one, even on a tied rrf_score', () => {
    // Rank-0-in-a-single-arm gives an identical rrf_score (1/61) regardless
    // of which arm it came from — an easy, exact tie. Pre-fix, a plain
    // rrfScore sort left ties in Map insertion order: since the text list
    // is processed first below, the weak item would land first purely
    // because it happened to be in the first list passed in, not because
    // it deserved to outrank the moderate one (measured live, twice).
    const weak = make('weak-text-only', 0.02, 0.5); // relevance 0.5, 1 arm -> weak
    const moderate = make('moderate-semantic-only', 0.6, 0.95); // relevance 0.95, 1 arm -> moderate
    const merged = rrfMerge([
      { field: 'text_score', results: [weak] },
      { field: 'semantic_score', results: [moderate] },
    ]);
    expect(merged[0].rrf_score).toBeCloseTo(merged[1].rrf_score, 10); // confirms this really is a tie
    expect(merged[0].id).toBe('moderate-semantic-only');
    expect(merged.map((r) => r.confidence)).toEqual(['moderate', 'weak']);
  });

  it('confidence ordering invariant: weak never above moderate, moderate never above strong', () => {
    const strong = make('s', 0.09, 0.95); // will be re-scored strong only when both arms hit it below
    const moderate = make('m', 0.05, 0.95);
    const weak = make('w', 0.01, 0.4);
    const merged = rrfMerge([
      { field: 'text_score', results: [weak, moderate, strong] },
      { field: 'semantic_score', results: [strong] }, // only 's' gets a second arm -> strong
    ]);
    const rank = { strong: 0, moderate: 1, weak: 2 };
    for (let i = 1; i < merged.length; i++) {
      expect(rank[merged[i - 1].confidence]).toBeLessThanOrEqual(rank[merged[i].confidence]);
    }
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

describe('makeExcerpt — table header recovery', () => {
  // Enough that the window's natural center-on-match start lands well past
  // the header row, not just a few characters short of it — reproduces the
  // live failure (search on "Kybase — методика оценки embedding-моделей"),
  // not a construction that happens to snap back to the header for free.
  const filler = (n: number) => 'Вступительный текст перед таблицей для объёма. '.repeat(n);

  it('prepends header + separator when the window opens inside a table body', () => {
    const content = filler(20) + '\n\n' +
      '| Параметр | Значение | Комментарий |\n' +
      '|---|---|---|\n' +
      '| ОС | Linux 6.8 | аптайм 39 дней |\n' +
      '| RAM | 7.8 ГБ | swap увеличен недавно на диске |\n' +
      '| Контейнеры | ~39 шт | Traefik единственный вход |';
    const out = makeExcerpt(content, 'swap увеличен недавно', 100);
    expect(out).toContain('| Параметр | Значение | Комментарий |');
    expect(out).toContain('|---|---|---|');
    expect(out).toContain('swap увеличен недавно');
  });

  it('does not exceed the requested budget — the tail is shaved to make room for the header', () => {
    const content = filler(20) + '\n\n' +
      '| Параметр | Значение | Комментарий |\n' +
      '|---|---|---|\n' +
      '| ОС | Linux 6.8 | аптайм 39 дней |\n' +
      '| RAM | 7.8 ГБ | swap увеличен недавно на диске |\n' +
      '| Контейнеры | ~39 шт | Traefik единственный вход |';
    const out = makeExcerpt(content, 'swap увеличен недавно', 100);
    expect(out.length).toBeLessThanOrEqual(100 + '| Параметр | Значение | Комментарий |\n|---|---|---|\n'.length + 1);
  });

  it('recovers the header when the table is the very first thing in the note', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `| Строка${i} | Значение номер ${i} с текстом заполнения |`);
    const content = '| Параметр | Значение |\n|---|---|\n' + rows.join('\n');
    const out = makeExcerpt(content, 'Значение номер 15', 80);
    expect(out).toContain('| Параметр | Значение |');
    expect(out).toContain('|---|---|');
    expect(out).toContain('Значение номер 15');
  });

  it('recovers the header when the table is the last thing in the note', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `| Строка${i} | Значение номер ${i} с текстом заполнения |`);
    const content = filler(10) + '\n\n| Параметр | Значение |\n|---|---|\n' + rows.join('\n');
    const out = makeExcerpt(content, 'Значение номер 18', 80);
    expect(out).toContain('| Параметр | Значение |');
    expect(out).toContain('Значение номер 18');
  });

  it('match in the very first body row still shows the header (no duplicate)', () => {
    const content = filler(20) + '\n\n| Параметр | Значение |\n|---|---|\n| Первая строка | искомое значение тут |\n| Вторая | x |';
    const out = makeExcerpt(content, 'искомое значение', 60);
    const occurrences = out.split('| Параметр | Значение |').length - 1;
    expect(occurrences).toBe(1); // present, not duplicated
  });

  it('does not duplicate the header when the natural window already includes it', () => {
    // Short enough overall that centering on the match still lands at or
    // before the header — repair must recognize "already have it" and add
    // nothing.
    const content = 'x'.repeat(50) + '\n\n| A | B |\n|---|---|\n| match here | y |';
    const out = makeExcerpt(content, 'match here', 300);
    const occurrences = out.split('| A | B |').length - 1;
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  it('leaves behavior unchanged when the whole table fits in the window', () => {
    const content = filler(20) + '\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const out = makeExcerpt(content, '| 1 | 2 |', 300);
    expect(out).toContain('| A | B |');
    expect(out.split('| A | B |').length - 1).toBe(1);
  });

  it('a table with no body rows does not break a match found after it', () => {
    const content = '| A | B |\n|---|---|\n\n' + filler(30) + 'хвостовая фраза для поиска здесь';
    const out = makeExcerpt(content, 'хвостовая фраза', 60);
    expect(out).toContain('хвостовая фраза');
    // Nothing to recover — the match isn't inside a table at all.
    expect(out).not.toContain('| A | B |');
  });

  it('two tables in a row: a match in the second table recovers the second header, not the first', () => {
    const content = filler(15) +
      '\n\n| First | Table |\n|---|---|\n| f1 | f2 |\n\n' +
      '| Second | Table |\n|---|---|\n' +
      Array.from({ length: 10 }, (_, i) => `| row${i} | искомое совпадение номер ${i} с заполнением |`).join('\n');
    const out = makeExcerpt(content, 'искомое совпадение номер 7', 80);
    expect(out).toContain('| Second | Table |');
    expect(out).not.toContain('| First | Table |');
  });

  it('a | inside a fenced code block is not mistaken for a table', () => {
    const fence = '```\n| this | looks | like | a | table | but | is | code |\n|---|---|\n```';
    const content = filler(20) + '\n\n' + fence + '\n\n' + filler(5) + 'ключевая фраза в коде-фенсе тест';
    // Land the search match inside the fence content itself.
    const idxInFence = content.indexOf('| this | looks');
    const header = tableHeaderAbove(content, idxInFence);
    expect(header).toBeNull();
  });

  it('resolves through CRLF line endings', () => {
    // A few padding rows between the header and the match, same reasoning
    // as filler() above: without them the natural window can land exactly
    // on the header's own line by coincidence, which isn't what this case
    // is testing for.
    const content = filler(20).replace(/\n/g, '\r\n') + '\r\n\r\n' +
      '| Параметр | Значение |\r\n|---|---|\r\n' +
      '| A | заполняющая строка один |\r\n| B | заполняющая строка два |\r\n' +
      '| C | искомое значение тут |\r\n| D | y |';
    const out = makeExcerpt(content, 'искомое значение', 60);
    expect(out).toContain('| Параметр | Значение |');
  });
});

describe('tableHeaderAbove', () => {
  it('returns null when offset is not inside a table at all', () => {
    expect(tableHeaderAbove('just plain prose, no pipes here', 10)).toBeNull();
  });

  it('returns null for a stray | line with no separator row (not a real table)', () => {
    const content = 'a | b | c\nmore text here that is not a table row';
    expect(tableHeaderAbove(content, 2)).toBeNull();
  });

  it('returns the header/separator and the offset where they start', () => {
    const content = 'intro\n\n| H1 | H2 |\n|---|---|\n| a | b |';
    const bodyOffset = content.indexOf('| a | b |');
    const result = tableHeaderAbove(content, bodyOffset);
    expect(result?.text).toBe('| H1 | H2 |\n|---|---|\n');
    expect(result?.offset).toBe(content.indexOf('| H1 | H2 |'));
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
      .mockResolvedValueOnce([{ id: 'a', created_at: '2026-01-01T00:00:00.000Z' }]); // enrichResults
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

  it('attaches created_at and content_length to every result via one id = any($1) lookup', async () => {
    dbQuery
      .mockResolvedValueOnce([
        { id: 'a', title: 'A', tags: [], rank: 0.9, headline: 'hi' },
        { id: 'b', title: 'B', tags: [], rank: 0.5, headline: 'hi' },
      ])
      .mockResolvedValueOnce([
        { id: 'a', created_at: '2026-01-01T00:00:00.000Z', content_length: 120 },
        { id: 'b', created_at: '2026-02-01T00:00:00.000Z', content_length: 4300 },
      ]);
    const results = await textSearch('q', 5);
    const [sql, params] = dbQuery.mock.calls[1];
    expect(sql).toBe('select id, created_at, length(content) as content_length from notes where id = any($1)');
    expect(params).toEqual([['a', 'b']]);
    expect(results.map((r) => r.created_at)).toEqual(['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']);
    expect(results.map((r) => r.content_length)).toEqual([120, 4300]);
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

describe('textSearch — table header repair', () => {
  const NOTE_CONTENT = 'Вступление в заметку с достаточным объёмом текста для окна.\n\n' +
    '| Параметр | Значение |\n|---|---|\n| A | не это |\n' +
    '| B | часть строки, которую вернул ts_headline как сниппет |\n| C | y |';

  it('repairs a headline that opens inside a table with no separator in view', async () => {
    const brokenHeadline = '| B | часть строки, которую вернул ts_headline как сниппет |';
    dbQuery
      .mockResolvedValueOnce([{ id: 'a', title: 'A', tags: [], rank: 0.9, headline: brokenHeadline }])
      .mockResolvedValueOnce([{ id: 'a', content: NOTE_CONTENT }]) // repair fetch
      .mockResolvedValueOnce([{ id: 'a', created_at: '2026-01-01T00:00:00.000Z', content_length: 10 }]); // enrichResults

    const [result] = await textSearch('q', 5);
    expect(result.excerpt).toContain('| Параметр | Значение |');
    expect(result.excerpt).toContain('|---|---|');
    expect(result.excerpt).toContain(brokenHeadline);

    const [repairSql, repairParams] = dbQuery.mock.calls[1];
    expect(repairSql).toBe('select id, content from notes where id = any($1)');
    expect(repairParams).toEqual([['a']]);
  });

  it('does not touch an excerpt that already has its header, and fetches nothing extra', async () => {
    const cleanHeadline = '| Параметр | Значение |\n|---|---|\n| A | не это |';
    dbQuery
      .mockResolvedValueOnce([{ id: 'a', title: 'A', tags: [], rank: 0.9, headline: cleanHeadline }])
      .mockResolvedValueOnce([{ id: 'a', created_at: '2026-01-01T00:00:00.000Z', content_length: 10 }]); // enrichResults only

    const [result] = await textSearch('q', 5);
    expect(result.excerpt).toBe(cleanHeadline);
    expect(dbQuery).toHaveBeenCalledTimes(2); // FTS + enrichResults — no repair round trip
  });

  it('does not touch an excerpt with no table-shaped line at all', async () => {
    dbQuery
      .mockResolvedValueOnce([{ id: 'a', title: 'A', tags: [], rank: 0.9, headline: 'plain prose snippet, nothing table-shaped here' }])
      .mockResolvedValueOnce([{ id: 'a', created_at: '2026-01-01T00:00:00.000Z', content_length: 10 }]);
    await textSearch('q', 5);
    expect(dbQuery).toHaveBeenCalledTimes(2);
  });

  it('catches a snippet cropped mid-cell on both edges — no line is fully |...|-shaped', async () => {
    // Live case (Kybase — методика оценки embedding-моделей, query
    // "непригодна для RU"): ts_headline's MaxWords=45 crop landed after the
    // row's opening | and before its closing one on both lines, so neither
    // TABLE_ROW_RE nor a naive "starts and ends with |" check matches
    // either line — only counting | characters catches it.
    const brokenHeadline =
      'без префикса −0.004) | полоса 0.60–0.68, топ по «борщу» — нерелевантный «Кейс для резюме» 0.68 | непригодна для RU |\n' +
      '| embeddinggemma | separation +0.21 | резюме → топ сплошь резюме; борщ → ничего | разделяет RU';
    const noteContent = 'Вступление с достаточным объёмом текста, чтобы окно не совпало с началом.\n\n' +
      '| | контроль | живой прогон | вывод |\n|---|---|---|---|\n' +
      '| nomic-embed-text | separation +0.06 (без префикса −0.004) | полоса 0.60–0.68, топ по «борщу» — нерелевантный «Кейс для резюме» 0.68 | непригодна для RU |\n' +
      '| embeddinggemma | separation +0.21 | резюме → топ сплошь резюме; борщ → ничего | разделяет RU |';
    dbQuery
      .mockResolvedValueOnce([{ id: 'a', title: 'A', tags: [], rank: 0.9, headline: brokenHeadline }])
      .mockResolvedValueOnce([{ id: 'a', content: noteContent }])
      .mockResolvedValueOnce([{ id: 'a', created_at: '2026-01-01T00:00:00.000Z', content_length: 10 }]);

    const [result] = await textSearch('q', 5);
    expect(result.excerpt).toContain('| | контроль | живой прогон | вывод |');
    expect(result.excerpt).toContain('|---|---|---|---|');
  });

  it('caps repairs at MAX_TABLE_REPAIR_FETCHES and logs when the cap is hit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = (id: string) => ({ id, title: id, tags: [], rank: 0.5, headline: `| ${id} | broken row no separator |` });
    dbQuery
      .mockResolvedValueOnce([broken('a'), broken('b'), broken('c'), broken('d')]) // 4 broken, cap is 3
      .mockResolvedValueOnce([]) // repair fetch: none resolve, doesn't matter for the cap assertion
      .mockResolvedValueOnce([]); // enrichResults

    await textSearch('q', 5);
    const [, repairParams] = dbQuery.mock.calls[1];
    expect(repairParams[0]).toHaveLength(3); // only the first 3 of 4 fetched
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('4 broken excerpts'));
    warn.mockRestore();
  });

  it('leaves the excerpt untouched if the note is gone by repair time (deleted concurrently)', async () => {
    const brokenHeadline = '| B | broken row no separator here |';
    dbQuery
      .mockResolvedValueOnce([{ id: 'a', title: 'A', tags: [], rank: 0.9, headline: brokenHeadline }])
      .mockResolvedValueOnce([]) // repair fetch: id no longer found
      .mockResolvedValueOnce([]); // enrichResults
    const [result] = await textSearch('q', 5);
    expect(result.excerpt).toBe(brokenHeadline); // unchanged, not thrown
  });

  it('leaves the excerpt untouched if its first line cannot be located in the fetched content', async () => {
    // Content drifted since the FTS snapshot (edited concurrently) — the
    // headline's first line is no longer a literal substring.
    const brokenHeadline = '| B | this exact text is no longer in the note |';
    dbQuery
      .mockResolvedValueOnce([{ id: 'a', title: 'A', tags: [], rank: 0.9, headline: brokenHeadline }])
      .mockResolvedValueOnce([{ id: 'a', content: 'completely different content now' }])
      .mockResolvedValueOnce([]);
    const [result] = await textSearch('q', 5);
    expect(result.excerpt).toBe(brokenHeadline);
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
      heading: 'Диагностика', tags: [], similarity: 0.75, // well clear of the degenerate-set margin, irrelevant to what this test checks
    }]);
    const [r] = await semanticSearch('nomic русский', 5);
    expect(r.excerpt).toBe('[Диагностика] nomic оказалась непригодна на русском');
    expect(r.excerpt).not.toContain('##'); // markdown heading line stripped from the body
  });

  it('skips the created_at lookup entirely on an empty result — no wasted PK query', async () => {
    // match_chunks returns [] whenever nothing clears the similarity floor
    // (no embeddings yet, or everything below threshold) — a common, not
    // exceptional, outcome. enrichResults must not fire a second
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
    // Each arm now also fires its own enrichResults call, and the two
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
  it('textSearch scores ts_rank relative to this query\'s own best rank, not a fixed anchor', async () => {
    dbQuery
      .mockResolvedValueOnce([
        { id: 'a', title: 'A', tags: [], rank: 0.08, headline: 'hi' },
        { id: 'b', title: 'B', tags: [], rank: 0.04, headline: 'hi' },
      ])
      .mockResolvedValueOnce([]); // enrichResults, no created_at rows needed for this assertion
    const out = await textSearch('q', 5);
    expect(out[0].relevance).toBe(1); // top hit is always exactly 1.0
    expect(out[1].relevance).toBeCloseTo(0.04 / 0.08, 5);
  });

  it('confidence needs BOTH a high relevance and both arms to reach strong', () => {
    expect(confidenceFor(0.95, 2)).toBe('strong');
    expect(confidenceFor(0.95, 1)).toBe('moderate'); // one arm, however close to its own top — never strong
    expect(confidenceFor(0.75, 2)).toBe('moderate'); // both arms, but not near either one's own top
    expect(confidenceFor(0.5, 2)).toBe('weak');
    expect(confidenceFor(0.5, 1)).toBe('weak');
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

  // Both regressions below were measured live 2026-08-14 on a real vault
  // after steps 1-3 shipped, before the cascade-tier discount existed.
  it('regression: an OR-cascade-only text match never exceeds weak, however high its own relevance', () => {
    // The control-noise case: strict AND found nothing, OR matched a single
    // common word against unrelated notes, and the "best of that garbage"
    // got relevance 1.0 with no semantic corroboration at all.
    const merged = rrfMerge([
      { field: 'text_score', results: [make('noise', 0.02, 1.0, 'or')] },
    ]);
    expect(merged[0].confidence).toBe('weak');
  });

  it('regression: an OR-cascade text match does not count as corroboration for strong, even with a real semantic hit', () => {
    // The German-query case: strict AND on the text side found nothing, OR
    // matched broadly, and an unrelated note's incidental semantic score
    // combined with that OR match to read as "both arms agree" -> strong.
    const merged = rrfMerge([
      { field: 'text_score', results: [make('a', 0.03, 0.95, 'or')] },
      { field: 'semantic_score', results: [make('a', 0.6, 0.95)] },
    ]);
    expect(merged[0].confidence).not.toBe('strong');
    expect(merged[0].confidence).toBe('moderate'); // semantic alone still earns this
  });

  it('an OR-cascade text match DOES count as corroboration for strong when it has full coverage (шаг 3b refinement)', () => {
    // External-corpus review (2026-08-14): requiring strict-AND-only made
    // `strong` unreachable for 11/11 real queries on a short, precise
    // 28-note corpus — natural-language queries routinely don't echo a
    // note's exact wording, so the OR cascade fires even for a fully
    // correct match. coverage 1.0 (every significant word present, just not
    // via a valid strict tsquery) distinguishes that case from the
    // regression above (there, coverage was well under 1 — one word out of
    // several) without reopening it.
    const orFullCoverage = { id: 'a', title: 'a', excerpt: '', tags: [] as string[], score: 0.03, relevance: 0.95, confidence: confidenceFor(0.95, 0), text_tier: 'or' as const, coverage: 1 };
    const merged = rrfMerge([
      { field: 'text_score', results: [orFullCoverage] },
      { field: 'semantic_score', results: [make('a', 0.6, 0.95)] },
    ]);
    expect(merged[0].confidence).toBe('strong');
  });

  it('an OR-cascade text match with PARTIAL coverage still never reaches strong, even at high relevance', () => {
    const orPartialCoverage = { id: 'a', title: 'a', excerpt: '', tags: [] as string[], score: 0.03, relevance: 0.95, confidence: confidenceFor(0.95, 0), text_tier: 'or' as const, coverage: 0.6 };
    const merged = rrfMerge([
      { field: 'text_score', results: [orPartialCoverage] },
      { field: 'semantic_score', results: [make('a', 0.6, 0.95)] },
    ]);
    expect(merged[0].confidence).not.toBe('strong');
    expect(merged[0].confidence).toBe('moderate');
  });

  it('a genuine AND-tier text match plus a real semantic match still reaches strong', () => {
    // Confirms the fix didn't overcorrect — real two-arm agreement must
    // still work exactly as steps 1-2 established.
    const merged = rrfMerge([
      { field: 'text_score', results: [make('a', 0.09, 0.95, 'and')] },
      { field: 'semantic_score', results: [make('a', 0.6, 0.95)] },
    ]);
    expect(merged[0].confidence).toBe('strong');
  });

  it('textSearch: an OR-tier result is capped at weak standalone, not just inside hybrid', async () => {
    // Rule applies whether or not this ever reaches rrfMerge — a type=text
    // call on a near-empty query shouldn't read as moderate just because
    // the loosened pass's best-of-a-bad-set relevance is high.
    dbQuery
      .mockResolvedValueOnce([]) // strict AND: nothing
      .mockResolvedValueOnce([{ id: 'n', title: 'N', tags: [], rank: 0.02, headline: 'hi' }]) // OR pass
      .mockResolvedValueOnce([]); // enrichResults
    const [result] = await textSearch('какое то нерелевантное сообщение', 5);
    expect(result.text_tier).toBe('or');
    expect(result.confidence).toBe('weak');
  });

  it('semanticSearch scores relevance relative to this query\'s own best hit', async () => {
    // 0.72 is within 0.75x of the best (0.8 * 0.75 = 0.6), so it survives
    // the recall cutoff and gets a relative relevance — not an absolute one.
    dbQuery.mockResolvedValue([
      { id: 'n1', title: 'N1', chunk_content: 'body', heading: null, tags: [], similarity: 0.8 },
      { id: 'n2', title: 'N2', chunk_content: 'body', heading: null, tags: [], similarity: 0.72 },
    ]);
    const out = await semanticSearch('q', 5);
    expect(out).toHaveLength(2);
    expect(out[0].relevance).toBe(1); // top hit is always exactly 1.0
    expect(out[1].relevance).toBeCloseTo(0.72 / 0.8, 5);
    // single arm, standalone call — never strong regardless of relevance
    expect(out[0].confidence).toBe('moderate');
    // getMinSimilarity's floor is still the RPC's junk-gate threshold
    expect(dbQuery.mock.calls[0][1][2]).toBe(0.55);
  });

  it('drops candidates below 0.75x of this query\'s best hit — the recall cutoff, not a fixed cosine', async () => {
    dbQuery.mockResolvedValue([
      { id: 'n1', title: 'N1', chunk_content: 'body', heading: null, tags: [], similarity: 0.8 },
      // 0.5 clears getMinSimilarity's junk gate (mocked at 0.55... actually
      // match_chunks itself would have excluded anything under the floor;
      // this row simulates one that cleared the floor but is still far from
      // this query's own best hit) — 0.5 / 0.8 = 0.625, under the 0.75x cutoff.
      { id: 'n2', title: 'N2', chunk_content: 'body', heading: null, tags: [], similarity: 0.5 },
    ]);
    const out = await semanticSearch('q', 5);
    expect(out.map((r) => r.id)).toEqual(['n1']);
  });

  it('regression: a degenerate result set (best barely clears the floor) returns empty, not a false-confident top hit', async () => {
    // Measured live on nomic-embed-text 2026-08-14: noise cosines ~0.66,
    // signal cosines ~0.68 — a ~0.02 gap. getMinSimilarity's floor alone
    // can't separate them; this is the second layer that catches it.
    getMinSimilarity.mockResolvedValueOnce(0.65);
    dbQuery.mockResolvedValueOnce([
      { id: 'n1', title: 'N1', chunk_content: 'body', heading: null, tags: [], similarity: 0.66 }, // only 0.01 above the floor
    ]);
    const out = await semanticSearch('q', 5);
    expect(out).toEqual([]);
  });

  it('a result set with real headroom above the floor is unaffected by the degenerate-set guard', async () => {
    getMinSimilarity.mockResolvedValueOnce(0.30);
    dbQuery.mockResolvedValueOnce([
      { id: 'n1', title: 'N1', chunk_content: 'body', heading: null, tags: [], similarity: 0.53 }, // 0.23 above the floor
    ]);
    const out = await semanticSearch('q', 5);
    expect(out.map((r) => r.id)).toEqual(['n1']);
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
    // Single-arm, fixed-constant relevance well under 0.9 — confidence caps
    // at weak, same as any other single-arm hit that isn't near its own top.
    expect(byId['t'].confidence).toBe('weak');
  });
});

describe('effectiveSemanticThreshold (наряд-поиск-2026-08-14 шаг 3b, anomaly item 2)', () => {
  it('is the recall floor PLUS the degenerate-set margin, not the bare floor', async () => {
    // Measured live 2026-08-14: floor 0.30, best_score 0.305 → empty
    // results, but the envelope reported threshold: 0.3 — a caller had no
    // way to tell "0.305 is still short" from "the filter is broken",
    // because best_score (0.305) reads as clearing the reported threshold
    // (0.3) while the actual applied cutoff says otherwise. The margin
    // itself is 7% of the floor's remaining headroom (1 - floor), not a
    // flat cosine value (pre-publication review: a flat margin eats a
    // hugely different fraction of a compressed-range model's usable
    // headroom than a wide-range one) — 0.3 + 0.07×0.7 = 0.349, not the
    // old flat 0.35.
    getMinSimilarity.mockResolvedValueOnce(0.3);
    expect(await effectiveSemanticThreshold()).toBeCloseTo(0.349, 10);
  });

  it('the margin scales down for a model with a compressed range (high floor), not a fixed slice', async () => {
    // nomic-embed-text's floor (0.65) leaves only 0.35 of headroom — the
    // same flat 0.05 the old code used would have been ~14% of that, not
    // ~7%. Confirms the fraction is genuinely relative, not a renamed
    // constant that still happens to be flat.
    getMinSimilarity.mockResolvedValueOnce(0.65);
    expect(await effectiveSemanticThreshold()).toBeCloseTo(0.65 + 0.07 * 0.35, 10);
  });
});

describe('textSearch — query coverage (наряд-поиск-2026-08-14 шаг 3b)', () => {
  // Coverage queries: first call decides which of the query's words are
  // "significant" (non-empty in at least one configured FTS language),
  // second call counts how many of those significant words each candidate
  // id actually contains. Both go through the same mocked dbQuery used for
  // search_notes_fts, in call order.
  const sig = (words: string[]) => words.map((word) => ({ word, significant: true }));
  const counts = (rows: { id: string; matched: number; total: number }[]) => rows;

  it('discounts an OR-cascade hit that matched one word out of three — order of operations: coverage multiplies AFTER rank normalization', async () => {
    dbQuery
      .mockResolvedValueOnce([]) // strict AND: nothing
      .mockResolvedValueOnce([{ id: 'noise', title: 'Noise', tags: [], rank: 0.02, headline: 'hi' }]) // OR pass, single hit
      .mockResolvedValueOnce(sig(['банан', 'рецепт', 'мороженого'])) // coverage: significance
      .mockResolvedValueOnce(counts([{ id: 'noise', matched: 1, total: 3 }])) // coverage: match counts
      .mockResolvedValueOnce([]); // enrichResults
    const [result] = await textSearch('банан рецепт мороженого', 5);
    expect(result.text_tier).toBe('or');
    // Rank-normalized alone would be exactly 1.0 (sole OR hit) — coverage
    // (1/3) must still show up multiplied on top, not cancelled out.
    expect(result.coverage).toBeCloseTo(1 / 3, 5);
    expect(result.relevance).toBeCloseTo(1 * (1 / 3), 5);
    expect(result.confidence).toBe('weak'); // OR tier, 0 corroborating arms, regardless of the number
  });

  it('does not collapse two different-rank hits to the same relevance just because they share a coverage ratio', async () => {
    // Regression guard for the exact bug flagged live: multiplying coverage
    // in BEFORE dividing by the set's max rank would let a shared 0.2
    // multiplier divide out of both sides and hand every hit relevance 1.0
    // again. Applying it after must preserve the two hits' relative order.
    dbQuery
      .mockResolvedValueOnce([]) // strict AND: nothing
      .mockResolvedValueOnce([
        { id: 'a', title: 'A', tags: [], rank: 0.05, headline: 'hi' },
        { id: 'b', title: 'B', tags: [], rank: 0.03, headline: 'hi' },
      ]) // OR pass
      .mockResolvedValueOnce(sig(['один', 'два', 'три', 'четыре', 'пять']))
      .mockResolvedValueOnce(counts([
        { id: 'a', matched: 1, total: 5 },
        { id: 'b', matched: 1, total: 5 },
      ]))
      .mockResolvedValueOnce([]); // enrichResults
    const out = await textSearch('один два три четыре пять', 5);
    const byId = Object.fromEntries(out.map((r) => [r.id, r]));
    expect(byId['a'].coverage).toBeCloseTo(0.2, 5);
    expect(byId['b'].coverage).toBeCloseTo(0.2, 5);
    // Rank-normalized first: a=0.05/0.05=1, b=0.03/0.05=0.6 — THEN ×0.2.
    expect(byId['a'].relevance).toBeCloseTo(0.2, 5);
    expect(byId['b'].relevance).toBeCloseTo(0.12, 5);
    expect(byId['a'].relevance).toBeGreaterThan(byId['b'].relevance); // order preserved, not flattened to 1.0/1.0
  });

  it('leaves a genuine AND-tier full match at relevance 1.0 — single-word identifiers do not degrade', async () => {
    // No coverage round trip at all here: coverage only ever applies to the
    // 'or' tier (see textSearch), and a single word never triggers the OR
    // pass in the first place (words.length > 2 gate) — 'and' tier hits are
    // unconditionally coverage: 1, not computed and discovered to be 1.
    dbQuery
      .mockResolvedValueOnce([{ id: 'r', title: 'Runbook', tags: ['runbook'], rank: 0.5, headline: 'hi' }]) // strict AND
      .mockResolvedValueOnce([]); // enrichResults
    const [result] = await textSearch('runbook', 5);
    expect(result.text_tier).toBe('and');
    expect(result.coverage).toBe(1);
    expect(result.relevance).toBe(1);
    expect(dbQuery).toHaveBeenCalledTimes(2); // no coverage query fired for an AND-only, single-word result
  });

  it('an AND-tier hit is never coverage-discounted even when it coexists with an OR pass — dotted identifiers are one lexeme to Postgres, not to a naive JS split', async () => {
    // Measured live 2026-08-14: "host1.example.cloud" is one lexeme to
    // websearch_to_tsquery's own dotted-host tokenizer, but a plain JS
    // regex split (significantWords) naively cuts it into three —
    // "host1"/"example"/"cloud" — and testing those as three separate
    // lexemes against a vector that stored the hostname as one dropped a
    // correct, exact AND match from relevance 1.0 to 0.33. Two different
    // tokenizers must never be asked to agree — scoping coverage to the OR
    // tier sidesteps the disagreement instead of chasing consistency
    // between them.
    dbQuery
      .mockResolvedValueOnce([{ id: 'host', title: 'srv1.example.com', tags: [], rank: 0.5, headline: 'hi' }]) // strict AND: exact hit
      .mockResolvedValueOnce([{ id: 'noise', title: 'Noise', tags: [], rank: 0.01, headline: 'hi' }]) // OR pass also returns something
      .mockResolvedValueOnce(sig(['one', 'two', 'three']))
      .mockResolvedValueOnce(counts([{ id: 'noise', matched: 1, total: 3 }])) // coverage only ever looked up for the OR id
      .mockResolvedValueOnce([]); // enrichResults
    const out = await textSearch('srv1 one two three', 5);
    const coverageParams = dbQuery.mock.calls[3][1] as unknown[]; // the match-count query's params
    expect(coverageParams[coverageParams.length - 1]).toEqual(['noise']); // never 'host'
    const host = out.find((r) => r.id === 'host')!;
    expect(host.text_tier).toBe('and');
    expect(host.coverage).toBe(1);
    expect(host.relevance).toBe(1); // top of its own set, undiscounted
  });

  it('sorts by confidence first, relevance second — a high-coverage AND hit outranks a same-relevance OR hit', async () => {
    // Both tiers can end up at the same numeric relevance after the
    // discount; text_tier still decides corroboratingArms (and therefore
    // confidence), and confidence must win the sort, not array order.
    dbQuery
      .mockResolvedValueOnce([{ id: 'strict', title: 'Strict', tags: [], rank: 0.048, headline: 'hi' }]) // strict AND
      .mockResolvedValueOnce([{ id: 'loose', title: 'Loose', tags: [], rank: 0.05, headline: 'hi' }]) // OR pass, higher raw rank
      .mockResolvedValueOnce(sig(['aaa', 'bbb', 'ccc']))
      .mockResolvedValueOnce(counts([
        { id: 'strict', matched: 3, total: 3 }, // full coverage
        { id: 'loose', matched: 3, total: 3 },  // also full coverage, but OR tier
      ]))
      .mockResolvedValueOnce([]); // enrichResults
    const out = await textSearch('aaa bbb ccc', 5);
    // best = max(0.048, 0.05) = 0.05 → strict normalizes to 0.96 (moderate,
    // 1 arm), loose normalizes to the full 1.0 but is forced to weak by its
    // 0 corroborating arms (or tier). 'loose' has the higher raw rank, so
    // without a confidence-first sort it would land first — it must not.
    expect(out[0].id).toBe('strict');
    expect(out[0].confidence).toBe('moderate');
    expect(out[1].id).toBe('loose');
    expect(out[1].confidence).toBe('weak');
  });

  it('fails open (no discount, no crash) if the coverage query itself errors', async () => {
    dbQuery
      .mockResolvedValueOnce([]) // strict AND: nothing
      .mockResolvedValueOnce([{ id: 'n', title: 'N', tags: [], rank: 0.02, headline: 'hi' }]) // OR pass
      .mockRejectedValueOnce(new Error('invalid regconfig: "klingon"')) // coverage: significance query throws
      .mockResolvedValueOnce([]); // enrichResults
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [result] = await textSearch('какой то запрос тут', 5);
    expect(result.coverage).toBe(1); // no discount applied
    expect(result.relevance).toBe(1); // unaffected — same as before 3b
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('coverage computation failed'), expect.anything());
    warn.mockRestore();
  });
});

describe('semanticSearch — chunk dedup (наряд-поиск-2026-08-14 шаг 6 side effect)', () => {
  it('never returns the same note twice even when match_chunks returns 2 of its chunks', async () => {
    // Measured live: "семейное предприятие..." returned the same note
    // twice in a 3-slot result set (migration 017 lets match_chunks return
    // up to 2 rows per note). Best-scoring chunk per note wins; the note
    // still occupies exactly one result slot.
    dbQuery.mockResolvedValueOnce([
      { id: 'book', title: 'Book', chunk_content: 'chunk A — best', heading: null, tags: [], similarity: 0.9 },
      { id: 'other', title: 'Other', chunk_content: 'chunk X', heading: null, tags: [], similarity: 0.85 },
      { id: 'book', title: 'Book', chunk_content: 'chunk B — worse', heading: null, tags: [], similarity: 0.8 },
    ]);
    const out = await semanticSearch('q', 5);
    expect(out.map((r) => r.id)).toEqual(['book', 'other']); // 'book' once, not twice
    expect(out.find((r) => r.id === 'book')!.excerpt).toContain('chunk A');
    expect(out.find((r) => r.id === 'book')!.excerpt).not.toContain('chunk B');
  });

  it('a duplicate chunk does not crowd out a genuinely different note within `limit`', async () => {
    dbQuery.mockResolvedValueOnce([
      { id: 'book', title: 'Book', chunk_content: 'chunk A', heading: null, tags: [], similarity: 0.9 },
      { id: 'book', title: 'Book', chunk_content: 'chunk B', heading: null, tags: [], similarity: 0.88 },
      { id: 'other', title: 'Other', chunk_content: 'chunk X', heading: null, tags: [], similarity: 0.8 },
    ]);
    const out = await semanticSearch('q', 2); // only 2 slots requested
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.id)).toEqual(['book', 'other']); // both distinct notes, not book twice
  });
});
