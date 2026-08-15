// lib/docx-import.ts — DOCX → Markdown via mammoth: Word's "Heading 1/2/3"
// paragraph styles map directly to real <h1>-<h6>, no guessing needed —
// the one document-conversion problem that's already fully solved by the
// format itself, unlike PDF (lib/pdf-import.ts, font-size heuristics) or
// a broken/scanned PDF (no fix short of OCR, out of scope — see that file).
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { htmlToMarkdown } from './html-to-markdown';
import { readEntryCapped, MAX_UNZIPPED_BYTES } from './zip-safety';

const DOCX_TOO_LARGE = `This DOCX expands to more than ${Math.floor(MAX_UNZIPPED_BYTES / (1024 * 1024))}mb when decompressed — refusing to process it.`;

// mammoth.convertToHtml does its own internal unzip with no hook to
// intercept individual entry reads, so a zip bomb inside a .docx can't be
// capped mid-decompress the way EPUB/vault import do it. Instead we
// pre-flight: load the same buffer with JSZip ourselves first and sum the
// actual decompressed size of every entry through the same capped reader
// and the same budget mammoth would otherwise blow through unchecked. Only
// if the whole archive stays under budget do we hand it to mammoth.
//
// This means a legitimate DOCX gets decompressed twice — once here, once
// inside mammoth. That's a deliberate, bounded cost (at most
// MAX_UNZIPPED_BYTES worth of work) for safety, not a bug to "optimize"
// away by dropping the pre-flight pass.
async function assertUnzippedSizeWithinBudget(buffer: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(buffer);
  let remaining = MAX_UNZIPPED_BYTES;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const text = await readEntryCapped(entry, remaining);
    if (text === null) throw new Error(DOCX_TOO_LARGE);
    remaining -= Buffer.byteLength(text, 'utf8');
  }
}

export async function importDocx(buffer: Buffer): Promise<string> {
  await assertUnzippedSizeWithinBudget(buffer);
  const { value: html } = await mammoth.convertToHtml({ buffer });
  return htmlToMarkdown(html);
}
