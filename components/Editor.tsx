'use client';

// components/Editor.tsx — note view/edit surface: toolbar (rename note &
// folder, move, share, wikilink picker, tags) and the editor/preview body
// with wikilink autocomplete. Extracted from KybaseApp. The editor-only
// refs and insertWikilink live here; everything shared comes in as props.
import { useRef, useCallback } from 'react';
import type { Note, Folder } from '@/lib/types';
import { Icons } from './Icons';
import { parseMarkdown, renderWithWikilinks } from '@/lib/markdown';

type WikilinkPreview = { x: number; y: number; title: string; excerpt: string } | null;

export default function Editor(p: {
  activeNote: Note;
  activeFolder: Folder | null;
  notes: Note[];
  folders: Folder[];
  activeNoteId: string | null;
  editMode: boolean;
  setEditMode: (v: boolean) => void;
  editTitle: string;
  setEditTitle: (v: string) => void;
  editContent: string;
  setEditContent: (v: string) => void;
  renamingFolderId: string | null;
  setRenamingFolderId: (v: string | null) => void;
  renamingFolderName: string;
  setRenamingFolderName: (v: string) => void;
  renameFolder: (id: string, name: string) => void;
  toolbarEditingTitle: boolean;
  setToolbarEditingTitle: (v: boolean) => void;
  movingNote: boolean;
  setMovingNote: (v: boolean) => void;
  moveNote: (folderId: string | null) => void;
  shareNote: () => void;
  saveNote: () => void;
  linkPickerOpen: boolean;
  setLinkPickerOpen: (v: boolean) => void;
  linkSearch: string;
  setLinkSearch: (v: string) => void;
  linkInlineTrigger: boolean;
  setLinkInlineTrigger: (v: boolean) => void;
  addingTag: boolean;
  setAddingTag: (v: boolean) => void;
  newTag: string;
  setNewTag: (v: string) => void;
  addTag: (raw: string) => void;
  removeTag: (tag: string) => void;
  filterByTag: (tag: string) => void;
  wikilinkPreview: WikilinkPreview;
  setWikilinkPreview: (v: WikilinkPreview) => void;
}) {
  const {
    activeNote, activeFolder, notes, folders, activeNoteId,
    editMode, setEditMode, editTitle, setEditTitle, editContent, setEditContent,
    renamingFolderId, setRenamingFolderId, renamingFolderName, setRenamingFolderName, renameFolder,
    toolbarEditingTitle, setToolbarEditingTitle,
    movingNote, setMovingNote, moveNote, shareNote, saveNote,
    linkPickerOpen, setLinkPickerOpen, linkSearch, setLinkSearch, linkInlineTrigger, setLinkInlineTrigger,
    addingTag, setAddingTag, newTag, setNewTag, addTag, removeTag, filterByTag,
    wikilinkPreview, setWikilinkPreview,
  } = p;

  const editorRef        = useRef<HTMLTextAreaElement>(null);
  const wikilinkStartRef = useRef<number>(-1);

  const insertWikilink = useCallback((title: string) => {
    const el = editorRef.current;
    if (!el) return;
    const inlineStart = wikilinkStartRef.current;
    const start = inlineStart >= 0 ? inlineStart : el.selectionStart;
    const end   = inlineStart >= 0 ? el.selectionStart : el.selectionEnd;
    const link  = `[[${title}]]`;
    const next  = editContent.slice(0, start) + link + editContent.slice(end);
    setEditContent(next);
    setLinkPickerOpen(false);
    setLinkInlineTrigger(false);
    setLinkSearch('');
    wikilinkStartRef.current = -1;
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + link.length, start + link.length);
    }, 0);
  }, [editContent, setEditContent, setLinkPickerOpen, setLinkInlineTrigger, setLinkSearch]);

  return (
          <div className="editor-area">
            {activeNote ? (
              <>
                <div className="editor-toolbar">
                  <button className={!editMode ? 'active' : ''} onClick={() => { if (editMode) saveNote(); else setEditMode(false); }}>
                    {Icons.eye}<span>Preview</span>
                  </button>
                  <button className={editMode ? 'active' : ''} onClick={() => setEditMode(true)}>
                    {Icons.edit}<span>Edit</span>
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 6, minWidth: 0 }}>
                    {activeFolder && (
                      <>
                        {renamingFolderId === activeFolder.id ? (
                          <input
                            autoFocus
                            value={renamingFolderName}
                            onChange={e => setRenamingFolderName(e.target.value)}
                            onBlur={() => renameFolder(activeFolder.id, renamingFolderName)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') renameFolder(activeFolder.id, renamingFolderName);
                              if (e.key === 'Escape') setRenamingFolderId(null);
                            }}
                            style={{ background: '#313244', border: '1px solid #89b4fa', borderRadius: 4, color: '#cdd6f4', fontSize: 12, fontWeight: 500, padding: '2px 6px', outline: 'none', maxWidth: 130 }}
                          />
                        ) : (
                          <button
                            onClick={() => { setRenamingFolderName(activeFolder.name); setRenamingFolderId(activeFolder.id); }}
                            style={{ background: 'none', border: 'none', color: '#6c7086', fontSize: 12, fontWeight: 500, cursor: 'pointer', padding: '2px 6px', borderRadius: 4, fontFamily: 'inherit', transition: 'all 0.15s', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#cdd6f4'; (e.currentTarget as HTMLButtonElement).style.background = '#313244'; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#6c7086'; (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
                            title="Rename folder"
                          >
                            {activeFolder.name}
                          </button>
                        )}
                        <span style={{ color: '#45475a', fontSize: 12, userSelect: 'none', padding: '0 1px' }}>/</span>
                      </>
                    )}
                    {toolbarEditingTitle ? (
                      <input
                        autoFocus
                        value={editTitle}
                        onChange={e => setEditTitle(e.target.value)}
                        onBlur={() => { saveNote(); setToolbarEditingTitle(false); }}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { saveNote(); setToolbarEditingTitle(false); }
                          if (e.key === 'Escape') setToolbarEditingTitle(false);
                        }}
                        style={{ background: '#313244', border: '1px solid #89b4fa', borderRadius: 4, color: '#cdd6f4', fontSize: 12, fontWeight: 600, padding: '2px 8px', outline: 'none', maxWidth: 220, minWidth: 80 }}
                      />
                    ) : (
                      <button
                        onClick={() => setToolbarEditingTitle(true)}
                        style={{ background: 'none', border: 'none', color: '#a6adc8', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '2px 8px', borderRadius: 4, fontFamily: 'inherit', transition: 'all 0.15s', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#cdd6f4'; (e.currentTarget as HTMLButtonElement).style.background = '#313244'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#a6adc8'; (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
                        title="Rename note"
                      >
                        {editTitle || activeNote.title}
                      </button>
                    )}
                  </div>
                  <div className="sep" />
                  {movingNote ? (
                    <select
                      autoFocus
                      defaultValue={activeNote.folder_id ?? ''}
                      onBlur={() => setMovingNote(false)}
                      onChange={e => moveNote(e.target.value || null)}
                      style={{ background: '#313244', border: '1px solid #45475a', borderRadius: 4, color: '#cdd6f4', fontSize: 12, padding: '2px 6px', cursor: 'pointer' }}
                    >
                      <option value="">— No folder —</option>
                      {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  ) : (
                    <button title="Move to folder" onClick={() => setMovingNote(true)} style={{ fontSize: 12, gap: 4 }}>
                      {Icons.folder}<span>Move</span>
                    </button>
                  )}
                  <button title="Create a public read-only link" onClick={shareNote} style={{ fontSize: 12, gap: 4 }}>
                    {Icons.link}<span>Share</span>
                  </button>
                  {editMode && (
                    <>
                      <div className="sep" />
                      {linkPickerOpen ? (
                        <div style={{ position: 'relative', display: 'inline-block' }}>
                          <input
                            autoFocus
                            placeholder="Search note…"
                            value={linkSearch}
                            onChange={e => setLinkSearch(e.target.value)}
                            onBlur={e => { if (!e.relatedTarget) { setLinkPickerOpen(false); setLinkSearch(''); } }}
                            style={{ background: '#313244', border: '1px solid #45475a', borderRadius: 4, color: '#cdd6f4', fontSize: 12, padding: '2px 8px', width: 160, outline: 'none' }}
                          />
                          {linkSearch && (
                            <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 100, background: 'rgba(30,30,46,0.65)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, minWidth: 220, maxHeight: 200, overflowY: 'auto', marginTop: 4, boxShadow: '0 12px 40px rgba(0,0,0,0.5)' }}>
                              {notes
                                .filter(n => n.id !== activeNoteId && n.title.toLowerCase().includes(linkSearch.toLowerCase()))
                                .slice(0, 10)
                                .map(n => (
                                  <div
                                    key={n.id}
                                    tabIndex={0}
                                    onMouseDown={e => { e.preventDefault(); insertWikilink(n.title); }}
                                    style={{ padding: '6px 10px', cursor: 'pointer', color: '#cdd6f4', fontSize: 13 }}
                                    onMouseEnter={e => (e.currentTarget.style.background = '#313244')}
                                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                  >
                                    {n.title}
                                  </div>
                                ))}
                              {notes.filter(n => n.id !== activeNoteId && n.title.toLowerCase().includes(linkSearch.toLowerCase())).length === 0 && (
                                <div style={{ padding: '6px 10px', color: '#585b70', fontSize: 13 }}>No results</div>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <button title="Insert wikilink" onClick={() => setLinkPickerOpen(true)} style={{ fontSize: 12, gap: 4 }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                          <span>Link</span>
                        </button>
                      )}
                    </>
                  )}
                  <div className="sep" />
                  {activeNote.tags.map(t => (
                    <span key={t} className="tag-pill" onClick={() => filterByTag(t)} title={`Filter by #${t}`}>
                      #{t}
                      <span className="tag-x" onClick={e => { e.stopPropagation(); removeTag(t); }} title="Remove tag">×</span>
                    </span>
                  ))}
                  {addingTag ? (
                    <input
                      autoFocus
                      className="tag-input"
                      placeholder="tag…"
                      value={newTag}
                      onChange={e => setNewTag(e.target.value)}
                      onBlur={() => { if (newTag.trim()) addTag(newTag); setAddingTag(false); }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(newTag); }
                        if (e.key === 'Escape') { setNewTag(''); setAddingTag(false); }
                      }}
                    />
                  ) : (
                    <button className="tag-add-btn" onClick={() => setAddingTag(true)} title="Add tag">+ tag</button>
                  )}
                </div>
                <div className="editor-content">
                  {editMode ? (
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
                      <input
                        type="text"
                        value={editTitle}
                        onChange={e => setEditTitle(e.target.value)}
                        style={{ background: 'transparent', border: 'none', borderBottom: '1px solid #313244', color: '#cdd6f4', fontSize: 22, fontWeight: 700, fontFamily: "'DM Sans', sans-serif", padding: '0 0 8px', marginBottom: 16, outline: 'none' }}
                      />
                      <textarea
                        ref={editorRef}
                        value={editContent}
                        onChange={e => {
                          const val = e.target.value;
                          setEditContent(val);
                          const pos = e.target.selectionStart;
                          const before = val.slice(0, pos);
                          const bracketIdx = before.lastIndexOf('[[');
                          if (bracketIdx >= 0 && !before.slice(bracketIdx).includes(']]')) {
                            const q = before.slice(bracketIdx + 2);
                            if (!q.includes('\n')) {
                              wikilinkStartRef.current = bracketIdx;
                              setLinkSearch(q);
                              setLinkPickerOpen(true);
                              setLinkInlineTrigger(true);
                              return;
                            }
                          }
                          if (linkPickerOpen && linkInlineTrigger) {
                            setLinkPickerOpen(false);
                            setLinkInlineTrigger(false);
                            setLinkSearch('');
                            wikilinkStartRef.current = -1;
                          }
                        }}
                        onKeyDown={e => {
                          if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveNote(); }
                          if (e.key === 'Escape' && linkPickerOpen) {
                            setLinkPickerOpen(false); setLinkInlineTrigger(false);
                            setLinkSearch(''); wikilinkStartRef.current = -1;
                          }
                        }}
                        autoFocus
                      />
                      {linkPickerOpen && linkInlineTrigger && (
                        <div style={{ position: 'absolute', bottom: '2.5rem', left: 0, right: 0, zIndex: 150, background: 'rgba(30,30,46,0.65)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, maxHeight: 220, overflowY: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,0.5)' }}>
                          {notes
                            .filter(n => n.id !== activeNoteId && (linkSearch === '' || n.title.toLowerCase().includes(linkSearch.toLowerCase())))
                            .slice(0, 10)
                            .map(n => (
                              <div
                                key={n.id}
                                onMouseDown={e => { e.preventDefault(); insertWikilink(n.title); }}
                                style={{ padding: '7px 12px', cursor: 'pointer', color: '#cdd6f4', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}
                                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(49,50,68,0.7)')}
                                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                              >
                                <span style={{ color: '#585b70', flexShrink: 0 }}>{Icons.file}</span>
                                {n.title}
                                {n.folder_id && <span style={{ fontSize: 11, color: '#585b70', marginLeft: 'auto' }}>{folders.find(f => f.id === n.folder_id)?.name}</span>}
                              </div>
                            ))}
                          {notes.filter(n => n.id !== activeNoteId && (linkSearch === '' || n.title.toLowerCase().includes(linkSearch.toLowerCase()))).length === 0 && (
                            <div style={{ padding: '7px 12px', color: '#585b70', fontSize: 13 }}>No results</div>
                          )}
                        </div>
                      )}
                      <div style={{ paddingTop: 8, fontSize: 11, color: '#585b70' }}>
                        Ctrl+S to save • Type [[ for wikilinks • Auto-saves after 0.8s
                      </div>
                    </div>
                  ) : (
                    <div
                      className="markdown-preview"
                      dangerouslySetInnerHTML={{ __html: renderWithWikilinks(parseMarkdown(activeNote.content), notes) }}
                      onMouseMove={e => {
                        const target = e.target as HTMLElement;
                        if (target.classList.contains('wikilink')) {
                          const noteTitle = target.dataset.title ?? '';
                          const found = notes.find(n => n.title.toLowerCase() === noteTitle.toLowerCase());
                          if (found) {
                            const excerpt = found.content.replace(/^#.+\n?/m, '').replace(/\[\[|\]\]/g, '').trim().slice(0, 160);
                            setWikilinkPreview({ x: e.clientX + 14, y: e.clientY - 8, title: found.title, excerpt });
                            return;
                          }
                        }
                        if (wikilinkPreview) setWikilinkPreview(null);
                      }}
                      onMouseLeave={() => setWikilinkPreview(null)}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#45475a" strokeWidth="1.5">
                  <circle cx="12" cy="5.5" r="2.5" />
                  <circle cx="5.5" cy="18" r="2.5" />
                  <circle cx="18.5" cy="18" r="2.5" />
                  <path d="M10.9 7.7 6.7 15.8M13.1 7.7l4.2 8.1M8 18h8" strokeLinecap="round" />
                </svg>
                <span className="empty-state-text">Select or create a note</span>
              </div>
            )}
          </div>
  );
}
