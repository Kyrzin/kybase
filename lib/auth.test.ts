import { describe, it, expect } from 'vitest';
import { safeEqual, bearerToken } from './auth';

describe('safeEqual', () => {
  it('returns true for identical strings', () => {
    expect(safeEqual('super-secret', 'super-secret')).toBe(true);
  });
  it('returns false for different strings of equal length', () => {
    expect(safeEqual('super-secret', 'super-secre1')).toBe(false);
  });
  it('returns false for different-length strings without throwing', () => {
    expect(safeEqual('short', 'much-longer-secret')).toBe(false);
  });
  it('returns false when compared to empty string', () => {
    expect(safeEqual('', 'super-secret')).toBe(false);
  });
  it('treats two empty strings as equal', () => {
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('bearerToken', () => {
  const req = (authorization: string | null) => ({
    headers: { get: (name: string) => (name === 'authorization' ? authorization : null) },
  });

  it('extracts the token after "Bearer "', () => {
    expect(bearerToken(req('Bearer abc123'))).toBe('abc123');
  });
  it('returns empty string when no Authorization header', () => {
    expect(bearerToken(req(null))).toBe('');
  });
  it('returns empty string for non-Bearer schemes', () => {
    expect(bearerToken(req('Basic abc123'))).toBe('');
  });
});
