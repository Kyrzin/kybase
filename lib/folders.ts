// lib/folders.ts — folder paths ("Projects/Kybase") and their ids, shared by MCP and REST.
import { query } from './db';

// A bare folder_id UUID tells an agent nothing — it had to call list_folders
// and join client-side just to know where a note lives. Folder counts are
// tiny, so building the full id->path map once per call (rather than a
// per-row join) is cheap and handles nesting correctly.
export type FolderRow = { id: string; name: string; parent_id: string | null };

/** Folder id -> full path (cycle-safe — mirrors lib/export.ts's folderPaths). */
export function buildFolderPathMap(folders: FolderRow[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  const resolve = (id: string, seen: Set<string>): string => {
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    const f = byId.get(id);
    if (!f || seen.has(id)) return '';
    seen.add(id);
    const path = f.parent_id ? `${resolve(f.parent_id, seen)}/${f.name}` : f.name;
    paths.set(id, path);
    return path;
  };
  folders.forEach((f) => resolve(f.id, new Set()));
  return paths;
}

export async function folderPathMap(): Promise<Map<string, string>> {
  const folders = await query<FolderRow>('select id, name, parent_id from folders');
  return buildFolderPathMap(folders);
}

/** An unknown path (the caller's error, 400) as opposed to a failed lookup (500). */
export class FolderPathNotFoundError extends Error {}

/**
 * The folder id for a human-written path like "Projects/Kybase", matched
 * case-insensitively and forgiving of leading/trailing slashes.
 *
 * Exists so a caller with a path in hand does not have to fetch the whole
 * folder tree just to translate it into a UUID — the round-trip every
 * folder-scoped search used to start with. Throws with real examples rather
 * than returning null: a mistyped path that silently searched the whole vault
 * would look like a working search with wrong results.
 */
export async function folderIdFromPath(folderPath: string): Promise<string> {
  const paths = await folderPathMap();
  const norm = (p: string) => p.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
  const wanted = norm(folderPath);
  for (const [id, p] of paths.entries()) if (norm(p) === wanted) return id;
  const available = Array.from(paths.values()).filter(Boolean).slice(0, 10).join('", "');
  throw new FolderPathNotFoundError(`Folder path "${folderPath}" not found. Available folders include: "${available}"`);
}
