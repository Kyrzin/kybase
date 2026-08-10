import { describe, it, expect } from 'vitest';
import { stripNulBytes } from './types';

describe('stripNulBytes', () => {
  it('removes NUL bytes so Postgres does not reject the string', () => {
    const withNul = 'before' + String.fromCharCode(0) + 'after';
    expect(stripNulBytes(withNul)).toBe('beforeafter');
  });

  it('leaves ordinary text untouched', () => {
    expect(stripNulBytes('hello world')).toBe('hello world');
  });
});
