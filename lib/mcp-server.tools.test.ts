// End-to-end tests for the MCP tools: the real server from createMcpServer()
// is driven through an in-memory transport by a real MCP Client, so tool
// registration, argument validation, and result shaping are all exercised.
// Only the data layer (db/search/indexing/semantic-edges) is mocked;
// wikilink parsing runs for real.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const query = vi.fn();
const queryOne = vi.fn();
const txClientQuery = vi.fn();
const withTransaction = vi.fn(async (fn: (c: { query: typeof txClientQuery }) => unknown) => fn({ query: txClientQuery }));
vi.mock('./db', () => ({
  query: (...a: unknown[]) => query(...a),
  queryOne: (...a: unknown[]) => queryOne(...a),
  withTransaction: (fn: (c: { query: typeof txClientQuery }) => unknown) => withTransaction(fn),
  isUniqueViolation: (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505',
  FOLDER_REPARENT_LOCK_KEY: 0x666f6c64,
}));

const textSearch = vi.fn();
const semanticSearch = vi.fn();
const hybridSearch = vi.fn();
const bestSemanticScore = vi.fn();
vi.mock('./search', async () => {
  const actual = await vi.importActual<typeof import('./search')>('./search');
  return {
    textSearch: (...a: unknown[]) => textSearch(...a),
    semanticSearch: (...a: unknown[]) => semanticSearch(...a),
    hybridSearch: (...a: unknown[]) => hybridSearch(...a),
    bestSemanticScore: (...a: unknown[]) => bestSemanticScore(...a),
    makeExcerpt: actual.makeExcerpt,
    // Real implementation (getMinSimilarity + MIN_SIGNAL_MARGIN) — it's a
    // one-line composition of two things already independently mocked/
    // tested (getMinSimilarity here, MIN_SIGNAL_MARGIN in search.test.ts),
    // not worth its own fake here.
    effectiveSemanticThreshold: actual.effectiveSemanticThreshold,
  };
});

const getMinSimilarity = vi.fn();
vi.mock('./embeddings', () => ({ getMinSimilarity: (...a: unknown[]) => getMinSimilarity(...a) }));

const indexNoteAsync = vi.fn();
vi.mock('./indexing', () => ({ indexNoteAsync: (...a: unknown[]) => indexNoteAsync(...a) }));

const getSemanticEdges = vi.fn();
vi.mock('./semantic-edges', () => ({ getSemanticEdges: (...a: unknown[]) => getSemanticEdges(...a) }));

import { createMcpServer } from './mcp-server';
import { MAX_NOTE_CONTENT_CHARS } from './types';

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function connectClient() {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Call a tool; return the parsed JSON of its first text block. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const client = await connectClient();
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  expect(res.isError, `tool ${name} unexpectedly errored: ${res.content?.[0]?.text}`).toBeFalsy();
  const text = res.content[0].text;
  try { return JSON.parse(text); } catch { return text; }
}

/** Call a tool expecting a handler error; return the error text. */
async function callExpectingError(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const client = await connectClient();
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  expect(res.isError, `tool ${name} was expected to error but succeeded`).toBe(true);
  return res.content[0].text;
}

beforeEach(() => {
  query.mockReset().mockResolvedValue([]);
  queryOne.mockReset().mockResolvedValue(null);
  txClientQuery.mockReset().mockResolvedValue({ rows: [] });
  withTransaction.mockClear();
  textSearch.mockReset().mockResolvedValue([]);
  semanticSearch.mockReset().mockResolvedValue([]);
  hybridSearch.mockReset().mockResolvedValue([]);
  bestSemanticScore.mockReset().mockResolvedValue(null);
  getMinSimilarity.mockReset().mockResolvedValue(0.55);
  indexNoteAsync.mockReset();
  getSemanticEdges.mockReset().mockResolvedValue([]);
});

describe('tools/list', () => {
  it('registers all 17 tools', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'append_to_note', 'create_folder', 'create_note', 'delete_folder', 'delete_note',
      'get_backlinks', 'get_graph', 'get_note', 'indexing_status',
      'list_folders', 'list_notes', 'list_tags', 'replace_in_note', 'restore_note',
      'search_notes', 'update_folder', 'update_note',
    ]);
  });

  // A `+`-concatenation of two interpolated template literals loses the left
  // operand's trailing text in the Next build, which shipped a description
  // reading "default 200004000 chars" to every agent. Keep the numbers apart.
  it('states both content limits intelligibly', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const getNote = tools.find((t) => t.name === 'get_note')!;
    expect(getNote.description).toContain('20000 chars by default');
    expect(getNote.description).toContain('capped at 4000 chars');
    for (const t of tools) expect(t.description).not.toMatch(/\d{6,}/);
  });

  it('advertises a ceiling on note content in both write schemas', async () => {
    // Nothing bounded content until the platform's request cap was raised to
    // let real imports through; the agent is the write path most likely to
    // paste something enormous, so the limit has to be in its schema.
    const client = await connectClient();
    const { tools } = await client.listTools();
    for (const name of ['create_note', 'update_note']) {
      const props = (tools.find(t => t.name === name)!.inputSchema as {
        properties: Record<string, { maxLength?: number }>;
      }).properties;
      expect(props.content?.maxLength, `${name}.content`).toBe(MAX_NOTE_CONTENT_CHARS);
    }
  });
});

describe('list_notes', () => {
  it('filters by folder_id and tag and applies the limit', async () => {
    query.mockResolvedValue([{ id: '1', title: 'A' }]);
    await call('list_notes', { folder_id: '11111111-1111-4111-8111-111111111111', tag: 'x', limit: 10 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('folder_id = $1');
    expect(sql).toContain('tags @> $2');
    expect(params).toEqual(['11111111-1111-4111-8111-111111111111', ['x'], 10]);
  });

  it('always excludes trashed notes, even unfiltered', async () => {
    await call('list_notes', {});
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('deleted_at is null');
    expect(params).toEqual([20]); // default limit
  });

  it('trashed:true lists soft-deleted notes instead, ignoring folder_id/tag', async () => {
    query.mockResolvedValue([{ id: '1', title: 'Gone', deleted_at: '2026-01-01T00:00:00Z' }]);
    await call('list_notes', { trashed: true, limit: 20 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('deleted_at is not null');
    expect(params).toEqual([20]);
  });

  it('projects created_at and content_length alongside the existing columns', async () => {
    await call('list_notes', {});
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('created_at');
    expect(sql).toContain('length(content) as content_length');
  });

  it('filters by created_after/created_before, symmetric with updated_after/updated_before', async () => {
    await call('list_notes', { created_after: '2026-01-01', created_before: '2026-06-01' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('created_at >= $1');
    expect(sql).toContain('created_at <= $2');
    expect(params).toEqual(['2026-01-01', '2026-06-01', 20]);
  });

  it('defaults to sorting by updated_at (unchanged behavior)', async () => {
    await call('list_notes', {});
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('order by updated_at desc');
  });

  it('sort:"created" orders by created_at instead', async () => {
    await call('list_notes', { sort: 'created' });
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('order by created_at desc');
    expect(sql).not.toContain('order by updated_at desc');
  });
});

describe('indexing_status', () => {
  it('reports total/indexed/pending and completeness from one aggregate', async () => {
    queryOne.mockResolvedValue({ total: 14, pending: 3 });
    const out = await call('indexing_status', {}) as Record<string, unknown>;
    const [sql] = queryOne.mock.calls[0];
    expect(sql).toContain('embedding_pending');
    expect(sql).toContain('deleted_at is null');
    expect(out).toEqual({ total: 14, indexed: 11, pending: 3, complete: false });
  });

  it('is complete when nothing is pending', async () => {
    queryOne.mockResolvedValue({ total: 5, pending: 0 });
    const out = await call('indexing_status', {});
    expect(out).toEqual({ total: 5, indexed: 5, pending: 0, complete: true });
  });

  it('treats an empty vault (null row) as complete with zero counts', async () => {
    queryOne.mockResolvedValue(null);
    const out = await call('indexing_status', {});
    expect(out).toEqual({ total: 0, indexed: 0, pending: 0, complete: true });
  });
});

describe('list_tags', () => {
  it('returns the tag/count rows from an unnest+group-by, most-used first', async () => {
    query.mockResolvedValue([{ tag: 'workflow', count: 9 }, { tag: 'проект', count: 3 }]);
    const out = await call('list_tags', {}) as { tag: string; count: number }[];
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('unnest(tags)');
    expect(sql).toContain('count(*)');
    expect(sql).toContain('order by count desc');
    expect(sql).toContain('limit $1');
    expect(params).toEqual([40]); // default limit
    expect(out).toEqual([{ tag: 'workflow', count: 9 }, { tag: 'проект', count: 3 }]);
  });

  it('caps the tag list at a caller-given limit', async () => {
    query.mockResolvedValue([]);
    await call('list_tags', { limit: 5 });
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([5]);
  });

  it('is advertised in the create_note/update_note tag guidance', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    for (const name of ['create_note', 'update_note']) {
      expect(tools.find(t => t.name === name)!.description).toContain('list_tags');
    }
  });
});

describe('get_note outline and sections', () => {
  const NOTE = [
    '# Title',
    'intro',
    '',
    '## Alpha',
    'alpha body',
    '',
    '## Beta',
    'beta body',
  ].join('\n');

  it('returns the outline so a truncated read still shows what was left behind', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'T', content: NOTE });
    const out = await call('get_note', { id: '11111111-1111-4111-8111-111111111111' }) as
      { headings: { text: string; offset: number }[] };
    expect(out.headings.map(h => h.text)).toEqual(['Title', 'Alpha', 'Beta']);
    // Offsets must address the real content, not a re-rendered copy.
    expect(NOTE.slice(out.headings[2].offset)).toMatch(/^## Beta/);
  });

  it('section returns that heading and its body, stopping at the next one', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'T', content: NOTE });
    const out = await call('get_note', {
      id: '11111111-1111-4111-8111-111111111111', section: 'Alpha',
    }) as { content: string };
    expect(out.content).toContain('## Alpha');
    expect(out.content).toContain('alpha body');
    expect(out.content).not.toContain('Beta');
    expect(out.content).not.toContain('intro');
  });

  it('a section can be named by its slug as well as its text', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'T', content: NOTE });
    const out = await call('get_note', {
      id: '11111111-1111-4111-8111-111111111111', section: 'beta',
    }) as { content: string };
    expect(out.content).toContain('beta body');
  });

  it('finds a section across scripts and across Unicode normal forms', async () => {
    // Headings are not all ASCII, and "é" has two encodings: macOS writes NFD,
    // most editors NFC. Byte-comparing them calls an existing section missing.
    const note = '# Intro\nx\n\n## 项目结构\ncjk body\n\n## Café\naccent body\n';
    queryOne.mockResolvedValue({ id: '1', title: 'T', content: note });
    const id = '11111111-1111-4111-8111-111111111111';

    const cjk = await call('get_note', { id, section: '项目结构' }) as { content: string };
    expect(cjk.content).toContain('cjk body');

    const nfd = 'Café'; // e + combining acute, same word as the NFC heading
    const accent = await call('get_note', { id, section: nfd }) as { content: string };
    expect(accent.content).toContain('accent body');
  });

  it('an unknown section lists the ones that exist instead of failing blankly', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'T', content: NOTE });
    const err = await callExpectingError('get_note', {
      id: '11111111-1111-4111-8111-111111111111', section: 'Nope',
    });
    expect(err).toContain('Alpha');
    expect(err).toContain('Beta');
  });
});

describe('get_note', () => {
  it('escapes ilike wildcards in a title lookup (audit fix)', async () => {
    queryOne.mockResolvedValue({ id: '1', title: '50%_off', content: 'hi' });
    await call('get_note', { title: '50%_off' });
    expect(queryOne.mock.calls[0][1]).toEqual(['50\\%\\_off']);
  });

  it('windows long content and reports truncation', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'Big', content: 'x'.repeat(30000) });
    const out = await call('get_note', { id: '11111111-1111-4111-8111-111111111111' }) as Record<string, unknown>;
    expect(out.content_truncated).toBe(true);
    expect(out.content_total_length).toBe(30000);
    expect(out.next_offset).toBe(20000);
  });

  it('errors when neither id nor title is given', async () => {
    expect(await callExpectingError('get_note', {})).toContain('Provide either id or title');
  });

  it('errors when the note is missing', async () => {
    queryOne.mockResolvedValue(null);
    expect(await callExpectingError('get_note', { title: 'nope' })).toContain('Note not found');
  });
});

// Titles in a real vault are long and composite, so an agent rarely reproduces
// one verbatim: get_note(title=...) resolves exact, then prefix, then substring.
describe('get_note title fallback', () => {
  /** Serve note rows only for the given ilike patterns; everything else (folders, hints) is empty. */
  function notesMatching(byPattern: Record<string, Record<string, unknown>[]>) {
    return async (sql: string, params: unknown[]) => {
      if (!String(sql).includes('from notes where title ilike')) return [];
      return byPattern[String(params[0])] ?? [];
    };
  }

  it('keeps an exact match authoritative and skips the fallbacks entirely', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'Exact', content: 'hi' });
    await call('get_note', { title: 'Exact' });
    const widened = query.mock.calls.filter(([sql]) => String(sql).includes('from notes where title ilike'));
    expect(widened).toHaveLength(0);
  });

  it('resolves a unique prefix to that note', async () => {
    queryOne.mockResolvedValue(null);
    query.mockImplementation(notesMatching({
      'Kybase — открытые пункты%': [{ id: 'n1', title: 'Kybase — открытые пункты и идеи', content: 'body' }],
    }));
    const out = await call('get_note', { title: 'Kybase — открытые пункты' }) as Record<string, unknown>;
    expect(out.id).toBe('n1');
    expect(out.content).toBe('body');
  });

  it('returns the candidate list instead of an error string when the prefix is ambiguous', async () => {
    queryOne.mockResolvedValue(null);
    query.mockImplementation(notesMatching({
      'Kybase%': [
        { id: 'n1', title: 'Kybase — A', content: 'a' },
        { id: 'n2', title: 'Kybase — B', content: 'b' },
      ],
    }));
    const err = await callExpectingError('get_note', { title: 'Kybase' });
    expect(err).toContain('matches 2 notes');
    expect(err).toContain('n1');
    expect(err).toContain('Kybase — B');
  });

  it('falls through to a substring match when nothing starts with the title', async () => {
    queryOne.mockResolvedValue(null);
    query.mockImplementation(notesMatching({
      '%Zoho MCP%': [{ id: 'n3', title: 'Хэндофф проектному агенту: Zoho MCP (эталон)', content: 'c' }],
    }));
    const out = await call('get_note', { title: 'Zoho MCP' }) as Record<string, unknown>;
    expect(out.id).toBe('n3');
  });

  it('suggests the closest titles on a total miss', async () => {
    queryOne.mockResolvedValue(null);
    query.mockImplementation(async (sql: string) =>
      String(sql).includes('select title from notes')
        ? [{ title: 'Kybase — фидбэк по MCP-инструментам' }]
        : []);
    const err = await callExpectingError('get_note', { title: 'Kybase фидбэк отсутствующий' });
    expect(err).toContain('Note not found');
    expect(err).toContain('Closest titles');
    expect(err).toContain('Kybase — фидбэк по MCP-инструментам');
    expect(err).toContain('search_notes');
  });

  it('escapes wildcards in the widened patterns too', async () => {
    queryOne.mockResolvedValue(null);
    query.mockImplementation(notesMatching({}));
    await callExpectingError('get_note', { title: '50%_off' });
    const patterns = query.mock.calls
      .filter(([sql]) => String(sql).includes('from notes where title ilike'))
      .map(([, params]) => (params as unknown[])[0]);
    expect(patterns).toEqual(['50\\%\\_off%', '%50\\%\\_off%']);
  });

  it('applies the same resolution with resolve_links', async () => {
    queryOne.mockResolvedValue(null);
    query.mockImplementation(notesMatching({
      'Хэндофф%': [{ id: 'n9', title: 'Хэндофф проектному агенту: Zoho MCP', content: 'no links here' }],
    }));
    const out = await call('get_note', { title: 'Хэндофф', resolve_links: true }) as Record<string, unknown>;
    expect(out.id).toBe('n9');
  });
});

describe('append_to_note', () => {
  const NOTE = ['# Log', '', '## Today', 'first entry', '', '## Later', 'nothing yet'].join('\n');

  const ID = '11111111-1111-4111-8111-111111111111';

  /** Resolve the id, then the locked read and the write inside the transaction. */
  const mockNote = (content = NOTE) => {
    queryOne.mockResolvedValue({ id: 'n1' });
    txClientQuery
      .mockResolvedValueOnce({ rows: [{ title: 'Log', content }] })
      .mockResolvedValueOnce({ rows: [{ id: 'n1', title: 'Log', updated_at: 'now' }] });
  };

  it('adds to the end of the note without resending what was already there', async () => {
    mockNote();
    await call('append_to_note', { id: ID, content: 'second entry' });
    const [sql, params] = txClientQuery.mock.calls[1];
    expect(sql).toContain('update notes set content');
    expect(sql).toContain('embedding_pending = true');
    expect(params[0]).toContain('first entry');   // old text survives
    expect(params[0]).toContain('second entry');  // new text landed
    expect(params[0].indexOf('second entry')).toBeGreaterThan(params[0].indexOf('nothing yet'));
  });

  it('reads the note under a row lock so a concurrent append cannot be lost', async () => {
    // Append is read-modify-write: without the lock two sessions build on the
    // same text and the first one's line disappears without a trace.
    mockNote();
    await call('append_to_note', { id: ID, content: 'x' });
    expect(withTransaction).toHaveBeenCalled();
    expect(txClientQuery.mock.calls[0][0]).toMatch(/select[\s\S]*for update/i);
  });

  it('appending to a section lands before the next heading, not after it', async () => {
    mockNote();
    await call('append_to_note', { id: ID, content: 'same-day note', section: 'Today' });
    const body = txClientQuery.mock.calls[1][1][0] as string;
    // Reads as part of "Today" to anyone opening the note.
    expect(body.indexOf('same-day note')).toBeGreaterThan(body.indexOf('first entry'));
    expect(body.indexOf('same-day note')).toBeLessThan(body.indexOf('## Later'));
  });

  it('re-embeds the note in the background', async () => {
    mockNote();
    await call('append_to_note', { id: ID, content: 'x' });
    expect(indexNoteAsync).toHaveBeenCalledOnce();
  });

  it('refuses an unknown section rather than appending in the wrong place', async () => {
    mockNote();
    const err = await callExpectingError('append_to_note', {
      id: ID, content: 'x', section: 'Missing',
    });
    expect(err).toContain('Today');
  });

  it('refuses a write that would exceed the note content limit, note left untouched', async () => {
    mockNote('# Log\n\nshort');
    const err = await callExpectingError('append_to_note', {
      id: ID, content: 'x'.repeat(MAX_NOTE_CONTENT_CHARS),
    });
    expect(err).toContain(`${MAX_NOTE_CONTENT_CHARS}-character limit`);
    // Only the locked read happened — no update statement was sent.
    expect(txClientQuery).toHaveBeenCalledTimes(1);
  });

  describe('at', () => {
    // The actual failure mode this guards: a journal with an H1 title and a
    // blockquote legend under it, "new entries on top" convention. Naive
    // offset-0 insertion lands the new entry ABOVE the H1 — the one case
    // this parameter exists to fix.
    const JOURNAL = [
      '# Kybase — journal',
      '',
      '> Closed passes, newest first.',
      '> Format: ...',
      '',
      '## External review 2026-08-11',
      'body one',
      '',
      '## Roadmap',
      'body two',
    ].join('\n');

    it('note_start lands after the H1/intro, before the first nested heading — not offset 0', async () => {
      mockNote(JOURNAL);
      await call('append_to_note', { id: ID, content: 'new entry', at: 'note_start' });
      const body = txClientQuery.mock.calls[1][1][0] as string;
      expect(body.indexOf('# Kybase — journal')).toBeLessThan(body.indexOf('new entry'));
      expect(body.indexOf('Closed passes')).toBeLessThan(body.indexOf('new entry'));
      expect(body.indexOf('new entry')).toBeLessThan(body.indexOf('## External review 2026-08-11'));
    });

    it('note_start falls back to the end of the note when there is only one heading', async () => {
      mockNote(['# Only heading', 'some prose'].join('\n'));
      await call('append_to_note', { id: ID, content: 'tail entry', at: 'note_start' });
      const body = txClientQuery.mock.calls[1][1][0] as string;
      expect(body.trim().endsWith('tail entry')).toBe(true);
    });

    it('note_start on a note with no headings at all lands at offset 0', async () => {
      mockNote('just prose, no headings');
      await call('append_to_note', { id: ID, content: 'front entry', at: 'note_start' });
      const body = txClientQuery.mock.calls[1][1][0] as string;
      // insertAddition always blank-line-separates from head, even an empty
      // one — same as today's note_end against an empty note. What matters
      // here is order: the addition precedes the original text, not offset 0
      // literally being glued to "front entry" with no separator at all.
      expect(body.trim().startsWith('front entry')).toBe(true);
      expect(body.indexOf('front entry')).toBeLessThan(body.indexOf('just prose'));
    });

    it('before_section lands above the section\'s own heading line', async () => {
      mockNote();
      await call('append_to_note', { id: ID, content: 'new section text', section: 'Later', at: 'before_section' });
      const body = txClientQuery.mock.calls[1][1][0] as string;
      expect(body.indexOf('new section text')).toBeGreaterThan(body.indexOf('## Today'));
      expect(body.indexOf('new section text')).toBeLessThan(body.indexOf('## Later'));
    });

    it('after_section behaves like today\'s section append (past the whole section)', async () => {
      mockNote();
      await call('append_to_note', { id: ID, content: 'trailing', section: 'Today', at: 'after_section' });
      const body = txClientQuery.mock.calls[1][1][0] as string;
      expect(body.indexOf('trailing')).toBeGreaterThan(body.indexOf('first entry'));
      expect(body.indexOf('trailing')).toBeLessThan(body.indexOf('## Later'));
    });

    it('section_start lands right under the heading, before the section\'s existing body', async () => {
      mockNote();
      await call('append_to_note', { id: ID, content: 'leading line', section: 'Today', at: 'section_start' });
      const body = txClientQuery.mock.calls[1][1][0] as string;
      expect(body.indexOf('## Today')).toBeLessThan(body.indexOf('leading line'));
      expect(body.indexOf('leading line')).toBeLessThan(body.indexOf('first entry'));
    });

    it('a section-relative at without section gives a clear error, not a crash', async () => {
      mockNote();
      const err = await callExpectingError('append_to_note', { id: ID, content: 'x', at: 'before_section' });
      expect(err).toContain('requires section');
    });

    it('an unknown section with at: before_section lists available sections, same as today', async () => {
      mockNote();
      const err = await callExpectingError('append_to_note', {
        id: ID, content: 'x', section: 'Missing', at: 'before_section',
      });
      expect(err).toContain('Today');
      expect(err).toContain('Later');
    });

    it('omitting at keeps default behavior: note_end without section, section_end with it', async () => {
      mockNote();
      await call('append_to_note', { id: ID, content: 'default no-section' });
      const noSectionBody = txClientQuery.mock.calls[1][1][0] as string;
      expect(noSectionBody.trim().endsWith('default no-section')).toBe(true);

      mockNote();
      await call('append_to_note', { id: ID, content: 'default with-section', section: 'Today' });
      // Second call in this test — calls[0]/[1] belong to the first
      // invocation above, this one's locked-read/update land at [2]/[3].
      const sectionBody = txClientQuery.mock.calls[3][1][0] as string;
      expect(sectionBody.indexOf('default with-section')).toBeLessThan(sectionBody.indexOf('## Later'));
      expect(sectionBody.indexOf('default with-section')).toBeGreaterThan(sectionBody.indexOf('first entry'));
    });
  });
});

describe('replace_in_note', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const UPDATED_AT = '2026-01-01T00:00:00.000Z';

  /** Resolve the id, then the locked read (and the write, if the handler reaches it). */
  const mockReplace = (content: string, updatedAt = UPDATED_AT) => {
    queryOne.mockResolvedValue({ id: 'n1' });
    txClientQuery
      .mockResolvedValueOnce({ rows: [{ title: 'T', content, updated_at: updatedAt }] })
      .mockResolvedValueOnce({ rows: [{ id: 'n1', title: 'T', updated_at: updatedAt }] });
  };

  it('replaces the one match and reports content_length', async () => {
    mockReplace('before\n\n- [ ] task\n\nafter');
    const out = await call('replace_in_note', {
      id: ID, find: '- [ ] task', replace: '- [x] task',
    }) as { replaced_count: number; content_length: number };
    const body = txClientQuery.mock.calls[1][1][0] as string;
    expect(body).toContain('- [x] task');
    expect(body).not.toContain('- [ ] task');
    expect(out.replaced_count).toBe(1);
    expect(out.content_length).toBe(body.length);
  });

  it('refuses when find is not found, note left untouched', async () => {
    mockReplace('nothing to see here');
    const err = await callExpectingError('replace_in_note', {
      id: ID, find: '- [ ] task', replace: '- [x] task',
    });
    expect(err).toContain('not found');
    expect(txClientQuery).toHaveBeenCalledTimes(1); // locked read only, no update
  });

  it('refuses when find matches more than expected_count, reporting the actual count', async () => {
    mockReplace('- [ ] a\n- [ ] b\n- [ ] c');
    const err = await callExpectingError('replace_in_note', {
      id: ID, find: '- [ ] ', replace: '- [x] ',
    }); // default expected_count is 1, but this matches 3 times
    expect(err).toContain('3');
    expect(err).toContain('expected 1');
    expect(txClientQuery).toHaveBeenCalledTimes(1);
  });

  it('replaces all matches when expected_count matches the actual count', async () => {
    mockReplace('- [ ] a\n- [ ] b\n- [ ] c');
    const out = await call('replace_in_note', {
      id: ID, find: '- [ ] ', replace: '- [x] ', expected_count: 3,
    }) as { replaced_count: number };
    const body = txClientQuery.mock.calls[1][1][0] as string;
    expect(body).toBe('- [x] a\n- [x] b\n- [x] c');
    expect(out.replaced_count).toBe(3);
  });

  it('reads the note under a row lock, same as append_to_note', async () => {
    mockReplace('x');
    const err = await callExpectingError('replace_in_note', { id: ID, find: 'y', replace: 'z' });
    expect(err).toContain('not found');
    expect(txClientQuery.mock.calls[0][0]).toMatch(/select[\s\S]*for update/i);
  });

  it('re-embeds the note in the background', async () => {
    mockReplace('x');
    await call('replace_in_note', { id: ID, find: 'x', replace: 'y' });
    expect(indexNoteAsync).toHaveBeenCalledOnce();
  });

  it('expected_updated_at does not need to be given — find/replace self-anchors', async () => {
    mockReplace('x');
    await call('replace_in_note', { id: ID, find: 'x', replace: 'y' });
    expect(txClientQuery).toHaveBeenCalledTimes(2); // reached the update, no guard blocked it
  });

  it('refuses a stale expected_updated_at, note left untouched', async () => {
    mockReplace('x', '2026-01-02T00:00:00.000Z'); // actual updated_at is newer than expected below
    const err = await callExpectingError('replace_in_note', {
      id: ID, find: 'x', replace: 'y', expected_updated_at: '2026-01-01T00:00:00.000Z',
    });
    expect(err).toContain('changed since you read it');
    expect(txClientQuery).toHaveBeenCalledTimes(1);
  });

  it('goes through with a matching expected_updated_at', async () => {
    mockReplace('x', UPDATED_AT);
    await call('replace_in_note', {
      id: ID, find: 'x', replace: 'y', expected_updated_at: UPDATED_AT,
    });
    expect(txClientQuery).toHaveBeenCalledTimes(2);
  });

  it('refuses a write that would exceed the note content limit, note left untouched', async () => {
    mockReplace('x');
    const err = await callExpectingError('replace_in_note', {
      id: ID, find: 'x', replace: 'y'.repeat(MAX_NOTE_CONTENT_CHARS + 1),
    });
    expect(err).toContain(`${MAX_NOTE_CONTENT_CHARS}-character limit`);
    expect(txClientQuery).toHaveBeenCalledTimes(1);
  });

  it('accepts old_string/new_string as an alias for find/replace', async () => {
    mockReplace('before\n\n- [ ] task\n\nafter');
    const out = await call('replace_in_note', {
      id: ID, old_string: '- [ ] task', new_string: '- [x] task',
    }) as { replaced_count: number };
    const body = txClientQuery.mock.calls[1][1][0] as string;
    expect(body).toContain('- [x] task');
    expect(out.replaced_count).toBe(1);
  });

  it('lets old_string pair with an empty new_string (deletion), same as find/replace', async () => {
    mockReplace('before- [ ] task after');
    const out = await call('replace_in_note', {
      id: ID, old_string: '- [ ] task ', new_string: '',
    }) as { replaced_count: number };
    const body = txClientQuery.mock.calls[1][1][0] as string;
    expect(body).toBe('beforeafter');
    expect(out.replaced_count).toBe(1);
  });

  it('refuses when neither find nor old_string is given', async () => {
    const err = await callExpectingError('replace_in_note', { id: ID, replace: 'y' });
    expect(err).toContain('Provide find');
  });

  it('refuses when neither replace nor new_string is given', async () => {
    const err = await callExpectingError('replace_in_note', { id: ID, find: 'x' });
    expect(err).toContain('Provide replace');
  });

  describe('edits batch', () => {
    it('applies edits in order — an earlier edit can create the text a later one needs', async () => {
      mockReplace('before\n\nTODO\n\nafter');
      const out = await call('replace_in_note', {
        id: ID,
        edits: [
          { find: 'TODO', replace: 'DONE: step' },
          { find: 'DONE: step', replace: 'DONE: step (verified)' },
        ],
      }) as { replaced_count: number; results: { replaced_count: number }[] };
      const body = txClientQuery.mock.calls[1][1][0] as string;
      expect(body).toContain('DONE: step (verified)');
      expect(out.results).toEqual([{ replaced_count: 1 }, { replaced_count: 1 }]);
      expect(out.replaced_count).toBe(2);
      expect(txClientQuery).toHaveBeenCalledTimes(2); // one locked read, one write for the whole batch
      expect(indexNoteAsync).toHaveBeenCalledOnce(); // not once per edit
    });

    it('accepts old_string/new_string aliases inside edits items too', async () => {
      mockReplace('before\n\nTODO\n\nafter');
      const out = await call('replace_in_note', {
        id: ID, edits: [{ old_string: 'TODO', new_string: 'DONE' }],
      }) as { replaced_count: number };
      const body = txClientQuery.mock.calls[1][1][0] as string;
      expect(body).toContain('DONE');
      expect(out.replaced_count).toBe(1);
    });

    it('refuses the whole batch when a later edit does not match, note left untouched', async () => {
      mockReplace('before\n\nTODO\n\nafter');
      const err = await callExpectingError('replace_in_note', {
        id: ID,
        edits: [
          { find: 'TODO', replace: 'DONE' },
          { find: 'nonexistent text', replace: 'x' },
        ],
      });
      expect(err).toContain('edits[1]');
      expect(err).toContain('occurs 0 times');
      expect(err).toContain('nonexistent text');
      expect(txClientQuery).toHaveBeenCalledTimes(1); // locked read only, no update reached
    });

    it('names the failing step with its actual count when a find matches the wrong number of times', async () => {
      mockReplace('- [ ] a\n- [ ] b');
      const err = await callExpectingError('replace_in_note', {
        id: ID,
        edits: [{ find: '- [ ] ', replace: '- [x] ' }], // matches twice, expected_count defaults to 1
      });
      // A one-item edits array is still the common single-edit case — plain
      // wording, no "edits[0]:" noise.
      expect(err).not.toContain('edits[0]');
      expect(err).toContain('occurs 2 times');
    });

    it('names the failing step for a real (multi-item) batch', async () => {
      mockReplace('- [ ] a\n- [ ] b');
      const err = await callExpectingError('replace_in_note', {
        id: ID,
        edits: [
          { find: 'a', replace: 'A' },
          { find: '- [ ] ', replace: '- [x] ' }, // matches twice at this point, expected_count defaults to 1
        ],
      });
      expect(err).toContain('edits[1]');
      expect(err).toContain('occurs 2 times');
    });

    it('refuses when edits is combined with singular find/replace', async () => {
      const err = await callExpectingError('replace_in_note', {
        id: ID, find: 'x', replace: 'y', edits: [{ find: 'a', replace: 'b' }],
      });
      expect(err).toContain('not both');
      expect(queryOne).not.toHaveBeenCalled(); // rejected before any lookup
    });

    it('refuses when edits is combined with a bare expected_count', async () => {
      const err = await callExpectingError('replace_in_note', {
        id: ID, expected_count: 2, edits: [{ find: 'a', replace: 'b' }],
      });
      expect(err).toContain('not both');
    });
  });
});

describe('create_note', () => {
  it('inserts and kicks off background indexing', async () => {
    queryOne.mockResolvedValue({ id: 'new-id', title: 'T', content: 'C' });
    const out = await call('create_note', { title: 'T', content: 'C' }) as Record<string, unknown>;
    expect(out.id).toBe('new-id');
    expect(indexNoteAsync).toHaveBeenCalledWith('new-id', 'T', 'C');
  });

  it('maps a unique-title violation to a friendly message', async () => {
    queryOne.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const err = await callExpectingError('create_note', { title: 'Dupe' });
    expect(err).toContain('already exists');
    expect(indexNoteAsync).not.toHaveBeenCalled();
  });
});

describe('update_note concurrency guard', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  it('refuses the write when the note moved on since it was read', async () => {
    queryOne.mockResolvedValue({ title: 'T', content: 'c', updated_at: '2026-01-02T00:00:00.000Z' });
    const err = await callExpectingError('update_note', {
      id: ID, content: 'mine', expected_updated_at: '2026-01-01T00:00:00.000Z',
    });
    expect(err).toContain('changed since you read it');
    expect(txClientQuery).not.toHaveBeenCalled(); // nothing was written
  });

  it('goes through when the note is untouched', async () => {
    queryOne.mockResolvedValue({ title: 'T', content: 'c', updated_at: '2026-01-01T00:00:00.000Z' });
    txClientQuery.mockResolvedValue({ rows: [{ id: ID, title: 'T', content: 'mine' }] });
    await call('update_note', {
      id: ID, content: 'mine', expected_updated_at: '2026-01-01T00:00:00.000Z',
    });
    expect(txClientQuery).toHaveBeenCalled();
  });

  it('carries the guard into the UPDATE, not just the read before it', async () => {
    // Checking in a separate SELECT leaves a window: another session can
    // commit between the check and the write, and the write it was meant to
    // refuse lands anyway. Only a condition on the UPDATE itself is atomic.
    queryOne.mockResolvedValue({ title: 'T', content: 'c', updated_at: '2026-01-01T00:00:00.000Z' });
    txClientQuery.mockResolvedValue({ rows: [{ id: ID, title: 'T', content: 'mine' }] });
    await call('update_note', {
      id: ID, content: 'mine', expected_updated_at: '2026-01-01T00:00:00.000Z',
    });
    const [sql, params] = txClientQuery.mock.calls[1];
    expect(sql).toContain('update notes set');
    // Truncated both sides: the column keeps microseconds, the caller saw ms.
    expect(sql).toMatch(/date_trunc\('milliseconds', updated_at\) = date_trunc/);
    expect(params).toContain('2026-01-01T00:00:00.000Z');
  });

  it('reports a lost race when the guard matches nothing at write time', async () => {
    queryOne.mockResolvedValue({ title: 'T', content: 'c', updated_at: '2026-01-01T00:00:00.000Z' });
    txClientQuery.mockResolvedValue({ rows: [] }); // someone committed in between
    const err = await callExpectingError('update_note', {
      id: ID, content: 'mine', expected_updated_at: '2026-01-01T00:00:00.000Z',
    });
    expect(err).toContain('changed since you read it');
  });

  it('without the guard it writes as before', async () => {
    queryOne.mockResolvedValue({ title: 'T', content: 'c', updated_at: '2026-01-02T00:00:00.000Z' });
    txClientQuery.mockResolvedValue({ rows: [{ id: ID, title: 'T', content: 'mine' }] });
    await call('update_note', { id: ID, content: 'mine' });
    expect(txClientQuery).toHaveBeenCalled();
  });
});

describe('list_notes recency filter', () => {
  it('updated_after answers "what changed since I was last here"', async () => {
    await call('list_notes', { updated_after: '2026-01-01T00:00:00.000Z' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('updated_at >=');
    expect(sql).toContain('order by updated_at desc');
    expect(params).toContain('2026-01-01T00:00:00.000Z');
  });

  it('created_after answers "what is new" — a distinct filter from updated_after', async () => {
    await call('list_notes', { created_after: '2026-01-01T00:00:00.000Z' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('created_at >=');
    expect(sql).not.toContain('updated_at >='); // the other filter was not also applied
    expect(params).toContain('2026-01-01T00:00:00.000Z');
  });

  it('created_after and updated_after combine with AND when both are given', async () => {
    await call('list_notes', { created_after: '2026-01-01', updated_after: '2026-06-01' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('created_at >= $1');
    expect(sql).toContain('updated_at >= $2');
    expect(params).toEqual(['2026-01-01', '2026-06-01', 20]);
  });
});

describe('update_note', () => {
  it('reads the pre-update title under a row lock, not the earlier unlocked read', async () => {
    // Otherwise a concurrent rename that commits its own update_wikilinks
    // first leaves THIS call rewriting links keyed on an already-stale
    // title, so update_wikilinks matches nothing and backlinks go stale.
    queryOne.mockResolvedValue({ title: 'Old', content: 'body' }); // existing (pre-check)
    txClientQuery
      .mockResolvedValueOnce({ rows: [{ title: 'Old', content: 'body' }] }) // locked read
      .mockResolvedValueOnce({ rows: [{ id: 'i', title: 'New', content: 'body' }] }) // update
      .mockResolvedValueOnce({ rows: [] }); // update_wikilinks
    await call('update_note', { id: '11111111-1111-4111-8111-111111111111', title: 'New' });
    expect(txClientQuery.mock.calls[0][0]).toMatch(/select[\s\S]*for update/i);
  });

  it('rewrites backlinks in the same transaction when the title changes', async () => {
    queryOne.mockResolvedValue({ title: 'Old', content: 'body' }); // existing (pre-check)
    txClientQuery
      .mockResolvedValueOnce({ rows: [{ title: 'Old', content: 'body' }] }) // locked read
      .mockResolvedValueOnce({ rows: [{ id: 'i', title: 'New', content: 'body' }] }) // update
      .mockResolvedValueOnce({ rows: [] }); // update_wikilinks
    await call('update_note', { id: '11111111-1111-4111-8111-111111111111', title: 'New' });
    expect(withTransaction).toHaveBeenCalledOnce();
    const calledWikilinks = txClientQuery.mock.calls.some(c => String(c[0]).includes('update_wikilinks'));
    expect(calledWikilinks).toBe(true);
    expect(indexNoteAsync).toHaveBeenCalled();
  });

  it('does not touch wikilinks when only content changes', async () => {
    queryOne.mockResolvedValue({ title: 'Same', content: 'old' }); // existing (pre-check)
    txClientQuery
      .mockResolvedValueOnce({ rows: [{ title: 'Same', content: 'old' }] }) // locked read
      .mockResolvedValueOnce({ rows: [{ id: 'i', title: 'Same', content: 'new' }] }); // update
    await call('update_note', { id: '11111111-1111-4111-8111-111111111111', content: 'new' });
    expect(txClientQuery.mock.calls.some(c => String(c[0]).includes('update_wikilinks'))).toBe(false);
  });

  it('errors with no fields to update', async () => {
    queryOne.mockResolvedValue({ title: 'X', content: 'y' });
    expect(await callExpectingError('update_note', { id: '11111111-1111-4111-8111-111111111111' }))
      .toContain('at least one field');
  });

  it('errors when the note does not exist', async () => {
    queryOne.mockResolvedValue(null);
    expect(await callExpectingError('update_note', { id: '11111111-1111-4111-8111-111111111111', title: 'X' }))
      .toContain('Note not found');
  });

  it('maps a duplicate-title collision on rename to a friendly message', async () => {
    queryOne.mockResolvedValue({ title: 'Old', content: 'b' });
    withTransaction.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    expect(await callExpectingError('update_note', { id: '11111111-1111-4111-8111-111111111111', title: 'Taken' }))
      .toContain('already exists');
  });
});

describe('delete_note / restore_note', () => {
  const id = '11111111-1111-4111-8111-111111111111';

  it('delete_note soft-deletes: sets deleted_at instead of removing the row', async () => {
    queryOne.mockResolvedValueOnce({ id }); // softDeleteNote's update ... returning id
    const out = await call('delete_note', { id });
    expect(queryOne.mock.calls[0][0]).toMatch(/update notes set deleted_at = now\(\)/);
    expect(queryOne.mock.calls[0][1]).toEqual([id]);
    expect(out).toContain('trash');
  });

  it('delete_note errors on an unknown or already-deleted note', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect(await callExpectingError('delete_note', { id })).toContain('not found');
  });

  it('restore_note clears deleted_at on a trashed note', async () => {
    queryOne.mockResolvedValueOnce({ id });
    const out = await call('restore_note', { id });
    expect(queryOne.mock.calls[0][0]).toMatch(/update notes set deleted_at = null/);
    expect(out).toContain('restored');
  });

  it('restore_note errors when the note is not in the trash', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect(await callExpectingError('restore_note', { id })).toContain('not in trash');
  });

  it('restore_note reports a friendly error when a live note has since taken the title, not a raw DB error', async () => {
    queryOne.mockRejectedValueOnce(Object.assign(new Error('duplicate key value'), { code: '23505' }));
    const err = await callExpectingError('restore_note', { id });
    expect(err).toContain('already has this title');
    expect(err).not.toContain('duplicate key');
  });
});

describe('search_notes', () => {
  const noFilters = {
    folderId: undefined, tag: undefined,
    createdAfter: undefined, createdBefore: undefined,
    updatedAfter: undefined, updatedBefore: undefined,
  };

  it('routes by type', async () => {
    await call('search_notes', { query: 'q', type: 'text' });
    expect(textSearch).toHaveBeenCalledWith('q', 5, noFilters);
    await call('search_notes', { query: 'q', type: 'semantic', limit: 3 });
    expect(semanticSearch).toHaveBeenCalledWith('q', 3, noFilters);
    await call('search_notes', { query: 'q' }); // default hybrid
    expect(hybridSearch).toHaveBeenCalledWith('q', 5, noFilters);
  });

  it('passes folder_id/tag/updated_after/updated_before through as filters', async () => {
    await call('search_notes', {
      query: 'q', type: 'text',
      folder_id: '11111111-1111-4111-8111-111111111111',
      tag: 'work', updated_after: '2026-01-01', updated_before: '2026-12-31',
    });
    expect(textSearch).toHaveBeenCalledWith('q', 5, {
      folderId: '11111111-1111-4111-8111-111111111111',
      tag: 'work', createdAfter: undefined, createdBefore: undefined,
      updatedAfter: '2026-01-01', updatedBefore: '2026-12-31',
    });
  });

  it('passes created_after/created_before through as filters, distinct from updated_after/before', async () => {
    await call('search_notes', {
      query: 'q', type: 'text',
      created_after: '2026-01-01', created_before: '2026-12-31',
    });
    expect(textSearch).toHaveBeenCalledWith('q', 5, {
      folderId: undefined, tag: undefined,
      createdAfter: '2026-01-01', createdBefore: '2026-12-31',
      updatedAfter: undefined, updatedBefore: undefined,
    });
  });

  it('an empty text-search result stays a bare array — no diagnostics', async () => {
    textSearch.mockResolvedValue([]);
    const out = await call('search_notes', { query: 'q', type: 'text' });
    expect(out).toEqual([]);
  });

  it('an empty semantic/hybrid result is wrapped with threshold/best_score/pending_embeddings', async () => {
    semanticSearch.mockResolvedValue([]);
    bestSemanticScore.mockResolvedValue(0.31);
    query.mockResolvedValue([{ count: 2 }]); // pending_embeddings count
    const out = await call('search_notes', { query: 'q', type: 'semantic' }) as {
      results: unknown[]; threshold: number; best_score: number; pending_embeddings: number;
    };
    expect(out.results).toEqual([]);
    // getMinSimilarity (0.55) + 7% of its remaining headroom (0.45) — the
    // raw floor alone understates what a best_score actually needs to
    // clear (наряд-поиск-2026-08-14, anomaly item 2: a best_score just
    // above the bare floor could still come back empty via the
    // degenerate-set guard, and the old threshold field didn't reflect
    // that). Margin is a fraction of headroom, not a flat cosine value
    // (pre-publication review) — 0.55 + 0.07×0.45 = 0.5815, rounds to 0.58.
    expect(out.threshold).toBe(0.58);
    expect(out.best_score).toBe(0.31);
    expect(out.pending_embeddings).toBe(2);
  });

  it('rounds relevance and drops debug fields by default; JSON is indented so a non-parsing client still sees structure', async () => {
    textSearch.mockResolvedValue([{
      id: 'aaaaaaaa-1111-4111-8111-111111111111',
      title: 'Runbook: MCP server',
      excerpt: 'How to add a tool to an existing server.',
      tags: ['runbook', 'mcp'],
      score: 0.08,
      relevance: 0.9488824385394478,
      confidence: 'moderate',
      text_tier: 'and',
    }]);
    const client = await connectClient();
    const res = (await client.callTool({ name: 'search_notes', arguments: { query: 'q', type: 'text' } })) as ToolResult;
    const raw = res.content[0].text;
    expect(raw).toContain('\n  '); // pretty-printed, readable even without a parser
    expect(raw).not.toMatch(/0\.9488824385394478/); // full-precision relevance not leaked

    const [out] = JSON.parse(raw);
    expect(out.relevance).toBe(0.95);
    expect(out.text_tier).toBe('and');
    expect(out).not.toHaveProperty('score'); // internal RRF-rank field, never part of the public shape
  });

  it('explain:true adds raw scores and created_at, rounded; omitted by default', async () => {
    hybridSearch.mockResolvedValue([{
      id: 'a', title: 'A', excerpt: 'x', tags: [],
      relevance: 0.95, confidence: 'strong', text_tier: 'and',
      matched_by: ['text_score', 'semantic_score'],
      text_score: 0.09123456, semantic_score: 0.61234567, rrf_score: 0.03109932,
      created_at: '2026-07-24T12:20:49.425Z',
    }]);
    const plain = await call('search_notes', { query: 'q', type: 'hybrid' }) as { results: Record<string, unknown>[] };
    expect(plain.results[0]).not.toHaveProperty('rrf_score');
    expect(plain.results[0]).not.toHaveProperty('created_at');

    const explained = await call('search_notes', { query: 'q', type: 'hybrid', explain: true }) as { results: Record<string, unknown>[] };
    const [r] = explained.results;
    expect(r.text_score).toBe(0.091);
    expect(r.semantic_score).toBe(0.612);
    expect(r.rrf_score).toBe(0.031);
    expect(r.created_at).toBe('2026-07-24T12:20:49.425Z');
  });
});

describe('folders', () => {
  it('list_folders resolves path from a single query, no created_at/parent_id', async () => {
    query.mockResolvedValue([
      { id: 'a', name: 'Parent', parent_id: null },
      { id: 'b', name: 'Child', parent_id: 'a' },
    ]);
    type Row = { id: string; name: string; path: string; created_at?: string; parent_id?: string };
    const out = await call('list_folders', {}) as Row[];
    expect(query).toHaveBeenCalledTimes(1); // no second folderPathMap() round trip
    expect(out.find(f => f.id === 'a')!.path).toBe('Parent');
    expect(out.find(f => f.id === 'b')!.path).toBe('Parent/Child');
    expect(out.every(f => f.created_at === undefined && f.parent_id === undefined)).toBe(true);
    expect(Object.keys(out[0]).sort()).toEqual(['id', 'name', 'path']);
  });

  it('create_folder inserts with an optional parent', async () => {
    queryOne.mockResolvedValue({ id: 'f', name: 'N', parent_id: null });
    await call('create_folder', { name: 'N' });
    expect(queryOne.mock.calls[0][1]).toEqual(['N', null]);
  });

  it('update_folder refuses to make a folder its own parent', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(await callExpectingError('update_folder', { id, parent_id: id }))
      .toContain('its own parent');
  });

  it('update_folder refuses a move into a descendant (cycle check)', async () => {
    txClientQuery
      .mockResolvedValueOnce({ rows: [] })          // advisory lock
      .mockResolvedValueOnce({ rows: [{ id: 'desc' }] }); // cycle query finds the target among ancestors
    const err = await callExpectingError('update_folder', {
      id: '11111111-1111-4111-8111-111111111111',
      parent_id: '22222222-2222-4222-8222-222222222222',
    });
    expect(err).toContain('descendant');
  });

  it('update_folder returns the resolved path after a rename', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    txClientQuery.mockResolvedValueOnce({ rows: [{ id, name: 'Renamed', parent_id: 'p' }] });
    query.mockResolvedValueOnce([
      { id: 'p', name: 'Parent', parent_id: null },
      { id, name: 'Renamed', parent_id: 'p' },
    ]);
    const out = await call('update_folder', { id, name: 'Renamed' }) as { path: string };
    expect(out.path).toBe('Parent/Renamed');
  });

  it('update_folder returns the resolved path after a move to a new parent', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const newParent = '22222222-2222-4222-8222-222222222222';
    txClientQuery
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // cycle check: no cycle
      .mockResolvedValueOnce({ rows: [{ id, name: 'Folder', parent_id: newParent }] }); // update
    query.mockResolvedValueOnce([
      { id: newParent, name: 'NewParent', parent_id: null },
      { id, name: 'Folder', parent_id: newParent },
    ]);
    const out = await call('update_folder', { id, parent_id: newParent }) as { path: string };
    expect(out.path).toBe('NewParent/Folder');
  });

  it('delete_folder trashes every note in the subtree, then deletes the folder, in one transaction', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    txClientQuery
      .mockResolvedValueOnce({ rows: [{ id: 'n1' }, { id: 'n2' }] }) // trashFolderNotes
      .mockResolvedValueOnce({ rows: [{ id }] }); // delete from folders ... returning id
    const out = await call('delete_folder', { id });
    expect(withTransaction).toHaveBeenCalledOnce();
    expect(txClientQuery.mock.calls[0][0]).toContain('with recursive subtree');
    expect(txClientQuery.mock.calls[1][0]).toContain('delete from folders');
    expect(out).toContain(id);
    expect(out).toContain('2 notes moved to trash');
  });

  it('delete_folder reports a folder that was not there, and the transaction rolls back (nothing left trashed)', async () => {
    // Deleting nothing must not read as success, or an agent holding a stale
    // id carries on believing the folder is gone.
    const err = await callExpectingError('delete_folder', {
      id: '11111111-1111-4111-8111-111111111111',
    });
    expect(err).toContain('not found');
  });
});

describe('get_backlinks', () => {
  it('escapes the title, keeps only exact wikilink matches, and returns a snippet by default', async () => {
    query
      .mockResolvedValueOnce([
        { id: '1', title: 'Real', content: 'see [[Target]] here' },
        { id: '2', title: 'False', content: 'mentions Target but no link' },
      ])
      .mockResolvedValueOnce([]); // folderPathMap's folders query
    const out = await call('get_backlinks', { title: 'Target' }) as {
      results: { id: string; content?: string; snippet?: string }[]; total: number;
    };
    expect(query.mock.calls[0][1]).toEqual(['%[[Target%']);
    expect(out.results.map(n => n.id)).toEqual(['1']); // precise filter drops the false positive
    expect(out.total).toBe(1);
    expect(out.results[0].content).toBeUndefined();
    expect(out.results[0].snippet).toContain('Target');
  });

  it('include_content:true returns full content instead of a snippet', async () => {
    query
      .mockResolvedValueOnce([{ id: '1', title: 'Real', content: 'see [[Target]] here' }])
      .mockResolvedValueOnce([]);
    const out = await call('get_backlinks', { title: 'Target', include_content: true }) as {
      results: { content?: string; snippet?: string }[];
    };
    expect(out.results[0].content).toBe('see [[Target]] here');
    expect(out.results[0].snippet).toBeUndefined();
  });

  it('paginates with limit/offset and reports next_offset', async () => {
    const notes = Array.from({ length: 5 }, (_, i) => ({ id: String(i), title: `N${i}`, content: '[[Target]]' }));
    query.mockResolvedValueOnce(notes).mockResolvedValueOnce([]);
    const out = await call('get_backlinks', { title: 'Target', limit: 2, offset: 1 }) as {
      results: { id: string }[]; total: number; next_offset?: number;
    };
    expect(out.results.map(n => n.id)).toEqual(['1', '2']);
    expect(out.total).toBe(5);
    expect(out.next_offset).toBe(3);
  });
});

describe('get_note with resolve_links', () => {
  it('resolves present links and separates missing ones', async () => {
    queryOne
      .mockResolvedValueOnce({ id: 'main', title: 'Main', content: 'links [[Found]] and [[Gone]]' })
      .mockImplementation(async (_sql: string, params: unknown[]) =>
        params[0] === 'Found' ? { id: 'f', title: 'Found', content: 'linked body' } : null);
    const out = await call('get_note', { id: '11111111-1111-4111-8111-111111111111', resolve_links: true }) as {
      linked_notes: { title: string }[]; unresolved_links: string[];
    };
    expect(out.linked_notes.map(n => n.title)).toEqual(['Found']);
    expect(out.unresolved_links).toEqual(['Gone']);
  });

  it('omits linked_notes/unresolved_links entirely when resolve_links is not set', async () => {
    queryOne.mockResolvedValueOnce({ id: 'main', title: 'Main', content: 'links [[Found]]' });
    const out = await call('get_note', { id: '11111111-1111-4111-8111-111111111111' }) as Record<string, unknown>;
    expect(out.linked_notes).toBeUndefined();
    expect(out.unresolved_links).toBeUndefined();
  });
});

describe('get_graph', () => {
  it('builds directed edges from wikilinks, indexed against nodes, includes semantic edges', async () => {
    query.mockResolvedValue([
      { id: 'a', title: 'A', content: 'to [[B]]' },
      { id: 'b', title: 'B', content: 'no links' },
    ]);
    getSemanticEdges.mockResolvedValue([{ from: 'a', to: 'b', score: 0.9 }]);
    const out = await call('get_graph') as {
      nodes: { i: number; id: string; t: string }[];
      edges: [number, number][];
      semantic_edges: [number, number, number][];
    };
    expect(out.nodes).toEqual([{ i: 0, id: 'a', t: 'A' }, { i: 1, id: 'b', t: 'B' }]);
    expect(out.edges).toEqual([[0, 1]]);
    expect(out.semantic_edges).toEqual([[0, 1, 0.9]]);
  });

  it('still returns the wikilink graph when semantic edges fail', async () => {
    query.mockResolvedValue([{ id: 'a', title: 'A', content: 'to [[B]]' }, { id: 'b', title: 'B', content: '' }]);
    getSemanticEdges.mockRejectedValue(new Error('vector ext down'));
    const out = await call('get_graph') as { edges: unknown[]; semantic_edges: unknown[] };
    expect(out.edges).toHaveLength(1);
    expect(out.semantic_edges).toEqual([]);
  });
});
