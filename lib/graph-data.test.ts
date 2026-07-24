import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('./db', () => ({ query: (...a: unknown[]) => query(...a) }));

const getSemanticEdges = vi.fn();
vi.mock('./semantic-edges', () => ({ getSemanticEdges: (...a: unknown[]) => getSemanticEdges(...a) }));

import { buildGraph } from './graph-data';

const note = (id: string, title: string, content: string, folder_id: string | null = null) => ({
  id, title, content, folder_id,
});

beforeEach(() => {
  query.mockReset();
  getSemanticEdges.mockReset().mockResolvedValue([]);
});

describe('buildGraph — unfiltered (default)', () => {
  it('returns the whole vault, matching prior unconditional behavior', async () => {
    query.mockResolvedValueOnce([
      note('a', 'Alpha', 'to [[Beta]]'),
      note('b', 'Beta', 'no links'),
    ]);
    getSemanticEdges.mockResolvedValue([{ from: 'a', to: 'b', score: 0.9 }]);

    const graph = await buildGraph();

    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([{ from: 'a', to: 'b' }]);
    expect(graph.semantic_edges).toEqual([{ from: 'a', to: 'b', score: 0.9 }]);
    expect(getSemanticEdges).toHaveBeenCalledWith(0.75, 5); // default min_score
  });
});

describe('buildGraph — folderId', () => {
  it('restricts nodes to a folder and its descendants', async () => {
    query
      .mockResolvedValueOnce([
        note('a', 'Alpha', 'to [[Beta]]', 'f1'),
        note('b', 'Beta', 'to [[Gamma]]', 'f2'), // f2 is a child of f1
        note('c', 'Gamma', 'outside', 'other'),
      ])
      .mockResolvedValueOnce([
        { id: 'f1', parent_id: null },
        { id: 'f2', parent_id: 'f1' },
        { id: 'other', parent_id: null },
      ]);

    const graph = await buildGraph({ folderId: 'f1' });

    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(graph.edges).toEqual([{ from: 'a', to: 'b' }]); // link to Gamma dropped — outside the subtree
  });
});

describe('buildGraph — rootTitle + depth', () => {
  it('keeps only nodes within depth hops, treating wikilinks as undirected', async () => {
    query.mockResolvedValueOnce([
      note('a', 'A', 'to [[B]]'),
      note('b', 'B', 'to [[C]]'),
      note('c', 'C', 'to [[D]]'),
      note('d', 'D', ''),
    ]);

    const graph = await buildGraph({ rootTitle: 'B', depth: 1 });

    // B is 1 hop from A (inbound) and C (outbound); D is 2 hops away — excluded.
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('throws when the root title does not exist', async () => {
    query.mockResolvedValueOnce([note('a', 'A', '')]);
    await expect(buildGraph({ rootTitle: 'Missing' })).rejects.toThrow('No note titled "Missing" found');
  });
});

describe('buildGraph — semantic edge options', () => {
  it('skips the semantic_edges call entirely when includeSemantic is false', async () => {
    query.mockResolvedValueOnce([note('a', 'A', '')]);
    const graph = await buildGraph({ includeSemantic: false });
    expect(getSemanticEdges).not.toHaveBeenCalled();
    expect(graph.semantic_edges).toEqual([]);
  });

  it('passes a custom minScore through to getSemanticEdges', async () => {
    query.mockResolvedValueOnce([note('a', 'A', '')]);
    await buildGraph({ minScore: 0.5 });
    expect(getSemanticEdges).toHaveBeenCalledWith(0.5, 5);
  });

  it('drops semantic edges whose endpoints fall outside a scoped node set', async () => {
    query.mockResolvedValueOnce([
      note('a', 'A', 'to [[B]]', 'f1'),
      note('b', 'B', '', 'f1'),
      note('c', 'C', '', 'other'),
    ]).mockResolvedValueOnce([{ id: 'f1', parent_id: null }, { id: 'other', parent_id: null }]);
    getSemanticEdges.mockResolvedValue([
      { from: 'a', to: 'b', score: 0.9 },
      { from: 'a', to: 'c', score: 0.95 }, // c is outside the f1 subtree
    ]);

    const graph = await buildGraph({ folderId: 'f1' });

    expect(graph.semantic_edges).toEqual([{ from: 'a', to: 'b', score: 0.9 }]);
  });
});
