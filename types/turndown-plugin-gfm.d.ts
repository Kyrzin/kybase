// turndown-plugin-gfm ships no types — only the export actually used
// (lib/html-to-markdown.ts) is typed here, not the package's full surface.
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export const tables: (turndownService: TurndownService) => void;
}
