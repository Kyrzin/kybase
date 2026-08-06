import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockQueryOne = vi.fn();
vi.mock('./db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

import { softDeleteNote, restoreNote, listTrash, purgeExpiredTrash, purgeNote, trashFolderNotes, TRASH_RETENTION_DAYS } from './trash';

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue([]);
  mockQueryOne.mockReset().mockResolvedValue(null);
});

describe('softDeleteNote', () => {
  it('sets deleted_at and reports success when a live note matched', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'n1' });
    expect(await softDeleteNote('n1')).toBe(true);
    expect(mockQueryOne.mock.calls[0][0]).toMatch(/update notes set deleted_at = now\(\)/);
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['n1']);
  });

  it('is idempotent: returns false for an already-deleted or missing note', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await softDeleteNote('gone')).toBe(false);
  });

  it('opportunistically purges expired trash after every delete', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'n1' });
    await softDeleteNote('n1');
    expect(mockQuery.mock.calls[0][0]).toContain('delete from notes where deleted_at <');
    expect(mockQuery.mock.calls[0][0]).toContain(`interval '${TRASH_RETENTION_DAYS} days'`);
  });
});

describe('restoreNote', () => {
  it('clears deleted_at and reports success when a trashed note matched', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'n1' });
    expect(await restoreNote('n1')).toBe(true);
    expect(mockQueryOne.mock.calls[0][0]).toMatch(/update notes set deleted_at = null/);
  });

  it('returns false when the note was never deleted (or already restored/purged)', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await restoreNote('live-note')).toBe(false);
  });
});

describe('listTrash', () => {
  it('queries only soft-deleted notes, newest deletion first', async () => {
    await listTrash();
    expect(mockQuery.mock.calls[0][0]).toMatch(/where\s+deleted_at is not null/);
    expect(mockQuery.mock.calls[0][0]).toContain('order by deleted_at desc');
  });
});

describe('purgeExpiredTrash', () => {
  it('returns the number of rows actually purged', async () => {
    mockQuery.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    expect(await purgeExpiredTrash()).toBe(2);
  });
});

describe('purgeNote', () => {
  it('permanently deletes a trashed note and reports success', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'n1' });
    expect(await purgeNote('n1')).toBe(true);
    expect(mockQueryOne.mock.calls[0][0]).toMatch(/delete from notes where id = \$1 and deleted_at is not null/);
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['n1']);
  });

  it('refuses to purge a note that is not in the trash (still live, or unknown id)', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    expect(await purgeNote('live-note')).toBe(false);
  });
});

describe('trashFolderNotes', () => {
  it('soft-deletes live notes across the folder and its descendant subtree via the given client', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }] });
    const client = { query: clientQuery };
    expect(await trashFolderNotes('f1', client)).toBe(3);
    expect(clientQuery.mock.calls[0][0]).toContain('with recursive subtree');
    expect(clientQuery.mock.calls[0][0]).toMatch(/update notes set deleted_at = now\(\)/);
    expect(clientQuery.mock.calls[0][0]).toContain('deleted_at is null');
    expect(clientQuery.mock.calls[0][1]).toEqual(['f1']);
  });

  it('returns 0 when the folder has no live notes anywhere in its subtree', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await trashFolderNotes('empty-folder', client)).toBe(0);
  });

  it('never touches the pool-level query/queryOne — everything goes through the passed client', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await trashFolderNotes('f1', client);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});
