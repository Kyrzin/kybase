// A stopped reindex; honored during Google's pacing and 429 waits, the only long ones.
export class EmbedCancelledError extends Error {
  constructor() { super('Reindex cancelled'); }
}

/**
 * The provider refused on quota (a 429 that outlived fetchWithRetry), as
 * opposed to failing on this input. Reindex counts these separately, and the
 * context-overflow check must run after it: quota messages mention tokens.
 */
export function isQuotaExhausted(err: unknown): boolean {
  return err instanceof Error
    && /\(429\)|RESOURCE_EXHAUSTED|exceeded your current quota|rate limit/i.test(err.message);
}

// A hung provider must not block saves and searches; the note stays pending.
const EMBED_TIMEOUT_MS = 30_000;

// Google's 429 body carries the wait in error.details[].retryDelay ("23s"); null otherwise.
async function parseRetryDelayMs(res: Response): Promise<number | null> {
  try {
    const body = await res.clone().json();
    const info = body?.error?.details?.find((d: { '@type'?: string }) => d['@type']?.includes('RetryInfo'));
    const seconds = typeof info?.retryDelay === 'string' ? parseFloat(info.retryDelay) : NaN;
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

// Sleeps in short slices so a cancel lands quickly.
export async function sleepCancellable(ms: number, isCancelled?: () => boolean): Promise<void> {
  const slice = 500;
  for (let remaining = ms; remaining > 0; remaining -= slice) {
    if (isCancelled?.()) throw new EmbedCancelledError();
    await new Promise(r => setTimeout(r, Math.min(slice, remaining)));
  }
  if (isCancelled?.()) throw new EmbedCancelledError();
}

/** Retries 429s with backoff: the body's retryDelay, then Retry-After, then exponential. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  // `pace` runs before every attempt: retries count against the rate limit too.
  opts: { attempts?: number; onRateLimited?: () => void; isCancelled?: () => boolean; pace?: () => Promise<void> } = {}
): Promise<Response> {
  const attempts = opts.attempts ?? 5;
  // Caps a provider-suggested wait; reindex's circuit breaker decides when to stop.
  const MAX_WAIT_MS = 30_000;
  let delay = 2000;
  for (let i = 0; ; i++) {
    if (opts.isCancelled?.()) throw new EmbedCancelledError();
    if (opts.pace) await opts.pace();
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(EMBED_TIMEOUT_MS) });
    if (res.status !== 429 || i >= attempts - 1) return res;
    opts.onRateLimited?.();
    const bodyDelayMs = await parseRetryDelayMs(res);
    const headerDelayMs = Number(res.headers.get('retry-after')) * 1000;
    const waitMs = bodyDelayMs || (headerDelayMs > 0 ? headerDelayMs : delay);
    await sleepCancellable(Math.min(waitMs, MAX_WAIT_MS), opts.isCancelled);
    delay = Math.min(delay * 2, MAX_WAIT_MS);
  }
}
