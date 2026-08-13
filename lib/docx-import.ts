// lib/docx-import.ts — DOCX → Markdown via mammoth: Word's "Heading 1/2/3"
// paragraph styles map directly to real <h1>-<h6>, no guessing needed —
// the one document-conversion problem that's already fully solved by the
// format itself, unlike PDF (lib/pdf-import.ts, font-size heuristics) or
// a broken/scanned PDF (no fix short of OCR, out of scope — see that file).
import mammoth from 'mammoth';
import { htmlToMarkdown } from './html-to-markdown';

export async function importDocx(buffer: Buffer): Promise<string> {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  return htmlToMarkdown(html);
}
