import { describe, it, expect } from 'vitest';
import { nextUntitledTitle } from './useNotes';

describe('nextUntitledTitle', () => {
  it('returns "Untitled" when nothing is taken', () => {
    expect(nextUntitledTitle(new Set())).toBe('Untitled');
  });

  it('returns "Untitled 2" once "Untitled" is taken', () => {
    expect(nextUntitledTitle(new Set(['untitled']))).toBe('Untitled 2');
  });

  it('skips consecutively taken numbers', () => {
    expect(nextUntitledTitle(new Set(['untitled', 'untitled 2', 'untitled 3']))).toBe('Untitled 4');
  });

  it('fills a gap left by a renamed note instead of always incrementing from the count', () => {
    // "Untitled 2" was renamed away — count-based logic would wrongly guess
    // "Untitled 3" is free by counting entries, not by checking that slot.
    expect(nextUntitledTitle(new Set(['untitled', 'untitled 3']))).toBe('Untitled 2');
  });

  it('expects callers to lower-case titles first, matching the DB unique index', () => {
    expect(nextUntitledTitle(new Set(['Mixed Case Title'.toLowerCase(), 'untitled']))).toBe('Untitled 2');
  });
});
