import { describe, it, expect } from 'vitest';
import { extractWikilinkTarget, extractAllWikilinks } from './wikilinks';

describe('extractWikilinkTarget', () => {
  it('returns plain title unchanged', () => {
    expect(extractWikilinkTarget('RAG Pipeline')).toBe('RAG Pipeline');
  });
  it('strips alias after |', () => {
    expect(extractWikilinkTarget('RAG Pipeline|RAG')).toBe('RAG Pipeline');
  });
  it('strips section after #', () => {
    expect(extractWikilinkTarget('RAG Pipeline#Overview')).toBe('RAG Pipeline');
  });
  it('strips both section and alias', () => {
    expect(extractWikilinkTarget('RAG Pipeline#Overview|RAG')).toBe('RAG Pipeline');
  });
  it('trims whitespace', () => {
    expect(extractWikilinkTarget('  My Note  ')).toBe('My Note');
  });
});

describe('extractAllWikilinks', () => {
  it('finds all wikilink targets in text', () => {
    const text = 'See [[RAG Pipeline|RAG]] and [[Docker Setup#Networking]]';
    expect(extractAllWikilinks(text)).toEqual(['RAG Pipeline', 'Docker Setup']);
  });
  it('returns empty array when no wikilinks', () => {
    expect(extractAllWikilinks('No links here')).toEqual([]);
  });
  it('deduplicates repeated links', () => {
    const text = '[[Note A]] and [[Note A]] again';
    expect(extractAllWikilinks(text)).toEqual(['Note A']);
  });
  it('handles plain wikilinks', () => {
    expect(extractAllWikilinks('See [[Postgres Internals]]')).toEqual(['Postgres Internals']);
  });
});
