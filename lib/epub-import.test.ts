import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  parseContainerRootfile, parseOpfManifest, parseOpfSpine, parseOpfTitle, resolveEpubPath, importEpub,
} from './epub-import';

describe('parseContainerRootfile', () => {
  it('extracts the package document path from container.xml', () => {
    const xml = `<?xml version="1.0"?>
      <container><rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles></container>`;
    expect(parseContainerRootfile(xml)).toBe('OEBPS/content.opf');
  });

  it('returns null when there is no rootfile', () => {
    expect(parseContainerRootfile('<container><rootfiles></rootfiles></container>')).toBeNull();
  });
});

const SAMPLE_OPF = `<?xml version="1.0"?>
<package xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:title>Sample Book</dc:title></metadata>
  <manifest>
    <item id="ch1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="images/cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

describe('parseOpfManifest', () => {
  it('maps every item id to its href and media-type', () => {
    const manifest = parseOpfManifest(SAMPLE_OPF);
    expect(manifest.get('ch1')).toEqual({ href: 'text/chapter1.xhtml', mediaType: 'application/xhtml+xml' });
    expect(manifest.get('cover')).toEqual({ href: 'images/cover.jpg', mediaType: 'image/jpeg' });
  });
});

describe('parseOpfSpine', () => {
  it('returns idrefs in reading order, ignoring non-spine items', () => {
    expect(parseOpfSpine(SAMPLE_OPF)).toEqual(['ch1', 'ch2']);
  });
});

describe('parseOpfTitle', () => {
  it('extracts dc:title', () => {
    expect(parseOpfTitle(SAMPLE_OPF)).toBe('Sample Book');
  });
});

describe('resolveEpubPath', () => {
  it('resolves a href relative to the OPF file\'s own directory', () => {
    expect(resolveEpubPath('OEBPS/content.opf', 'text/chapter1.xhtml')).toBe('OEBPS/text/chapter1.xhtml');
  });

  it('handles an OPF at the zip root (no directory to prefix)', () => {
    expect(resolveEpubPath('content.opf', 'chapter1.xhtml')).toBe('chapter1.xhtml');
  });

  it('collapses ../ segments against the OPF directory', () => {
    expect(resolveEpubPath('OEBPS/package.opf', '../shared/style.css')).toBe('shared/style.css');
  });
});

describe('importEpub', () => {
  it('extracts chapters in spine order with real headings, and the book title', async () => {
    const zip = new JSZip();
    zip.file('META-INF/container.xml', `<?xml version="1.0"?>
      <container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`);
    zip.file('OEBPS/content.opf', SAMPLE_OPF);
    zip.file('OEBPS/text/chapter1.xhtml', '<html><body><h1>Chapter One</h1><p>First chapter text.</p></body></html>');
    zip.file('OEBPS/text/chapter2.xhtml', '<html><body><h1>Chapter Two</h1><p>Second chapter text.</p></body></html>');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const result = await importEpub(buffer);
    expect(result.title).toBe('Sample Book');
    expect(result.content).toContain('## Chapter One');
    expect(result.content).toContain('## Chapter Two');
    expect(result.content).toContain('First chapter text.');
    // Reading order preserved.
    expect(result.content.indexOf('Chapter One')).toBeLessThan(result.content.indexOf('Chapter Two'));
  });

  it('throws a clear error for a zip that is not an EPUB', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'not an epub');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(importEpub(buffer)).rejects.toThrow(/not a valid epub/i);
  });
});
