import { describe, it, expect } from 'vitest';
import { buildWikilinkEdges, dedupeEdges, indexedForm } from './graph';

const note = (id: string, title: string, content: string) => ({ id, title, content });

describe('buildWikilinkEdges', () => {
  it('creates a directed edge for each resolved wikilink', () => {
    const edges = buildWikilinkEdges([
      note('a', 'Alpha', 'links to [[Beta]]'),
      note('b', 'Beta', 'no links'),
    ]);
    expect(edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('resolves titles case-insensitively', () => {
    const edges = buildWikilinkEdges([
      note('a', 'Alpha', 'see [[beta]]'),
      note('b', 'Beta', ''),
    ]);
    expect(edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('ignores links to titles that do not exist', () => {
    expect(buildWikilinkEdges([note('a', 'Alpha', 'to [[Ghost]]')])).toEqual([]);
  });

  it('skips self-links', () => {
    expect(buildWikilinkEdges([note('a', 'Alpha', 'I am [[Alpha]]')])).toEqual([]);
  });

  it('strips section anchors and aliases when resolving', () => {
    const edges = buildWikilinkEdges([
      note('a', 'Alpha', 'jump to [[Beta#Section|the alias]]'),
      note('b', 'Beta', ''),
    ]);
    expect(edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('emits one edge per occurrence (the client counts each link)', () => {
    const edges = buildWikilinkEdges([
      note('a', 'Alpha', '[[Beta]] and again [[Beta]]'),
      note('b', 'Beta', ''),
    ]);
    expect(edges).toEqual([{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }]);
  });
});

describe('dedupeEdges', () => {
  it('collapses repeated pairs to one, preserving first-seen order', () => {
    expect(dedupeEdges([
      { from: 'a', to: 'b' },
      { from: 'c', to: 'd' },
      { from: 'a', to: 'b' },
    ])).toEqual([{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }]);
  });

  it('keeps opposite directions as distinct edges', () => {
    expect(dedupeEdges([{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]))
      .toEqual([{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]);
  });
});

describe('indexedForm', () => {
  const graph = () => ({
    nodes: [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }, { id: 'c', title: 'Gamma' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    semantic_edges: [{ from: 'a', to: 'c', score: 0.83 }],
  });

  it('keeps every node, tagged with its array index', () => {
    const out = indexedForm(graph());
    expect(out.nodes).toEqual([
      { i: 0, id: 'a', t: 'Alpha' },
      { i: 1, id: 'b', t: 'Beta' },
      { i: 2, id: 'c', t: 'Gamma' },
    ]);
  });

  it('resolves every edge to a valid pair of node indices', () => {
    const out = indexedForm(graph());
    expect(out.edges).toEqual([[0, 1], [1, 2]]);
    for (const [from, to] of out.edges) {
      expect(from).toBeGreaterThanOrEqual(0);
      expect(from).toBeLessThan(out.nodes.length);
      expect(to).toBeGreaterThanOrEqual(0);
      expect(to).toBeLessThan(out.nodes.length);
    }
  });

  it('carries the cosine score through as the triple\'s third element', () => {
    const out = indexedForm(graph());
    expect(out.semantic_edges).toEqual([[0, 2, 0.83]]);
  });

  it('does not throw on an empty graph', () => {
    expect(indexedForm({ nodes: [], edges: [], semantic_edges: [] }))
      .toEqual({ nodes: [], edges: [], semantic_edges: [] });
  });

  it('drops an edge whose endpoint is not among the given nodes, rather than emitting a dangling index', () => {
    const out = indexedForm({
      nodes: [{ id: 'a', title: 'Alpha' }],
      edges: [{ from: 'a', to: 'ghost' }],
      semantic_edges: [{ from: 'ghost', to: 'a', score: 0.5 }],
    });
    expect(out.edges).toEqual([]);
    expect(out.semantic_edges).toEqual([]);
  });
});
