// lib/pdf-polyfills.ts — must be imported before pdfjs-dist (see the first
// line of lib/pdf-import.ts), not after.
//
// pdfjs-dist needs a DOMMatrix constructor at module load in Node, even for
// text extraction. A pure-JS implementation avoids shipping a native canvas.
import CSSMatrix from '@thednp/dommatrix';

if (typeof globalThis.DOMMatrix === 'undefined') {
  (globalThis as unknown as { DOMMatrix: unknown }).DOMMatrix = CSSMatrix;
}

// PDFWorker (pdf.mjs) needs a worker to hand parsing off to — even in Node,
// where it never actually spawns a thread, just runs the worker module's
// code in-process ("fake worker"). Its default path for that is a runtime
// `import(this.workerSrc)` resolved relative to wherever pdf.mjs itself
// ends up on disk. That's fine unpacked in node_modules, but breaks under
// `output: standalone`: Turbopack inlines pdf.mjs into a server chunk, so
// the relative path resolves against `.next/server/chunks/` instead —
// verified: "Cannot find module '.next/server/chunks/pdf.worker.mjs'"
// even after outputFileTracingIncludes correctly copied the real file into
// node_modules; the code was never looking there once bundled.
// PDFWorker's own fallback (pdf.mjs, PDFWorker.#mainThreadWorkerMessageHandler)
// checks `globalThis.pdfjsWorker?.WorkerMessageHandler` FIRST and skips the
// dynamic import entirely if set — this is that hook. Statically imported
// (not dynamic), so Turbopack traces and bundles it normally, no special
// config needed.
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = { WorkerMessageHandler };
