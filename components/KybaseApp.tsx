'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Note, Folder, SearchHit } from '@/lib/types';
import { parseMarkdown, renderWithWikilinks } from '@/lib/markdown';
import { Icons } from './Icons';
import MiniGraph, { type GraphData } from './MiniGraph';
import SettingsModal from './SettingsModal';
import Sidebar from './Sidebar';

const TOKEN_KEY = 'kybase_token';
const FOCUS_KEY = 'kybase_focus_folder';

// ─── API helper ──────────────────────────────────────────────────────────────
function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) ?? '' : '';
  return fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

// Markdown rendering lives in lib/markdown.ts (shared with the public
// share page); its XSS coverage is in lib/markdown.test.ts.

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function KybaseApp() {
  const [notes, setNotes]             = useState<Note[]>([]);
  const [folders, setFolders]         = useState<Folder[]>([]);
  const [loading, setLoading]         = useState(true);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [editMode, setEditMode]       = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editTitle, setEditTitle]     = useState('');
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

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Expand a note's ancestor folders so it is visible in the tree. Called
  // from the actions that change the active note (not an effect), so the
  // user can still collapse folders afterwards.
  const expandAncestors = useCallback((folderId: string | null | undefined, folderList: Folder[]) => {
    if (!folderId) return;
    const parents = new Set<string>();
    let cur: string | null = folderId;
    while (cur) {
      if (parents.has(cur)) break; // Failsafe guard against DB folder cycles
      parents.add(cur);
      const f: Folder | undefined = folderList.find(f => f.id === cur);
      cur = f?.parent_id ?? null;
    }
    setExpandedFolders(prev => {
      if (Array.from(parents).every(id => prev.has(id))) return prev;
      const next = new Set(prev);
      parents.forEach(id => next.add(id));
      return next;
    });
  }, []);

  // Scroll sidebar to active note after folders have expanded
  useEffect(() => {
    if (!activeNoteId) return;
    const timer = setTimeout(() => {
      document.querySelector('.tree-item.note-item.active')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 150);
    return () => clearTimeout(timer);
  }, [activeNoteId]);

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
  // preference — lives in localStorage, never sent to the server or MCP.
  const [focusFolderId, setFocusFolderId] = useState<string | null>(null);
  const switchFocus = (id: string | null) => {
    setFocusFolderId(id);
    if (id) localStorage.setItem(FOCUS_KEY, id);
    else localStorage.removeItem(FOCUS_KEY);
  };

  const saveTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef        = useRef<HTMLTextAreaElement>(null);
  const wikilinkStartRef = useRef<number>(-1);

  // ── Initial data load ───────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      apiFetch('/api/notes').then(r => r.json()),
      apiFetch('/api/folders').then(r => r.json()),
    ]).then(([notesData, foldersData]: [Note[], Folder[]]) => {
      setNotes(notesData);
      setFolders(foldersData);
      const savedFocus = localStorage.getItem(FOCUS_KEY);
      if (savedFocus && foldersData.some(f => f.id === savedFocus && f.parent_id === null)) {
        setFocusFolderId(savedFocus);
      } else if (savedFocus) {
        localStorage.removeItem(FOCUS_KEY);
      }
      if (notesData.length > 0) {
        const first = notesData[0];
        setActiveNoteId(first.id);
        setEditContent(first.content);
        setEditTitle(first.title);
        expandAncestors(first.folder_id, foldersData);
      }
    }).finally(() => setLoading(false));
  }, [expandAncestors]);

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
  const activeNote = useMemo(() => notes.find(n => n.id === activeNoteId) ?? null, [notes, activeNoteId]);
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
    const edgesList: GraphData['edges'] = [];
    visibleNotes.forEach(note => {
      const matches = note.content.match(/\[\[([^\]]+)\]\]/g) ?? [];
      matches.forEach(m => {
        const target = m.slice(2, -2).split(/[|#]/)[0].trim();
        const targetNote = visibleNotes.find(n => n.title.toLowerCase() === target.toLowerCase());
        if (targetNote && targetNote.id !== note.id) {
          edgesList.push({ from: note.id, to: targetNote.id });
        }
      });
    });
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

  // ── Auto-save debounce (800ms) ───────────────────────────────────────────────
  useEffect(() => {
    if (!editMode || !activeNoteId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      await apiFetch(`/api/notes/${activeNoteId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: editTitle, content: editContent }),
      });
      setNotes(prev => prev.map(n =>
        n.id === activeNoteId
          ? { ...n, title: editTitle, content: editContent, updated_at: new Date().toISOString() }
          : n
      ));
    }, 800);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTitle, editContent]);

  // ── Actions ──────────────────────────────────────────────────────────────────
  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (editMode && activeNoteId) {
      await apiFetch(`/api/notes/${activeNoteId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: editTitle, content: editContent }),
      });
      setNotes(prev => prev.map(n =>
        n.id === activeNoteId
          ? { ...n, title: editTitle, content: editContent, updated_at: new Date().toISOString() }
          : n
      ));
    }
  }, [editMode, activeNoteId, editTitle, editContent]);

  const selectNote = useCallback(async (id: string) => {
    await flushSave();
    const note = notes.find(n => n.id === id);
    if (note) {
      setEditContent(note.content);
      setEditTitle(note.title);
      expandAncestors(note.folder_id, folders);
    }
    setActiveNoteId(id);
    setEditMode(false);
    setShareInfo(null); // the popover belongs to the note it was created for
    // Close sidebar on mobile after selecting a note
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  }, [flushSave, notes, folders, expandAncestors]);

  // ── Wikilink click handler ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = async (e: MouseEvent) => {
      const wl = (e.target as HTMLElement).closest('.wikilink') as HTMLElement | null;
      if (!wl) return;
      const title = wl.dataset.title ?? '';
      const target = notes.find(n => n.title.toLowerCase() === title.toLowerCase());
      if (target) {
        selectNote(target.id);
      } else {
        const res = await apiFetch('/api/notes', {
          method: 'POST',
          body: JSON.stringify({ title, content: `# ${title}\n\n`, tags: [] }),
        });
        if (res.ok) {
          const newNote: Note = await res.json();
          setNotes(prev => [...prev, newNote]);
          setActiveNoteId(newNote.id);
          setEditMode(true);
          setEditContent(newNote.content);
          setEditTitle(newNote.title);
        }
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [notes, selectNote]);

  const saveNote = useCallback(async () => {
    if (!activeNote) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    await apiFetch(`/api/notes/${activeNote.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: editTitle, content: editContent }),
    });
    setNotes(prev => prev.map(n =>
      n.id === activeNote.id
        ? { ...n, title: editTitle, content: editContent, updated_at: new Date().toISOString() }
        : n
    ));
    setEditMode(false);
  }, [activeNote, editTitle, editContent]);

  // ── Tags ───────────────────────────────────────────────────────────────────
  // Optimistic local update + PATCH. Tags don't change embeddings, so the
  // server skips re-indexing (only title/content do).
  const saveTags = useCallback(async (tags: string[]) => {
    if (!activeNote) return;
    const id = activeNote.id;
    setNotes(prev => prev.map(n => (n.id === id ? { ...n, tags } : n)));
    await apiFetch(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ tags }) });
  }, [activeNote]);

  const addTag = useCallback((raw: string) => {
    if (!activeNote) return;
    const t = raw.replace(/^#+/, '').trim().toLowerCase();
    setNewTag('');
    if (!t || activeNote.tags.includes(t)) return;
    saveTags([...activeNote.tags, t]);
  }, [activeNote, saveTags]);

  const removeTag = useCallback((tag: string) => {
    if (!activeNote) return;
    saveTags(activeNote.tags.filter(t => t !== tag));
  }, [activeNote, saveTags]);

  const filterByTag = useCallback((tag: string) => {
    setTagFilter(tag);
    setSearchQuery('');
    setRightPanel(null);
    if (typeof window !== 'undefined' && window.innerWidth < 768) setSidebarOpen(true);
  }, []);

  const createNote = useCallback(async (folderId: string | null = null) => {
    const res = await apiFetch('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title: 'Untitled', content: '# Untitled\n\nStart writing...', folder_id: folderId, tags: [] }),
    });
    if (!res.ok) return;
    const newNote: Note = await res.json();
    setNotes(prev => [...prev, newNote]);
    setActiveNoteId(newNote.id);
    setEditMode(true);
    setEditContent(newNote.content);
    setEditTitle(newNote.title);
  }, []);

  const createFolder = useCallback(async (parentId: string | null = null) => {
    const name = prompt('Folder name:');
    if (!name) return;
    const res = await apiFetch('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name, parent_id: parentId }),
    });
    if (!res.ok) return;
    const newFolder: Folder = await res.json();
    setFolders(prev => [...prev, newFolder]);
    setExpandedFolders(prev => new Set([...prev, newFolder.id]));
  }, []);

  const deleteFolder = useCallback(async (id: string) => {
    if (!confirm('Delete folder and all its contents?')) return;
    await apiFetch(`/api/folders/${id}`, { method: 'DELETE' });
    setFolders(prev => prev.filter(f => f.id !== id));
    // Remove notes that were in this folder from local state
    setNotes(prev => {
      const removed = prev.filter(n => n.folder_id === id);
      const next = prev.filter(n => n.folder_id !== id);
      if (removed.some(n => n.id === activeNoteId)) {
        const nextNote = next[0] ?? null;
        setActiveNoteId(nextNote?.id ?? null);
        if (nextNote) { setEditContent(nextNote.content); setEditTitle(nextNote.title); }
      }
      return next;
    });
  }, [activeNoteId]);

  const renameFolder = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) { setRenamingFolderId(null); return; }
    const res = await apiFetch(`/api/folders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.ok) {
      setFolders(prev => prev.map(f => f.id === id ? { ...f, name: trimmed } : f));
    }
    setRenamingFolderId(null);
  }, []);

  const deleteNote = useCallback(async (id: string) => {
    await apiFetch(`/api/notes/${id}`, { method: 'DELETE' });
    setNotes(prev => {
      const next = prev.filter(n => n.id !== id);
      if (activeNoteId === id) {
        const nextNote = next[0] ?? null;
        setActiveNoteId(nextNote?.id ?? null);
        if (nextNote) { setEditContent(nextNote.content); setEditTitle(nextNote.title); }
      }
      return next;
    });
  }, [activeNoteId]);

  const moveNote = useCallback(async (folderId: string | null) => {
    if (!activeNoteId) return;
    await apiFetch(`/api/notes/${activeNoteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ folder_id: folderId }),
    });
    setNotes(prev => prev.map(n =>
      n.id === activeNoteId ? { ...n, folder_id: folderId } : n
    ));
    setMovingNote(false);
  }, [activeNoteId]);

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
  }, [editContent]);

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

  const toggleFolder = (id: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Folder tree renderer ─────────────────────────────────────────────────────

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

          {/* Right Panel */}
          {rightPanel && (
            <div
              className={`right-panel${rightPanel === 'graph' && graphFullscreen ? ' graph-fullscreen' : ''}`}
              style={{ width: panelWidth }}
            >
              <div className="drawer-handle" />
              <div
                className="panel-resize-handle"
                onMouseDown={e => { e.preventDefault(); panelResizeRef.current = { active: true, startX: e.clientX, startW: panelWidth }; }}
              />
              {rightPanel === 'backlinks' && (
                <>
                  <div className="right-panel-header">Backlinks ({backlinks.length})</div>
                  <div className="right-panel-body">
                    {backlinks.length === 0 ? (
                      <div style={{ color: '#585b70', fontSize: 13, textAlign: 'center', padding: 24 }}>No backlinks found</div>
                    ) : backlinks.map(bl => {
                      const lines     = bl.content.split('\n');
                      const matchLine = activeNote ? lines.find(l => l.toLowerCase().includes(`[[${activeNote.title.toLowerCase()}]]`)) : null;
                      return (
                        <div key={bl.id} className="backlink-item" onClick={() => selectNote(bl.id)}>
                          <div className="backlink-title">{bl.title}</div>
                          <div className="backlink-excerpt">{matchLine ?? lines.slice(0, 3).join(' ')}</div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {rightPanel === 'graph' && (() => {
                const isMobile = winSize.w < 768;
                const cw = isMobile ? winSize.w : panelWidth;
                const topbar = 48, panelHeader = 40;
                const ch = graphFullscreen
                  ? winSize.h - topbar - panelHeader
                  : isMobile
                    ? Math.floor(winSize.h * 0.55) - panelHeader
                    : winSize.h - topbar - panelHeader;
                return (
                  <>
                    <div className="right-panel-header" style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 8 }}>
                      <span>Graph View</span>
                      <span style={{ fontSize: 11, color: '#45475a', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                        {graphData.nodes.length} · {graphData.edges.length}
                      </span>
                      <div style={{ flex: 1 }} />
                      <button
                        onClick={() => graphFitRef.current?.()}
                        title="Zoom to fit"
                        style={{ background: 'none', border: 'none', color: '#585b70', cursor: 'pointer', padding: '2px 6px', fontSize: 13, lineHeight: 1 }}
                      >⊞</button>
                      <button
                        onClick={() => setGraphFullscreen(v => !v)}
                        title={graphFullscreen ? 'Collapse' : 'Fullscreen'}
                        style={{ background: 'none', border: 'none', color: '#585b70', cursor: 'pointer', padding: '2px 4px', fontSize: 14, lineHeight: 1 }}
                      >
                        {graphFullscreen ? '⊡' : '⛶'}
                      </button>
                    </div>
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <MiniGraph
                        graphData={graphData}
                        activeNoteId={activeNoteId}
                        onSelectNote={id => {
                          if (id.startsWith('f:')) {
                            const fid = id.slice(2);
                            setExpandedFolders(prev => { const n = new Set(prev); if (n.has(fid)) n.delete(fid); else n.add(fid); return n; });
                            if (winSize.w < 768) setSidebarOpen(true);
                          } else {
                            selectNote(id);
                            if (winSize.w < 768) setRightPanel(null);
                          }
                        }}
                        w={cw}
                        h={ch}
                        fitRef={graphFitRef}
                      />
                    </div>
                  </>
                );
              })()}

              {rightPanel === 'ai' && (
                <>
                  <div className="right-panel-header">AI Search</div>
                  <div className="ai-search-bar">
                    <div className="ai-input-row">
                      <input
                        type="text"
                        placeholder="Ask your knowledge base..."
                        value={aiQuery}
                        onChange={e => setAiQuery(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleAiSearch()}
                      />
                      <button onClick={handleAiSearch} disabled={aiLoading}>{Icons.ai}</button>
                    </div>
                  </div>
                  <div className="right-panel-body">
                    {aiLoading && (
                      <div className="ai-loading"><div className="ai-spinner" />Searching…</div>
                    )}
                    {aiResults && !aiLoading && (
                      aiResults.length === 0 ? (
                        <div style={{ color: '#585b70', fontSize: 13, textAlign: 'center', padding: 24 }}>No matches found</div>
                      ) : aiResults.map(note => (
                        <div key={note.id} className="ai-result-item" onClick={() => selectNote(note.id)}>
                          <div className="ai-result-title">{note.title}</div>
                          {note.excerpt && <div className="ai-result-excerpt">{note.excerpt}</div>}
                          <div className="ai-result-tags">
                            {note.tags.map(t => (
                              <span key={t} onClick={e => { e.stopPropagation(); filterByTag(t); }} style={{ cursor: 'pointer' }} title={`Filter by #${t}`}>#{t}</span>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                    {!aiResults && !aiLoading && (
                      <div style={{ color: '#585b70', fontSize: 12, padding: 12, lineHeight: 1.6 }}>
                        Hybrid semantic + full-text search powered by pgvector and RRF ranking.
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
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
