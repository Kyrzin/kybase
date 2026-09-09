// lib/html-import.ts — a saved web page or an exported HTML document.
//
// The conversion itself is the shared one (lib/html-to-markdown.ts), already
// exercised by every EPUB and DOCX import: this format carries real headings,
// so nothing is guessed. What a standalone file needs on top of that is the
// two things an EPUB gets from its container instead — a character encoding
// and a title.
import { htmlToMarkdown } from './html-to-markdown';

export type HtmlResult = {
  /** From <title>, else the first <h1>. Null when the document names itself nowhere. */
  title: string | null;
  content: string;
};

/** Only the start of the file is scanned for a charset — a declaration must precede content to be usable at all. */
const CHARSET_SCAN_BYTES = 2048;

/**
 * Decode using the document's own declared charset.
 *
 * UTF-8 is the right default and the wrong assumption to make silently: pages
 * saved from Russian sites are still routinely windows-1251, and decoding
 * those as UTF-8 yields a note of replacement characters that looks like a
 * broken import rather than a wrong encoding. The declaration is read from
 * the head as Latin-1, which is safe for the ASCII a meta tag is made of
 * whatever the real encoding turns out to be.
 */
function decode(bytes: Buffer): string {
  const head = bytes.subarray(0, CHARSET_SCAN_BYTES).toString('latin1');
  const declared =
    head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i)?.[1] ??
    head.match(/<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i)?.[1];
  if (declared && !/^utf-?8$/i.test(declared)) {
    try {
      // An unknown label throws rather than mis-decoding; UTF-8 is then no
      // worse than the guess we could not honour.
      return new TextDecoder(declared).decode(bytes);
    } catch {
      /* fall through */
    }
  }
  return bytes.toString('utf8');
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

/** Enough entity handling for a title line; the body's are turndown's problem. */
function unescape(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * The document's own name. <title> first, because that is where a page states
 * it; the first <h1> as the fallback, because an exported fragment often has
 * no head at all. A site that appends its own name to every title ("Article —
 * Example.com") is left as written: trimming that is a guess about one site's
 * convention, and the note is renamed like any other.
 */
function titleOf(html: string): string | null {
  const raw =
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (!raw) return null;
  const text = unescape(raw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text || null;
}

export function importHtml(bytes: Buffer): HtmlResult {
  const html = decode(bytes);
  return { title: titleOf(html), content: htmlToMarkdown(html) };
}
