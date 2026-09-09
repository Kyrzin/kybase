// lib/rerank.ts — optional cross-encoder reranking of the fused result page.
//
// Retrieval decides WHICH notes come back; this decides which of them goes
// first. The two are different problems, and rank fusion is weak at the
// second one: it can only see how each arm ranked a note, never whether the
// note's text actually answers the question. A cross-encoder reads the query
// and the passage together and scores that pair directly.
//
// Off unless KYBASE_RERANK_URL is set. With it unset nothing here runs and
// search behaves exactly as it did before — the frozen baseline stays the
// default until reranking is shown to earn its place, on the owner's own
// vault, against the queries it actually gets asked.
//
// Cost is the reason for that caution, not caution for its own sake. A
// cross-encoder scores every (query, passage) pair through a full transformer
// pass, so its cost is linear in the number of passages and paid on EVERY
// search — measured 2026-09-08 on the deployment this was built for (4 shared
// cores, no GPU, mmarco-mMiniLMv2-L12 behind text-embeddings-inference):
// roughly 190 ms per passage, i.e. ~1.9 s for ten. Search itself runs in
// ~280 ms. The defaults below are chosen to keep that bounded, and a caller
// that wants more passages is choosing to wait for them.
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

/**
 * Whether a reranker service is installed at all — env only, no database
 * read. Separate from rerankConfig so a caller can tell "nothing to turn on"
 * from "turned off", which is the difference between a missing feature and a
 * deliberate choice, and the settings UI has to show them differently.
 */
export function rerankAvailable(): boolean {
  return !!process.env.KYBASE_RERANK_URL?.trim();
}

/**
 * null = do not rerank: either no service is configured (the shipped default,
 * where nothing here runs at all) or the setting turns it off.
 */
export async function rerankConfig(): Promise<RerankConfig | null> {
  const url = process.env.KYBASE_RERANK_URL?.trim();
  if (!url) return null;
  if (!(await getRerankEnabled())) return null;
  return {
    url: url.replace(/\/+$/, ''),
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
 * How much of a chunk the model is shown.
 *
 * Small on purpose. A cross-encoder scores the passage as a whole, so a
 * relevant sentence buried in unrelated text scores far below the same
 * sentence on its own — measured against this deployment's model: a sentence
 * alone 0.129, the same sentence after 1100 characters of unrelated text
 * 0.0065, the unrelated text alone 0.000075. It reads the sentence either
 * way; dilution costs a factor of twenty regardless.
 *
 * That is why this used to be the wrong shape. Sending the first 1200
 * characters of a chunk both diluted the passage and, since chunks here
 * average well over that, dropped the tail of a typical one — so a note was
 * judged on a padded opening while its answer sat unread further down. Short
 * documents and lists of links, which are naturally undiluted, beat real
 * documents on that arrangement.
 */
const PASSAGE_CHARS = 450;

export type RerankPassage = {
  noteId: string;
  /** What is sent to the model: heading prefixed, truncated to its window. */
  text: string;
  /** The chunk's own body, kept verbatim so the winning passage can become the excerpt. */
  content: string;
};

/**
 * Which passages represent a note to the reranker.
 *
 * The shown excerpt is NOT used: it is a ~300-character window built for a
 * human to read, and the fact that answers the query is routinely outside it.
 * Reranking that window would score the excerpt, not the note. Chunks are the
 * note's own source text, which is what the question has to be judged against.
 *
 * Selection is by query-word overlap because the alternative — sending every
 * chunk — is unaffordable: the top ten notes of a real vault carry 100-230
 * chunks between them, which at CPU speed is minutes, not seconds. The cost
 * of choosing is a real one and worth stating plainly: if the answer sits in
 * a chunk that shares no words with the question, this hands the reranker a
 * passage that cannot answer it, and the note loses on a text it was never
 * asked about. Raising perNote widens that net at a full model pass each.
 */
/** Enough windows to sweep a whole chunk; chunks are bounded, so is this. */
const WINDOW_SCAN_CAP = 16;

/**
 * The window of a chunk that carries most of the query, rather than its first
 * PASSAGE_CHARS characters. Overlapping windows mean a phrase on a boundary
 * still lands whole in one of them. Ties keep the earliest window, so a chunk
 * that matches nothing is represented by its opening as before.
 */
function bestWindow(content: string, words: string[]): string {
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

export function selectPassages(
  noteId: string,
  chunks: { heading: string | null; content: string }[],
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
  return scored.slice(0, perNote).map(({ c }) => ({
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
 * Scores passages against the query and returns the best score per note.
 *
 * Returns null on any failure — an unreachable service, a timeout, a
 * malformed response. Null means "no opinion", and the caller keeps the order
 * fusion produced. Reranking is an improvement to ordering, never a
 * dependency of search: the same rule the text and semantic arms already
 * follow (see hybridRun's allSettled).
 */
export async function scorePassages(
  query: string,
  passages: RerankPassage[],
  cfg: RerankConfig
): Promise<Map<string, RerankHit> | null> {
  if (passages.length === 0) return null;
  try {
    const res = await fetch(`${cfg.url}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, texts: passages.map((p) => p.text) }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[rerank] ${res.status} from ${cfg.url}, keeping fusion order`);
      return null;
    }
    const scored: unknown = await res.json();
    if (!Array.isArray(scored)) return null;
    const best = new Map<string, RerankHit>();
    for (const row of scored as { index?: number; score?: number }[]) {
      const p = typeof row?.index === 'number' ? passages[row.index] : undefined;
      if (!p || typeof row.score !== 'number') continue;
      const prior = best.get(p.noteId);
      // A note is as good as its best passage. Averaging would punish long
      // notes for the chunks that merely aren't about the question.
      if (prior === undefined || row.score > prior.score) {
        best.set(p.noteId, { score: row.score, content: p.content });
      }
    }
    return best.size > 0 ? best : null;
  } catch (err) {
    console.warn(`[rerank] unavailable (${err instanceof Error ? err.message : String(err)}), keeping fusion order`);
    return null;
  }
}
