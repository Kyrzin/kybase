'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { Folder, SearchHit } from '@/lib/types';
import { Icons } from './Icons';
import { type GraphData } from './MiniGraph';
import { buildWikilinkEdges } from '@/lib/graph';
import SettingsModal from './SettingsModal';
import Sidebar from './Sidebar';
import Editor from './Editor';
import RightPanel from './RightPanel';
import { apiFetch, useNotes } from '@/lib/useNotes';

const FOCUS_KEY = 'kybase_focus_folder';

// Markdown rendering lives in lib/markdown.ts (shared with the public
// share page). Notes/folders data + CRUD live in lib/useNotes.ts.

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function KybaseApp() {
  const [searchQuery, setSearchQuery] = useState('');
  const [aiQuery, setAiQuery]         = useState('');
  const [aiResults, setAiResults]     = useState<SearchHit[] | null>(null);
  const [aiLoading, setAiLoading]     = useState(false);
  const [sidebarOpen, setSidebarOpen]   = useState(typeof window !== 'undefined' ? window.innerWidth >= 768 : true);
  const [rightPanel, setRightPanel]     = useState<'backlinks' | 'graph' | 'ai' | null>(null);
  const [graphFullscreen, setGraphFullscreen] = useState(false);
  const [semanticEdges, setSemanticEdges] = useState<{ from: string; to: string; score: number }[]>([]);
  const graphFitRef = useRef<(() => void) | null>(null);
  const [winSize, setWinSize]           = useState({ w: typeof window !== 'undefined' ? window.innerWidth : 800, h: typeof window !== 'undefined' ? window.innerHeight : 600 });
  const [panelWidth, setPanelWidth]     = useState(300);
  const panelResizeRef = useRef<{ active: boolean; startX: number; startW: number }>({ active: false, startX: 0, startW: 300 });

  useEffect(() => {
    const update = () => setWinSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Global resize listeners — prevent onMouseLeave from cancelling drag when cursor exits panel
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!panelResizeRef.current.active) return;
      const delta = panelResizeRef.current.startX - e.clientX;
      setPanelWidth(Math.max(240, Math.min(Math.floor(window.innerWidth * 0.8), panelResizeRef.current.startW + delta)));
    };
    const onUp = () => { panelResizeRef.current.active = false; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Settings modal
  const [settingsOpen, setSettingsOpen]       = useState(false);

  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingFolderName, setRenamingFolderName] = useState('');
  const [toolbarEditingTitle, setToolbarEditingTitle] = useState(false);

  const [movingNote, setMovingNote]     = useState(false);
  const [shareInfo, setShareInfo]       = useState<{ token: string; url: string } | null>(null);
  const [shareCopied, setShareCopied]   = useState(false);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkInlineTrigger, setLinkInlineTrigger] = useState(false);
  const [linkSearch, setLinkSearch]     = useState('');
  const [wikilinkPreview, setWikilinkPreview] = useState<{ x: number; y: number; title: string; excerpt: string } | null>(null);

  const [tagFilter, setTagFilter]       = useState<string | null>(null);
  const [addingTag, setAddingTag]       = useState(false);
  const [newTag, setNewTag]             = useState('');

  // Focus mode: show only one top-level folder's subtree (workspace). Pure view
  // preference — lives in localStorage, never sent to the server or MCP. Stays
  // in the parent (not useNotes) because the graph reads the same visibleNotes.
  const [focusFolderId, setFocusFolderId] = useState<string | null>(null);
  const switchFocus = (id: string | null) => {
    setFocusFolderId(id);
    if (id) localStorage.setItem(FOCUS_KEY, id);
    else localStorage.removeItem(FOCUS_KEY);
  };

  // UI reactions that useNotes' data actions must trigger — kept here (not in
  // the hook) so the hook owns no view state. Memoized so the hook's load
  // effect doesn't re-run every render.
  const restoreFocus = useCallback((foldersData: Folder[]) => {
    const savedFocus = localStorage.getItem(FOCUS_KEY);
    if (savedFocus && foldersData.some(f => f.id === savedFocus && f.parent_id === null)) {
      setFocusFolderId(savedFocus);
    } else if (savedFocus) {
      localStorage.removeItem(FOCUS_KEY);
    }
  }, []);
  const onNoteOpened = useCallback(() => {
    setShareInfo(null); // the popover belongs to the note it was created for
    if (typeof window !== 'undefined' && window.innerWidth < 768) setSidebarOpen(false);
  }, []);
  const onMoveDone = useCallback(() => setMovingNote(false), []);
  const onRenameDone = useCallback(() => setRenamingFolderId(null), []);
  const onTagInputConsumed = useCallback(() => setNewTag(''), []);

  const {
    notes, setNotes, folders, setFolders, loading, activeNote, activeNoteId,
    editMode, setEditMode, editContent, setEditContent, editTitle, setEditTitle,
    expandedFolders, toggleFolder,
    selectNote, saveNote, addTag, removeTag,
    createNote, createFolder, deleteFolder, renameFolder, deleteNote, moveNote,
  } = useNotes({ onNoteOpened, onMoveDone, onRenameDone, onTagInputConsumed, restoreFocus });

  // Scroll sidebar to active note after folders have expanded
  useEffect(() => {
    if (!activeNoteId) return;
    const timer = setTimeout(() => {
      document.querySelector('.tree-item.note-item.active')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 150);
    return () => clearTimeout(timer);
  }, [activeNoteId]);

  // Semantic edges: embedding-similarity pairs from the server. Fetched with
  // the lowest useful threshold — the graph's slider narrows client-side.
  // Refreshed each time the graph opens to pick up freshly indexed notes.
  useEffect(() => {
    if (rightPanel !== null && rightPanel !== 'graph') return;
    apiFetch('/api/graph/semantic?threshold=0.6')
      .then(r => (r.ok ? r.json() : []))
      .then(d => { if (Array.isArray(d)) setSemanticEdges(d); })
      .catch(() => {});
  }, [rightPanel]);

  // ── Derived ─────────────────────────────────────────────────────────────────
  const activeFolder = useMemo(() => activeNote?.folder_id ? (folders.find(f => f.id === activeNote.folder_id) ?? null) : null, [activeNote, folders]);

  // Focus subtree: the focused folder plus all its descendants
  const focusFolderIds = useMemo<Set<string> | null>(() => {
    if (!focusFolderId) return null;
    const ids = new Set<string>([focusFolderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) {
          ids.add(f.id);
          grew = true;
        }
      }
    }
    return ids;
  }, [focusFolderId, folders]);

  const visibleNotes = useMemo(
    () => focusFolderIds ? notes.filter(n => n.folder_id !== null && focusFolderIds.has(n.folder_id)) : notes,
    [notes, focusFolderIds]
  );
  const visibleFolders = useMemo(
    () => focusFolderIds ? folders.filter(f => focusFolderIds.has(f.id)) : folders,
    [folders, focusFolderIds]
  );

  const backlinks = useMemo(() => {
    if (!activeNote) return [];
    const escaped = activeNote.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\[\\[${escaped}(\\|[^\\]]+)?\\]\\]`, 'gi');
    return notes.filter(n => n.id !== activeNote.id && re.test(n.content));
  }, [activeNote, notes]);

  const graphData = useMemo<GraphData>(() => {
    const nodesList: GraphData['nodes'] = visibleNotes.map(n => ({ id: n.id, title: n.title, type: 'note', folderId: n.folder_id }));
    // Explicit [[wikilink]] edges via the shared kernel (same directed,
    // case-insensitive, self-skipping resolution the server graph uses).
    const edgesList: GraphData['edges'] = buildWikilinkEdges(visibleNotes);
    // Merge semantic edges: only between visible notes, and never on a pair
    // that already has an explicit wikilink — solid beats dashed.
    const ids = new Set(nodesList.map(n => n.id));
    const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const linked = new Set(edgesList.map(e => pairKey(e.from, e.to)));
    semanticEdges.forEach(e => {
      if (!ids.has(e.from) || !ids.has(e.to)) return;
      const key = pairKey(e.from, e.to);
      if (linked.has(key)) return;
      linked.add(key);
      edgesList.push({ from: e.from, to: e.to, kind: 'semantic', score: e.score });
    });
    return { nodes: nodesList, edges: edgesList };
  }, [visibleNotes, semanticEdges]);

  const filteredNotes = useMemo(() => {
    if (tagFilter) return visibleNotes.filter(n => n.tags.includes(tagFilter));
    if (!searchQuery) return null;
    const q = searchQuery.toLowerCase();
    return visibleNotes.filter(n =>
      n.title.toLowerCase().includes(q) ||
      n.content.toLowerCase().includes(q) ||
      n.tags.some(t => t.toLowerCase().includes(q))
    );
  }, [searchQuery, tagFilter, visibleNotes]);

  const filterByTag = useCallback((tag: string) => {
    setTagFilter(tag);
    setSearchQuery('');
    setRightPanel(null);
    if (typeof window !== 'undefined' && window.innerWidth < 768) setSidebarOpen(true);
  }, []);

  const handleAiSearch = async () => {
    if (!aiQuery.trim()) return;
    setAiLoading(true);
    setAiResults(null);
    try {
      const res = await apiFetch(`/api/search?q=${encodeURIComponent(aiQuery)}&type=hybrid&limit=5`);
      if (res.ok) {
        const data: SearchHit[] = await res.json();
        setAiResults(data);
      }
    } finally {
      setAiLoading(false);
    }
  };

  const shareNote = async () => {
    if (!activeNoteId) return;
    const res = await apiFetch(`/api/notes/${activeNoteId}/share`, { method: 'POST', body: '{}' });
    if (!res.ok) return;
    const data = await res.json();
    setShareInfo({ token: data.token, url: data.url });
  };

  // The editor's share popover can revoke the link it just created.
  const revokeShareLink = async (noteId: string, token: string) => {
    const res = await apiFetch(`/api/notes/${noteId}/share/${token}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setShareInfo(prev => (prev?.token === token ? null : prev));
    }
  };

  // ── Loading screen ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#1e1e2e', color: '#a6adc8', fontFamily: "'DM Sans', sans-serif", fontSize: 14, gap: 10 }}>
        <div style={{ width: 16, height: 16, border: '2px solid #313244', borderTopColor: '#89b4fa', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
        Loading notes…
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <>

      <div className="kybase-app">
        {/* Top Bar */}
        <div className="topbar">
          <button className="topbar-btn" onClick={() => setSidebarOpen(v => !v)}>
            {Icons.sidebar}
          </button>
          <div className="topbar-brand">
            {/* Brand mark: three linked notes — the knowledge graph */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="5.5" r="2.5" stroke="url(#g1)" strokeWidth="2" />
              <circle cx="5.5" cy="18" r="2.5" stroke="url(#g1)" strokeWidth="2" />
              <circle cx="18.5" cy="18" r="2.5" stroke="url(#g1)" strokeWidth="2" />
              <path d="M10.9 7.7 6.7 15.8M13.1 7.7l4.2 8.1M8 18h8" stroke="url(#g1)" strokeWidth="2" strokeLinecap="round" />
              <defs>
                <linearGradient id="g1" x1="3" y1="3" x2="21" y2="21">
                  <stop stopColor="#89b4fa" /><stop offset="1" stopColor="#b4befe" />
                </linearGradient>
              </defs>
            </svg>
            <span>Kybase</span>
          </div>
          <div className="topbar-sep" />
          {activeNote && <span className="topbar-note-title">{editMode ? editTitle : activeNote.title}</span>}
          <div className="topbar-sep" />
          <button className={`topbar-btn ${rightPanel === 'backlinks' ? 'active' : ''}`} onClick={() => { const n = rightPanel === 'backlinks' ? null : 'backlinks'; setRightPanel(n); setPanelWidth(300); }} title="Backlinks">{Icons.link}</button>
          <button className={`topbar-btn ${rightPanel === 'graph' ? 'active' : ''}`} onClick={() => { const n = rightPanel === 'graph' ? null : 'graph'; setRightPanel(n); setGraphFullscreen(false); setPanelWidth(n === 'graph' && window.innerWidth >= 768 ? Math.floor(window.innerWidth * 0.5) : 300); }} title="Graph View">{Icons.graph}</button>
          <button className={`topbar-btn ${rightPanel === 'ai' ? 'active' : ''}`} onClick={() => { const n = rightPanel === 'ai' ? null : 'ai'; setRightPanel(n); setPanelWidth(300); }} title="AI Search">{Icons.ai}</button>
          <button className="topbar-btn" onClick={() => setSettingsOpen(true)} title="Settings">{Icons.settings}</button>
        </div>

        {/* Main Layout */}
        <div className="main-layout">
          <Sidebar
            sidebarOpen={sidebarOpen}
            setSidebarOpen={setSidebarOpen}
            folders={folders}
            visibleFolders={visibleFolders}
            visibleNotes={visibleNotes}
            filteredNotes={filteredNotes}
            focusFolderId={focusFolderId}
            switchFocus={switchFocus}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            tagFilter={tagFilter}
            setTagFilter={setTagFilter}
            activeNoteId={activeNoteId}
            selectNote={selectNote}
            expandedFolders={expandedFolders}
            toggleFolder={toggleFolder}
            createNote={createNote}
            createFolder={createFolder}
            deleteNote={deleteNote}
            deleteFolder={deleteFolder}
          />

          {/* Editor */}
          {activeNote ? (
            <Editor
              activeNote={activeNote}
              activeFolder={activeFolder}
              notes={notes}
              folders={folders}
              activeNoteId={activeNoteId}
              editMode={editMode}
              setEditMode={setEditMode}
              editTitle={editTitle}
              setEditTitle={setEditTitle}
              editContent={editContent}
              setEditContent={setEditContent}
              renamingFolderId={renamingFolderId}
              setRenamingFolderId={setRenamingFolderId}
              renamingFolderName={renamingFolderName}
              setRenamingFolderName={setRenamingFolderName}
              renameFolder={renameFolder}
              toolbarEditingTitle={toolbarEditingTitle}
              setToolbarEditingTitle={setToolbarEditingTitle}
              movingNote={movingNote}
              setMovingNote={setMovingNote}
              moveNote={moveNote}
              shareNote={shareNote}
              saveNote={saveNote}
              linkPickerOpen={linkPickerOpen}
              setLinkPickerOpen={setLinkPickerOpen}
              linkSearch={linkSearch}
              setLinkSearch={setLinkSearch}
              linkInlineTrigger={linkInlineTrigger}
              setLinkInlineTrigger={setLinkInlineTrigger}
              addingTag={addingTag}
              setAddingTag={setAddingTag}
              newTag={newTag}
              setNewTag={setNewTag}
              addTag={addTag}
              removeTag={removeTag}
              filterByTag={filterByTag}
              wikilinkPreview={wikilinkPreview}
              setWikilinkPreview={setWikilinkPreview}
            />
          ) : (
            <div className="editor-area">
              <div className="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#45475a" strokeWidth="1.5">
                  <circle cx="12" cy="5.5" r="2.5" />
                  <circle cx="5.5" cy="18" r="2.5" />
                  <circle cx="18.5" cy="18" r="2.5" />
                  <path d="M10.9 7.7 6.7 15.8M13.1 7.7l4.2 8.1M8 18h8" strokeLinecap="round" />
                </svg>
                <span className="empty-state-text">Select or create a note</span>
              </div>
            </div>
          )}

          {/* Right Panel */}
          {rightPanel && (
            <RightPanel
              rightPanel={rightPanel}
              graphFullscreen={graphFullscreen}
              setGraphFullscreen={setGraphFullscreen}
              panelWidth={panelWidth}
              panelResizeRef={panelResizeRef}
              backlinks={backlinks}
              activeNote={activeNote}
              activeNoteId={activeNoteId}
              selectNote={selectNote}
              winSize={winSize}
              graphData={graphData}
              graphFitRef={graphFitRef}
              toggleFolder={toggleFolder}
              setSidebarOpen={setSidebarOpen}
              setRightPanel={setRightPanel}
              aiQuery={aiQuery}
              setAiQuery={setAiQuery}
              handleAiSearch={handleAiSearch}
              aiLoading={aiLoading}
              aiResults={aiResults}
              filterByTag={filterByTag}
            />
          )}
        </div>
      </div>

      {/* Settings Modal */}
      {/* Share Link Modal */}
      {shareInfo && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={e => { if (e.target === e.currentTarget) setShareInfo(null); }}>
          <div style={{ background: 'rgba(30,30,46,0.95)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', border: '1px solid rgba(69,71,90,0.6)', borderRadius: 12, padding: 24, width: 'min(480px, calc(100vw - 32px))', boxShadow: '0 8px 48px rgba(0,0,0,0.6)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              {Icons.link}
              <span style={{ fontWeight: 600, fontSize: 15, color: '#cdd6f4' }}>Public link created</span>
            </div>
            <div style={{ fontSize: 12, color: '#a6adc8', marginBottom: 14, lineHeight: 1.5 }}>
              Anyone with this link can read the note — no login needed. The link is the access:
              revoke it here or later in Settings → Active share links.
            </div>
            <input
              readOnly
              autoFocus
              value={shareInfo.url}
              onFocus={e => e.target.select()}
              style={{ width: '100%', background: '#11111b', border: '1px solid #45475a', borderRadius: 6, color: '#89b4fa', fontSize: 13, padding: '10px 12px', outline: 'none', marginBottom: 14, fontFamily: 'monospace' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => { navigator.clipboard?.writeText(shareInfo.url); setShareCopied(true); setTimeout(() => setShareCopied(false), 1500); }}
                style={{ flex: 2, background: shareCopied ? '#a6e3a1' : 'linear-gradient(135deg,#89b4fa,#b4befe)', border: 'none', borderRadius: 6, color: '#1e1e2e', padding: '10px 0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'background 0.2s' }}
              >
                {shareCopied ? '✓ Copied' : 'Copy link'}
              </button>
              <button
                onClick={() => activeNoteId && revokeShareLink(activeNoteId, shareInfo.token)}
                style={{ flex: 1, background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#f38ba8', padding: '10px 0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Revoke
              </button>
              <button
                onClick={() => setShareInfo(null)}
                style={{ flex: 1, background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#cdd6f4', padding: '10px 0', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <SettingsModal
          apiFetch={apiFetch}
          onClose={() => setSettingsOpen(false)}
          setNotes={setNotes}
          setFolders={setFolders}
          onShareRevoked={token => setShareInfo(prev => (prev?.token === token ? null : prev))}
        />
      )}

      {/* Wikilink hover preview tooltip */}
      {wikilinkPreview && (
        <div style={{ position: 'fixed', left: Math.min(wikilinkPreview.x, window.innerWidth - 300), top: wikilinkPreview.y, zIndex: 300, background: 'rgba(30,30,46,0.65)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '10px 14px', maxWidth: 280, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', pointerEvents: 'none', fontFamily: "'DM Sans', sans-serif" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#89b4fa', marginBottom: 6 }}>{wikilinkPreview.title}</div>
          <div style={{ fontSize: 12, color: '#a6adc8', lineHeight: 1.55 }}>{wikilinkPreview.excerpt || 'No content'}</div>
        </div>
      )}
    </>
  );
}
