import { query as dbQuery } from '../db';
import { getFtsLanguages, getTagWeights, type TagWeights, getFolderWeights, type FolderWeights } from '../settings';
import { escapeLike } from '../sql';
import type { SearchFilters, SearchResult } from './types';
import { DEMOTE_QUESTION_ECHO } from './config';
import { applyFilters, enrichResults, overfetchLimit, resolveScope, scopeParam } from './results';
import { attachSections, makeExcerpt, repairBrokenTableExcerpts, type NoteRow } from './excerpt';
import { attachQuestionEcho, computeTextCoverage, rareAnchors, significantWords } from './signals';

// Substring hits have no rank: fixed levels, below a full-rank FTS match.
const SUBSTRING_RELEVANCE = { title: 0.65, content: 0.5 };

type FtsRow = { id: string; title: string; tags: string[]; folder_id: string | null; rank: number; headline: string };

// Product of the note's tag weights; 1 when no weights are configured.
function weightForTags(tags: string[], weights: TagWeights): number {
  return tags.reduce((acc, t) => acc * (weights[t] ?? 1), 1);
}

// Exact folder match, no subtree recursion (same as SearchFilters.folderId).
function weightForFolder(folderId: string | null | undefined, weights: FolderWeights): number {
  return folderId ? (weights[folderId] ?? 1) : 1;
}

/**
 * Full-text search via search_notes_fts, in passes:
 *  1. strict — the query as typed (AND);
 *  2. OR — the significant words OR'd, when the strict pass came back short;
 *  3. rare-word anchors — when the strict pass found nothing;
 *  4. substring — always; marks verbatim identifier matches as `exact`.
 *
 * `deferSections`: hybrid resolves section headings once, on the final page,
 * instead of per arm on the whole candidate pool.
 */
export async function textSearch(query: string, limit = 10, filters?: SearchFilters, allowedIds?: Set<string>, deferSections = false): Promise<SearchResult[]> {
  const fetchLimit = overfetchLimit(limit, filters);
  const scope = await resolveScope(filters, allowedIds);
  const scopeIds = scopeParam(scope);
  const [rows, tagWeights, folderWeights] = await Promise.all([
    dbQuery<FtsRow>('select * from search_notes_fts($1, $2, $3)', [query, fetchLimit, scopeIds]),
    getTagWeights(),
    getFolderWeights(),
  ]);

  let orRows: FtsRow[] = [];
  let anchorRows: FtsRow[] = [];
  const words = significantWords(query);
  // With one or two words an OR pass adds nothing over the strict pass.
  if (rows.length < limit && words.length > 2) {
    const seen = new Set(rows.map((r) => r.id));
    const orAll = await dbQuery<FtsRow>(
      'select * from search_notes_fts($1, $2, $3)',
      [words.join(' or '), fetchLimit, scopeIds]
    );
    orRows = orAll.filter((r) => !seen.has(r.id));
  }

  // A question the strict pass could not match: also search its rarest words
  // as a strict query, so a distinctive term is not drowned by filler words.
  if (rows.length === 0 && words.length > 1) {
    const anchors = await rareAnchors(words, await getFtsLanguages());
    if (anchors.length > 0) {
      const seen = new Set(orRows.map((r) => r.id));
      const anchorAll = await dbQuery<FtsRow>('select * from search_notes_fts($1, $2, $3)', [anchors.join(' '), fetchLimit, scopeIds]);
      anchorRows = anchorAll.filter((r) => !seen.has(r.id));
    }
  }

  // A whitespace-free query that looks like an identifier (several words, a
  // delimiter, or a long letter+digit token) and occurs literally in a note is
  // marked `exact`: Postgres tokenizes such names differently in the query and
  // in the note, so FTS alone cannot rank them. ASCII only, so ordinary
  // hyphenated words do not qualify.
  const q = query.trim();
  const asciiToken = /^[\x21-\x7E]+$/.test(q);
  const structured = asciiToken && q.length >= 4 && /[-_.:/\\]/.test(q);
  const opaque = asciiToken && q.length >= 8 && /[0-9]/.test(q) && /[A-Za-z]/.test(q);
  const verbatim = !/\s/.test(q) && (words.length > 1 || structured || opaque);
  const exactHits = (await substringSearch(query, limit, filters, scope))
    .map((r) => (verbatim ? { ...r, exact: true } : r));
  if (rows.length === 0 && orRows.length === 0 && anchorRows.length === 0) {
    return enrichResults(applyExactBand(exactHits));
  }
  const exactIds = new Set(verbatim ? exactHits.map((r) => r.id) : []);

  // ts_rank relative to this query's best; tag and folder weights multiply the
  // raw rank so relevance stays a ratio to the best hit.
  const weightedRank = (n: FtsRow) => n.rank * weightForTags(n.tags, tagWeights) * weightForFolder(n.folder_id, folderWeights);
  const best = Math.max(0, ...rows.map(weightedRank), ...orRows.map(weightedRank), ...anchorRows.map(weightedRank));
  // Coverage is computed for the loose tiers only: an AND hit matched every
  // term by construction, and re-splitting the query in JS can disagree with
  // Postgres' tokenizer (a dotted hostname is one lexeme there).
  const coverageMap = await computeTextCoverage(words, [...orRows, ...anchorRows].map((n) => n.id));
  const toResult = (n: FtsRow, tier: 'and' | 'or'): SearchResult => {
    // Coverage applies after normalization; before it, a set sharing one
    // coverage value would cancel back to 1.0.
    const normalized = best > 0 ? weightedRank(n) / best : 0;
    const exact = exactIds.has(n.id);
    const coverage = exact || tier === 'and' ? 1 : (coverageMap?.get(n.id) ?? 1);
    const relevance = normalized * coverage;
    return {
      id:      n.id,
      title:   n.title,
      excerpt: n.headline.replace(/<\/?b>/g, ''),
      tags:    n.tags,
      score:   n.rank,
      relevance,
      text_tier: tier,
      coverage,
      exact,
    };
  };
  // On a duplicate the FTS row wins (it has a real rank) and keeps `exact`.
  const ftsResults = [
    ...rows.map((n) => toResult(n, 'and')),
    ...orRows.map((n) => toResult(n, 'or')),
    ...anchorRows.map((n) => toResult(n, 'or')),
  ];
  const ftsIds = new Set(ftsResults.map((r) => r.id));
  const results = applyExactBand([...ftsResults, ...exactHits.filter((r) => !ftsIds.has(r.id))]);
  await attachQuestionEcho(results, words);
  results
    .sort((a, b) =>
      Number(b.exact ?? false) - Number(a.exact ?? false)
      || (DEMOTE_QUESTION_ECHO ? Number(a.question_echo ?? false) - Number(b.question_echo ?? false) : 0)
      || b.relevance - a.relevance);
  const filtered = await applyFilters(results, limit, filters, scope);
  await repairBrokenTableExcerpts(filtered);
  if (!deferSections) await attachSections(filtered, query);
  return enrichResults(filtered);
}

// Verbatim hits take the upper half of the relevance scale and everything else
// the lower half, so the number agrees with the order. Proportions within each
// half are kept. A no-op when nothing matched verbatim.
const EXACT_BAND = 0.5;

function applyExactBand<T extends { relevance: number; exact?: boolean }>(results: T[]): T[] {
  const exactScores = results.filter((r) => r.exact).map((r) => r.relevance);
  if (exactScores.length === 0) return results;
  const top = Math.max(...exactScores) || 1;
  return results.map((r) => ({
    ...r,
    relevance: r.exact
      ? EXACT_BAND + (1 - EXACT_BAND) * Math.min(1, r.relevance / top)
      : EXACT_BAND * r.relevance,
  }));
}

/** Title matches rank above content matches (queried separately, merged in order). */
async function substringSearch(
  query: string,
  limit: number,
  filters?: SearchFilters,
  allowedIds?: Set<string>
): Promise<SearchResult[]> {
  const cols = 'id, title, content, tags';
  const escapedQuery = escapeLike(query);
  const fetchLimit = overfetchLimit(limit, filters);
  // Ordered by id so the positional score below is stable between calls.
  const [byTitle, byContent] = await Promise.all([
    dbQuery<NoteRow>(`select ${cols} from notes where title ilike $1 and deleted_at is null order by id asc limit $2`, [`%${escapedQuery}%`, fetchLimit]),
    dbQuery<NoteRow>(`select ${cols} from notes where content ilike $1 and deleted_at is null order by id asc limit $2`, [`%${escapedQuery}%`, fetchLimit]),
  ]);

  const seen = new Set<string>();
  const merged: (NoteRow & { viaTitle: boolean })[] = [];
  const titleIds = new Set(byTitle.map(r => r.id));
  for (const row of [...byTitle, ...byContent]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push({ ...row, viaTitle: titleIds.has(row.id) });
  }

  const results = merged.map((n, i) => {
    const relevance = n.viaTitle ? SUBSTRING_RELEVANCE.title : SUBSTRING_RELEVANCE.content;
    return {
      id:      n.id,
      title:   n.title,
      excerpt: makeExcerpt(n.content, query),
      tags:    n.tags,
      score:   1 / (i + 1),
      relevance,
      text_tier: 'substring' as const,
    };
  });
  return applyFilters(results, limit, filters, allowedIds);
}
