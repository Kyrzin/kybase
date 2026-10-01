import type { EmbedTask } from './model';

const OLLAMA_TIMEOUT_MS = 60_000;

// Task-instruction prefix per model family; the wrong one collapses cosine
// separation. embeddinggemma: https://ai.google.dev/gemma/docs/embeddinggemma;
// nomic-embed-text: search_query:/search_document:; anything else: none.
function ollamaPromptInput(model: string, task: EmbedTask, text: string): string {
  if (model.includes('embeddinggemma')) {
    return task === 'query'
      ? `task: search result | query: ${text}`
      : `title: none | text: ${text}`;
  }
  if (model.includes('nomic-embed-text')) {
    return (task === 'query' ? 'search_query: ' : 'search_document: ') + text;
  }
  return text;
}

// One short retry for a network failure or 5xx (Ollama restarting); a 4xx is
// left to the caller.
const OLLAMA_RETRY_DELAY_MS = 500;

class OllamaRetryableError extends Error {}

async function ollamaEmbedOnce(url: string, model: string, input: string): Promise<number[]> {
  let res: Response;
  try {
    res = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
  } catch (err) {
    throw new OllamaRetryableError(err instanceof Error ? err.message : 'fetch failed');
  }
  if (!res.ok) {
    // Include the body: Ollama's statusText is just "Bad Request", the real
    // cause ("input length exceeds the context length") is in the JSON.
    const body = (await res.text()).slice(0, 200);
    // A model still downloading answers like one never pulled.
    if (res.status === 404 && /not found, try pulling it first/i.test(body)) {
      throw new Error(
        `Ollama does not have "${model}" yet. On a first start it downloads in the background — `
        + 'wait for that to finish and try again. `docker compose exec ollama ollama list` shows '
        + 'what is ready.'
      );
    }
    const message = `Ollama error (${res.status}): ${body}`;
    if (res.status >= 500) throw new OllamaRetryableError(message);
    throw new Error(message);
  }
  const data = await res.json();
  return data.embeddings[0] as number[];
}

export async function ollamaEmbed(text: string, model: string | undefined, task: EmbedTask): Promise<number[]> {
  const url = process.env.OLLAMA_URL ?? 'http://ollama:11434';
  const resolvedModel = model ?? 'embeddinggemma';
  const input = ollamaPromptInput(resolvedModel, task, text);
  try {
    return await ollamaEmbedOnce(url, resolvedModel, input);
  } catch (err) {
    if (!(err instanceof OllamaRetryableError)) throw err;
    await new Promise(r => setTimeout(r, OLLAMA_RETRY_DELAY_MS));
    return ollamaEmbedOnce(url, resolvedModel, input);
  }
}
