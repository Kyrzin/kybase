import { describe, it, expect } from 'vitest';
import { demoteHeadings, htmlToMarkdown } from './html-to-markdown';

describe('demoteHeadings', () => {
  it('demotes h1 to h2 so it never competes with the note title', () => {
    expect(demoteHeadings('# Chapter One\n\nBody.')).toBe('## Chapter One\n\nBody.');
  });

  it('demotes every level by one, capping at h6', () => {
    expect(demoteHeadings('##### Deep')).toBe('###### Deep');
    expect(demoteHeadings('###### Already max')).toBe('###### Already max');
  });

  it('leaves a line that only looks like a heading mid-sentence alone', () => {
    // No leading '#' at the start of the line — not a heading, must not change.
    expect(demoteHeadings('The value is #1 on the list')).toBe('The value is #1 on the list');
  });
});

describe('htmlToMarkdown', () => {
  it('converts real HTML headings to demoted markdown headings', () => {
    const html = '<h1>Chapter One</h1><p>Some body text.</p><h2>A Section</h2>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('## Chapter One');
    expect(md).toContain('### A Section');
    expect(md).toContain('Some body text.');
  });
});
