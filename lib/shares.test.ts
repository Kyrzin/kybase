import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockQueryOne = vi.fn();
vi.mock('./db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

import { createShare, getSharedNote } from './shares';

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue([]);
  mockQueryOne.mockReset().mockResolvedValue(null);
});

describe('createShare', () => {
  it('generates a 256-bit base64url token — never short or sequential', async () => {
    mockQueryOne.mockImplementation((_sql: string, p: unknown[]) =>
      Promise.resolve({ token: p[0], note_id: 'n', created_at: 'now', expires_at: p[1] }));
    const a = await createShare('note-id');
    const b = await createShare('note-id');
    expect(a!.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(a!.token).not.toBe(b!.token);
  });

  it('returns null for a nonexistent note (insert..select matches nothing)', async () => {
    mockQueryOne.mockResolvedValue(null);
    expect(await createShare('missing')).toBeNull();
  });

  it('passes the expiry through and defaults to permanent', async () => {
    mockQueryOne.mockImplementation((_sql: string, p: unknown[]) =>
      Promise.resolve({ token: p[0], note_id: 'n', created_at: 'now', expires_at: p[1] }));
    expect((await createShare('n'))!.expires_at).toBeNull();
    const week = await createShare('n', 7);
    expect(new Date(week!.expires_at as unknown as string).getTime())
      .toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  });
});

describe('getSharedNote — the only query the public route makes', () => {
  it('rejects an empty token without touching the DB', async () => {
    expect(await getSharedNote('')).toBeNull();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('missing, revoked and expired tokens are one code path: the query returns nothing', async () => {
    // Revoked rows are deleted and expired rows fail the WHERE clause, so all
    // three cases are literally the same null from the same single query —
    // indistinguishable by response shape or timing.
    mockQueryOne.mockResolvedValue(null);
    expect(await getSharedNote('missing-or-revoked-or-expired')).toBeNull();
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  it('selects only anonymous-safe fields', async () => {
    mockQueryOne.mockResolvedValue({ title: 't', content: 'c', updated_at: 'u' });
    await getSharedNote('tok');
    const sql = String(mockQueryOne.mock.calls[0][0]);
    const selectList = sql.slice(0, sql.indexOf('from'));
    expect(selectList).toContain('n.title, n.content, n.updated_at');
    expect(selectList).not.toMatch(/n\.id|folder_id|tags|embedding/);
  });
});
