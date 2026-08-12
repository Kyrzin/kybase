// POST /api/notes/import-pdf — HTTP-level concerns only (size cap, title
// derivation, insert/conflict handling, indexing trigger). The actual
// PDF→Markdown conversion is lib/pdf-import.ts, already covered by
// lib/pdf-import.test.ts — mocked here so this file doesn't need a real
// PDF buffer. Body is raw bytes (Content-Type: application/pdf), matching
// /api/import's file-upload convention — not multipart/form-data.
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

import { POST } from './route';

function req(bytes: Uint8Array, opts: { filename?: string; folderId?: string } = {}): NextRequest {
  const url = new URL('http://localhost/api/notes/import-pdf');
  if (opts.folderId) url.searchParams.set('folder_id', opts.folderId);
  const headers: Record<string, string> = { 'content-type': 'application/pdf' };
  if (opts.filename) headers['x-filename'] = opts.filename;
  return new NextRequest(url, { method: 'POST', body: new Blob([bytes as BlobPart]), headers });
}

const smallPdf = () => new Uint8Array(100);

beforeEach(() => {
  queryOne.mockReset();
  isUniqueViolation.mockReset().mockReturnValue(false);
  isInvalidTextRepresentation.mockReset().mockReturnValue(false);
  indexNoteAsync.mockReset();
  importPdf.mockReset().mockResolvedValue('## Heading\n\nBody text.');
});

describe('POST /api/notes/import-pdf', () => {
  it('rejects an empty body', async () => {
    const res = await POST(req(new Uint8Array(0)));
    expect(res.status).toBe(400);
    expect(importPdf).not.toHaveBeenCalled();
  });

  it('rejects a body over the size cap via Content-Length before reading it', async () => {
    const request = req(smallPdf());
    request.headers.set('content-length', String(90 * 1024 * 1024));
    const res = await POST(request);
    expect(res.status).toBe(413);
    expect(importPdf).not.toHaveBeenCalled();
  });

  it('derives the title from x-filename, converting separators to spaces', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'AI Engineering Insider', content: 'x' });
    await POST(req(smallPdf(), { filename: 'AI_Engineering-Insider.pdf' }));
    const [, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('AI Engineering Insider');
  });

  it('decodes a URI-encoded non-ASCII filename (headers are Latin-1 only)', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'Основы Python', content: 'x' });
    await POST(req(smallPdf(), { filename: encodeURIComponent('Основы_Python.pdf') }));
    const [, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('Основы Python');
  });

  it('falls back to "Untitled" when no filename header is sent', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'Untitled', content: 'x' });
    await POST(req(smallPdf()));
    const [, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('Untitled');
  });

  it('passes folder_id from the query string through to the insert', async () => {
    queryOne.mockResolvedValue({ id: '1', title: 'x', content: 'x' });
    await POST(req(smallPdf(), { folderId: '11111111-1111-4111-8111-111111111111' }));
    const [, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('creates the note from the converted content and triggers indexing', async () => {
    importPdf.mockResolvedValue('## Chapter 1\n\nHello there.');
    queryOne.mockResolvedValue({ id: 'new-id', title: 'my-book', content: '## Chapter 1\n\nHello there.' });
    const res = await POST(req(smallPdf(), { filename: 'my-book.pdf' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('new-id');
    expect(indexNoteAsync).toHaveBeenCalledWith('new-id', 'my-book', '## Chapter 1\n\nHello there.');
  });

  it('returns 409 when a note with that title already exists', async () => {
    isUniqueViolation.mockReturnValue(true);
    queryOne.mockRejectedValue(new Error('duplicate key'));
    const res = await POST(req(smallPdf()));
    expect(res.status).toBe(409);
  });

  it('returns 400 with the underlying reason when conversion fails', async () => {
    importPdf.mockRejectedValue(new Error('Invalid PDF structure'));
    const res = await POST(req(smallPdf()));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid PDF structure');
  });
});
