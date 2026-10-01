// lib/model-pull.ts — download an Ollama model, with progress a caller can see.
//
// Progress lives here rather than in the response, like lib/reindex.ts: the
// download outlives the request that starts it, so the client polls.
const OLLAMA_PULL_TIMEOUT_MS = 30 * 60_000;

export type PullProgress = {
  model: string;
  running: boolean;
  /** Bytes within the layer being fetched, not the whole model. */
  completed: number;
  total: number;
  /** Ollama's own phase word — "pulling manifest", "verifying sha256", … */
  status: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

let current: PullProgress | null = null;

export function getPullProgress(): PullProgress | null {
  return current;
}

function ollamaUrl(): string {
  return process.env.OLLAMA_URL ?? 'http://ollama:11434';
}

/**
 * Starts a pull unless one is already running. Returns immediately; the
 * caller polls getPullProgress.
 */
export function startModelPull(model: string): { started: boolean; progress: PullProgress } {
  if (current?.running) return { started: false, progress: current };
  current = { model, running: true, completed: 0, total: 0, status: 'starting', startedAt: Date.now() };
  void runPull(model);
  return { started: true, progress: current };
}

async function runPull(model: string): Promise<void> {
  try {
    const res = await fetch(`${ollamaUrl()}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: AbortSignal.timeout(OLLAMA_PULL_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    // Newline-delimited JSON, one object per progress tick. A chunk can split
    // mid-object, so the tail is carried over rather than parsed.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let tail = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tail += decoder.decode(value, { stream: true });
      const lines = tail.split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim() || !current) continue;
        try {
          const tick = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
          if (tick.error) throw new Error(tick.error);
          current.status = tick.status ?? current.status;
          // One layer's pair, taken together or not at all — carried over
          // separately they mix layers and the percentage exceeds a hundred.
          if (typeof tick.total === 'number') {
            current.total = tick.total;
            current.completed = typeof tick.completed === 'number' ? tick.completed : 0;
          }
        } catch (err) {
          if (err instanceof SyntaxError) continue; // a half-written line, not a failure
          throw err;
        }
      }
    }
    if (current) { current.running = false; current.finishedAt = Date.now(); current.status = 'ready'; }
  } catch (err) {
    if (current) {
      current.running = false;
      current.finishedAt = Date.now();
      current.error = err instanceof Error ? err.message : String(err);
    }
  }
}
