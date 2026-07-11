// lib/chunking.ts — split note markdown into embedding-sized chunks

export type NoteChunk = {
  index: number;
  heading: string | null; // nearest markdown heading, for embedding context
  content: string;
};

// ~2000 chars ≈ 700–1000 tokens for ru/en text — comfortably inside
// the 2048-token input limit of text-embedding-004 / nomic-embed-text,
// leaving room for the "title › heading" context prefix.
const DEFAULT_MAX_LEN = 2000;

type Section = { heading: string | null; text: string };

export function chunkNote(content: string, maxLen = DEFAULT_MAX_LEN): NoteChunk[] {
  if (!content.trim()) return [];

  // 1. Split into sections at markdown headings; ignore '#' inside ``` fences
  const sections: Section[] = [];
  let current: Section = { heading: null, text: '' };
  let inFence = false;

  for (const line of content.split('\n')) {
    if (line.trim().startsWith('```')) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) {
      if (current.text.trim()) sections.push(current);
      current = { heading: m[2].trim(), text: line + '\n' };
    } else {
      current.text += line + '\n';
    }
  }
  if (current.text.trim()) sections.push(current);

  // 2. Break oversized sections at paragraph boundaries (hard-split giant paragraphs)
  const atoms: Section[] = [];
  for (const s of sections) {
    const text = s.text.trim();
    if (text.length <= maxLen) {
      atoms.push({ heading: s.heading, text });
      continue;
    }
    let buf = '';
    const flush = () => {
      if (buf.trim()) atoms.push({ heading: s.heading, text: buf.trim() });
      buf = '';
    };
    for (const para of text.split(/\n{2,}/)) {
      if (para.length > maxLen) {
        flush();
        for (let i = 0; i < para.length; i += maxLen) {
          atoms.push({ heading: s.heading, text: para.slice(i, i + maxLen) });
        }
      } else if (buf.length + para.length + 2 > maxLen) {
        flush();
        buf = para;
      } else {
        buf = buf ? buf + '\n\n' + para : para;
      }
    }
    flush();
  }

  // 3. Merge small adjacent atoms so tiny sections don't become noise chunks
  const chunks: NoteChunk[] = [];
  let acc: Section | null = null;
  for (const a of atoms) {
    if (acc && acc.text.length + a.text.length + 2 <= maxLen) {
      acc.text += '\n\n' + a.text;
    } else {
      if (acc) chunks.push({ index: chunks.length, heading: acc.heading, content: acc.text });
      acc = { heading: a.heading, text: a.text };
    }
  }
  if (acc) chunks.push({ index: chunks.length, heading: acc.heading, content: acc.text });

  return chunks;
}
