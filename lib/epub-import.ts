// lib/epub-import.ts — EPUB → Markdown. Unlike PDF, an EPUB's content
// documents are already XHTML with real <h1>-<h6> tags — no font-size
// guessing needed (see lib/pdf-import.ts for why that's a whole module by
// itself), just parse the package structure to find the content documents
// in reading order, then hand each one to lib/html-to-markdown.ts.
//
// EPUB is a zip (jszip is already a dependency — lib/export.ts's vault
// export/import uses it) containing:
//   META-INF/container.xml → points at the "rootfile" (the .opf package doc)
//   the .opf file           → <manifest> (id → href/media-type for every
//                             resource) + <spine> (reading order, by id)
// A hand-rolled regex parser rather than a full XML library: EPUB's package
// document has a small, predictable attribute shape, and pulling in a real
// XML parser for four attributes isn't worth the dependency.
import JSZip from 'jszip';
import { htmlToMarkdown } from './html-to-markdown';

type ManifestEntry = { href: string; mediaType: string };

export function parseContainerRootfile(xml: string): string | null {
  return xml.match(/<rootfile\b[^>]*\bfull-path="([^"]+)"/)?.[1] ?? null;
}

export function parseOpfManifest(xml: string): Map<string, ManifestEntry> {
  const manifest = new Map<string, ManifestEntry>();
  for (const tag of xml.match(/<item\b[^>]*\/?>/g) ?? []) {
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    const href = tag.match(/\bhref="([^"]+)"/)?.[1];
    const mediaType = tag.match(/\bmedia-type="([^"]+)"/)?.[1] ?? '';
    if (id && href) manifest.set(id, { href: decodeURIComponent(href), mediaType });
  }
  return manifest;
}

export function parseOpfSpine(xml: string): string[] {
  const spineBody = xml.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/)?.[1] ?? '';
  return [...spineBody.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)].map((m) => m[1]);
}

export function parseOpfTitle(xml: string): string | null {
  const raw = xml.match(/<dc:title\b[^>]*>([^<]+)<\/dc:title>/)?.[1];
  return raw ? raw.trim() : null;
}

/** href is relative to the OPF file's own directory, and may contain ../ segments — resolve against that, not the zip root. */
export function resolveEpubPath(opfPath: string, href: string): string {
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const segments: string[] = [];
  for (const part of (baseDir + href).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

export type EpubResult = { title: string | null; content: string };

export async function importEpub(buffer: Buffer): Promise<EpubResult> {
  const zip = await JSZip.loadAsync(buffer);

  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  if (!containerXml) throw new Error('Not a valid EPUB: missing META-INF/container.xml');
  const opfPath = parseContainerRootfile(containerXml);
  if (!opfPath) throw new Error('Not a valid EPUB: container.xml has no rootfile');

  const opfXml = await zip.file(opfPath)?.async('string');
  if (!opfXml) throw new Error(`Not a valid EPUB: missing package document at ${opfPath}`);

  const manifest = parseOpfManifest(opfXml);
  const spine = parseOpfSpine(opfXml);
  if (spine.length === 0) throw new Error('Not a valid EPUB: spine is empty');

  const chapters: string[] = [];
  for (const idref of spine) {
    const entry = manifest.get(idref);
    if (!entry || !/x?html/i.test(entry.mediaType)) continue;
    const fullPath = resolveEpubPath(opfPath, entry.href);
    const html = await zip.file(fullPath)?.async('string');
    if (!html) continue;
    const md = htmlToMarkdown(html).trim();
    if (md) chapters.push(md);
  }

  return { title: parseOpfTitle(opfXml), content: chapters.join('\n\n') };
}
