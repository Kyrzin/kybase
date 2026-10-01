'use client';

// components/FolderPicker.tsx — a small folder <select> reused by both the
// Editor (move a note) and the Sidebar (move a folder). Callers pass the
// list of eligible targets already filtered (e.g. the Sidebar excludes the
// moved folder and its descendants); this component only renders and reports.
import type { Folder } from '@/lib/types';

export default function FolderPicker({
  folders, value, onPick, onCancel, rootLabel = '— No folder —',
}: {
  folders: Folder[];
  value: string | null;
  onPick: (id: string | null) => void;
  onCancel: () => void;
  rootLabel?: string;
}) {
  return (
    <select
      autoFocus
      defaultValue={value ?? ''}
      onBlur={onCancel}
      onChange={e => onPick(e.target.value || null)}
      onClick={e => e.stopPropagation()}
      style={{ background: '#313244', border: '1px solid #45475a', borderRadius: 4, color: '#cdd6f4', fontSize: 12, padding: '2px 6px', cursor: 'pointer', maxWidth: 180 }}
    >
      <option value="">{rootLabel}</option>
      {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
    </select>
  );
}
