// lib/request-body.ts — capped streaming read of a Request body.
//
// Content-Length is attacker-controlled (or simply absent under chunked
// encoding), so a size limit checked only against that header can be
// skipped entirely. The budget instead has to be counted on bytes as they
// actually arrive off the socket — buffering the whole body first (a plain
// `await req.arrayBuffer()`) would let an oversized upload exhaust memory
// before any limit ever runs.
import type { NextRequest } from 'next/server';

export async function readRequestBodyCapped(req: NextRequest, limit: number): Promise<Buffer | null> {
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
