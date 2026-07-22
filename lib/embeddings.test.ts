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

  it('prefixes nomic-embed-text input with search_query:/search_document: per task', async () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_URL = 'http://ollama:11434';
    process.env.OLLAMA_MODEL = 'nomic-embed-text';

    const fakeEmbedding = Array.from({ length: 768 }, (_, i) => i * 0.001);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ embeddings: [fakeEmbedding] }) });

    const { getEmbedding } = await import('./embeddings');
    await getEmbedding('hello world', 'query');
    await getEmbedding('hello world', 'document');

    const bodies = mockFetch.mock.calls.map(([, init]) => JSON.parse(init.body).input);
    expect(bodies[0]).toBe('search_query: hello world');
    expect(bodies[1]).toBe('search_document: hello world');
  });

  it('does not prefix a non-nomic Ollama model', async () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_URL = 'http://ollama:11434';
    process.env.OLLAMA_MODEL = 'mxbai-embed-large';

    const fakeEmbedding = Array.from({ length: 768 }, (_, i) => i * 0.001);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ embeddings: [fakeEmbedding] }) });

    const { getEmbedding } = await import('./embeddings');
    await getEmbedding('hello world', 'query');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toBe('hello world');
  });

  it('throws when Ollama returns non-ok status', async () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_URL = 'http://ollama:11434';
    process.env.OLLAMA_MODEL = 'nomic-embed-text';

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => '{"error":"model is loading"}',
    });

    const { getEmbedding } = await import('./embeddings');
    await expect(getEmbedding('test')).rejects.toThrow('Ollama error (503): {"error":"model is loading"}');
  });
});

describe('getEmbedding - unknown provider', () => {
  it('throws for unknown provider', async () => {
    process.env.EMBEDDING_PROVIDER = 'unknown_provider';
    const { getEmbedding } = await import('./embeddings');
    await expect(getEmbedding('test')).rejects.toThrow('Unknown embedding provider');
  });
});

describe('getEmbedConcurrency', () => {
  it('gives ollama a higher but still modest concurrency', async () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    const { getEmbedConcurrency } = await import('./embeddings');
    expect(await getEmbedConcurrency()).toEqual({ notes: 2, chunks: 2 });
  });

  it('gives cloud providers a conservative concurrency to respect free-tier rate limits', async () => {
    process.env.EMBEDDING_PROVIDER = 'google';
    const { getEmbedConcurrency } = await import('./embeddings');
    expect(await getEmbedConcurrency()).toEqual({ notes: 1, chunks: 2 });
  });
});
