import { describe, it, expect } from 'vitest';
import { sanitizeName, folderPaths, buildExportTree, parseFrontmatter } from './export';
import type { ExportNote, ExportFolder } from './export';

const note = (over: Partial<ExportNote>): ExportNote => ({
  title: 'Note',
  content: 'body',
  folder_id: null,
  tags: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  ...over,
});

describe('sanitizeName', () => {
  it('replaces path separators and reserved characters', () => {
    expect(sanitizeName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });
  it('trims leading/trailing dots and spaces', () => {
    expect(sanitizeName('  ..hidden.. ')).toBe('hidden');
  });
  it('falls back for names that sanitize to nothing', () => {
    expect(sanitizeName('...')).toBe('untitled');
    expect(sanitizeName('   ')).toBe('untitled');
  });
});

describe('folderPaths', () => {
  const folders: ExportFolder[] = [
    { id: 'a', name: 'Projects', parent_id: null },
    { id: 'b', name: 'Kybase', parent_id: 'a' },
    { id: 'c', name: 'Ideas/2026', parent_id: 'b' },
  ];
  it('builds nested sanitized paths', () => {
    expect(folderPaths(folders).get('c')).toBe('Projects/Kybase/Ideas_2026');
  });
  it('survives a parent cycle without hanging', () => {
    const cyclic: ExportFolder[] = [
      { id: 'x', name: 'X', parent_id: 'y' },
      { id: 'y', name: 'Y', parent_id: 'x' },
    ];
    expect(() => folderPaths(cyclic)).not.toThrow();
  });
});

describe('buildExportTree', () => {
  it('places notes under their folder path with frontmatter', () => {
    const files = buildExportTree(
      [note({ title: 'My Note', folder_id: 'a', tags: ['x'] })],
      [{ id: 'a', name: 'Docs', parent_id: null }]
    );
    expect(files[0].path).toBe('Docs/My Note.md');
    expect(files[0].content).toContain('title: "My Note"');
    expect(files[0].content).toContain('tags: ["x"]');
    expect(files[0].content).toContain('\n---\n\nbody');
  });

  it('suffixes filename collisions instead of overwriting', () => {
    const files = buildExportTree(
      [note({ title: 'a/b' }), note({ title: 'a\\b' }), note({ title: 'A_B' })],
      []
    );
    expect(files.map(f => f.path)).toEqual(['a_b.md', 'a_b (2).md', 'A_B (3).md']);
  });
});

describe('parseFrontmatter', () => {
  it('round-trips an exported note', () => {
    const [file] = buildExportTree([note({ title: 'Q: "test"', tags: ['a', 'b'], content: '# Hi\n' })], []);
    const parsed = parseFrontmatter(file.content);
    expect(parsed.title).toBe('Q: "test"');
    expect(parsed.tags).toEqual(['a', 'b']);
    expect(parsed.body).toBe('# Hi\n');
  });

  it('tolerates unquoted YAML-ish frontmatter from other tools', () => {
    const parsed = parseFrontmatter('---\ntitle: Plain Title\ntags: [alpha, beta]\n---\ntext');
    expect(parsed.title).toBe('Plain Title');
    expect(parsed.tags).toEqual(['alpha', 'beta']);
    expect(parsed.body).toBe('text');
  });

  it('returns the whole file as body when there is no frontmatter', () => {
    const parsed = parseFrontmatter('# Just markdown');
    expect(parsed.title).toBeUndefined();
    expect(parsed.body).toBe('# Just markdown');
  });
});
