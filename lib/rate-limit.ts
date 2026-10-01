// lib/rate-limit.ts — in-memory failed-attempt limiter for auth endpoints.
// Only failures count, so a request never fills the bucket just by
// succeeding. That alone doesn't guarantee a legitimate user is never
// locked out, though: GLOBAL_LIMIT isn't IP-scoped, so if a caller checked
// this bucket before verifying the credential, anyone who could reach the
// port could fill it with garbage attempts and 429 the real secret holder.
// Every caller checks the credential first and only consults the bucket on
// the invalid path, to avoid exactly that — this is the actual invariant to
// preserve in any new caller, not a specific file list (one drifted stale
// here before: proxy.ts, app/api/mcp/route.ts, and lib/route-auth.ts were
// correct, but app/authorize/route.ts, app/api/oauth/token/route.ts,
// app/api/auth/check/route.ts, and app/share/[token]/route.ts all checked
// the bucket first until this comment was fixed alongside them). Single-
// process by design (Next standalone server); a horizontally scaled deploy
// needs a shared store (Redis) instead.

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
 * the request is allowed. Check this only after the credential has already
 * failed — checking it first lets the global bucket lock out a caller who
 * would have presented a valid credential (see the file header comment).
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
