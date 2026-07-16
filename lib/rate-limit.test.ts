import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clientIp, authLimitExceeded, recordAuthFailure, resetRateLimits } from './rate-limit';

const req = (ip: string | null) => ({
  headers: { get: (name: string) => (name === 'x-forwarded-for' ? ip : null) },
});

beforeEach(() => {
  vi.useFakeTimers();
  resetRateLimits();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('clientIp', () => {
  it('takes the first X-Forwarded-For hop', () => {
    expect(clientIp(req('203.0.113.7, 10.0.0.1'))).toBe('203.0.113.7');
  });

  it('falls back to a shared key without a proxy header', () => {
    expect(clientIp(req(null))).toBe('direct');
  });
});

describe('authLimitExceeded / recordAuthFailure', () => {
  it('allows requests while under the failure limit', () => {
    for (let i = 0; i < 9; i++) recordAuthFailure(req('1.1.1.1'), 'login');
    expect(authLimitExceeded(req('1.1.1.1'), 'login')).toBe(0);
  });

  it('blocks an IP after 10 failures with a positive retry-after', () => {
    for (let i = 0; i < 10; i++) recordAuthFailure(req('1.1.1.1'), 'login');
    expect(authLimitExceeded(req('1.1.1.1'), 'login')).toBeGreaterThan(0);
  });

  it('never blocks on successes alone (only failures count)', () => {
    for (let i = 0; i < 100; i++) expect(authLimitExceeded(req('1.1.1.1'), 'login')).toBe(0);
  });

  it('unblocks after the window elapses', () => {
    for (let i = 0; i < 10; i++) recordAuthFailure(req('1.1.1.1'), 'login');
    vi.advanceTimersByTime(60_001);
    expect(authLimitExceeded(req('1.1.1.1'), 'login')).toBe(0);
  });

  it('caps rotating IPs via the global bucket', () => {
    // 30 failures from 30 different "IPs" exhaust the global window,
    // so spoofing X-Forwarded-For cannot bypass the limiter.
    for (let i = 0; i < 30; i++) recordAuthFailure(req(`10.0.0.${i}`), 'login');
    expect(authLimitExceeded(req('99.99.99.99'), 'login')).toBeGreaterThan(0);
  });

  it('does not let one client exhaust another endpoint bucket', () => {
    for (let i = 0; i < 10; i++) recordAuthFailure(req('1.1.1.1'), 'login');
    expect(authLimitExceeded(req('1.1.1.1'), 'token')).toBe(0);
  });
});
