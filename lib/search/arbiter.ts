import type { NamedResultList } from './types';
import { ARBITER_SEM_THRESHOLD } from './config';

/**
 * The note the arbiter puts first, or undefined to leave the top slot to
 * relevance. Only a verbatim match outranks a strong semantic hit: notes often
 * contain every word of a short query without being about it.
 */
export function arbiterLead(lists: NamedResultList[]): string | undefined {
  const textTop = lists.find((l) => l.field === 'text_score')?.results[0];
  const semTop = lists.find((l) => l.field === 'semantic_score')?.results[0];
  if (!textTop || !semTop) return undefined;
  if (textTop.id === semTop.id || textTop.exact) return textTop.id;
  return semTop.score >= ARBITER_SEM_THRESHOLD ? semTop.id : undefined;
}
