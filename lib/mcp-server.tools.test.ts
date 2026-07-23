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
vi.mock('./search', () => ({
  textSearch: (...a: unknown[]) => textSearch(...a),
  semanticSearch: (...a: unknown[]) => semanticSearch(...a),
  hybridSearch: (...a: unknown[]) => hybridSearch(...a),
}));

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
  indexNoteAsync.mockReset();
  getSemanticEdges.mockReset().mockResolvedValue([]);
});

describe('tools/list', () => {
  it('registers all 13 tools', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'create_folder', 'create_note', 'delete_folder', 'delete_note', 'get_backlinks',
      'get_graph', 'get_note', 'get_note_with_links', 'list_folders', 'list_notes',
      'search_notes', 'update_folder', 'update_note',
    ]);
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

  it('omits the WHERE clause when unfiltered', async () => {
    await call('list_notes', {});
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('where');
    expect(params).toEqual([50]); // default limit
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

describe('search_notes', () => {
  it('routes by type', async () => {
    await call('search_notes', { query: 'q', type: 'text' });
    expect(textSearch).toHaveBeenCalledWith('q', 5);
    await call('search_notes', { query: 'q', type: 'semantic', limit: 3 });
    expect(semanticSearch).toHaveBeenCalledWith('q', 3);
    await call('search_notes', { query: 'q' }); // default hybrid
    expect(hybridSearch).toHaveBeenCalledWith('q', 5);
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
  it('escapes the title and keeps only exact wikilink matches', async () => {
    query.mockResolvedValue([
      { id: '1', title: 'Real', content: 'see [[Target]] here' },
      { id: '2', title: 'False', content: 'mentions Target but no link' },
    ]);
    const out = await call('get_backlinks', { title: 'Target' }) as { id: string }[];
    expect(query.mock.calls[0][1]).toEqual(['%[[Target%']);
    expect(out.map(n => n.id)).toEqual(['1']); // precise filter drops the false positive
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
