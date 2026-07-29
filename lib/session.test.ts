import { describe, it, expect } from 'vitest';
import { createSessionToken, verifySessionToken } from './session';

describe('createSessionToken / verifySessionToken', () => {
  it('accepts a freshly issued token', async () => {
    const token = await createSessionToken('secret-a');
    expect(await verifySessionToken(token, 'secret-a')).toBe(true);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await createSessionToken('secret-a');
    expect(await verifySessionToken(token, 'secret-b')).toBe(false);
  });

  it('rejects a tampered payload', async () => {
    const token = await createSessionToken('secret-a');
    const [payload, signature] = token.split('.');
    const tampered = `${payload}x.${signature}`;
    expect(await verifySessionToken(tampered, 'secret-a')).toBe(false);
  });

  it('rejects malformed tokens without throwing', async () => {
    expect(await verifySessionToken('', 'secret-a')).toBe(false);
    expect(await verifySessionToken('not-a-token', 'secret-a')).toBe(false);
    expect(await verifySessionToken('a.b.c', 'secret-a')).toBe(false);
  });

  it('rejects an expired token', async () => {
    const originalNow = Date.now;
    try {
      Date.now = () => 0;
      const token = await createSessionToken('secret-a');
      Date.now = () => 365 * 24 * 60 * 60 * 1000; // one year later
      expect(await verifySessionToken(token, 'secret-a')).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });
});
