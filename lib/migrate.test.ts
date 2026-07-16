import { describe, it, expect } from 'vitest';
import { pendingMigrations } from './migrate';

describe('pendingMigrations', () => {
  it('returns unapplied .sql files in filename order', () => {
    const files = ['003_c.sql', '001_a.sql', '002_b.sql'];
    expect(pendingMigrations(files, new Set())).toEqual(['001_a.sql', '002_b.sql', '003_c.sql']);
  });

  it('skips already-applied files', () => {
    const files = ['001_a.sql', '002_b.sql', '003_c.sql'];
    expect(pendingMigrations(files, new Set(['001_a.sql', '002_b.sql']))).toEqual(['003_c.sql']);
  });

  it('ignores non-sql files (READMEs, editor swap files)', () => {
    const files = ['001_a.sql', 'README.md', '001_a.sql.swp'];
    expect(pendingMigrations(files, new Set())).toEqual(['001_a.sql']);
  });

  it('returns empty when everything is applied', () => {
    expect(pendingMigrations(['001_a.sql'], new Set(['001_a.sql']))).toEqual([]);
  });
});
