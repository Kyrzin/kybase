// POST /api/notes/import-document?folder_id=... — upload a PDF/EPUB/DOCX,
// convert it to structured Markdown, and create a note via the same insert
// path as POST /api/notes. Body is the raw file bytes (Content-Type set to
// the format's MIME type) — matches /api/import's raw-body convention for
// file uploads, not multipart/form-data.
//
// Dispatch is by filename extension, not Content-Type: browsers are
// inconsistent about what MIME type they attach to a given file, but the
// extension the user picked is reliable. Each format gets its own module
// (lib/pdf-import.ts, lib/epub-import.ts, lib/docx-import.ts) because each
// needs an entirely different strategy for finding headings — font size for
// PDF (it has no semantic structure to read), real <h1>-<h6>/Heading-styles
// for EPUB/DOCX (they already carry it, nothing to guess).
//
// Excluded from proxy.ts's matcher and authenticates itself instead (see
// lib/route-auth.ts) so an unauthenticated caller's body is never buffered
// before the 401.
import { NextRequest, NextResponse } from 'next/server';
import { queryOne, isUniqueViolation, isInvalidTextRepresentation } from '@/lib/db';
import { indexNoteAsync } from '@/lib/indexing';
import { importPdf } from '@/lib/pdf-import';
import { importEpub } from '@/lib/epub-import';
import { importDocx } from '@/lib/docx-import';
import { MAX_NOTE_CONTENT_CHARS, stripNulBytes } from '@/lib/types';
import { requireAuth } from '@/lib/route-auth';
import { readRequestBodyCapped } from '@/lib/request-body';

const NOTE_SELECT = 'id, title, content, folder_id, tags, embedding_pending, created_at, updated_at';

// The heaviest real file this pipeline was tested against (a 738-page PDF
// textbook with diagrams) was 60MB and converted in ~10s. 80MB leaves
// headroom for a legitimately large scanned book without inviting a
// multi-minute request. This is the app-level "is this reasonable" cap,
// enforced by streaming the body in and giving up as soon as it's exceeded
// (readRequestBodyCapped) rather than trusting the attacker-controlled
// Content-Length header.
const MAX_FILE_BYTES = 80 * 1024 * 1024;

type Format = 'pdf' | 'epub' | 'docx';

function formatFromFilename(filename: string): Format | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'pdf' || ext === 'epub' || ext === 'docx') return ext;
  return null;
}

/** Filename minus extension, with import-artifact separators turned into spaces — a starting point, not a final title; the user renames it like any other note. */
function titleFromFilename(filename: string): string {
  const withoutExt = filename.replace(/\.[^.]+$/, '');
  const spaced = withoutExt.replace(/[_-]+/g, ' ').trim();
  return (spaced || 'Untitled').slice(0, 500);
}

async function convert(format: Format, bytes: Buffer, filename: string): Promise<{ title: string; content: string }> {
  const fallbackTitle = titleFromFilename(filename);
  if (format === 'pdf') return { title: fallbackTitle, content: await importPdf(bytes) };
  if (format === 'docx') return { title: fallbackTitle, content: await importDocx(bytes) };
  const epub = await importEpub(bytes);
  // EPUB carries its own title in metadata — prefer it over the filename
  // (PDF/DOCX have no equivalent field this pipeline reads), but a missing
  // or empty <dc:title> is common enough in the wild to still need the
  // filename fallback.
  return { title: epub.title?.trim() || fallbackTitle, content: epub.content };
}

export async function POST(req: NextRequest) {
  const authFailure = await requireAuth(req);
  if (authFailure) return authFailure;

  const { searchParams } = new URL(req.url);
  const folderId = searchParams.get('folder_id');
  // URI-encoded client-side (components/Sidebar.tsx): raw header values must
  // be Latin-1, and this vault's note titles are routinely Cyrillic/German.
  const rawFilename = req.headers.get('x-filename');
  const filename = rawFilename ? decodeURIComponent(rawFilename) : '';

  const format = formatFromFilename(filename);
  if (!format) return NextResponse.json({ error: 'Unsupported file type — use .pdf, .epub, or .docx' }, { status: 400 });

  const bytes = await readRequestBodyCapped(req, MAX_FILE_BYTES);
  if (bytes === null) {
    return NextResponse.json({ error: `File too large (max ${MAX_FILE_BYTES / (1024 * 1024)}MB)` }, { status: 413 });
  }
  if (bytes.length === 0) return NextResponse.json({ error: 'Missing file' }, { status: 400 });

  let title: string;
  let content: string;
  try {
    const converted = await convert(format, bytes, filename);
    title = converted.title;
    content = stripNulBytes(converted.content).slice(0, MAX_NOTE_CONTENT_CHARS);
  } catch (err) {
    const message = err instanceof Error ? err.message : `Could not read this ${format.toUpperCase()}`;
    return NextResponse.json({ error: `${format.toUpperCase()} conversion failed: ${message}` }, { status: 400 });
  }

  let note;
  try {
    note = await queryOne<{ id: string; title: string; content: string }>(
      `insert into notes (title, content, folder_id, tags, embedding_pending)
       values ($1, $2, $3, '{}', true)
       returning ${NOTE_SELECT}`,
      [title, content, folderId ?? null]
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json({ error: 'A note with this title already exists' }, { status: 409 });
    }
    if (isInvalidTextRepresentation(err)) {
      return NextResponse.json({ error: 'Malformed folder id' }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Insert failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
  if (!note) return NextResponse.json({ error: 'Insert failed' }, { status: 500 });

  indexNoteAsync(note.id, note.title, note.content);

  if (note.content.length > 200_000) {
    return NextResponse.json(
      { ...note, warning: 'Full-text (keyword) search only covers the first 200,000 characters of this note; semantic search covers the full content.' },
      { status: 201 }
    );
  }
  return NextResponse.json(note, { status: 201 });
}
