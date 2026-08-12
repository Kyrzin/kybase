// POST /api/notes/import-pdf?folder_id=... — upload a PDF, convert it to
// structured Markdown (lib/pdf-import.ts — headings by font size, not by
// copy-pasted "#" characters that collide with extractHeadings' own
// syntax), and create a note from the result via the same insert path as
// POST /api/notes. Body is the raw PDF bytes (Content-Type: application/pdf)
// — matches /api/import's raw-body convention for file uploads, not
// multipart/form-data.
import { NextRequest, NextResponse } from 'next/server';
import { queryOne, isUniqueViolation, isInvalidTextRepresentation } from '@/lib/db';
import { indexNoteAsync } from '@/lib/indexing';
import { importPdf } from '@/lib/pdf-import';
import { MAX_NOTE_CONTENT_CHARS, stripNulBytes } from '@/lib/types';

const NOTE_SELECT = 'id, title, content, folder_id, tags, embedding_pending, created_at, updated_at';

// The heaviest real PDF this was tested against (a 738-page textbook with
// diagrams) was 60MB and converted in ~10s. 80MB leaves headroom for a
// legitimately large scanned book without inviting a multi-minute request —
// proxy.ts's proxyClientMaxBodySize (150MB, next.config.ts) is the outer
// transport cap that already runs before this handler sees the request;
// this is the app-level "is this a reasonable PDF" cap.
const MAX_PDF_BYTES = 80 * 1024 * 1024;

/** Filename minus extension, with import-artifact separators turned into spaces — a starting point, not a final title; the user renames it like any other note. */
function titleFromFilename(filename: string): string {
  const withoutExt = filename.replace(/\.pdf$/i, '');
  const spaced = withoutExt.replace(/[_-]+/g, ' ').trim();
  return (spaced || 'Untitled').slice(0, 500);
}

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const folderId = searchParams.get('folder_id');
  // URI-encoded client-side (components/Sidebar.tsx): raw header values must
  // be Latin-1, and this vault's note titles are routinely Cyrillic/German.
  const rawFilename = req.headers.get('x-filename');
  const filename = rawFilename ? decodeURIComponent(rawFilename) : 'Untitled.pdf';

  const declaredLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
    return NextResponse.json({ error: `PDF too large (max ${MAX_PDF_BYTES / (1024 * 1024)}MB)` }, { status: 413 });
  }

  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length === 0) return NextResponse.json({ error: 'Missing file' }, { status: 400 });
  if (bytes.length > MAX_PDF_BYTES) {
    return NextResponse.json({ error: `PDF too large (max ${MAX_PDF_BYTES / (1024 * 1024)}MB)` }, { status: 413 });
  }

  let content: string;
  try {
    content = stripNulBytes(await importPdf(bytes)).slice(0, MAX_NOTE_CONTENT_CHARS);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not read this PDF';
    return NextResponse.json({ error: `PDF conversion failed: ${message}` }, { status: 400 });
  }

  const title = titleFromFilename(filename);
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

  return NextResponse.json(note, { status: 201 });
}
