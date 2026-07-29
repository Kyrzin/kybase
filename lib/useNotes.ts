'use client';

// lib/useNotes.ts — the data layer extracted from KybaseApp: notes/folders
// loading, the editor buffer (activeNoteId + editMode/editTitle/editContent),
// folder expansion, autosave, and every CRUD action. Pure data + its
// mutations live here; UI reactions that a data action must trigger (closing
// the mobile sidebar, dismissing the share popover, clearing transient
// toolbar state, restoring the persisted focus) are passed in as callbacks so
// this hook owns no view state.
import { useState, useEffect, useCallback, useRef } from 'react';
import type { Note, Folder } from './types';

// Auth is a session cookie (httpOnly, set by /api/auth/check) that the
// browser attaches to same-origin requests on its own — nothing to read
// or forward here.
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

/** Smallest free "Untitled"/"Untitled N" name given lower-cased titles already in use. */
export function nextUntitledTitle(takenLowercase: Set<string>): string {
  if (!takenLowercase.has('untitled')) return 'Untitled';
  let n = 2;
  while (takenLowercase.has(`untitled ${n}`)) n++;
  return `Untitled ${n}`;
}

export type UseNotesCallbacks = {
  onNoteOpened: () => void;                 // selectNote: close mobile sidebar + reset share popover
  onMoveDone: () => void;                   // moveNote finished
  onRenameDone: () => void;                 // renameFolder finished
  onTagInputConsumed: () => void;           // addTag cleared the input
  restoreFocus: (folders: Folder[]) => void; // reapply persisted workspace focus after load
};

export function useNotes(cb: UseNotesCallbacks) {
  const [notes, setNotes]             = useState<Note[]>([]);
  const [folders, setFolders]         = useState<Folder[]>([]);
  const [loading, setLoading]         = useState(true);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [editMode, setEditMode]       = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editTitle, setEditTitle]     = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeNote = notes.find(n => n.id === activeNoteId) ?? null;

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

  const toggleFolder = useCallback((id: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const { restoreFocus } = cb;
  // ── Initial data load ───────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      apiFetch('/api/notes').then(r => r.json()),
      apiFetch('/api/folders').then(r => r.json()),
    ]).then(([notesData, foldersData]: [Note[], Folder[]]) => {
      setNotes(notesData);
      setFolders(foldersData);
      restoreFocus(foldersData);
      if (notesData.length > 0) {
        const first = notesData[0];
        setActiveNoteId(first.id);
        setEditContent(first.content);
        setEditTitle(first.title);
        expandAncestors(first.folder_id, foldersData);
      }
    }).finally(() => setLoading(false));
  }, [expandAncestors, restoreFocus]);

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

  const { onNoteOpened } = cb;
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
    onNoteOpened(); // close sidebar on mobile + dismiss the share popover
  }, [flushSave, notes, folders, expandAncestors, onNoteOpened]);

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

  const { onTagInputConsumed } = cb;
  const addTag = useCallback((raw: string) => {
    if (!activeNote) return;
    const t = raw.replace(/^#+/, '').trim().toLowerCase();
    onTagInputConsumed();
    if (!t || activeNote.tags.includes(t)) return;
    saveTags([...activeNote.tags, t]);
  }, [activeNote, saveTags, onTagInputConsumed]);

  const removeTag = useCallback((tag: string) => {
    if (!activeNote) return;
    saveTags(activeNote.tags.filter(t => t !== tag));
  }, [activeNote, saveTags]);

  const createNote = useCallback(async (folderId: string | null = null) => {
    // notes.title has a global case-insensitive unique index (migration 006):
    // a second click always collided with the first "Untitled" note and 409'd
    // forever. Scan for the smallest free "Untitled"/"Untitled N" slot.
    const taken = new Set(notes.map(n => n.title.toLowerCase()));
    let res: Response | undefined;
    let title = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      title = nextUntitledTitle(taken);
      res = await apiFetch('/api/notes', {
        method: 'POST',
        body: JSON.stringify({ title, content: `# ${title}\n\nStart writing...`, folder_id: folderId, tags: [] }),
      });
      if (res.status !== 409) break;
      taken.add(title.toLowerCase()); // another tab/client claimed it between our snapshot and the insert — retry
    }
    if (!res || !res.ok) return;
    const newNote: Note = await res.json();
    setNotes(prev => [...prev, newNote]);
    setActiveNoteId(newNote.id);
    setEditMode(true);
    setEditContent(newNote.content);
    setEditTitle(newNote.title);
  }, [notes]);

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

  const { onRenameDone } = cb;
  const renameFolder = useCallback(async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) { onRenameDone(); return; }
    const res = await apiFetch(`/api/folders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.ok) {
      setFolders(prev => prev.map(f => f.id === id ? { ...f, name: trimmed } : f));
    }
    onRenameDone();
  }, [onRenameDone]);

  const deleteNote = useCallback(async (id: string) => {
    if (!confirm('Delete this note?')) return;
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

  const { onMoveDone } = cb;
  const moveNote = useCallback(async (folderId: string | null) => {
    if (!activeNoteId) return;
    await apiFetch(`/api/notes/${activeNoteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ folder_id: folderId }),
    });
    setNotes(prev => prev.map(n =>
      n.id === activeNoteId ? { ...n, folder_id: folderId } : n
    ));
    onMoveDone();
  }, [activeNoteId, onMoveDone]);

  // Re-parent a folder. The Sidebar already hides the folder's own subtree
  // from the target picker, so a 400 (server's cycle guard) is a fallback,
  // not the expected path — on it we leave state untouched and return a
  // message for the caller to show. Returns null on success.
  const moveFolder = useCallback(async (id: string, parentId: string | null): Promise<string | null> => {
    const res = await apiFetch(`/api/folders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ parent_id: parentId }),
    });
    if (!res.ok) {
      return res.status === 400
        ? "Can't move a folder into itself or one of its subfolders"
        : 'Move failed';
    }
    setFolders(prev => prev.map(f => (f.id === id ? { ...f, parent_id: parentId } : f)));
    // Reveal the folder in its new home (expandAncestors includes parentId itself).
    if (parentId) expandAncestors(parentId, folders);
    return null;
  }, [folders, expandAncestors]);

  return {
    notes, setNotes, folders, setFolders, loading, activeNote, activeNoteId, setActiveNoteId,
    editMode, setEditMode, editContent, setEditContent, editTitle, setEditTitle,
    expandedFolders, toggleFolder, expandAncestors,
    flushSave, selectNote, saveNote, saveTags, addTag, removeTag,
    createNote, createFolder, deleteFolder, renameFolder, deleteNote, moveNote, moveFolder,
  };
}
