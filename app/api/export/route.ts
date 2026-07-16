// GET /api/export — the whole vault as a zip of markdown files with
// frontmatter, folders as directories. Bearer-protected by middleware.
import { NextResponse } from 'next/server';
import JSZip from 'jszip';
import { query } from '@/lib/db';
import { buildExportTree, type ExportNote, type ExportFolder } from '@/lib/export';

export const dynamic = 'force-dynamic';

export async function GET() {
  let notes: ExportNote[], folders: ExportFolder[];
  try {
    [notes, folders] = await Promise.all([
      query<ExportNote>('select title, content, folder_id, tags, created_at, updated_at from notes order by title'),
      query<ExportFolder>('select id, name, parent_id from folders'),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const zip = new JSZip();
  for (const file of buildExportTree(notes, folders)) {
    zip.file(file.path, file.content);
  }
  const archive = await zip.generateAsync({ type: 'uint8array' });

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(Buffer.from(archive), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="kybase-export-${stamp}.zip"`,
    },
  });
}
