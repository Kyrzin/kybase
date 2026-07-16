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
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
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
