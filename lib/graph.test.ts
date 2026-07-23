import { describe, it, expect } from 'vitest';
import { buildWikilinkEdges } from './graph';

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

  it('counts repeated links to the same target once', () => {
    const edges = buildWikilinkEdges([
      note('a', 'Alpha', '[[Beta]] and again [[Beta]]'),
      note('b', 'Beta', ''),
    ]);
    expect(edges).toEqual([{ from: 'a', to: 'b' }]);
  });
});
