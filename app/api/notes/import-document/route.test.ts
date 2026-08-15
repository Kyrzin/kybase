// POST /api/notes/import-document — HTTP-level concerns: format dispatch by
// filename extension, size cap, title derivation (including EPUB's own
// metadata title), insert/conflict handling, indexing trigger. Each
// format's actual conversion (lib/pdf-import.ts, lib/epub-import.ts,
// lib/docx-import.ts) has its own test file — mocked here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryOne = vi.fn();
const isUniqueViolation = vi.fn();
const isInvalidTextRepresentation = vi.fn();
vi.mock('@/lib/db', () => ({
  queryOne: (...a: unknown[]) => queryOne(...a),
  isUniqueViolation: (...a: unknown[]) => isUniqueViolation(...a),
  isInvalidTextRepresentation: (...a: unknown[]) => isInvalidTextRepresentation(...a),
}));

const indexNoteAsync = vi.fn();
vi.mock('@/lib/indexing', () => ({ indexNoteAsync: (...a: unknown[]) => indexNoteAsync(...a) }));

const importPdf = vi.fn();
vi.mock('@/lib/pdf-import', () => ({ importPdf: (...a: unknown[]) => importPdf(...a) }));
const importEpub = vi.fn();
vi.mock('@/lib/epub-import', () => ({ importEpub: (...a: unknown[]) => importEpub(...a) }));
const importDocx = vi.fn();
vi.mock('@/lib/docx-import', () => ({ importDocx: (...a: unknown[]) => importDocx(...a) }));

import { POST } from './route';

// The route now authenticates itself (lib/route-auth.ts) instead of relying
// on proxy.ts, which never runs when a test calls the route handler
// directly — every request built here needs a valid Bearer token.
const TEST_SECRET = 'route-test-secret';

function req(bytes: Uint8Array, opts: { filename?: string; folderId?: string; authorized?: boolean } = {}): NextRequest {
  const url = new URL('http://localhost/api/notes/import-document');
  if (opts.folderId) url.searchParams.set('folder_id', opts.folderId);
  const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
  if (opts.filename) headers['x-filename'] = opts.filename;
  if (opts.authorized !== false) headers['authorization'] = `Bearer ${TEST_SECRET}`;
  return new NextRequest(url, { method: 'POST', body: new Blob([bytes as BlobPart]), headers });
}

const smallFile = () => new Uint8Array(100);

beforeEach(() => {
  process.env.KYBASE_SECRET = TEST_SECRET;
  queryOne.mockReset();
  isUniqueViolation.mockReset().mockReturnValue(false);
  isInvalidTextRepresentation.mockReset().mockReturnValue(false);
  indexNoteAsync.mockReset();
  importPdf.mockReset().mockResolvedValue('## Heading\n\nBody text.');
  importEpub.mockReset().mockResolvedValue({ title: null, content: '## Heading\n\nBody text.' });
  importDocx.mockReset().mockResolvedValue('## Heading\n\nBody text.');
});

describe('POST /api/notes/import-document — format dispatch', () => {
  it('rejects a file with no recognized extension', async () => {
    const res = await POST(req(smallFile(), { filename: 'notes.txt' }));
    expect(res.status).toBe(400);
    expect(importPdf).not.toHaveBeenCalled();
    expect(importEpub).not.toHaveBeenCalled();
    expect(importDocx).not.toHaveBeenCalled();
  });

  it('rejects a request with no filename at all', async () => {
    const res = await POST(req(smallFile()));
    expect(res.status).toBe(400);
  });

  it('routes a .pdf file to importPdf', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'x', content: 'x' });
    await POST(req(smallFile(), { filename: 'book.pdf' }));
    expect(importPdf).toHaveBeenCalledTimes(1);
    expect(importEpub).not.toHaveBeenCalled();
    expect(importDocx).not.toHaveBeenCalled();
  });

  it('routes a .epub file to importEpub', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'x', content: 'x' });
    await POST(req(smallFile(), { filename: 'book.epub' }));
    expect(importEpub).toHaveBeenCalledTimes(1);
    expect(importPdf).not.toHaveBeenCalled();
  });

  it('routes a .docx file to importDocx', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'x', content: 'x' });
    await POST(req(smallFile(), { filename: 'book.docx' }));
    expect(importDocx).toHaveBeenCalledTimes(1);
    expect(importPdf).not.toHaveBeenCalled();
  });

  it('dispatches case-insensitively on extension', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'x', content: 'x' });
    await POST(req(smallFile(), { filename: 'BOOK.PDF' }));
    expect(importPdf).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/notes/import-document — title derivation', () => {
  it('derives the title from the filename for PDF/DOCX', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'x', content: 'x' });
    await POST(req(smallFile(), { filename: 'AI_Engineering-Insider.pdf' }));
    const [, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('AI Engineering Insider');
  });

  it('prefers EPUB\'s own metadata title over the filename', async () => {
    importEpub.mockResolvedValue({ title: 'The Real Book Title', content: 'x' });
    queryOne.mockResolvedValue({ id: '1', title: 'x', content: 'x' });
    await POST(req(smallFile(), { filename: 'some_export_name.epub' }));
    const [, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('The Real Book Title');
  });

  it('falls back to the filename when EPUB has no title', async () => {
    importEpub.mockResolvedValue({ title: null, content: 'x' });
    queryOne.mockResolvedValue({ id: '1', title: 'x', content: 'x' });
    await POST(req(smallFile(), { filename: 'untitled_export.epub' }));
    const [, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('untitled export');
  });
});

describe('POST /api/notes/import-document — auth', () => {
  it('rejects a request with no/wrong Bearer token before touching the file', async () => {
    const res = await POST(req(smallFile(), { filename: 'book.pdf', authorized: false }));
    expect(res.status).toBe(401);
    expect(importPdf).not.toHaveBeenCalled();
  });
});

describe('POST /api/notes/import-document — other HTTP concerns', () => {
  it('rejects a body over the size cap without ever buffering it fully', async () => {
    // Content-Length is no longer trusted — the cap is enforced by counting
    // bytes as they stream in (lib/request-body.ts), so this has to be a
    // body that's actually over MAX_FILE_BYTES (80MB), not just a header.
    const oversized = new Uint8Array(81 * 1024 * 1024);
    const res = await POST(req(oversized, { filename: 'book.pdf' }));
    expect(res.status).toBe(413);
    expect(importPdf).not.toHaveBeenCalled();
  });

  it('passes folder_id from the query string through to the insert', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'x', content: 'x' });
    await POST(req(smallFile(), { filename: 'book.pdf', folderId: '11111111-1111-4111-8111-111111111111' }));
    const [, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('creates the note from the converted content and triggers indexing', async () => {
    importDocx.mockResolvedValue('## Chapter 1\n\nHello there.');
    queryOne.mockResolvedValue({ id: 'new-id', title: 'my-book', content: '## Chapter 1\n\nHello there.' });
    const res = await POST(req(smallFile(), { filename: 'my-book.docx' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('new-id');
    expect(indexNoteAsync).toHaveBeenCalledWith('new-id', 'my-book', '## Chapter 1\n\nHello there.');
  });

  it('returns 409 when a note with that title already exists', async () => {
    isUniqueViolation.mockReturnValue(true);
    queryOne.mockRejectedValue(new Error('duplicate key'));
    const res = await POST(req(smallFile(), { filename: 'book.pdf' }));
    expect(res.status).toBe(409);
  });

  it('returns 400 with the underlying reason when conversion fails', async () => {
    importPdf.mockRejectedValue(new Error('Invalid PDF structure'));
    const res = await POST(req(smallFile(), { filename: 'book.pdf' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid PDF structure');
  });
});
