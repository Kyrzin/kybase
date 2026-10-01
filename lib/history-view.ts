// lib/history-view.ts — what the History and Changes panels show for a
// revision: who made it, what kind of change it was, when, and the line diff
// of the text. Pure functions, no React; the data comes from lib/history.ts
// through /api/notes/[id]/revisions and /api/changes.
import { diffLines } from 'diff';
import type { RevisionKind } from './types';

/** A changed_by value as the owner reads it. */
export function actorLabel(changedBy: string): string {
  if (changedBy.startsWith('mcp:')) return changedBy.slice(4) || 'MCP';
  switch (changedBy) {
    case 'web': return 'You';
    case 'mcp': return 'MCP';
    case 'api': return 'API';
    case 'import': return 'Import';
    case 'unattributed': return 'Unknown';
    default: return changedBy;
  }
}

/** You, an agent over MCP, or anything else — the panels color them apart. */
export function actorKind(changedBy: string): 'you' | 'agent' | 'other' {
  if (changedBy === 'web') return 'you';
  return changedBy === 'mcp' || changedBy.startsWith('mcp:') ? 'agent' : 'other';
}

const KIND_LABELS: Record<RevisionKind, string> = {
  create: 'created',
  edit: 'edited',
  'rename-link': 'links updated',
  revert: 'reverted',
  delete: 'moved to trash',
  restore: 'restored',
};

export function kindLabel(kind: RevisionKind): string {
  return KIND_LABELS[kind] ?? kind;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function relativeTime(iso: string, now: number): string {
  // A server clock slightly ahead of this one must not read as the future.
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? '1 day ago' : `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

export type DiffLine = { type: 'add' | 'del' | 'same'; text: string };
export type DiffRow = DiffLine | { type: 'skip'; count: number };

// A diff runs on the main thread, and a note may hold millions of characters.
// Past this jsdiff gives up, and the panel says so instead of freezing. A time
// bound rather than an edit-length one: appending thousands of lines is a long
// edit but a cheap diff.
const DIFF_TIMEOUT_MS = 1000;

/** Line diff of two texts, or null when it is too large to compute here. */
export function diffTextLines(before: string, after: string): DiffLine[] | null {
  if (before === after) return splitLines(before).map(text => ({ type: 'same', text }));
  const changes = diffLines(before, after, {
    timeout: DIFF_TIMEOUT_MS,
    // An append to a note without a final newline otherwise shows its old
    // last line as removed and re-added.
    ignoreNewlineAtEof: true,
  });
  if (!changes) return null;
  const lines: DiffLine[] = [];
  for (const change of changes) {
    const type = change.added ? 'add' : change.removed ? 'del' : 'same';
    for (const text of splitLines(change.value)) lines.push({ type, text });
  }
  return lines;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Unchanged runs cut down to `context` lines on each side of a change, the
 * rest folded into a count, the way a unified diff shows them. Empty when
 * nothing changed.
 */
export function collapseUnchanged(lines: DiffLine[], context = 3): DiffRow[] {
  if (lines.every(l => l.type === 'same')) return [];
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'same') {
      rows.push(lines[i]);
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].type === 'same') end++;
    const keepHead = i === 0 ? 0 : context;
    const keepTail = end === lines.length ? 0 : context;
    const hidden = end - i - keepHead - keepTail;
    // Folding a single line would take the same room as showing it.
    if (hidden > 1) {
      for (let k = i; k < i + keepHead; k++) rows.push(lines[k]);
      rows.push({ type: 'skip', count: hidden });
      for (let k = end - keepTail; k < end; k++) rows.push(lines[k]);
    } else {
      for (let k = i; k < end; k++) rows.push(lines[k]);
    }
    i = end;
  }
  return rows;
}
