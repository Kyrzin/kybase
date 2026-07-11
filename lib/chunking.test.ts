import { describe, it, expect } from 'vitest';
import { chunkNote } from './chunking';

describe('chunkNote', () => {
  it('returns no chunks for empty content', () => {
    expect(chunkNote('')).toEqual([]);
    expect(chunkNote('   \n\n  ')).toEqual([]);
  });

  it('returns a single chunk for short content without headings', () => {
    const chunks = chunkNote('просто короткая заметка без заголовков');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBeNull();
    expect(chunks[0].content).toContain('просто короткая заметка');
  });

  it('splits at markdown headings and captures heading text', () => {
    const content = [
      '# Заметка',
      'вступление ' + 'а'.repeat(100),
      '## Архитектура',
      'про архитектуру ' + 'б'.repeat(100),
      '## Деплой',
      'про деплой ' + 'в'.repeat(100),
    ].join('\n');
    const chunks = chunkNote(content, 150);
    expect(chunks.length).toBe(3);
    expect(chunks[0].heading).toBe('Заметка');
    expect(chunks[1].heading).toBe('Архитектура');
    expect(chunks[2].heading).toBe('Деплой');
    expect(chunks[1].content).toContain('## Архитектура');
  });

  it('merges small adjacent sections up to maxLen', () => {
    const content = [
      '## Один',
      'мало текста',
      '## Два',
      'тоже мало',
      '## Три',
      'и тут мало',
    ].join('\n');
    const chunks = chunkNote(content, 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('## Один');
    expect(chunks[0].content).toContain('## Три');
  });

  it('splits an oversized section by paragraphs, all within maxLen', () => {
    const para = 'абзац среднего размера. '.repeat(4).trim(); // ~95 chars
    const content = '## Большая секция\n\n' + Array(10).fill(para).join('\n\n');
    const chunks = chunkNote(content, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(300);
      expect(c.heading).toBe('Большая секция');
    }
  });

  it('hard-splits a single paragraph longer than maxLen', () => {
    const content = 'х'.repeat(700);
    const chunks = chunkNote(content, 300);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(300);
  });

  it('ignores # lines inside code fences', () => {
    const content = [
      '## Реальный заголовок',
      'текст',
      '```bash',
      '# это комментарий, не заголовок',
      'echo hi',
      '```',
      'ещё текст',
    ].join('\n');
    const chunks = chunkNote(content, 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('Реальный заголовок');
  });

  it('assigns sequential indexes starting at 0', () => {
    const content = '## A\n' + 'a'.repeat(250) + '\n## B\n' + 'b'.repeat(250);
    const chunks = chunkNote(content, 300);
    expect(chunks.map(c => c.index)).toEqual(chunks.map((_, i) => i));
  });
});
