// lib/pdf-polyfills.ts — must be imported before pdfjs-dist (see the first
// line of lib/pdf-import.ts), not after.
//
// pdfjs-dist references `DOMMatrix` at module-evaluation time, not only
// when rendering is actually used — importing it in a worker-less Node
// environment throws `ReferenceError: DOMMatrix is not defined` before
// extractPdfPages ever runs a single line, even though this app only ever
// calls getTextContent(), never render(). Verified live: this didn't show
// up running the module directly under tsx, only inside the bundled
// Next.js server — ES module side effects still need to happen in the
// right order either way, hence this being its own module imported first.
//
// @napi-rs/canvas (a real native canvas backend) would also satisfy
// pdfjs-dist's own check for this, but it means shipping a prebuilt binary
// per OS/arch/libc for a rendering capability this module never exercises.
// @thednp/dommatrix is a pure-JS DOMMatrix-spec implementation (CSSMatrix)
// with no native dependency — good enough since nothing here does real
// rendering math with the result, just needs the constructor to exist.
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
// verified live: "Cannot find module '.next/server/chunks/pdf.worker.mjs'"
// even after outputFileTracingIncludes correctly copied the real file into
// node_modules; the code was never looking there once bundled.
// PDFWorker's own fallback (pdf.mjs, PDFWorker.#mainThreadWorkerMessageHandler)
// checks `globalThis.pdfjsWorker?.WorkerMessageHandler` FIRST and skips the
// dynamic import entirely if set — this is that hook. Statically imported
// (not dynamic), so Turbopack traces and bundles it normally, no special
// config needed.
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = { WorkerMessageHandler };
