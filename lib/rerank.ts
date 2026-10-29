// lib/rerank.ts — optional cross-encoder reranking of the fused result page.
//
// Retrieval decides which notes come back; a cross-encoder, reading query and
// passage together, decides which goes first. Used when the reranker service
// answers (the compose service by default, or KYBASE_RERANK_URL) and reranking
// is enabled in settings. Cost is a full model pass per passage on every
// search, so the defaults keep the number of passages small.
//
// Wire protocol is text-embeddings-inference's /rerank: POST {query, texts}
// -> [{index, score}]. Any service answering that shape works.
import { getRerankEnabled } from './settings';
import { sectionOfSpan } from './markdown';
import { RRF_K } from './search/config';
import { stripLeadingHeading } from './search/excerpt';

export type RerankConfig = {
  url: string;
  /** How many of the fused page's notes are rescored. The rest keep their order below them. */
  topN: number;
  /** Passages sent per note. More costs a full model pass each; see the timing note above. */
  perNote: number;
  timeoutMs: number;
  /** How many top results get their excerpt chosen by the model too. 0 disables it. */
  excerptTop: number;
  /** How the model's score meets the fused order; see RerankMode. */
  mode: RerankMode;
  /** score mode: weight of the fused relevance, 0..1; the model's score gets the rest. */
  blendAlpha: number;
  /** rank mode: weight of the model's rank against the fused rank. */
  rankWeight: number;
};

/**
 * rank (default): rank fusion of the fused order and the model's order, so
 * neither scale matters. score: a weighted sum of the fused relevance and the
 * model's score, both 0..1. replace: the model's score alone orders the
 * rescored notes. A blend keeps a candidate that both arms placed high from
 * sinking on one low model score — a query on several topics at once can score
 * every single passage low.
 */
export type RerankMode = 'replace' | 'score' | 'rank';

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const rerankMode = (v: string | undefined): RerankMode => (v === 'score' || v === 'replace' ? v : 'rank');

/** A number in [min, max], or the fallback for anything else, an empty value included. */
const bounded = (v: string | undefined, fallback: number, min: number, max = Infinity) => {
  const n = v?.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

/** The compose service name, so starting the profile is the whole setup; KYBASE_RERANK_URL overrides it. */
const DEFAULT_RERANK_URL = 'http://reranker:80';

export function rerankUrl(): string {
  return (process.env.KYBASE_RERANK_URL?.trim() || DEFAULT_RERANK_URL).replace(/\/+$/, '');
}

// Whether the service answered recently. Kept because the URL now has a
// default: without a liveness check, an install that never starts the profile
// would pay a connection timeout on every search to learn what it already
// knew a second ago.
let liveness: { ok: boolean; at: number } | null = null;
let probeInFlight: Promise<boolean> | null = null;
const LIVENESS_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 2_000;

/** One probe at a time; callers that want its answer share it. */
function probeShared(): Promise<boolean> {
  probeInFlight ??= probeReranker().finally(() => { probeInFlight = null; });
  return probeInFlight;
}

/** Asks the service whether it is there. A search awaits only the first one (rerankReady). */
export async function probeReranker(): Promise<boolean> {
  try {
    const res = await fetch(`${rerankUrl()}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    liveness = { ok: res.ok, at: Date.now() };
  } catch {
    liveness = { ok: false, at: Date.now() };
  }
  return liveness.ok;
}

/**
 * Whether a reranker is there, from the last probe — never awaiting one.
 *
 * A search must not wait to find out that nothing is listening: an install
 * that never started the profile would otherwise pay the connection timeout
 * on the first search of every minute. A stale answer costs at most one page
 * ranked by rank fusion instead, which is the shipped default anyway.
 */
export function rerankAvailable(): boolean {
  if (!liveness || Date.now() - liveness.at > LIVENESS_TTL_MS) void probeShared();
  return liveness?.ok ?? false;
}

/**
 * rerankAvailable for a search about to rerank. Until the process has asked
 * once there is no answer to go on, and the first search after a start would
 * go unranked; that one search waits for the first probe instead, at most
 * PROBE_TIMEOUT_MS. Every later one reads the last answer without waiting.
 */
export async function rerankReady(): Promise<boolean> {
  if (!liveness) await probeShared();
  return rerankAvailable();
}

/**
 * null = do not rerank: either no service is configured (the shipped default,
 * where nothing here runs at all) or the setting turns it off.
 */
export async function rerankConfig(): Promise<RerankConfig | null> {
  // Configuration only — whether anything is answering at that URL is a
  // separate question (rerankAvailable), asked by the caller. Keeping the two
  // apart means this stays a pure read of settings and env, and a search can
  // decide not to wait on a service it already knows is absent.
  if (!(await getRerankEnabled())) return null;
  return {
    url: rerankUrl(),
    topN: Math.min(50, num(process.env.KYBASE_RERANK_TOP_N, 10)),
    perNote: Math.min(5, num(process.env.KYBASE_RERANK_PASSAGES_PER_NOTE, 2)),
    // Deliberately longer than any other outbound call in this codebase: on
    // CPU the model genuinely takes seconds, and a timeout tuned for a fast
    // service would abort every real request and silently disable the thing
    // it was meant to protect.
    timeoutMs: num(process.env.KYBASE_RERANK_TIMEOUT_MS, 20000),
    excerptTop: Math.min(5, Math.max(0, Number(process.env.KYBASE_RERANK_EXCERPT_TOP ?? 1) || 0)),
    mode: rerankMode(process.env.KYBASE_RERANK_MODE),
    blendAlpha: bounded(process.env.KYBASE_RERANK_BLEND_ALPHA, 0.5, 0, 1),
    rankWeight: bounded(process.env.KYBASE_RERANK_RANK_WEIGHT, 1, 0),
  };
}

/**
 * The score that orders rescored candidates, higher first. `items` are in
 * fused order, best first: `fused` is the fused relevance (0..1), `rerank` the
 * model's score. Ranks in rank mode count from 1; equal model scores keep the
 * fused order.
 */
export function blendScores(
  items: { fused: number; rerank: number }[],
  cfg: Pick<RerankConfig, 'mode' | 'blendAlpha' | 'rankWeight'>
): number[] {
  if (cfg.mode === 'score') return items.map((it) => cfg.blendAlpha * it.fused + (1 - cfg.blendAlpha) * it.rerank);
  if (cfg.mode === 'rank') {
    const rerankRank = new Array<number>(items.length);
    items.map((_, i) => i)
      .sort((a, b) => items[b].rerank - items[a].rerank || a - b)
      .forEach((i, position) => { rerankRank[i] = position + 1; });
    return items.map((_, i) => 1 / (RRF_K + i + 1) + cfg.rankWeight / (RRF_K + rerankRank[i]));
  }
  return items.map((it) => it.rerank);
}

// Excerpt refinement budget. Both are per note and paid only for the first
// `excerptTop` results, because the cost is another model pass each and the
// hit a reader actually opens is the first one.
export const EXCERPT_CHUNK_CAP = 8;
const EXCERPT_WINDOW_CAP = 6;
const EXCERPT_WINDOW_CHARS = 450;

/**
 * How far a window edge may move to land between words. Same distance
 * makeExcerpt allows itself; kept here rather than imported because search.ts
 * imports this module, not the other way round.
 */
const SNAP_WINDOW = 24;

/** The slice from `from` to `to` with neither edge splitting a word. */
function snapToWords(text: string, from: number, to: number): string {
  if (from > 0) {
    const ws = text.slice(from, from + SNAP_WINDOW).search(/\s/);
    if (ws !== -1) from += ws + 1;
  }
  if (to < text.length) {
    const back = Math.max(from + 1, to - SNAP_WINDOW);
    const ws = text.slice(back, to).search(/\s\S*$/); // start of the last, partial word
    if (ws !== -1) to = back + ws;
  }
  return text.slice(from, to);
}

/**
 * Overlapping slices of a passage, so the excerpt can be chosen by the model
 * rather than by word overlap.
 *
 * Overlap is half a window: a fact that straddles a boundary would otherwise
 * be split across two windows and score poorly in both — which is the failure
 * being fixed here, one level down (a shown excerpt that stopped four words
 * before the token it was asked for).
 *
 * Edges land between words. A winning window becomes the shown excerpt, and
 * makeExcerpt only trims a start it had to move itself — so a window opening
 * mid-word reached the reader as a severed one, with no ellipsis to admit it.
 * The model reads these too, and half a word is noise to it as well.
 */
export function windowsOf(text: string, size = EXCERPT_WINDOW_CHARS, cap = EXCERPT_WINDOW_CAP): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  const stride = Math.floor(size / 2);
  for (let i = 0; i < text.length && out.length < cap; i += stride) {
    out.push(snapToWords(text, i, Math.min(text.length, i + size)));
  }
  return out;
}

/**
 * How much of a chunk the model is shown. Small on purpose: a cross-encoder
 * scores the passage as a whole, so a relevant sentence in a long window
 * scores far below the same sentence alone.
 */
const PASSAGE_CHARS = 450;

export type RerankPassage = {
  noteId: string;
  /** What is sent to the model: heading prefixed, truncated to its window. */
  text: string;
  /**
   * What the excerpt is cut from if this passage wins, kept verbatim: the
   * chunk's own body, or the window itself when no query word could place
   * the excerpt inside the chunk.
   */
  content: string;
};

/** Enough windows to sweep a whole chunk; chunks are bounded, so is this. */
const WINDOW_SCAN_CAP = 16;

/** The window of a chunk that scores highest; ties keep the earliest, so a chunk that matches nothing is represented by its opening. */
function bestWindowBy(content: string, score: (lowerText: string) => number): string {
  const windows = windowsOf(content, PASSAGE_CHARS, WINDOW_SCAN_CAP);
  let best = windows[0];
  let bestScore = -1;
  for (const w of windows) {
    const s = score(w.toLowerCase());
    if (s > bestScore) { bestScore = s; best = w; }
  }
  return best;
}

/**
 * The window of a chunk that carries most of the query, rather than its first
 * PASSAGE_CHARS characters. Overlapping windows mean a phrase on a boundary
 * still lands whole in one of them. Ties keep the earliest window, so a chunk
 * that matches nothing is represented by its opening as before.
 */
export function bestWindow(content: string, words: string[]): string {
  return bestWindowBy(content, (hay) => words.filter((x) => hay.includes(x)).length);
}

/**
 * Up to `count` windows spread evenly across a chunk, first and last
 * included. For a chunk chosen by meaning alone, where no query word says
 * which part of it matters: the model reads the spread and picks.
 */
function spreadWindows(text: string, count: number): string[] {
  const last = text.length - PASSAGE_CHARS;
  if (last <= 0) return [text];
  // No more than half-overlapping windows need to cover it.
  const n = Math.min(count, Math.ceil(last / (PASSAGE_CHARS / 2)) + 1);
  if (n <= 1) return [snapToWords(text, 0, PASSAGE_CHARS)];
  return Array.from({ length: n }, (_, i) => {
    const from = Math.round((i * last) / (n - 1));
    return snapToWords(text, from, from + PASSAGE_CHARS);
  });
}

// Score tiers, so a lower tier can never outweigh a higher one: the query
// verbatim, then an identifier it contains, then weighted words.
const PHRASE_MATCH = 1e6;
const IDENTIFIER_MATCH = 1e3;

/**
 * A query token that is matched whole: it contains punctuation that splitting
 * into words would shatter — case numbers (117/21), versions, file and host
 * names. A hyphen counts only next to a digit, so hyphenated words are not
 * identifiers; four characters at least, so abbreviations like "e.g." are not.
 */
const isIdentifier = (token: string) =>
  token.length >= 4 && (/[._/:@\\#]/.test(token) || (token.includes('-') && /\p{N}/u.test(token)));

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Punctuation that joins the parts of an identifier: 12/34, v1.5.0, 10:30, nas-02. */
const JOINER = /[./:_@#\\-]/;

/**
 * Matches `pattern` only where it is not part of a longer token: 12/34 is not
 * 112/340, and v1.5.0 is not v1.5.0.1. A joiner followed by a
 * space (the full stop after "v1.5.0.") does not extend the token.
 */
const standalone = (pattern: string) => new RegExp(
  `(?<![\\p{L}\\p{N}])(?<![\\p{L}\\p{N}][./:_@#\\\\-])${pattern}(?![\\p{L}\\p{N}])(?![./:_@#\\\\-][\\p{L}\\p{N}])`, 'u');

/**
 * Drops the whitespace typed or OCR'd around a joiner inside an identifier:
 * "12 / 34" → "12/34", "v 1 . 5 . 0" → "v 1.5.0". Only between a
 * letter or digit and another; a hyphen only before a digit, so "foo - bar"
 * stays three words.
 */
export function normalizeQuery(query: string): string {
  return query.replace(/(?<=[\p{L}\p{N}])\s*([./:_@#\\]|-(?=\s*\p{N}))\s*(?=[\p{L}\p{N}])/gu, '$1');
}

const isLetter = (ch: string) => /\p{L}/u.test(ch);
const isDigit = (ch: string) => /\p{N}/u.test(ch);
/** Whether text may hold whitespace between two adjacent characters of an identifier. */
const looseBetween = (a: string, b: string) =>
  JOINER.test(a) || JOINER.test(b) || (isLetter(a) && isDigit(b)) || (isDigit(a) && isLetter(b));

/**
 * A query token as a pattern that tolerates whitespace in the text around a
 * joiner and between letters and digits ("12 / 34", "v 1.5.0" for 12/34 and
 * v1.5.0), never inside a run of letters or of digits.
 */
function tolerant(token: string): string {
  const chars = [...token];
  return chars.map((ch, i) => (i > 0 && looseBetween(chars[i - 1], ch) ? '\\s*' : '') + escapeRegExp(ch)).join('');
}

/**
 * Scores lowercased text of one note against the query: the whole query as a
 * phrase (any whitespace between its tokens), identifier tokens, then words
 * weighted by inverse document frequency over the note's own chunks, so a term
 * few chunks share outweighs several that most of them do. `firstAt` is where
 * the earliest of them occurs in a text, or -1.
 */
function queryMatcher(query: string, hays: string[]): { score: (lowerText: string) => number; firstAt: (lowerText: string) => number } {
  const normalized = normalizeQuery(query).toLowerCase();
  const tokens = normalized.split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
  // Between two query tokens the text needs whitespace too, unless one ends in
  // a letter and the next starts with a digit or the reverse: "v 1.5.0" is
  // also "v1.5.0", "on line" is not "online", "2026 10" is not "202610".
  const phrase = tokens.length > 1
    ? standalone(tokens.map((t, i) => (i === 0 ? '' : looseBetween(tokens[i - 1].slice(-1), t[0]) ? '\\s*' : '\\s+') + tolerant(t)).join(''))
    : null;
  // \p{L}\p{N} with /u, not \w: JavaScript's \w is ASCII-only, so splitting a
  // Cyrillic query on \W+ shatters it into empty strings and every chunk
  // scores zero — the selection would silently degrade to "always the first
  // chunk" on exactly the languages this reranker is here to serve.
  const words = [...new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3))];
  const terms = [
    ...[...new Set(tokens.filter(isIdentifier))].map((t) => {
      const re = standalone(tolerant(t));
      return { tier: IDENTIFIER_MATCH, has: (hay: string) => re.test(hay), at: (hay: string) => hay.search(re) };
    }),
    ...words.map((w) => ({ tier: 0, has: (hay: string) => hay.includes(w), at: (hay: string) => hay.indexOf(w) })),
  ].map((t) => {
    const df = hays.filter(t.has).length;
    return { ...t, weight: df > 0 ? Math.log(1 + hays.length / df) : 0 };
  });
  return {
    score: (hay) => {
      let score = phrase?.test(hay) ? PHRASE_MATCH : 0;
      for (const t of terms) if (t.has(hay)) score += t.tier + t.weight;
      return score;
    },
    firstAt: (hay) => {
      const found = [phrase ? hay.search(phrase) : -1, ...terms.map((t) => t.at(hay))].filter((i) => i >= 0);
      return found.length > 0 ? Math.min(...found) : -1;
    },
  };
}

/**
 * Which passages represent a note to the reranker, at most perNote + 1 of
 * them — sending every chunk would take minutes on CPU. Chunks the query
 * reaches lexically come first (see queryMatcher), each by its best window;
 * then the chunk nearest the query by meaning, when distances are given;
 * then the note's opening fills any slot left, so a note nothing matches is
 * still represented. Ties keep document order.
 */
export function selectPassages(
  noteId: string,
  chunks: { heading: string | null; content: string; distance?: number | null }[],
  query: string,
  perNote: number,
  title?: string
): RerankPassage[] {
  const hays = chunks.map((c) => ((c.heading ?? '') + '\n' + c.content).toLowerCase());
  const { score: match, firstAt } = queryMatcher(query, hays);
  const scores = hays.map(match);
  // The heading line a chunk opens with does not count against the window:
  // the passage already names the section. A chunk whose text under that line
  // fits a window is sent whole, whichever window the words picked; a longer
  // one gets the line's length back on the window that opens it. Every other
  // window, and a chunk that fits as it is, is sent as before.
  const windowOf = (i: number, window: string): string => {
    const { content } = chunks[i];
    const lead = content.length - stripLeadingHeading(content).length;
    if (lead === 0 || window.length === content.length) return window;
    if (content.length - lead <= PASSAGE_CHARS) return content;
    if (!content.startsWith(window)) return window;
    return snapToWords(content, 0, Math.min(content.length, window.length + lead));
  };
  // The model reads a window under the heading of the section it sits in, not
  // the chunk's: a chunk can group several sections under the first one's. A
  // window the query's words reached belongs to the section they are in.
  const passage = (i: number, window: string, content = chunks[i].content): RerankPassage => {
    const at = chunks[i].content.indexOf(window);
    const hit = at === -1 ? -1 : firstAt(window.toLowerCase());
    const heading = (at === -1 ? null : sectionOfSpan(chunks[i].content, at, at + window.length, hit === -1 ? undefined : at + hit))
      ?? chunks[i].heading;
    // The note's title opens the passage unless the heading repeats it: an
    // entry of a log or a chapter of a book says little about what the note is.
    const named = title && title !== heading ? title + '\n' : '';
    return { noteId, text: named + (heading ? heading + '\n' : '') + window, content };
  };

  const lexical = chunks.map((_, i) => i).filter((i) => scores[i] > 0)
    .sort((a, b) => scores[b] - scores[a] || a - b)
    .slice(0, perNote);

  // The chunk nearest by meaning is added, not swapped in: a question that
  // shares no words with the text (another language, other wording) would
  // otherwise be judged on whatever the words picked — for a book, its title
  // page. A note's score is its best passage, so the word-matched ones keep
  // counting exactly as before.
  let nearest = -1;
  chunks.forEach((c, i) => {
    if (c.distance != null && (nearest === -1 || c.distance < chunks[nearest].distance!)) nearest = i;
  });
  let semantic: RerankPassage[] = [];
  if (nearest !== -1 && !lexical.includes(nearest)) {
    semantic = scores[nearest] > 0
      ? [passage(nearest, windowOf(nearest, bestWindowBy(chunks[nearest].content, match)))]
      // No query word says which part of it matters, so it takes the free
      // slots as windows across it. Each window is its own excerpt source:
      // the one that wins is the part shown.
      : [...new Set(spreadWindows(chunks[nearest].content, perNote + 1 - lexical.length).map((w) => windowOf(nearest, w)))]
        .map((w) => passage(nearest, w, w));
  }

  const slots = perNote + (semantic.length > 0 ? 1 : 0) - lexical.length - semantic.length;
  const opening = chunks.map((_, i) => i)
    .filter((i) => !lexical.includes(i) && i !== nearest)
    .slice(0, Math.max(0, slots));
  return [
    ...[...lexical, ...opening].map((i) => passage(i, windowOf(i, bestWindowBy(chunks[i].content, match)))),
    ...semantic,
  ];
}

/**
 * A note's verdict: its best passage's score, and that passage itself — the
 * caller shows it, because the passage that earned the rank is the one the
 * reader needs to see. Without it a note can be promoted for a paragraph deep
 * inside it and still display its own introduction.
 */
export type RerankHit = { score: number; content: string };

/**
 * Texts per request. TEI refuses a request with more than its
 * --max-client-batch-size texts (HTTP 413), which would switch reranking off
 * for the whole search; 32 is TEI's own default, the compose service allows 64.
 */
export const RERANK_BATCH = 32;

/** One request of at most RERANK_BATCH texts; indices are shifted by `offset` back into the caller's list. */
async function rerankBatch(
  query: string,
  texts: string[],
  offset: number,
  cfg: RerankConfig,
  signal: AbortSignal
): Promise<{ index: number; score: number }[] | null> {
  try {
    const res = await fetch(`${cfg.url}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, texts }),
      signal,
    });
    if (!res.ok) {
      console.warn(`[rerank] ${res.status} from ${cfg.url}, keeping fusion order`);
      return null;
    }
    const scored: unknown = await res.json();
    if (!Array.isArray(scored)) return null;
    return (scored as { index?: number; score?: number }[])
      .filter((row) => Number.isInteger(row?.index) && row.index! >= 0 && row.index! < texts.length && typeof row.score === 'number')
      .map((row) => ({ index: offset + row.index!, score: row.score! }));
  } catch (err) {
    console.warn(`[rerank] unavailable (${err instanceof Error ? err.message : String(err)}), keeping fusion order`);
    return null;
  }
}

/**
 * One model pass: each text scored against the query, as `{index, score}`
 * pairs pointing back into `texts`, best first and ties by position — the
 * same whether it took one request or several.
 *
 * Returns null on any failure — an unreachable service, a timeout, a
 * malformed response, any one request of several. Null means "no opinion",
 * and the caller keeps the order fusion produced. Reranking is an improvement
 * to ordering, never a dependency of search: the same rule the text and
 * semantic arms already follow (see hybridRun's allSettled).
 */
export async function rerankTexts(
  query: string,
  texts: string[],
  cfg: RerankConfig
): Promise<{ index: number; score: number }[] | null> {
  if (texts.length === 0) return null;
  // One deadline for the whole pass, however many requests it takes.
  const signal = AbortSignal.timeout(cfg.timeoutMs);
  const offsets: number[] = [];
  for (let i = 0; i < texts.length; i += RERANK_BATCH) offsets.push(i);
  const parts = await Promise.all(offsets.map((o) => rerankBatch(query, texts.slice(o, o + RERANK_BATCH), o, cfg, signal)));
  const scored: { index: number; score: number }[] = [];
  for (const part of parts) {
    if (!part) return null;
    scored.push(...part);
  }
  return scored.sort((a, b) => b.score - a.score || a.index - b.index);
}

/** Scores passages against the query and returns the best score per note. */
export async function scorePassages(
  query: string,
  passages: RerankPassage[],
  cfg: RerankConfig
): Promise<Map<string, RerankHit> | null> {
  const scored = await rerankTexts(query, passages.map((p) => p.text), cfg);
  if (!scored) return null;
  const best = new Map<string, RerankHit>();
  for (const { index, score } of scored) {
    const p = passages[index];
    const prior = best.get(p.noteId);
    // A note is as good as its best passage. Averaging would punish long
    // notes for the chunks that merely aren't about the question.
    if (prior === undefined || score > prior.score) {
      best.set(p.noteId, { score, content: p.content });
    }
  }
  return best.size > 0 ? best : null;
}
