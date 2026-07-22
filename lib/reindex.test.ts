import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
const mockIndexNote = vi.fn();

vi.mock('./db', () => ({ query: (...args: unknown[]) => mockQuery(...args) }));
vi.mock('./indexing', () => ({ indexNote: (...args: unknown[]) => mockIndexNote(...args) }));
vi.mock('./embeddings', () => ({ getEmbedConcurrency: async () => ({ notes: 2, chunks: 2 }) }));

import { reindexPending, reindexAll } from './reindex';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('reindexPending', () => {
  it('only selects embedding_pending = true notes', async () => {
    mockQuery.mockResolvedValue([{ id: '1', title: 'a', content: 'x' }]);
    mockIndexNote.mockResolvedValue(undefined);

    const result = await reindexPending();

    expect(mockQuery.mock.calls[0][0]).toContain('embedding_pending = true');
    expect(mockIndexNote).toHaveBeenCalledWith('1', 'a', 'x');
    expect(result).toEqual({ reindexed: 1, errors: [], total: 1 });
  });

  it('collects per-note errors without aborting the batch', async () => {
    mockQuery.mockResolvedValue([
      { id: '1', title: 'ok', content: 'x' },
      { id: '2', title: 'bad', content: 'y' },
    ]);
    mockIndexNote.mockImplementation(async (id: string) => {
      if (id === '2') throw new Error('provider down');
    });

    const result = await reindexPending();

    expect(result.reindexed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('provider down');
    expect(result.total).toBe(2);
  });
});

describe('reindexAll', () => {
  it('selects every note regardless of embedding_pending', async () => {
    mockQuery.mockResolvedValue([
      { id: '1', title: 'a', content: 'x' },
      { id: '2', title: 'b', content: 'y' },
    ]);
    mockIndexNote.mockResolvedValue(undefined);

    const result = await reindexAll();

    expect(mockQuery.mock.calls[0][0]).not.toContain('where');
    expect(mockIndexNote).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ reindexed: 2, errors: [], total: 2 });
  });
});
