import { describe, it, expect } from 'vitest';
import { escapeLike } from './sql';

describe('escapeLike', () => {
  it('escapes the ilike wildcards', () => {
    expect(escapeLike('50% off')).toBe('50\\% off');
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('escapes the backslash itself, so it cannot smuggle a wildcard through', () => {
    // Without this, '\' + '%' escapes to '\\%' — an escaped backslash followed
    // by a live wildcard, which is exactly the match-widening we prevent.
    expect(escapeLike('\\%')).toBe('\\\\\\%');
    expect(escapeLike('C:\\temp')).toBe('C:\\\\temp');
  });

  it('leaves ordinary text (including Cyrillic) untouched', () => {
    expect(escapeLike('Kybase — открытые пункты')).toBe('Kybase — открытые пункты');
    expect(escapeLike('')).toBe('');
  });
});
