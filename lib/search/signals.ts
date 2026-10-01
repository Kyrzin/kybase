import { query as dbQuery } from '../db';
import { getFtsLanguages } from '../settings';
import type { SearchResult } from './types';

// A missed question mark only means a note is not flagged — the safe direction.
const QUESTION_MARK_RE = /[?？؟]\s*$/;

/**
 * Whether a note lists the question instead of answering it: at least two
 * question lines share a query word and none is followed by a non-question
 * line. A real FAQ (question, then answer) never trips it. Structural only:
 * line breaks, question marks and the query's own words.
 */
export function questionEcho(content: string, words: string[]): boolean {
  if (words.length === 0) return false;
  const lower = words.map((w) => w.toLowerCase());
  const lines = content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  let matching = 0;
  let answered = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!QUESTION_MARK_RE.test(lines[i])) continue;
    const haystack = lines[i].toLowerCase();
    if (!lower.some((w) => haystack.includes(w))) continue;
    matching++;
    const next = lines[i + 1];
    if (next !== undefined && !QUESTION_MARK_RE.test(next)) answered++;
  }
  return matching >= 2 && answered === 0;
}

// Only snippets showing a question mark are fetched, and at most this many.
const MAX_ECHO_FETCHES = 8;

/** Sets `question_echo` on candidates, with one batched content fetch. */
export async function attachQuestionEcho(results: SearchResult[], words: string[]): Promise<void> {
  if (words.length === 0) return;
  const candidates = results.filter((r) => /[?？؟]/.test(r.excerpt)).slice(0, MAX_ECHO_FETCHES);
  if (candidates.length === 0) return;
  const rows = await dbQuery<{ id: string; content: string }>(
    'select id, content from notes where id = any($1)',
    [candidates.map((r) => r.id)]
  );
  const contentById = new Map(rows.map((r) => [r.id, r.content]));
  for (const r of candidates) {
    const content = contentById.get(r.id);
    if (content && questionEcho(content, words)) r.question_echo = true;
  }
}

// Minimum length of a "significant" query word. A known limit for scripts
// whose words run one or two characters (CJK).
export const MIN_SIGNIFICANT_WORD_LEN = 3;

export function significantWords(query: string): string[] {
  return query.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= MIN_SIGNIFICANT_WORD_LEN);
}

// Rare words kept as anchors; a pair often only means something together.
const ANCHOR_COUNT = 2;

/**
 * The query's rarest words by document frequency, for a strict re-query when
 * the whole query matched nothing. Words found in no note are dropped.
 */
export async function rareAnchors(words: string[], languages: string[]): Promise<string[]> {
  const unique = [...new Set(words)];
  if (unique.length < 2 || languages.length === 0) return [];
  const langExprs = languages.map((_, i) => `websearch_to_tsquery($${i + 2}::regconfig, unaccent(wt.word))`);
  const tsqExpr = [`websearch_to_tsquery('simple', unaccent(wt.word))`, ...langExprs].join(' || ');
  try {
    const rows = await dbQuery<{ word: string; df: number }>(
      `with word_tsq as (
         select word, (${tsqExpr}) as tsq
         from unnest($1::text[]) as wt(word)
       )
       select wt.word,
         (select count(*)::int from notes n
           where n.deleted_at is null and n.search_vector @@ wt.tsq) as df
       from word_tsq wt
       order by df asc`,
      [unique, ...languages]
    );
    const found = rows.filter((r) => r.df > 0);
    if (found.length === 0) return [];
    // An anchor must be under half as frequent as the query's commonest word.
    const commonest = found[found.length - 1].df;
    const anchors = found.filter((r) => r.df * 2 < commonest).slice(0, ANCHOR_COUNT);
    // All words as anchors is the query the strict pass already ran.
    if (anchors.length === 0 || anchors.length === unique.length) return [];
    return anchors.map((r) => r.word);
  } catch (err) {
    console.warn('[search] anchor selection failed, loose pass stands alone:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * IDF-weighted fraction of the query's significant words each note contains:
 * a ratio, comparable across vaults and languages. A word is significant when
 * at least one configured FTS language keeps it. Fails open with null.
 */
export async function computeTextCoverage(words: string[], ids: string[]): Promise<Map<string, number> | null> {
  if (words.length === 0 || ids.length === 0) return null;
  const uniqueWords = [...new Set(words)];

  try {
    const languages = await getFtsLanguages();
    if (languages.length === 0) return null;

    const sigRows = await dbQuery<{ word: string; significant: boolean }>(
      `select w.word, bool_or(numnode(websearch_to_tsquery(l.lang::regconfig, w.word)) > 0) as significant
       from unnest($1::text[]) as w(word)
       cross join unnest($2::text[]) as l(lang)
       group by w.word`,
      [uniqueWords, languages]
    );
    const significantWordList = sigRows.filter((r) => r.significant).map((r) => r.word);
    if (significantWordList.length === 0) return null;

    // unaccent() to match how search_vector is built.
    const langExprs = languages.map((_, i) => `websearch_to_tsquery($${i + 2}::regconfig, unaccent(wt.word))`);
    const tsqExpr = [`websearch_to_tsquery('simple', unaccent(wt.word))`, ...langExprs].join(' || ');
    const idsParamIndex = languages.length + 2;
    // Each word weighs ln(1 + N/(1+df)) in this vault, so rare words dominate
    // without a language-specific stopword list.
    const rows = await dbQuery<{ id: string; matched_idf: number; total_idf: number }>(
      `with word_tsq as (
         select word, (${tsqExpr}) as tsq
         from unnest($1::text[]) as wt(word)
       ),
       corpus as (select count(*)::float as n from notes where deleted_at is null),
       weighted as (
         select wt.word, wt.tsq,
                ln(1 + (select n from corpus) / (1 + (
                  select count(*) from notes df
                  where df.deleted_at is null and df.search_vector @@ wt.tsq
                ))) as idf
         from word_tsq wt
       )
       select n.id,
         coalesce(sum(w.idf) filter (where n.search_vector @@ w.tsq), 0) as matched_idf,
         (select coalesce(sum(idf), 0) from weighted) as total_idf
       from notes n
       cross join weighted w
       where n.id = any($${idsParamIndex}::uuid[])
       group by n.id`,
      [significantWordList, ...languages, ids]
    );

    const coverage = new Map<string, number>();
    for (const r of rows) {
      const total = Number(r.total_idf);
      coverage.set(r.id, total > 0 ? Number(r.matched_idf) / total : 1);
    }
    return coverage;
  } catch (err) {
    console.warn('[search] coverage computation failed, no discount applied:', err instanceof Error ? err.message : err);
    return null;
  }
}
