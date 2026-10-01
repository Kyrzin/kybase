// pdfjs-dist ships this submodule without a .d.ts — only its export actually
// used (lib/pdf-polyfills.ts) is typed here, not the module's real internals.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
