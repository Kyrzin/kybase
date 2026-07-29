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
  };
});

const getMinSimilarity = vi.fn();
vi.mock('./embeddings', () => ({ getMinSimilarity: (...a: unknown[]) => getMinSimilarity(...a) }));

const indexNoteAsync = vi.fn();
vi.mock('./indexing', () => ({ indexNoteAsync: (...a: unknown[]) => indexNoteAsync(...a) }));

const getSemanticEdges = vi.fn();
vi.mock('./semantic-edges', () => ({ getSemanticEdges: (...a: unknown[]) => getSemanticEdges(...a) }));

import { createMcpServer } from './mcp-server';

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
  it('registers all 15 tools', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'create_folder', 'create_note', 'delete_folder', 'delete_note', 'get_backlinks',
      'get_graph', 'get_note', 'get_note_with_links', 'list_folders', 'list_notes',
      'list_tags', 'restore_note', 'search_notes', 'update_folder', 'update_note',
    ]);
  });

  // A `+`-concatenation of two interpolated template literals loses the left
  // operand's trailing text in the Next build, which shipped a description
  // reading "default 200004000 chars" to every agent. Keep the numbers apart.
  it('states both content limits intelligibly', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const withLinks = tools.find((t) => t.name === 'get_note_with_links')!;
    expect(withLinks.description).toContain('default 20000 chars');
    expect(withLinks.description).toContain('capped at 4000 chars');
    for (const t of tools) expect(t.description).not.toMatch(/\d{6,}/);
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
    expect(params).toEqual([50]); // default limit
  });

  it('trashed:true lists soft-deleted notes instead, ignoring folder_id/tag', async () => {
    query.mockResolvedValue([{ id: '1', title: 'Gone', deleted_at: '2026-01-01T00:00:00Z' }]);
    await call('list_notes', { trashed: true, limit: 20 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('deleted_at is not null');
    expect(params).toEqual([20]);
  });
});

describe('list_tags', () => {
  it('returns the tag/count rows from an unnest+group-by, most-used first', async () => {
    query.mockResolvedValue([{ tag: 'workflow', count: 9 }, { tag: 'проект', count: 3 }]);
    const out = await call('list_tags', {}) as { tag: string; count: number }[];
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('unnest(tags)');
    expect(sql).toContain('count(*)');
    expect(sql).toContain('order by count desc');
    expect(out).toEqual([{ tag: 'workflow', count: 9 }, { tag: 'проект', count: 3 }]);
  });

  it('is advertised in the create_note/update_note tag guidance', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    for (const name of ['create_note', 'update_note']) {
      expect(tools.find(t => t.name === name)!.description).toContain('list_tags');
    }
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

  it('applies the same resolution in get_note_with_links', async () => {
    queryOne.mockResolvedValue(null);
    query.mockImplementation(notesMatching({
      'Хэндофф%': [{ id: 'n9', title: 'Хэндофф проектному агенту: Zoho MCP', content: 'no links here' }],
    }));
    const out = await call('get_note_with_links', { title: 'Хэндофф' }) as Record<string, unknown>;
    expect((out.note as Record<string, unknown>).id).toBe('n9');
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

describe('update_note', () => {
  it('rewrites backlinks in the same transaction when the title changes', async () => {
    queryOne.mockResolvedValue({ title: 'Old', content: 'body' }); // existing
    txClientQuery
      .mockResolvedValueOnce({ rows: [{ id: 'i', title: 'New', content: 'body' }] }) // update
      .mockResolvedValueOnce({ rows: [] }); // update_wikilinks
    await call('update_note', { id: '11111111-1111-4111-8111-111111111111', title: 'New' });
    expect(withTransaction).toHaveBeenCalledOnce();
    const calledWikilinks = txClientQuery.mock.calls.some(c => String(c[0]).includes('update_wikilinks'));
    expect(calledWikilinks).toBe(true);
    expect(indexNoteAsync).toHaveBeenCalled();
  });

  it('does not touch wikilinks when only content changes', async () => {
    queryOne.mockResolvedValue({ title: 'Same', content: 'old' });
    txClientQuery.mockResolvedValueOnce({ rows: [{ id: 'i', title: 'Same', content: 'new' }] });
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
});

describe('search_notes', () => {
  const noFilters = { folderId: undefined, tag: undefined, updatedAfter: undefined, updatedBefore: undefined };

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
      tag: 'work', updatedAfter: '2026-01-01', updatedBefore: '2026-12-31',
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
    expect(out.threshold).toBe(0.55);
    expect(out.best_score).toBe(0.31);
    expect(out.pending_embeddings).toBe(2);
  });
});

describe('folders', () => {
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
    queryOne.mockResolvedValue({ id: 'desc' }); // cycle query finds the target among ancestors
    const err = await callExpectingError('update_folder', {
      id: '11111111-1111-4111-8111-111111111111',
      parent_id: '22222222-2222-4222-8222-222222222222',
    });
    expect(err).toContain('descendant');
  });

  it('delete_folder issues a delete and confirms', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const out = await call('delete_folder', { id });
    expect(query.mock.calls[0][0]).toContain('delete from folders');
    expect(out).toContain(id);
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

describe('get_note_with_links', () => {
  it('resolves present links and separates missing ones', async () => {
    queryOne
      .mockResolvedValueOnce({ id: 'main', title: 'Main', content: 'links [[Found]] and [[Gone]]' })
      .mockImplementation(async (_sql: string, params: unknown[]) =>
        params[0] === 'Found' ? { id: 'f', title: 'Found', content: 'linked body' } : null);
    const out = await call('get_note_with_links', { id: '11111111-1111-4111-8111-111111111111' }) as {
      linked_notes: { title: string }[]; unresolved_links: string[];
    };
    expect(out.linked_notes.map(n => n.title)).toEqual(['Found']);
    expect(out.unresolved_links).toEqual(['Gone']);
  });
});

describe('get_graph', () => {
  it('builds directed edges from wikilinks and includes semantic edges', async () => {
    query.mockResolvedValue([
      { id: 'a', title: 'A', content: 'to [[B]]' },
      { id: 'b', title: 'B', content: 'no links' },
    ]);
    getSemanticEdges.mockResolvedValue([{ from: 'a', to: 'b', score: 0.9 }]);
    const out = await call('get_graph') as { nodes: unknown[]; edges: { from: string; to: string }[]; semantic_edges: unknown[] };
    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toEqual([{ from: 'a', to: 'b' }]);
    expect(out.semantic_edges).toHaveLength(1);
  });

  it('still returns the wikilink graph when semantic edges fail', async () => {
    query.mockResolvedValue([{ id: 'a', title: 'A', content: 'to [[B]]' }, { id: 'b', title: 'B', content: '' }]);
    getSemanticEdges.mockRejectedValue(new Error('vector ext down'));
    const out = await call('get_graph') as { edges: unknown[]; semantic_edges: unknown[] };
    expect(out.edges).toHaveLength(1);
    expect(out.semantic_edges).toEqual([]);
  });
});
