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

export type RerankConfig = {
  url: string;
  /** How many of the fused page's notes are rescored. The rest keep their order below them. */
  topN: number;
  /** Passages sent per note. More costs a full model pass each; see the timing note above. */
  perNote: number;
  timeoutMs: number;
  /** How many top results get their excerpt chosen by the model too. 0 disables it. */
  excerptTop: number;
};

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
let probeInFlight = false;
const LIVENESS_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 2_000;

/** Asks the service whether it is there. Awaited only off the search path. */
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
  if (!liveness || Date.now() - liveness.at > LIVENESS_TTL_MS) {
    if (!probeInFlight) {
      probeInFlight = true;
      probeReranker().finally(() => { probeInFlight = false; });
    }
  }
  return liveness?.ok ?? false;
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
  };
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
  /** The chunk's own body, kept verbatim so the winning passage can become the excerpt. */
  content: string;
};

/** Enough windows to sweep a whole chunk; chunks are bounded, so is this. */
const WINDOW_SCAN_CAP = 16;

/**
 * The window of a chunk that carries most of the query, rather than its first
 * PASSAGE_CHARS characters. Overlapping windows mean a phrase on a boundary
 * still lands whole in one of them. Ties keep the earliest window, so a chunk
 * that matches nothing is represented by its opening as before.
 */
export function bestWindow(content: string, words: string[]): string {
  const windows = windowsOf(content, PASSAGE_CHARS, WINDOW_SCAN_CAP);
  if (windows.length === 1 || words.length === 0) return windows[0];
  let best = windows[0];
  let bestHits = -1;
  for (const w of windows) {
    const hay = w.toLowerCase();
    const hits = words.filter((x) => hay.includes(x)).length;
    if (hits > bestHits) { bestHits = hits; best = w; }
  }
  return best;
}

/**
 * Which passages represent a note to the reranker: chunks (the note's own
 * text, not the display excerpt) chosen by query-word overlap, plus the chunk
 * nearest the query by meaning when distances are given. Sending every chunk
 * would take minutes on CPU.
 */
export function selectPassages(
  noteId: string,
  chunks: { heading: string | null; content: string; distance?: number | null }[],
  query: string,
  perNote: number
): RerankPassage[] {
  // \p{L}\p{N} with /u, not \w: JavaScript's \w is ASCII-only, so splitting a
  // Cyrillic query on \W+ shatters it into empty strings and every chunk
  // scores zero — the selection would silently degrade to "always the first
  // chunk" on exactly the languages this reranker is here to serve.
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3))];
  const scored = chunks.map((c) => {
    const hay = ((c.heading ?? '') + '\n' + c.content).toLowerCase();
    return { c, hits: words.filter((w) => hay.includes(w)).length };
  });
  // Ties keep document order, so a note whose chunks all score zero is
  // represented by its opening rather than by an arbitrary one.
  scored.sort((a, b) => b.hits - a.hits);
  const picked = scored.slice(0, perNote).map(({ c }) => c);
  // Plus the chunk nearest the query by meaning, when distances are known. A
  // question that shares no words with the text (another language, other
  // wording) would otherwise be judged on the note's opening — for a book,
  // its title page. Added, not swapped in: a note's score is its best
  // passage, so the word-matched ones keep counting exactly as before.
  const nearest = chunks.reduce<(typeof chunks)[number] | null>(
    (best, c) => (c.distance != null && (best === null || c.distance < best.distance!) ? c : best), null);
  if (nearest && !picked.includes(nearest)) picked.push(nearest);
  return picked.map((c) => ({
    noteId,
    text: (c.heading ? c.heading + '\n' : '') + bestWindow(c.content, words),
    content: c.content,
  }));
}

/**
 * A note's verdict: its best passage's score, and that passage itself — the
 * caller shows it, because the passage that earned the rank is the one the
 * reader needs to see. Without it a note can be promoted for a paragraph deep
 * inside it and still display its own introduction.
 */
export type RerankHit = { score: number; content: string };

/**
 * One model pass: each text scored against the query, as `{index, score}`
 * pairs pointing back into `texts`.
 *
 * Returns null on any failure — an unreachable service, a timeout, a
 * malformed response. Null means "no opinion", and the caller keeps the order
 * fusion produced. Reranking is an improvement to ordering, never a
 * dependency of search: the same rule the text and semantic arms already
 * follow (see hybridRun's allSettled).
 */
export async function rerankTexts(
  query: string,
  texts: string[],
  cfg: RerankConfig
): Promise<{ index: number; score: number }[] | null> {
  if (texts.length === 0) return null;
  try {
    const res = await fetch(`${cfg.url}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, texts }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[rerank] ${res.status} from ${cfg.url}, keeping fusion order`);
      return null;
    }
    const scored: unknown = await res.json();
    if (!Array.isArray(scored)) return null;
    return (scored as { index?: number; score?: number }[])
      .filter((row) => Number.isInteger(row?.index) && row.index! >= 0 && row.index! < texts.length && typeof row.score === 'number')
      .map((row) => ({ index: row.index!, score: row.score! }));
  } catch (err) {
    console.warn(`[rerank] unavailable (${err instanceof Error ? err.message : String(err)}), keeping fusion order`);
    return null;
  }
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
