// POST /api/import — restore/merge a vault from a zip of markdown files.
// Directories become folders, frontmatter supplies title/tags (filename is
// the fallback title). Bearer-protected by middleware.
//
// Conflict policy via ?mode= : 'skip' (default) leaves existing notes
// untouched, 'overwrite' replaces their content/tags. Titles are the
// identity — matching is case-insensitive, same as wikilink resolution.
import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { query, queryOne } from '@/lib/db';
import { parseFrontmatter } from '@/lib/export';
import { reindexPendingAsync } from '@/lib/reindex';

export const dynamic = 'force-dynamic';

const MAX_ZIP_BYTES = 100 * 1024 * 1024;

async function ensureFolderPath(
  segments: string[],
  cache: Map<string, string>
): Promise<string | null> {
  let parentId: string | null = null;
  let key = '';
  for (const rawName of segments) {
    const name = rawName.trim();
    if (!name) continue;
    key = key ? `${key}/${name.toLowerCase()}` : name.toLowerCase();
    const cached = cache.get(key);
    if (cached) { parentId = cached; continue; }

    const existing: { id: string } | null = await queryOne<{ id: string }>(
      `select id from folders where lower(name) = lower($1)
       and parent_id is not distinct from $2`,
      [name, parentId]
    );
    const id: string = existing?.id
      ?? (await queryOne<{ id: string }>(
        'insert into folders (name, parent_id) values ($1, $2) returning id',
        [name, parentId]
      ))!.id;
    cache.set(key, id);
    parentId = id;
  }
  return parentId;
}

export async function POST(req: NextRequest) {
  const mode = new URL(req.url).searchParams.get('mode') === 'overwrite' ? 'overwrite' : 'skip';

  const body = Buffer.from(await req.arrayBuffer());
  if (body.length === 0) return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
  if (body.length > MAX_ZIP_BYTES) return NextResponse.json({ error: 'Archive too large' }, { status: 413 });

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(body);
  } catch {
    return NextResponse.json({ error: 'Not a valid zip archive' }, { status: 400 });
  }

  const entries = Object.values(zip.files).filter(f => !f.dir && f.name.toLowerCase().endsWith('.md'));
  const folderCache = new Map<string, string>();
  let imported = 0, updated = 0, skipped = 0;
  const errors: string[] = [];

  for (const entry of entries) {
    try {
      const md = await entry.async('string');
      const { title: fmTitle, tags, body: content } = parseFrontmatter(md);

      // "a/b/Note.md" → folders ["a","b"], fallback title "Note".
      // Zip paths are attacker-shaped: '..' segments must not become folders.
      const segments = entry.name.split('/').filter(s => s && s !== '.' && s !== '..');
      const filename = segments.pop() ?? '';
      const title = (fmTitle ?? filename.replace(/\.md$/i, '')).trim().slice(0, 500);
      if (!title) { skipped++; continue; }

      // btrim both sides: titles created before write-time trimming existed
      // may carry invisible padding and must still match their export.
      const existing = await queryOne<{ id: string }>(
        'select id from notes where lower(btrim(title)) = lower(btrim($1))', [title]
      );
      if (existing) {
        if (mode === 'skip') { skipped++; continue; }
        await query(
          'update notes set content = $1, tags = $2, embedding_pending = true where id = $3',
          [content, tags, existing.id]
        );
        updated++;
        continue;
      }

      const folderId = await ensureFolderPath(segments, folderCache);
      await query(
        `insert into notes (title, content, folder_id, tags, embedding_pending)
         values ($1, $2, $3, $4, true)`,
        [title, content, folderId, tags]
      );
      imported++;
    } catch (err) {
      errors.push(`${entry.name}: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  // Embeddings happen in the background — text search works immediately.
  if (imported + updated > 0) reindexPendingAsync();

  return NextResponse.json({ imported, updated, skipped, errors, total: entries.length });
}
