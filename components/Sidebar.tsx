'use client';

// components/Sidebar.tsx — folder/note tree, search, tag filter, workspace
// focus select and create buttons. Extracted from KybaseApp; focus state
// stays in the parent because the graph consumes the same visibleNotes, so
// it's passed in rather than owned here.
import React from 'react';
import type { Note, Folder } from '@/lib/types';
import { Icons } from './Icons';

export default function Sidebar({
  sidebarOpen, setSidebarOpen,
  folders, visibleFolders, visibleNotes, filteredNotes,
  focusFolderId, switchFocus,
  searchQuery, setSearchQuery,
  tagFilter, setTagFilter,
  activeNoteId, selectNote,
  expandedFolders, toggleFolder,
  createNote, createFolder, deleteNote, deleteFolder,
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
}) {
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
              <div className="tree-item folder-item" style={{ paddingLeft: 12 + depth * 16 }} onClick={() => toggleFolder(folder.id)}>
                <span className="chevron" style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>{Icons.chevron}</span>
                <span className="tree-icon">{isExpanded ? Icons.folderOpen : Icons.folder}</span>
                <span className="tree-label">{folder.name}</span>
                <button className="tree-action" title="New note in folder" onClick={e => { e.stopPropagation(); createNote(folder.id); }}>{Icons.plus}</button>
                <button className="tree-action" title="New subfolder" onClick={e => { e.stopPropagation(); createFolder(folder.id); }}>{Icons.newFolder}</button>
                <button className="tree-action delete" title="Delete folder" onClick={e => { e.stopPropagation(); deleteFolder(folder.id); }}>{Icons.trash}</button>
              </div>
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
