import type { NamedResultList } from './types';
import { ARBITER_SEM_THRESHOLD } from './config';

/**
 * The note the arbiter puts first, or undefined to leave the top slot to
 * relevance. Only a verbatim match outranks a strong semantic hit: notes often
 * contain every word of a short query without being about it. Under a weak
 * semantic hit, the only note holding a word of the query (a name, a code)
 * leads: the semantic arm has found nothing close, the text arm the one note
 * that word names.
 */
export function arbiterLead(lists: NamedResultList[]): string | undefined {
  const text = lists.find((l) => l.field === 'text_score')?.results;
  const textTop = text?.[0];
  const semTop = lists.find((l) => l.field === 'semantic_score')?.results[0];
  if (!textTop || !semTop) return undefined;
  if (textTop.id === semTop.id || textTop.exact) return textTop.id;
  if (semTop.score >= ARBITER_SEM_THRESHOLD) return semTop.id;
  return text.find((r) => r.unique)?.id;
}
