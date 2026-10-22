'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { Folder, SearchHit } from '@/lib/types';
import { Icons } from './Icons';
import { type GraphData } from './SigmaGraph';
import SettingsModal from './SettingsModal';
import Sidebar from './Sidebar';
import Editor, { type WikilinkPreview } from './Editor';
import RightPanel, { type HistoryPick, type RightPanelMode } from './RightPanel';
import { useNotes } from '@/lib/useNotes';
import { useBacklinks, useGraphLinks, useNoteSearch } from '@/lib/useNoteQueries';
import { apiFetch } from '@/lib/api-client';

const FOCUS_KEY = 'kybase_focus_folder';

// Markdown rendering lives in lib/markdown.ts (shared with the public
// share page). Notes/folders data + CRUD live in lib/useNotes.ts.

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function KybaseApp() {
  const [searchQuery, setSearchQuery] = useState('');
  const [aiQuery, setAiQuery]         = useState('');
  const [aiResults, setAiResults]     = useState<SearchHit[] | null>(null);
  const [aiLoading, setAiLoading]     = useState(false);
  // Deterministic initial value (true) so SSR and the client's hydration
  // pass render the same markup — reading window.innerWidth here would make
  // a mobile client's hydration render disagree with the server's guess and
  // trigger a hydration-mismatch warning. Narrowed to the real width right
  // after mount instead.
  const [sidebarOpen, setSidebarOpen]   = useState(true);
  const [rightPanel, setRightPanel]     = useState<RightPanelMode | null>(null);
  const [historyPick, setHistoryPick]   = useState<HistoryPick | null>(null);
  const [changesActor, setChangesActor] = useState('');
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

  // Post-mount narrowing for sidebarOpen — see the state declaration above.
  // A one-time read of window.innerWidth on mount, not a derived value, so
  // the usual "don't setState in an effect" alternative (computing it during
  // render) isn't available: render can't know the real width without
  // disagreeing with the server's markup.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (window.innerWidth < 768) setSidebarOpen(false);
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
  const [shareInfo, setShareInfo]       = useState<{ id: string; url: string } | null>(null);
  const [shareCopied, setShareCopied]   = useState(false);
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkInlineTrigger, setLinkInlineTrigger] = useState(false);
  const [linkSearch, setLinkSearch]     = useState('');
  const [wikilinkPreview, setWikilinkPreview] = useState<WikilinkPreview>(null);

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
    notes, folders, loading, activeNote, activeNoteId,
    editMode, setEditMode, editContent, setEditContent, editTitle, setEditTitle,
    expandedFolders, toggleFolder,
    selectNote, saveNote, addTag, removeTag,
    createNote, createFolder, deleteFolder, renameFolder, deleteNote, moveNote, moveFolder,
    syncError, setSyncError, canOverwriteConflict, overwriteConflict,
    reindexingNoteId, reindexNote,
    refreshNote, revertNote, loadText, reloadNotes,
    pdfImporting, importPdfFile,
  } = useNotes({ onNoteOpened, onMoveDone, onRenameDone, onTagInputConsumed, restoreFocus });
  const [overwriting, setOverwriting] = useState(false);

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

  const backlinks = useBacklinks(activeNoteId, rightPanel === 'backlinks');

  const linkEdges = useGraphLinks(rightPanel === 'graph', notes);
  // The graph draws each top-level folder as an island: a note's group is the
  // root of its folder chain.
  const rootFolderOf = useMemo(() => {
    const parent = new Map(folders.map(f => [f.id, f.parent_id]));
    return (folderId: string | null): string | null => {
      let id = folderId;
      for (let hops = 0; id && parent.get(id) && hops < 64; hops++) id = parent.get(id)!;
      return id;
    };
  }, [folders]);

  const graphData = useMemo<GraphData>(() => {
    const nodesList: GraphData['nodes'] = visibleNotes.map(n => ({
      id: n.id, title: n.title, type: 'note', folderId: n.folder_id, group: rootFolderOf(n.folder_id),
    }));
    const used = new Set(nodesList.map(n => n.group));
    const groups = folders
      .filter(f => f.parent_id === null && used.has(f.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(f => ({ id: f.id, name: f.name }));
    const ids = new Set(nodesList.map(n => n.id));
    const edgesList: GraphData['edges'] = linkEdges.filter(e => ids.has(e.from) && ids.has(e.to));
    // Merge semantic edges: only between visible notes, and never on a pair
    // that already has an explicit wikilink — solid beats dashed.
    const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const linked = new Set(edgesList.map(e => pairKey(e.from, e.to)));
    semanticEdges.forEach(e => {
      if (!ids.has(e.from) || !ids.has(e.to)) return;
      const key = pairKey(e.from, e.to);
      if (linked.has(key)) return;
      linked.add(key);
      edgesList.push({ from: e.from, to: e.to, kind: 'semantic', score: e.score });
    });
    return { nodes: nodesList, edges: edgesList, groups };
  }, [visibleNotes, linkEdges, semanticEdges, folders, rootFolderOf]);

  const searchHits = useNoteSearch(searchQuery);
  const filteredNotes = useMemo(() => {
    if (tagFilter) return visibleNotes.filter(n => n.tags.includes(tagFilter));
    if (!searchHits) return null;
    return focusFolderIds ? searchHits.filter(n => n.folder_id !== null && focusFolderIds.has(n.folder_id)) : searchHits;
  }, [searchHits, tagFilter, visibleNotes, focusFolderIds]);

  const previewNote = wikilinkPreview ? notes.find(n => n.id === wikilinkPreview.noteId) ?? null : null;
  const previewText = previewNote?.content;
  const previewExcerpt = useMemo(
    () => (typeof previewText === 'string'
      ? previewText.replace(/^#.+\n?/m, '').replace(/\[\[|\]\]/g, '').trim().slice(0, 160)
      : null),
    [previewText]
  );

  const filterByTag = useCallback((tag: string) => {
    setTagFilter(tag);
    setSearchQuery('');
    setRightPanel(null);
    if (typeof window !== 'undefined' && window.innerWidth < 768) setSidebarOpen(true);
  }, []);

  // Sized like the graph: diffs read better wider, and Changes opens into History.
  const openHistoryPanel = (mode: 'history' | 'changes') => {
    const n = rightPanel === mode ? null : mode;
    setRightPanel(n);
    if (n === 'history') setHistoryPick(null);
    setPanelWidth(n && window.innerWidth >= 768 ? Math.min(Math.floor(window.innerWidth * 0.38), 560) : 300);
  };

  // A row of the Changes feed opens its note, with History showing that change.
  const openChange = async (noteId: string, revisionId: string) => {
    await selectNote(noteId);
    setHistoryPick({ noteId, revisionId });
    setRightPanel('history');
  };

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
    setShareInfo({ id: data.id, url: data.url });
  };

  // The editor's share popover can revoke the link it just created.
  // shareId is the share row's id (a uuid), not the secret token.
  const revokeShareLink = async (noteId: string, shareId: string) => {
    const res = await apiFetch(`/api/notes/${noteId}/share/${shareId}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      setShareInfo(prev => (prev?.id === shareId ? null : prev));
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
        {/* A write the server refused. Sits above everything and stays until
            dismissed: the edits it refers to are still only in this tab. */}
        {syncError && (
          <div
            role="alert"
            style={{ position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, maxWidth: 'min(560px, calc(100vw - 32px))', display: 'flex', alignItems: 'flex-start', gap: 10, background: '#2a1b22', border: '1px solid #f38ba8', borderRadius: 8, color: '#f38ba8', padding: '10px 12px', fontSize: 13, boxShadow: '0 4px 16px rgba(0,0,0,.4)' }}
          >
            <span style={{ flex: 1 }}>{syncError}</span>
            {canOverwriteConflict && (
              <button
                onClick={async () => {
                  setOverwriting(true);
                  await overwriteConflict();
                  setOverwriting(false);
                }}
                disabled={overwriting}
                style={{ background: 'none', border: '1px solid #f38ba8', borderRadius: 4, color: '#f38ba8', cursor: overwriting ? 'default' : 'pointer', fontSize: 12, lineHeight: 1.4, padding: '3px 8px', fontFamily: 'inherit', opacity: overwriting ? 0.6 : 1, whiteSpace: 'nowrap' }}
              >
                {overwriting ? 'Overwriting…' : 'Overwrite'}
              </button>
            )}
            <button
              onClick={() => setSyncError(null)}
              aria-label="Dismiss"
              style={{ background: 'none', border: 'none', color: '#f38ba8', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0, fontFamily: 'inherit' }}
            >
              ×
            </button>
          </div>
        )}
        {/* Top Bar */}
        <div className="topbar">
          <button className="topbar-btn" onClick={() => setSidebarOpen(v => !v)}>
            {Icons.sidebar}
          </button>
          <div className="topbar-brand">
            {/* Brand mark: three linked notes (note, agent, you) */}
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <defs>
                <linearGradient id="kbm0" gradientUnits="userSpaceOnUse" x1="5.03" y1="6.79" x2="18.97" y2="6.13">
                  <stop stopColor="#94e2d5"/>
                  <stop offset="1" stopColor="#89b4fa"/>
                </linearGradient>
                <linearGradient id="kbm1" gradientUnits="userSpaceOnUse" x1="18.97" y1="6.13" x2="11.43" y2="17.87">
                  <stop stopColor="#89b4fa"/>
                  <stop offset="1" stopColor="#f9e2af"/>
                </linearGradient>
                <linearGradient id="kbm2" gradientUnits="userSpaceOnUse" x1="11.43" y1="17.87" x2="5.03" y2="6.79">
                  <stop stopColor="#f9e2af"/>
                  <stop offset="1" stopColor="#94e2d5"/>
                </linearGradient>
              </defs>
              <path d="M4.2 8.5L4.88 8.74L5.56 8.96L6.24 9.15L6.91 9.31L7.58 9.44L8.25 9.53L8.91 9.6L9.57 9.64L10.22 9.65L10.87 9.63L11.51 9.58L12.14 9.5L12.77 9.4L13.39 9.26L14 9.1L14.6 8.91L15.2 8.7L15.79 8.45L16.37 8.19L16.95 7.89L17.51 7.57L18.07 7.23L18.63 6.86L19.18 6.47L18.76 5.79L18.18 6.06L17.6 6.3L17.02 6.51L16.45 6.69L15.88 6.85L15.31 6.98L14.75 7.08L14.2 7.16L13.65 7.21L13.11 7.23L12.57 7.23L12.04 7.21L11.51 7.16L10.98 7.08L10.46 6.99L9.94 6.87L9.43 6.72L8.91 6.56L8.4 6.37L7.89 6.16L7.38 5.92L6.88 5.66L6.37 5.38L5.86 5.08Z" fill="url(#kbm0)"/>
              <path d="M18.06 4.46L17.46 4.88L16.89 5.3L16.34 5.75L15.82 6.2L15.33 6.68L14.86 7.16L14.42 7.66L14.01 8.18L13.63 8.7L13.27 9.24L12.94 9.79L12.63 10.35L12.36 10.92L12.11 11.51L11.89 12.1L11.69 12.7L11.52 13.31L11.38 13.93L11.26 14.56L11.16 15.2L11.1 15.85L11.05 16.5L11.03 17.17L11.03 17.84L11.83 17.9L11.95 17.27L12.09 16.65L12.25 16.06L12.43 15.49L12.63 14.93L12.86 14.4L13.1 13.88L13.35 13.39L13.63 12.91L13.93 12.45L14.24 12.02L14.57 11.59L14.92 11.19L15.28 10.81L15.66 10.44L16.06 10.09L16.47 9.75L16.91 9.43L17.36 9.12L17.83 8.83L18.31 8.55L18.82 8.28L19.34 8.03L19.88 7.79Z" fill="url(#kbm1)"/>
              <path d="M13.33 17.89L13.26 17.21L13.17 16.54L13.05 15.89L12.91 15.25L12.74 14.64L12.55 14.03L12.33 13.45L12.09 12.88L11.82 12.33L11.53 11.8L11.21 11.29L10.87 10.8L10.51 10.33L10.13 9.88L9.73 9.45L9.3 9.04L8.86 8.65L8.4 8.28L7.92 7.93L7.42 7.6L6.9 7.28L6.36 6.98L5.8 6.7L5.23 6.44L4.83 7.13L5.32 7.49L5.78 7.86L6.21 8.23L6.61 8.62L6.98 9.01L7.33 9.41L7.65 9.81L7.95 10.23L8.22 10.65L8.46 11.08L8.68 11.51L8.88 11.95L9.05 12.4L9.2 12.85L9.33 13.32L9.43 13.78L9.52 14.26L9.58 14.74L9.62 15.24L9.65 15.74L9.65 16.25L9.63 16.77L9.59 17.3L9.53 17.85Z" fill="url(#kbm2)"/>
              <circle cx="18.97" cy="6.13" r="2.7" fill="#89b4fa"/>
              <circle cx="5.03" cy="6.79" r="2.7" fill="#94e2d5"/>
              <circle cx="11.43" cy="17.87" r="2.7" fill="#f9e2af"/>
            </svg>
            <span>Kybase</span>
          </div>
          <div className="topbar-sep" />
          {activeNote && <span className="topbar-note-title">{editMode ? editTitle : activeNote.title}</span>}
          <div className="topbar-sep" />
          <button className={`topbar-btn ${rightPanel === 'outline' ? 'active' : ''}`} onClick={() => { const n = rightPanel === 'outline' ? null : 'outline'; setRightPanel(n); setPanelWidth(300); }} title="Outline">{Icons.outline}</button>
          <button className={`topbar-btn ${rightPanel === 'backlinks' ? 'active' : ''}`} onClick={() => { const n = rightPanel === 'backlinks' ? null : 'backlinks'; setRightPanel(n); setPanelWidth(300); }} title="Backlinks">{Icons.link}</button>
          <button className={`topbar-btn ${rightPanel === 'graph' ? 'active' : ''}`} onClick={() => { const n = rightPanel === 'graph' ? null : 'graph'; setRightPanel(n); setGraphFullscreen(false); setPanelWidth(n === 'graph' && window.innerWidth >= 768 ? Math.min(Math.floor(window.innerWidth * 0.38), 560) : 300); }} title="Graph View">{Icons.graph}</button>
          <button className={`topbar-btn ${rightPanel === 'ai' ? 'active' : ''}`} onClick={() => { const n = rightPanel === 'ai' ? null : 'ai'; setRightPanel(n); setPanelWidth(300); }} title="AI Search">{Icons.ai}</button>
          <button className={`topbar-btn ${rightPanel === 'history' ? 'active' : ''}`} onClick={() => openHistoryPanel('history')} title="History">{Icons.history}</button>
          <button className={`topbar-btn ${rightPanel === 'changes' ? 'active' : ''}`} onClick={() => openHistoryPanel('changes')} title="Changes">{Icons.changes}</button>
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
            moveFolder={moveFolder}
            pdfImporting={pdfImporting}
            importPdfFile={importPdfFile}
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
              loadText={loadText}
              reindexingNoteId={reindexingNoteId}
              reindexNote={reindexNote}
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
              editMode={editMode}
              setEditMode={setEditMode}
              editContent={editContent}
              historyPick={historyPick}
              setHistoryPick={setHistoryPick}
              revertNote={revertNote}
              refreshNote={refreshNote}
              changesActor={changesActor}
              setChangesActor={setChangesActor}
              openChange={openChange}
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
                onClick={() => activeNoteId && revokeShareLink(activeNoteId, shareInfo.id)}
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
          reloadNotes={reloadNotes}
          onShareRevoked={id => setShareInfo(prev => (prev?.id === id ? null : prev))}
        />
      )}

      {/* Wikilink hover preview tooltip */}
      {wikilinkPreview && previewNote && (
        <div style={{ position: 'fixed', left: Math.min(wikilinkPreview.x, window.innerWidth - 300), top: wikilinkPreview.y, zIndex: 300, background: 'rgba(30,30,46,0.65)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '10px 14px', maxWidth: 280, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', pointerEvents: 'none', fontFamily: "'DM Sans', sans-serif" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#89b4fa', marginBottom: 6 }}>{previewNote.title}</div>
          <div style={{ fontSize: 12, color: '#a6adc8', lineHeight: 1.55 }}>{previewExcerpt === null ? 'Loading…' : previewExcerpt || 'No content'}</div>
        </div>
      )}
    </>
  );
}
