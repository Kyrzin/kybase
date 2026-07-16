// lib/rate-limit.ts — in-memory failed-attempt limiter for auth endpoints.
// Only failures count, so legitimate users with the right secret are never
// locked out. Single-process by design (Next standalone server); a
// horizontally scaled deploy needs a shared store (Redis) instead.

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

const WINDOW_MS = 60_000;
const IP_LIMIT = 10; // failures per minute from one client
const GLOBAL_LIMIT = 30; // failures per minute across all clients

// Cap the map so an attacker rotating spoofed X-Forwarded-For values can't
// grow it unbounded; expired entries are purged when the cap is reached.
const MAX_BUCKETS = 10_000;

function isLimited(key: string, limit: number): number {
  const bucket = buckets.get(key);
  const now = Date.now();
  if (!bucket || bucket.resetAt <= now || bucket.count < limit) return 0;
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}

function recordFailure(key: string): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (bucket && bucket.resetAt > now) {
    bucket.count++;
    return;
  }
  if (buckets.size >= MAX_BUCKETS && !buckets.has(key)) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    if (buckets.size >= MAX_BUCKETS) return; // global bucket still counts
  }
  buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
}

export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  // Behind a reverse proxy (Traefik/nginx) the client is the first
  // X-Forwarded-For hop. Without a proxy the header is client-controlled, so
  // per-IP limiting can be dodged — the global bucket still holds.
  const xff = req.headers.get('x-forwarded-for');
  return xff ? xff.split(',')[0].trim() : 'direct';
}

/**
 * Seconds until the client may try again (for a Retry-After header), or 0 if
 * the request is allowed. Check this before verifying the credential.
 */
export function authLimitExceeded(
  req: { headers: { get(name: string): string | null } },
  bucket: string
): number {
  return Math.max(
    isLimited(`${bucket}:${clientIp(req)}`, IP_LIMIT),
    isLimited(`${bucket}:*`, GLOBAL_LIMIT)
  );
}

/** Call after a credential check fails. */
export function recordAuthFailure(
  req: { headers: { get(name: string): string | null } },
  bucket: string
): void {
  recordFailure(`${bucket}:${clientIp(req)}`);
  recordFailure(`${bucket}:*`);
}

/** Test hook — clears all counters. */
export function resetRateLimits(): void {
  buckets.clear();
}
