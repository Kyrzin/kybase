import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// settings.ts reads the DB first and falls back to env vars.
// Mock the DB to return nothing so these tests exercise the env fallback.
vi.mock('./db', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  toVector: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.OLLAMA_URL;
  delete process.env.OLLAMA_MODEL;
});

describe('getEmbedding - ollama provider', () => {
  it('calls Ollama /api/embed and returns first embedding', async () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_URL = 'http://ollama:11434';
    process.env.OLLAMA_MODEL = 'nomic-embed-text';

    const fakeEmbedding = Array.from({ length: 768 }, (_, i) => i * 0.001);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [fakeEmbedding] }),
    });

    const { getEmbedding } = await import('./embeddings');
    const result = await getEmbedding('hello world');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://ollama:11434/api/embed',
      expect.objectContaining({ method: 'POST' })
    );
    expect(result).toHaveLength(768);
  });

  it('throws when Ollama returns non-ok status', async () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_URL = 'http://ollama:11434';
    process.env.OLLAMA_MODEL = 'nomic-embed-text';

    mockFetch.mockResolvedValueOnce({ ok: false, statusText: 'Service Unavailable' });

    const { getEmbedding } = await import('./embeddings');
    await expect(getEmbedding('test')).rejects.toThrow('Ollama error');
  });
});

describe('getEmbedding - unknown provider', () => {
  it('throws for unknown provider', async () => {
    process.env.EMBEDDING_PROVIDER = 'unknown_provider';
    const { getEmbedding } = await import('./embeddings');
    await expect(getEmbedding('test')).rejects.toThrow('Unknown embedding provider');
  });
});
