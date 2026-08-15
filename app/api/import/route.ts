// POST /api/import — restore/merge a vault from a zip of markdown files.
// Directories become folders, frontmatter supplies title/tags (filename is
// the fallback title). Bearer-protected by proxy.ts.
//
// Conflict policy via ?mode= : 'skip' (default) leaves existing notes
// untouched, 'overwrite' replaces their content/tags. Titles are the
// identity — matching is case-insensitive, same as wikilink resolution.
import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import type { Readable } from 'node:stream';
import { query, queryOne } from '@/lib/db';
import { parseFrontmatter } from '@/lib/export';
import { reindexPendingAsync } from '@/lib/reindex';
import { stripNulBytes } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_ZIP_BYTES = 100 * 1024 * 1024;
// A zip bomb can expand far beyond the archive-size cap, so the decompressed
// total is limited too. Counted as entries stream out — notes already written
// when the cap trips stay imported (each note is written independently).
const MAX_UNZIPPED_BYTES = 400 * 1024 * 1024;
// A vault of legitimately thousands of tiny notes stays well under this; an
// archive engineered as a huge pile of near-empty .md files (each cheap in
// bytes, but each one a folder lookup plus a DB round trip) does not.
const MAX_ENTRIES = 10_000;

// Reads the request body, giving up once it exceeds `limit` bytes. Content-
// Length is attacker-controlled (or absent under chunked encoding), so the
// budget has to be counted on bytes as they actually arrive — buffering the
// whole body first (the previous req.arrayBuffer() call did exactly that)
// would let an oversized upload exhaust memory before MAX_ZIP_BYTES ever runs.
async function readRequestBodyCapped(req: NextRequest, limit: number): Promise<Buffer | null> {
  const reader = req.body?.getReader();
  if (!reader) return Buffer.from(await req.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Reads one entry, giving up once it exceeds `limit` bytes. Sizes declared in
// the zip directory are attacker-controlled, so the budget has to be counted
// on bytes as they actually inflate — buffering the whole entry first would
// let a single highly-compressed file exhaust memory before any check runs.
function readEntryCapped(
  entry: JSZip.JSZipObject,
  limit: number
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream('nodebuffer') as Readable;
    const chunks: Buffer[] = [];
    let size = 0;

    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // pause() first: it is backpressure, not destroy(), that stops jszip
        // pumping the inflater — without it the bomb keeps expanding unread.
        stream.pause();
        stream.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

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

    const findFolder = () => queryOne<{ id: string }>(
      `select id from folders where lower(name) = lower($1)
       and parent_id is not distinct from $2`,
      [name, parentId]
    );

    // Since migration 010 the look-then-insert race ends in a unique violation
    // rather than a split subtree, which would fail the note instead of
    // filing it. Yield to whoever inserted first and reuse their folder.
    const existing = await findFolder();
    const inserted = existing ? null : await queryOne<{ id: string }>(
      `insert into folders (name, parent_id) values ($1, $2)
       on conflict do nothing returning id`,
      [name, parentId]
    );
    const id: string = existing?.id ?? inserted?.id ?? (await findFolder())!.id;
    cache.set(key, id);
    parentId = id;
  }
  return parentId;
}

export async function POST(req: NextRequest) {
  const mode = new URL(req.url).searchParams.get('mode') === 'overwrite' ? 'overwrite' : 'skip';

  const body = await readRequestBodyCapped(req, MAX_ZIP_BYTES);
  if (body === null) return NextResponse.json({ error: 'Archive too large' }, { status: 413 });
  if (body.length === 0) return NextResponse.json({ error: 'Empty request body' }, { status: 400 });

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(body);
  } catch {
    return NextResponse.json({ error: 'Not a valid zip archive' }, { status: 400 });
  }

  const entries = Object.values(zip.files).filter(f => !f.dir && f.name.toLowerCase().endsWith('.md'));
  if (entries.length > MAX_ENTRIES) {
    return NextResponse.json({ error: `Archive has too many files (max ${MAX_ENTRIES})` }, { status: 413 });
  }
  const folderCache = new Map<string, string>();
  let imported = 0, updated = 0, skipped = 0, unzippedBytes = 0;
  const errors: string[] = [];
  // Notes whose content exceeds the generated search_vector column's input
  // bound (migration 014, 200k chars) — full-text (keyword) search only
  // covers the truncated prefix for these; semantic/chunk search is
  // unaffected. Collected rather than checked per-entry error handling so a
  // long note that imports successfully still surfaces the caveat.
  const warnings: string[] = [];

  for (const entry of entries) {
    try {
      const md = await readEntryCapped(entry, MAX_UNZIPPED_BYTES - unzippedBytes);
      if (md === null) {
        // Notes written before the cap tripped are still pending embeddings —
        // kick off the background pass the normal exit path would have run.
        if (imported + updated > 0) reindexPendingAsync();
        return NextResponse.json(
          { error: 'Decompressed size limit exceeded', imported, updated, skipped, errors, warnings },
          { status: 413 }
        );
      }
      unzippedBytes += Buffer.byteLength(md, 'utf8');
      const { title: fmTitle, tags, body: rawContent, created } = parseFrontmatter(md);
      const content = stripNulBytes(rawContent);

      // "a/b/Note.md" → folders ["a","b"], fallback title "Note".
      // Zip paths are attacker-shaped: '..' segments must not become folders.
      const segments = entry.name.split('/').filter(s => s && s !== '.' && s !== '..');
      const filename = segments.pop() ?? '';
      const title = (fmTitle ?? filename.replace(/\.md$/i, '')).trim().slice(0, 500);
      if (!title) { skipped++; continue; }
      if (content.length > 200_000) {
        warnings.push(`${title}: full-text (keyword) search only covers the first 200,000 characters; semantic search covers the full content.`);
      }

      // btrim both sides: titles created before write-time trimming existed
      // may carry invisible padding and must still match their export.
      // deleted_at is null: a title held only by a trashed note is free —
      // import creates a fresh live note rather than resurrecting the old one.
      const existing = await queryOne<{ id: string }>(
        'select id from notes where lower(btrim(title)) = lower(btrim($1)) and deleted_at is null', [title]
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
      // created comes from frontmatter written by our own export (see
      // parseFrontmatter) — round-trips the real creation date instead of
      // stamping every re-imported note with "now". coalesce to the column's
      // own now() default when absent (foreign files, or nothing parsed).
      await query(
        `insert into notes (title, content, folder_id, tags, embedding_pending, created_at)
         values ($1, $2, $3, $4, true, coalesce($5::timestamptz, now()))`,
        [title, content, folderId, tags, created ?? null]
      );
      imported++;
    } catch (err) {
      errors.push(`${entry.name}: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  // Embeddings happen in the background — text search works immediately.
  if (imported + updated > 0) reindexPendingAsync();

  return NextResponse.json({ imported, updated, skipped, errors, warnings, total: entries.length });
}
