import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyPkce } from './pkce';

const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

describe('verifyPkce', () => {
  it('accepts a matching S256 verifier', () => {
    expect(verifyPkce(verifier, challenge, 'S256')).toBe(true);
  });

  it('rejects a wrong verifier', () => {
    expect(verifyPkce('wrong-verifier', challenge, 'S256')).toBe(false);
  });

  it('rejects an empty verifier and empty challenge (the old bypass)', () => {
    expect(verifyPkce('', '', 'plain')).toBe(false);
    expect(verifyPkce('', '', 'S256')).toBe(false);
  });

  it('rejects the plain method even when values match', () => {
    expect(verifyPkce('abc', 'abc', 'plain')).toBe(false);
  });

  it('rejects an empty challenge with a real verifier', () => {
    expect(verifyPkce(verifier, '', 'S256')).toBe(false);
  });
});
