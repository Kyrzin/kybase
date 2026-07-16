// lib/export.ts — markdown export/import core: note ↔ file mapping and
// frontmatter, kept pure for testability. Zip packing lives in the routes.
//
// Frontmatter values are emitted with JSON.stringify — valid YAML that
// survives quotes/colons in titles. The parser is tolerant on import:
// JSON first, then bare YAML-ish fallbacks, so vaults exported from other
// tools (e.g. Obsidian) still round-trip their title and tags.

export type ExportNote = {
  title: string;
  content: string;
  folder_id: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
};
export type ExportFolder = { id: string; name: string; parent_id: string | null };
export type ExportFile = { path: string; content: string };

/** Make a title/folder name safe as a single path segment. */
export function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 150);
  return cleaned || 'untitled';
}

function frontmatter(note: ExportNote): string {
  return [
    '---',
    `title: ${JSON.stringify(note.title)}`,
    `tags: ${JSON.stringify(note.tags ?? [])}`,
    `created: ${note.created_at}`,
    `updated: ${note.updated_at}`,
    '---',
    '',
    '',
  ].join('\n');
}

/** Folder id → sanitized "a/b/c" path (cycle-safe). */
export function folderPaths(folders: ExportFolder[]): Map<string, string> {
  const byId = new Map(folders.map(f => [f.id, f]));
  const paths = new Map<string, string>();
  const resolve = (id: string, seen: Set<string>): string => {
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    const folder = byId.get(id);
    if (!folder || seen.has(id)) return '';
    seen.add(id);
    const parent = folder.parent_id ? resolve(folder.parent_id, seen) : '';
    const path = parent ? `${parent}/${sanitizeName(folder.name)}` : sanitizeName(folder.name);
    paths.set(id, path);
    return path;
  };
  for (const f of folders) resolve(f.id, new Set());
  return paths;
}

/**
 * Lay out every note as `folder/path/Title.md` with frontmatter.
 * Distinct titles can sanitize to the same filename — collisions get " (2)",
 * " (3)", … suffixes so the zip never silently drops a note.
 */
export function buildExportTree(notes: ExportNote[], folders: ExportFolder[]): ExportFile[] {
  const paths = folderPaths(folders);
  const taken = new Set<string>();
  return notes.map(note => {
    const dir = note.folder_id ? paths.get(note.folder_id) ?? '' : '';
    const base = sanitizeName(note.title);
    let candidate = dir ? `${dir}/${base}.md` : `${base}.md`;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
      candidate = dir ? `${dir}/${base} (${n}).md` : `${base} (${n}).md`;
    }
    taken.add(candidate.toLowerCase());
    return { path: candidate, content: frontmatter(note) + note.content };
  });
}

export type ParsedNote = { title?: string; tags: string[]; body: string };

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch { /* not JSON — fall through to YAML-ish */ }
  const inner = raw.replace(/^\[|\]$/g, '');
  return inner.split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function parseValue(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
  } catch { /* bare string */ }
  return raw.replace(/^["']|["']$/g, '');
}

/** Split optional `--- … ---` frontmatter from a markdown file. */
export function parseFrontmatter(md: string): ParsedNote {
  // Eats at most one blank line after the closing '---' (what we emit),
  // so exported content round-trips byte-for-byte.
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?(\r?\n)?/);
  if (!match) return { tags: [], body: md };

  const body = md.slice(match[0].length);
  let title: string | undefined;
  let tags: string[] = [];
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    if (kv[1] === 'title' && kv[2]) title = parseValue(kv[2]);
    if (kv[1] === 'tags' && kv[2]) tags = parseTags(kv[2]);
  }
  return { title, tags, body };
}
