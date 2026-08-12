// PATCH /api/notes/[id] concurrency guard: the browser's 800ms autosave and
// an MCP append_to_note both PATCH the same note, so a stale write must be
// refused (409) instead of silently overwriting whatever landed in between.
// Mirrors update_note's guard tests in lib/mcp-server.tools.test.ts — same
// shape of guard, same mocking approach (db layer mocked, guard logic real).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const txClientQuery = vi.fn();
const withTransaction = vi.fn(async (fn: (c: { query: typeof txClientQuery }) => unknown) => fn({ query: txClientQuery }));
const queryOne = vi.fn();
const isUniqueViolation = vi.fn();
const isInvalidTextRepresentation = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...a: unknown[]) => queryOne(...a),
  withTransaction: (fn: (c: { query: typeof txClientQuery }) => unknown) => withTransaction(fn),
  isUniqueViolation: (...a: unknown[]) => isUniqueViolation(...a),
  isInvalidTextRepresentation: (...a: unknown[]) => isInvalidTextRepresentation(...a),
}));

const indexNoteAsync = vi.fn();
vi.mock('@/lib/indexing', () => ({ indexNoteAsync: (...a: unknown[]) => indexNoteAsync(...a) }));

const softDeleteNote = vi.fn();
vi.mock('@/lib/trash', () => ({ softDeleteNote: (...a: unknown[]) => softDeleteNote(...a) }));

import { PATCH } from './route';

const ID = '11111111-1111-4111-8111-111111111111';

function patchReq(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/notes/${ID}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

function call(body: unknown) {
  return PATCH(patchReq(body), { params: Promise.resolve({ id: ID }) });
}

beforeEach(() => {
  txClientQuery.mockReset();
  withTransaction.mockReset().mockImplementation(async (fn) => fn({ query: txClientQuery }));
  queryOne.mockReset();
  indexNoteAsync.mockReset();
  isUniqueViolation.mockReset().mockReturnValue(false);
});

describe('PATCH /api/notes/[id] concurrency guard', () => {
  it('accepts a write with a fresh expected_updated_at', async () => {
    txClientQuery
      .mockResolvedValueOnce({ rows: [{ title: 'T', content: 'old' }] })
      .mockResolvedValueOnce({ rows: [{ id: ID, title: 'T', content: 'new', updated_at: '2026-01-01T00:00:00.000Z' }] });
    const res = await call({ content: 'new', expected_updated_at: '2026-01-01T00:00:00.000Z' });
    expect(res.status).toBe(200);
  });

  it('rejects a write with a stale expected_updated_at (409)', async () => {
    txClientQuery
      .mockResolvedValueOnce({ rows: [{ title: 'T', content: 'old' }] }) // row still exists (locked)
      .mockResolvedValueOnce({ rows: [] }); // UPDATE's guard matched nothing
    const res = await call({ content: 'new', expected_updated_at: '2026-01-01T00:00:00.000Z' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('changed since you read it');
  });

  it('carries the guard into the UPDATE statement itself, not a read before it', async () => {
    // A guard enforced only by a SELECT-then-compare leaves a window where a
    // concurrent write commits in between and lands anyway — same class of
    // bug the row lock above already guards against for titles.
    txClientQuery
      .mockResolvedValueOnce({ rows: [{ title: 'T', content: 'old' }] })
      .mockResolvedValueOnce({ rows: [{ id: ID, title: 'T', content: 'new', updated_at: '2026-01-01T00:00:00.000Z' }] });
    await call({ content: 'new', expected_updated_at: '2026-01-01T00:00:00.000Z' });
    const [sql, params] = txClientQuery.mock.calls[1];
    expect(sql).toContain('update notes set');
    expect(sql).toMatch(/date_trunc\('milliseconds', updated_at\) = date_trunc/);
    expect(params).toContain('2026-01-01T00:00:00.000Z');
  });

  it('writes without a guard clause when expected_updated_at is omitted', async () => {
    txClientQuery
      .mockResolvedValueOnce({ rows: [{ title: 'T', content: 'old' }] })
      .mockResolvedValueOnce({ rows: [{ id: ID, title: 'T', content: 'new', updated_at: '2026-01-01T00:00:00.000Z' }] });
    const res = await call({ content: 'new' });
    expect(res.status).toBe(200);
    const [sql] = txClientQuery.mock.calls[1];
    expect(sql).not.toContain('date_trunc');
  });

  it('rejects a malformed expected_updated_at before touching the database', async () => {
    const res = await call({ content: 'new', expected_updated_at: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(withTransaction).not.toHaveBeenCalled();
  });
});
