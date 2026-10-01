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

// Cap on the total decompressed from one archive (zip bombs), shared by every
// import path. Sized under the container's 512 MB memory limit with room for
// the runtime's own overhead; revisit together with mem_limit.
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
