import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockQueryOne = vi.fn();
vi.mock('./db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

import { hashToken, issueToken, verifyToken } from './tokens';

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue([]);
  mockQueryOne.mockReset();
});

describe('hashToken', () => {
  it('is deterministic and collision-visible', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('issueToken', () => {
  it('returns a 256-bit base64url token and stores only its hash', async () => {
    const { token, expiresAt } = await issueToken('claude-ai');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const insert = mockQuery.mock.calls.find(c => String(c[0]).includes('insert into oauth_tokens'))!;
    expect(insert[1][0]).toBe(hashToken(token));
    expect(String(insert[1])).not.toContain(token); // raw token never hits the DB
  });

  it('issues unique tokens', async () => {
    const a = await issueToken();
    const b = await issueToken();
    expect(a.token).not.toBe(b.token);
  });
});

describe('verifyToken', () => {
  it('rejects an empty token without touching the DB', async () => {
    expect(await verifyToken('')).toBe(false);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('rejects unknown/expired tokens (single code path: query returns nothing)', async () => {
    mockQueryOne.mockResolvedValue(null);
    expect(await verifyToken('nope')).toBe(false);
  });

  it('accepts a live token and looks it up by hash', async () => {
    mockQueryOne.mockResolvedValue({ id: 'x', last_used_at: new Date().toISOString() });
    expect(await verifyToken('live-token')).toBe(true);
    expect(mockQueryOne.mock.calls[0][1]).toEqual([hashToken('live-token')]);
  });

  it('extends expiry only when last use is stale (throttled sliding window)', async () => {
    mockQueryOne.mockResolvedValue({ id: 'x', last_used_at: new Date().toISOString() });
    await verifyToken('t');
    expect(mockQuery.mock.calls.some(c => String(c[0]).includes('update oauth_tokens'))).toBe(false);

    mockQueryOne.mockResolvedValue({ id: 'x', last_used_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
    await verifyToken('t');
    expect(mockQuery.mock.calls.some(c => String(c[0]).includes('update oauth_tokens'))).toBe(true);
  });
});
