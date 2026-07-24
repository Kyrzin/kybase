'use client';

// components/Sidebar.tsx — folder/note tree, search, tag filter, workspace
// focus select and create buttons. Extracted from KybaseApp; focus state
// stays in the parent because the graph consumes the same visibleNotes, so
// it's passed in rather than owned here.
import React, { useMemo, useState } from 'react';
import type { Note, Folder } from '@/lib/types';
import { Icons } from './Icons';
import FolderPicker from './FolderPicker';

export default function Sidebar({
  sidebarOpen, setSidebarOpen,
  folders, visibleFolders, visibleNotes, filteredNotes,
  focusFolderId, switchFocus,
  searchQuery, setSearchQuery,
  tagFilter, setTagFilter,
  activeNoteId, selectNote,
  expandedFolders, toggleFolder,
  createNote, createFolder, deleteNote, deleteFolder, moveFolder,
}: {
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  folders: Folder[];
  visibleFolders: Folder[];
  visibleNotes: Note[];
  filteredNotes: Note[] | null;
  focusFolderId: string | null;
  switchFocus: (id: string | null) => void;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  tagFilter: string | null;
  setTagFilter: (v: string | null) => void;
  activeNoteId: string | null;
  selectNote: (id: string) => void;
  expandedFolders: Set<string>;
  toggleFolder: (id: string) => void;
  createNote: (folderId?: string | null) => void;
  createFolder: (parentId?: string | null) => void;
  deleteNote: (id: string) => void;
  deleteFolder: (id: string) => void;
  moveFolder: (id: string, parentId: string | null) => Promise<string | null>;
}) {
  // Which folder is being moved, and the last cycle/error message to show.
  const [movingFolderId, setMovingFolderId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  // Descendants of the folder being moved — invalid targets (would form a
  // cycle). Client-side guard; the server rejects cycles too (second line).
  const invalidTargets = useMemo(() => {
    if (!movingFolderId) return new Set<string>();
    const banned = new Set<string>([movingFolderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parent_id && banned.has(f.parent_id) && !banned.has(f.id)) {
          banned.add(f.id);
          grew = true;
        }
      }
    }
    return banned;
  }, [movingFolderId, folders]);

  const doMoveFolder = async (id: string, parentId: string | null) => {
    const err = await moveFolder(id, parentId);
    if (err) {
      setMoveError(err);            // keep the picker open, state unchanged
    } else {
      setMovingFolderId(null);
      setMoveError(null);
    }
  };

  const renderFolderTree = (parentId: string | null = null, depth = 0): React.ReactNode => {
    if (searchQuery && filteredNotes) return null;
    const childFolders = visibleFolders.filter(f => f.parent_id === parentId);
    const childNotes   = visibleNotes.filter(n => n.folder_id === parentId);
    return (
      <>
        {childFolders.map(folder => {
          const isExpanded = expandedFolders.has(folder.id);
          return (
            <div key={folder.id}>
              <div className="tree-item folder-item" style={{ paddingLeft: 12 + depth * 16 }} onClick={() => { if (movingFolderId !== folder.id) toggleFolder(folder.id); }}>
                <span className="chevron" style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>{Icons.chevron}</span>
                <span className="tree-icon">{isExpanded ? Icons.folderOpen : Icons.folder}</span>
                <span className="tree-label">{folder.name}</span>
                {movingFolderId === folder.id ? (
                  <FolderPicker
                    folders={folders.filter(f => !invalidTargets.has(f.id))}
                    value={folder.parent_id}
                    onPick={target => doMoveFolder(folder.id, target)}
                    onCancel={() => { setMovingFolderId(null); setMoveError(null); }}
                    rootLabel="— To root —"
                  />
                ) : (
                  <>
                    <button className="tree-action" title="New note in folder" onClick={e => { e.stopPropagation(); createNote(folder.id); }}>{Icons.plus}</button>
                    <button className="tree-action" title="New subfolder" onClick={e => { e.stopPropagation(); createFolder(folder.id); }}>{Icons.newFolder}</button>
                    <button className="tree-action" title="Move folder" onClick={e => { e.stopPropagation(); setMoveError(null); setMovingFolderId(folder.id); }}>{Icons.move}</button>
                    <button className="tree-action delete" title="Delete folder" onClick={e => { e.stopPropagation(); deleteFolder(folder.id); }}>{Icons.trash}</button>
                  </>
                )}
              </div>
              {movingFolderId === folder.id && moveError && (
                <div style={{ paddingLeft: 28 + depth * 16, color: '#f38ba8', fontSize: 11, padding: '2px 8px 4px 0', lineHeight: 1.4 }}>{moveError}</div>
              )}
              {isExpanded && renderFolderTree(folder.id, depth + 1)}
            </div>
          );
        })}
        {childNotes.map(note => (
          <div key={note.id} className={`tree-item note-item ${activeNoteId === note.id ? 'active' : ''}`} style={{ paddingLeft: 28 + depth * 16 }} onClick={() => selectNote(note.id)}>
            <span className="tree-icon">{Icons.file}</span>
            <span className="tree-label">{note.title}</span>
            <button className="tree-action delete" title="Delete" onClick={e => { e.stopPropagation(); deleteNote(note.id); }}>{Icons.trash}</button>
          </div>
        ))}
      </>
    );
  };

  return (
    <>
      {/* Sidebar overlay for mobile */}
      <div className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`} onClick={() => setSidebarOpen(false)} />
      {/* Sidebar */}
      <div className={`sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-header">
          <select
            className="focus-select"
            value={focusFolderId ?? ''}
            onChange={e => switchFocus(e.target.value || null)}
            title="Workspace focus"
          >
            <option value="">All notes</option>
            {folders.filter(f => f.parent_id === null).sort((a, b) => a.name.localeCompare(b.name)).map(f => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
          <button title="New Note"   onClick={() => createNote(focusFolderId)}>{Icons.plus}</button>
          <button title="New Folder" onClick={() => createFolder(focusFolderId)}>{Icons.newFolder}</button>
        </div>
        <div className="search-box">
          <span className="search-icon">{Icons.search}</span>
          <input type="text" placeholder="Search notes..." value={searchQuery} onChange={e => { setSearchQuery(e.target.value); if (tagFilter) setTagFilter(null); }} />
        </div>
        {tagFilter && (
          <div className="tag-filter-bar">
            <span className="tag-filter-chip">
              #{tagFilter}
              <span onClick={() => setTagFilter(null)} title="Clear filter">×</span>
            </span>
          </div>
        )}
        <div className="tree-container">
          {filteredNotes ? (
            filteredNotes.length === 0 ? (
              <div style={{ padding: 16, color: '#585b70', fontSize: 13, textAlign: 'center' }}>No results</div>
            ) : (
              filteredNotes.map(note => (
                <div key={note.id} className={`tree-item note-item ${activeNoteId === note.id ? 'active' : ''}`} style={{ paddingLeft: 12 }} onClick={() => { selectNote(note.id); setSearchQuery(''); }}>
                  <span className="tree-icon">{Icons.file}</span>
                  <span className="tree-label">{note.title}</span>
                </div>
              ))
            )
          ) : (
            renderFolderTree(focusFolderId, 0)
          )}
        </div>
      </div>
    </>
  );
}
