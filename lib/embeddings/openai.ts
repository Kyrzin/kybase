import { fetchWithRetry } from './transport';

export async function openaiEmbed(text: string, apiKey: string | undefined, model: string, dims: number | null): Promise<number[]> {
  if (!apiKey) throw new Error('OpenAI API key is not configured');
  const res = await fetchWithRetry('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    // Omitted rather than sent as null when no size was chosen: the older
    // embedding models reject the parameter instead of ignoring it.
    body: JSON.stringify({ model, input: text, ...(dims === null ? {} : { dimensions: dims }) }),
  });
  if (!res.ok) throw new Error(`OpenAI embed error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.data[0].embedding as number[];
}
