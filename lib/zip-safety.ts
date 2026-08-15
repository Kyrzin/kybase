// lib/zip-safety.ts — shared zip-bomb protection.
//
// A zip's directory declares each entry's uncompressed size, but that
// declaration is attacker-controlled — the only trustworthy number is bytes
// actually observed coming out of the inflater. readEntryCapped streams one
// entry and gives up the moment it exceeds a byte budget, so a single
// highly-compressed entry can never balloon into gigabytes of memory before
// anything notices. Every code path that walks a zip archive's entries
// (vault import, EPUB import, DOCX pre-flight) shares this one
// implementation rather than three copies of security-critical logic that
// could silently drift apart.
import type JSZip from 'jszip';
import type { Readable } from 'node:stream';

// A zip bomb can expand far beyond the archive's compressed size, so the
// decompressed total pulled from any single archive is capped independently
// of whatever compressed-upload-size check ran earlier. Shared by every
// consumer of readEntryCapped so there's one number to reason about, not one
// per import path that could silently drift apart.
//
// 400MB (the original value here) does NOT leave enough headroom under this
// app's own deployed container limit — measured live: a single EPUB whose
// one entry decompresses past that cap OOM-killed the kybase container
// (docker-compose.yml's `mem_limit: 512m` for the `kybase` service; kernel
// log: "Memory cgroup out of memory... anon-rss:514056kB"). The 400MB
// figure only accounted for the raw bytes pushed into `chunks` below — not
// Node's own baseline (~48MB measured idle), V8/GC overhead from holding
// tens of thousands of individual chunk Buffers in one array, or zlib's own
// inflate-window state, all of which are held *concurrently* with those
// bytes, not after. 200MB leaves real headroom for that overhead inside a
// 512MB container instead of assuming the cap number IS the peak. Re-verify
// live (not just by reasoning) after any future change to this constant or
// to the container's mem_limit — that's exactly the gap that let 400MB ship
// without anyone catching it.
export const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

// Reads one entry, giving up once it exceeds `limit` bytes. Sizes declared in
// the zip directory are attacker-controlled, so the budget has to be counted
// on bytes as they actually inflate — buffering the whole entry first would
// let a single highly-compressed file exhaust memory before any check runs.
export function readEntryCapped(
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
