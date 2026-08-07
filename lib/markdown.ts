// lib/markdown.ts — the hardened markdown renderer, shared by the app UI
// (components/KybaseApp.tsx) and the public share page (app/share/[token]).
// Content is escaped for &/</> before any HTML is generated, but quotes are
// left alone so they read naturally in text — attribute values built from
// user text must go through escapeAttr(), and URLs through safeUrl(), or a
// note containing e.g. [x](" onerror="...") breaks out of the attribute.
// XSS coverage lives in lib/markdown.test.ts — extend it when touching this.

export function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}

/**
 * Slug for a heading, shared by parseMarkdown (which sees &-escaped text) and
 * extractHeadings (which sees raw text): entities are unescaped first so both
 * inputs yield the same slug. Unicode letters/digits survive (Cyrillic titles
 * are the norm in real vaults); everything else collapses to "-". Duplicate
 * slugs are the CALLER's job (slugDeduper) so both call sites number
 * repeats in document order and stay in sync.
 */
export function slugifyHeading(text: string): string {
  // &amp; unescaped last: doing it first would let a literal "&amp;lt;" in
  // the source cascade into "&lt;" then "<" — a double-decode. Order doesn't
  // change the output here (everything non-alphanumeric collapses to "-"
  // below regardless), but it closes the static-analysis pattern for free.
  const slug = text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

export function slugDeduper(): (slug: string) => string {
  const seen = new Map<string, number>();
  return (slug: string) => {
    const n = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, n);
    return n === 1 ? slug : `${slug}-${n}`;
  };
}

export type Heading = {
  level: 1 | 2 | 3;
  text: string;
  slug: string;
  /** Character offset of the heading line — lets a reader seek to a section. */
  offset: number;
};

/**
 * Index of a ``` that never gets closed, or -1 when every fence is paired.
 * parseMarkdown substitutes fences in pairs, so a dangling marker renders as
 * ordinary text; treating it as an opening fence would hide every heading
 * below it from the chunker and the outline while the reader still sees them.
 * Shared so those passes cannot drift apart.
 */
export function unpairedFenceIndex(lines: string[]): number {
  const fences = lines.flatMap((l, i) => (/^```/.test(l.trim()) ? [i] : []));
  return fences.length % 2 === 1 ? fences[fences.length - 1] : -1;
}

/**
 * Headings (H1–H3) of a note in document order, with the same slugs
 * parseMarkdown puts on the rendered <h1>–<h3> ids. Skips headings inside
 * fenced code blocks — mirroring both the renderer (fences are extracted to
 * placeholders before heading markup runs) and the chunker's fence handling.
 */
export function extractHeadings(content: string): Heading[] {
  const out: Heading[] = [];
  const dedupe = slugDeduper();
  let inFence = false;
  const lines = content.split('\n');
  const unpaired = unpairedFenceIndex(lines);
  let offset = 0;
  for (const [i, line] of lines.entries()) {
    const lineStart = offset;
    offset += line.length + 1; // + the '\n' that split() consumed
    if (i !== unpaired && /^```/.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{1,3}) (.+)$/);
    if (!m) continue;
    out.push({
      level: m[1].length as 1 | 2 | 3,
      text: m[2].trim(),
      slug: dedupe(slugifyHeading(m[2])),
      offset: lineStart,
    });
  }
  return out;
}

export function safeUrl(url: string): string {
  return /^(https?:|mailto:|\/|#)/i.test(url.trim()) ? url : '#';
}

export function parseMarkdown(text: string): string {
  if (!text) return '';
  // Fenced code blocks come out first, into placeholders, so nothing inside
  // them is treated as markup — no **bold**, and no \n→<br> / \n\n→</p><p>
  // mangling the code. NUL delimits the placeholder because it cannot occur
  // in note text (Postgres rejects NUL in strings), so content can't forge it.
  const codeBlocks: string[] = [];
  // One heading pass (not one per level) so duplicate headings get their
  // -2/-3 suffixes in DOCUMENT order — the same order extractHeadings uses;
  // three per-level passes would number them h3-first and desync the ids.
  const dedupe = slugDeduper();
  const html = text
    .replace(/\u0000/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_: string, __: string, code: string) => {
      codeBlocks.push(
        `<pre style="background:#1e1e2e;padding:12px;border-radius:6px;overflow-x:auto;margin:8px 0"><code>${code.trim()}</code></pre>`);
      return `\u0000${codeBlocks.length - 1}\u0000`;
    })
    .replace(/^(#{1,3}) (.+)$/gm, (_: string, hashes: string, heading: string) => {
      const level = hashes.length;
      return `<h${level} id="${escapeAttr(dedupe(slugifyHeading(heading)))}">${heading}</h${level}>`;
    })
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/`([^`]+)`/g, '<code style="background:#1e1e2e;padding:2px 6px;border-radius:3px;font-size:0.9em">$1</code>')
    .replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:3px solid #6c7086;padding-left:12px;color:#a6adc8;margin:8px 0">$1</blockquote>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #313244;margin:16px 0">')
    .replace(/^- \[x\] (.+)$/gm, '<li style="margin-left:16px">☑ $1</li>')
    .replace(/^- \[ \] (.+)$/gm, '<li style="margin-left:16px">☐ $1</li>')
    .replace(/^- (.+)$/gm, '<li style="margin-left:16px">$1</li>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_: string, alt: string, url: string) =>
      `<img src="${escapeAttr(safeUrl(url))}" alt="${escapeAttr(alt)}" style="max-width:100%;border-radius:6px;margin:8px 0">`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_: string, label: string, url: string) =>
      `<a href="${escapeAttr(safeUrl(url))}" style="color:#89b4fa;text-decoration:underline">${label}</a>`)
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/\u0000(\d+)\u0000/g, (_: string, i: string) => codeBlocks[Number(i)]);
  return `<p>${html}</p>`;
}

export type WikilinkNote = { title: string };

export function renderWithWikilinks(html: string, notes: WikilinkNote[]): string {
  return html.replace(/\[\[([^\]]+)\]\]/g, (_: string, raw: string) => {
    const title = raw.split(/[|#]/)[0].trim();
    const exists = notes.some(n => n.title.toLowerCase() === title.toLowerCase());
    return `<span class="wikilink ${exists ? 'exists' : 'missing'}" data-title="${escapeAttr(title)}">[[${raw}]]</span>`;
  });
}

/**
 * The public share page renders wikilinks as dead text: the alias (or the
 * title) without brackets, no element, no data attributes. A shared note
 * must not let a visitor navigate to — or learn the existence of — any
 * other note.
 */
export function stripWikilinks(html: string): string {
  return html.replace(/\[\[([^\]]+)\]\]/g, (_: string, raw: string) => {
    const [target, alias] = raw.split('|');
    return (alias ?? target.split('#')[0]).trim();
  });
}
