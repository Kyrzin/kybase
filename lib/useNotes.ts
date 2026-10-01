'use client';

// lib/useNotes.ts — the data layer extracted from KybaseApp: notes/folders
// loading, the editor buffer (activeNoteId + editMode/editTitle/editContent),
// folder expansion, autosave, and every CRUD action. Pure data + its
// mutations live here; UI reactions that a data action must trigger (closing
// the mobile sidebar, dismissing the share popover, clearing transient
// toolbar state, restoring the persisted focus) are passed in as callbacks so
// this hook owns no view state.
import { useState, useEffect, useCallback, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { Note, Folder, ListedNote, NoteSummary } from './types';
import { apiFetch } from './api-client';

/** Smallest free "Untitled"/"Untitled N" name given lower-cased titles already in use. */
export function nextUntitledTitle(takenLowercase: Set<string>): string {
  if (!takenLowercase.has('untitled')) return 'Untitled';
  let n = 2;
  while (takenLowercase.has(`untitled ${n}`)) n++;
  return `Untitled ${n}`;
}

// Held text survives only an unchanged updated_at; newer held copies and the open note stay.
function mergeListed(held: ListedNote | undefined, listed: NoteSummary, openId: string | null): ListedNote {
  if (!held) return { ...listed, content: null };
  if (held.id === openId && held.content !== null) return held;
  const heldAt = Date.parse(held.updated_at), listedAt = Date.parse(listed.updated_at);
  if (heldAt > listedAt) return held;
  const content = heldAt === listedAt ? held.content : null;
  const same = content === held.content && held.updated_at === listed.updated_at
    && held.title === listed.title && held.folder_id === listed.folder_id
    && held.embedding_pending === listed.embedding_pending
    && held.tags.length === listed.tags.length && held.tags.every((t, i) => t === listed.tags[i]);
  return same ? held : { ...listed, content };
}

export type UseNotesCallbacks = {
  onNoteOpened: () => void;                 // selectNote: close mobile sidebar + reset share popover
  onMoveDone: () => void;                   // moveNote finished
  onRenameDone: () => void;                 // renameFolder finished
  onTagInputConsumed: () => void;           // addTag cleared the input
  restoreFocus: (folders: Folder[]) => void; // reapply persisted workspace focus after load
};

/** How revertNote ended; 'unsaved' means pending typing could not be saved first. */
export type RevertResult = 'restored' | 'unsaved' | 'conflict' | 'title_taken' | 'failed';

export function useNotes(cb: UseNotesCallbacks) {
  const [notes, setNotes]             = useState<ListedNote[]>([]);
  const [folders, setFolders]         = useState<Folder[]>([]);
  const [loading, setLoading]         = useState(true);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [editMode, setEditMode]       = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editTitle, setEditTitle]     = useState('');
  // Which note's text the edit buffer was filled with.
  const [bufferNoteId, setBufferNoteId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [syncError, setSyncError] = useState<string | null>(null);
  // Set alongside syncError only for a genuine 409 (not a network error, not
  // a self-healed race) — carries what the overwrite button needs to retry
  // the save as a deliberate act: which note, and the server's current
  // updated_at to satisfy the guard with (the stale one that just got
  // refused won't).
  const [conflict, setConflict] = useState<{ id: string; freshUpdatedAt: string } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Content saves awaiting an answer, keepalive included.
  const savesInFlightRef = useRef(0);

  const activeNote = notes.find(n => n.id === activeNoteId) ?? null;

  // Filled from the rendered note once its text is held; earlier typing is dropped.
  if (activeNote && activeNote.content !== null && bufferNoteId !== activeNote.id) {
    setBufferNoteId(activeNote.id);
    setEditTitle(activeNote.title);
    setEditContent(activeNote.content);
  }

  // Lets saveActiveNote/flushOnHide read the current notes array from inside
  // a stable callback (deps: [send], itself stable) instead of depending on
  // `notes` directly — keeping those callbacks' identity constant across
  // note-list churn (tag edits, moves, other tabs) so effects built on them
  // don't reset unrelated timers every time something elsewhere changes.
  const notesRef = useRef(notes);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  type SendResult<T> = { ok: true; data: T } | { ok: false; status: number | null };

  /**
   * Every write here used to treat "request sent" as "server agreed": the
   * local state updated regardless of the reply. A note trashed in another
   * tab or by the agent answers 404, and the editor went on showing edits as
   * saved that never reached the database. Callers now only commit to local
   * state when this reports ok, and the failure reaches the screen.
   *
   * Returns the parsed body on success (not just a boolean) — callers that
   * write updated_at into local state need the server's value, not a client
   * clock guess: a locally-fabricated timestamp would never match what the
   * database actually stored, and comparing against it (see saveActiveNote's
   * expected_updated_at) would reject every second save.
   */
  const send = useCallback(async <T = unknown>(
    path: string, init: RequestInit, whatFailed: string
  ): Promise<SendResult<T>> => {
    try {
      const res = await apiFetch(path, init);
      if (res.ok) {
        setSyncError(null);
        const data = res.status === 204 ? ({} as T) : (await res.json() as T);
        return { ok: true, data };
      }
      const body = await res.json().catch(() => ({}));
      const detail = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      setSyncError(`${whatFailed}: ${detail}`);
      return { ok: false, status: res.status };
    } catch {
      setSyncError(`${whatFailed}: no connection to the server`);
      return { ok: false, status: null };
    }
  }, []);

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

  const openNote = useCallback((id: string | null) => {
    setActiveNoteId(id);
    setBufferNoteId(null);
    setEditTitle('');
    setEditContent('');
  }, []);

  const { restoreFocus } = cb;
  // ── Initial data load ───────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      apiFetch('/api/notes?content=false').then(r => r.json()),
      apiFetch('/api/folders').then(r => r.json()),
    ]).then(([notesData, foldersData]: [NoteSummary[], Folder[]]) => {
      setNotes(notesData.map(n => ({ ...n, content: null })));
      setFolders(foldersData);
      restoreFocus(foldersData);
      if (notesData.length > 0) {
        const first = notesData[0];
        openNote(first.id);
        expandAncestors(first.folder_id, foldersData);
      }
    }).finally(() => setLoading(false));
  }, [expandAncestors, restoreFocus, openNote]);

  /**
   * Shared PATCH path for the three call sites that write {title, content}:
   * the debounce timer, flushSave, and saveNote. Carries expected_updated_at
   * (the note's last known updated_at) so a concurrent write — an agent's
   * append_to_note, another tab — gets a 409 instead of being silently
   * overwritten by a stale autosave.
   *
   * A 409 isn't automatically a real conflict: the most common cause is our
   * own previous PATCH landing after this one raced ahead of it (retry,
   * double-fire). Re-reading the note and accepting the new updated_at when
   * its content already matches what we tried to write avoids flashing a
   * conflict banner on every second save — only a genuine mismatch surfaces
   * as syncError, and the in-progress edit buffer is never touched either way
   * so nothing typed is lost while the user decides what to do.
   *
   * Resolves to the note's updated_at once saved, null when it was not. A
   * caller that writes next needs it at once: the new value reaches
   * notesRef only after a render.
   *
   * A save that would change nothing is not sent: it could only raise a false conflict.
   */
  const saveActiveNote = useCallback(async (
    id: string, title: string, content: string, expected_updated_at?: string
  ): Promise<string | null> => {
    const held = notesRef.current.find(n => n.id === id);
    // No text loaded means the buffer is not this note's: never save it.
    if (!held || held.content === null) return null;
    if (held.title === title && held.content === content
      && savesInFlightRef.current === 0 && expected_updated_at === undefined) return held.updated_at;
    savesInFlightRef.current++;
    try {
      const guardAt = expected_updated_at ?? held.updated_at;
      const result = await send<{ updated_at: string }>(
        `/api/notes/${id}`,
        { method: 'PATCH', body: JSON.stringify({ title, content, expected_updated_at: guardAt }) },
        'Not saved'
      );
      if (result.ok) {
        setConflict(null);
        setNotes(prev => prev.map(n =>
          n.id === id ? { ...n, title, content, updated_at: result.data.updated_at } : n
        ));
        return result.data.updated_at;
      }
      if (result.status === 409) {
        const fresh: { title: string; content: string; updated_at: string } | null = await apiFetch(`/api/notes/${id}`)
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null);
        // The server trims title (zod .trim()) before storing it, so a title
        // sent with incidental leading/trailing whitespace never equals what
        // comes back — comparing against the same trimmed form the server
        // would have produced, not the raw local value.
        if (fresh && fresh.title === title.trim() && fresh.content === content) {
          setSyncError(null);
          setConflict(null);
          setNotes(prev => prev.map(n =>
            n.id === id ? { ...n, title, content, updated_at: fresh.updated_at } : n
          ));
          return fresh.updated_at;
        }
        // History folds same-writer bursts, so only an agent's version is sure to survive.
        setSyncError('Note changed elsewhere since you opened it — your edits are kept here but not saved. Overwrite to keep your version, or reload to see the latest. An agent\'s change stays in History.');
        // fresh may be null (the re-read itself failed, e.g. offline) — no
        // updated_at to retry with yet, so overwrite stays unavailable until
        // a save attempt manages to read one.
        setConflict(fresh ? { id, freshUpdatedAt: fresh.updated_at } : null);
        return null;
      }
      return null;
    } finally {
      savesInFlightRef.current--;
    }
  }, [send]);

  /** Retry the in-progress edit as a deliberate overwrite, using the conflicting save's fresh updated_at as the guard. */
  const overwriteConflict = useCallback(async (): Promise<boolean> => {
    if (!conflict || conflict.id !== activeNoteId) return false;
    return (await saveActiveNote(activeNoteId, editTitle, editContent, conflict.freshUpdatedAt)) !== null;
  }, [conflict, activeNoteId, editTitle, editContent, saveActiveNote]);

  // ── Auto-save debounce (800ms) ───────────────────────────────────────────────
  useEffect(() => {
    if (!editMode || !activeNoteId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const id = activeNoteId, title = editTitle, content = editContent;
    // Nothing to send while the buffer matches the note, as on entering edit mode.
    const held = notesRef.current.find(n => n.id === id);
    if (held && held.title === title && held.content === content && savesInFlightRef.current === 0) return;
    // Cleared right as the timer fires (before the save even starts), so
    // saveTimerRef.current stays a precise "an edit is waiting to be sent"
    // flag — flushOnHide below relies on exactly that to know whether a
    // keepalive PATCH is worth attempting.
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      saveActiveNote(id, title, content);
    }, 800);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [editTitle, editContent, editMode, activeNoteId, saveActiveNote]);

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (editMode && activeNoteId) {
      await saveActiveNote(activeNoteId, editTitle, editContent);
    }
  }, [editMode, activeNoteId, editTitle, editContent, saveActiveNote]);

  // Latest edit state for listeners and async callbacks.
  const editStateRef = useRef({ editMode, activeNoteId, editTitle, editContent });
  useEffect(() => {
    editStateRef.current = { editMode, activeNoteId, editTitle, editContent };
  }, [editMode, activeNoteId, editTitle, editContent]);

  // ── A note's text ────────────────────────────────────────────────────────────
  // In-flight text requests, shared by concurrent callers.
  const textRequestsRef = useRef(new Map<string, Promise<string | null>>());

  // Fetched once; a copy that arrived another way meanwhile wins.
  const loadText = useCallback(async (id: string, whatFailed?: string): Promise<void> => {
    let request = textRequestsRef.current.get(id);
    if (!request) {
      request = (async () => {
        try {
          const res = await apiFetch(`/api/notes/${id}`);
          if (res.ok) {
            const note: Note = await res.json();
            setNotes(prev => {
              const held = prev.find(n => n.id === id);
              if (!held) return [...prev, note];
              return held.content === null ? prev.map(n => (n.id === id ? note : n)) : prev;
            });
            return null;
          }
          if (res.status === 404) {
            setNotes(prev => (prev.some(n => n.id === id && n.content === null) ? prev.filter(n => n.id !== id) : prev));
          }
          const body = await res.json().catch(() => ({}));
          return typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
        } catch {
          return 'no connection to the server';
        }
      })();
      textRequestsRef.current.set(id, request);
      void request.then(() => textRequestsRef.current.delete(id));
    }
    const failed = await request;
    if (failed && whatFailed) setSyncError(`${whatFailed}: ${failed}`);
  }, []);

  const textWanted = activeNoteId !== null && activeNote?.content == null ? activeNoteId : null;
  useEffect(() => {
    if (textWanted) loadText(textWanted, 'Not opened');
  }, [textWanted, loadText]);

  // ── The server's copy of a note ──────────────────────────────────────────────
  // Replaces the held copy; the buffer follows only if it is as last rendered.
  const applyNote = useCallback((note: Note) => {
    setNotes(prev => (prev.some(n => n.id === note.id)
      ? prev.map(n => (n.id === note.id ? note : n))
      : [...prev, note]));
    const { activeNoteId, editTitle, editContent } = editStateRef.current;
    if (activeNoteId === note.id) {
      setEditTitle(t => (t === editTitle ? note.title : t));
      setEditContent(c => (c === editContent ? note.content : c));
    }
  }, []);

  // Re-read one note: taken only if newer, and for the open note only without
  // unsaved edits or saves in flight (the save conflict check handles those).
  const refreshNote = useCallback(async (id: string) => {
    if (notesRef.current.find(n => n.id === id)?.content === null) return loadText(id, 'Not opened');
    const fresh: Note | null = await apiFetch(`/api/notes/${id}`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!fresh) return;
    const held = notesRef.current.find(n => n.id === id);
    if (held && Date.parse(fresh.updated_at) <= Date.parse(held.updated_at)) return;
    const { activeNoteId, editTitle, editContent } = editStateRef.current;
    if (activeNoteId === id && (savesInFlightRef.current > 0
      || !held || held.title !== editTitle || held.content !== editContent)) return;
    // flushSync: no keystroke may land between this check and the render.
    flushSync(() => applyNote(fresh));
  }, [applyNote, loadText]);

  // ── Reloading the notes list ─────────────────────────────────────────────────
  const foldersRef = useRef(folders);
  useEffect(() => { foldersRef.current = folders; }, [folders]);
  const reloadSeqRef = useRef(0);

  // The open note is left to refreshNote; a reply older than local changes is dropped.
  const reloadNotes = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    const idsAsked = new Set(notesRef.current.map(n => n.id));
    const foldersAsked = foldersRef.current;
    const answer: [NoteSummary[] | null, Folder[] | null] | null = await Promise.all([
      apiFetch('/api/notes?content=false').then(r => (r.ok ? r.json() : null)),
      apiFetch('/api/folders').then(r => (r.ok ? r.json() : null)),
    ]).catch(() => null);
    if (seq !== reloadSeqRef.current || !answer) return;
    const [list, folderList] = answer;
    if (!Array.isArray(list) || !Array.isArray(folderList)) return;
    const openId = editStateRef.current.activeNoteId;
    setNotes(prev => {
      if (prev.length !== idsAsked.size || prev.some(n => !idsAsked.has(n.id))) return prev;
      const held = new Map(prev.map(n => [n.id, n]));
      const next = list.map(listed => mergeListed(held.get(listed.id), listed, openId));
      // Kept even if gone on the server: it may hold typing, and its next save reports it.
      const open = openId ? held.get(openId) : undefined;
      if (open && open.content !== null && !list.some(n => n.id === openId)) {
        next.splice(Math.min(prev.indexOf(open), next.length), 0, open);
      }
      return next.length === prev.length && next.every((n, i) => n === prev[i]) ? prev : next;
    });
    setFolders(prev => (prev === foldersAsked ? folderList : prev));
  }, []);

  // ── Best-effort flush on tab hide/close, re-read on return ───────────────────
  // flushSave can't be used here: it awaits a normal fetch, and a request
  // started from beforeunload/pagehide gets cancelled along with the page
  // before the browser sends it. keepalive keeps the request alive past
  // unload, but only fire-and-forget — there is no page left to receive or
  // act on the response (a 409 here is silently unrecoverable, same as never
  // having tried).
  useEffect(() => {
    const flushOnHide = () => {
      const { editMode, activeNoteId, editTitle, editContent } = editStateRef.current;
      // saveTimerRef unset means either nothing changed since the last save,
      // or a save is already in flight with this exact content — nothing to
      // do either way.
      if (!editMode || !activeNoteId || !saveTimerRef.current) return;
      // As in saveActiveNote.
      const held = notesRef.current.find(n => n.id === activeNoteId);
      if (!held || held.content === null) return;
      const body = JSON.stringify({ title: editTitle, content: editContent, expected_updated_at: held.updated_at });
      // keepalive requests cap their total body around 64KB and throw
      // synchronously past that — skipping it here is honest about the loss;
      // attempting it would look like a save that never actually left.
      if (new Blob([body]).size > 60_000) return;
      // Cancel the still-armed debounce timer, not just the "pending" flag —
      // left alone it fires later with this same stale snapshot and sends a
      // redundant second PATCH behind this one's back.
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      const id = activeNoteId;
      // Counted as in flight so a re-read on return cannot overtake it.
      savesInFlightRef.current++;
      fetch(`/api/notes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      })
        .then(r => (r.ok ? r.json() : null))
        // visibilitychange fires on every tab switch, not just real unload —
        // the page is very much alive to receive this. Without it,
        // notesRef.current keeps the pre-flush updated_at forever, so the
        // next save (typing again after switching back) guard-fails against
        // a write that already landed — a conflict banner with no conflict.
        .then((data: { updated_at: string } | null) => {
          if (!data) return;
          setNotes(prev => prev.map(n =>
            n.id === id ? { ...n, title: editTitle, content: editContent, updated_at: data.updated_at } : n
          ));
        })
        .catch(() => {})
        .finally(() => { savesInFlightRef.current--; });
    };
    // Tab switch or window focus; both may fire for one return, so reads are spaced out.
    let lastReturnRead = 0;
    const refreshOnReturn = () => {
      if (Date.now() - lastReturnRead < 3_000) return;
      lastReturnRead = Date.now();
      const id = editStateRef.current.activeNoteId;
      if (id) refreshNote(id);
      reloadNotes();
    };
    // visibilitychange is the primary signal — it fires on tab switch/minimize
    // and, unlike beforeunload, reliably fires on mobile Safari/Android too.
    // pagehide and beforeunload are desktop-close fallbacks, kept in case hide
    // is somehow missed.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushOnHide();
      else refreshOnReturn();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', refreshOnReturn);
    window.addEventListener('pagehide', flushOnHide);
    window.addEventListener('beforeunload', flushOnHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', refreshOnReturn);
      window.removeEventListener('pagehide', flushOnHide);
      window.removeEventListener('beforeunload', flushOnHide);
    };
  }, [refreshNote, reloadNotes]);

  const { onNoteOpened } = cb;
  const selectNote = useCallback(async (id: string) => {
    await flushSave();
    const note = notes.find(n => n.id === id);
    if (note) expandAncestors(note.folder_id, folders);
    // Re-selecting the open note keeps its buffer: `notes` here predates the flushed save.
    if (id !== activeNoteId) openNote(id);
    setEditMode(false);
    onNoteOpened(); // close sidebar on mobile + dismiss the share popover
  }, [flushSave, notes, folders, expandAncestors, onNoteOpened, activeNoteId, openNote]);

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
        // Flush the current note's pending debounced edit before switching
        // away — otherwise its still-scheduled autosave timer gets cleared
        // (by the debounce effect re-running for the new note) without ever
        // sending it, silently dropping the last unsaved keystrokes.
        await flushSave();
        // `notes` holds live notes only, so a link to a trashed note looks
        // exactly like a link to one that never existed — and following it
        // would quietly mint an empty duplicate, which then blocks restoring
        // the original on the title's partial unique index.
        const trashed: { title: string }[] = await apiFetch('/api/notes/trash')
          .then(r => (r.ok ? r.json() : []))
          .catch(() => []);
        const inTrash = Array.isArray(trashed)
          && trashed.some(n => n.title.toLowerCase() === title.toLowerCase());
        if (inTrash) {
          setSyncError(`"${title}" is in the Trash — restore it from Settings instead of creating a new note.`);
          return;
        }
        const res = await apiFetch('/api/notes', {
          method: 'POST',
          body: JSON.stringify({ title, content: `# ${title}\n\n`, tags: [] }),
        });
        if (res.ok) {
          const newNote: Note = await res.json();
          setNotes(prev => [...prev, newNote]);
          openNote(newNote.id);
          setEditMode(true);
        }
      }
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [notes, selectNote, flushSave, openNote]);

  const saveNote = useCallback(async () => {
    if (!activeNote) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    // Staying in edit mode on failure keeps the text in front of the user
    // instead of dropping them into a read-only view of the older version.
    const savedAt = await saveActiveNote(activeNote.id, editTitle, editContent);
    if (savedAt === null) return;
    setEditMode(false);
  }, [activeNote, editTitle, editContent, saveActiveNote]);

  /** Take a tag/folder change's updated_at only while title and text still match the held copy. */
  const takeUpdatedAt = useCallback((note: Note) => {
    setNotes(prev => prev.map(n => (
      n.id === note.id && n.title.trim() === note.title && n.content === note.content
        ? { ...n, updated_at: note.updated_at }
        : n
    )));
  }, []);

  // ── Tags ───────────────────────────────────────────────────────────────────
  // Optimistic local update + PATCH. Tags don't change embeddings, so the
  // server skips re-indexing (only title/content do).
  const saveTags = useCallback(async (tags: string[]) => {
    if (!activeNote) return;
    const id = activeNote.id;
    const prevTags = activeNote.tags;
    setNotes(prev => prev.map(n => (n.id === id ? { ...n, tags } : n)));
    // Not guarded by expected_updated_at: a tag edit doesn't touch title/
    // content, so it can't collide with an agent's append_to_note the way
    // the content PATCHes in saveActiveNote can.
    const result = await send<Note>(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ tags }) }, 'Tag not saved');
    if (!result.ok) {
      setNotes(prev => prev.map(n => (n.id === id ? { ...n, tags: prevTags } : n)));
      return;
    }
    takeUpdatedAt(result.data);
  }, [activeNote, send, takeUpdatedAt]);

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

  // ── Manual per-note reindex ──────────────────────────────────────────────
  // Escape hatch for embedding_pending stuck true after a provider failure
  // (Ollama timeout/restart, or a note too long) — the automatic index fires
  // async on save and any error there is invisible beyond that flag. This
  // route (app/api/notes/[id]/reindex) is synchronous, so a real failure
  // surfaces in syncError instead of being swallowed.
  const [reindexingNoteId, setReindexingNoteId] = useState<string | null>(null);
  const reindexNote = useCallback(async (id: string) => {
    setReindexingNoteId(id);
    const result = await send(`/api/notes/${id}/reindex`, { method: 'POST' }, 'Reindex failed');
    setReindexingNoteId(null);
    if (result.ok) {
      setNotes(prev => prev.map(n => (n.id === id ? { ...n, embedding_pending: false } : n)));
    }
  }, [send]);

  // ── Note history ─────────────────────────────────────────────────────────
  /**
   * Put a note's title and content back the way a revision recorded them.
   * Typing not yet autosaved is saved first, so the revert keeps it in
   * history as the state it replaced instead of dropping it.
   */
  const revertNote = useCallback(async (id: string, revisionId: string): Promise<RevertResult> => {
    let expected = notesRef.current.find(n => n.id === id)?.updated_at;
    if (editMode && activeNoteId === id) {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const savedAt = await saveActiveNote(id, editTitle, editContent);
      if (savedAt === null) return 'unsaved';
      expected = savedAt;
      // The restored text replaces the buffer next; nothing may be typed into it meanwhile.
      setEditMode(false);
    }
    if (!expected) return 'failed';
    let res: Response;
    try {
      res = await apiFetch(`/api/notes/${id}/revisions/${revisionId}/revert`, {
        method: 'POST',
        body: JSON.stringify({ expected_updated_at: expected }),
      });
    } catch {
      return 'failed';
    }
    const body: { note?: Note; error?: unknown } = await res.json().catch(() => ({}));
    if (res.ok && body.note) {
      applyNote(body.note);
      return 'restored';
    }
    if (res.status === 409 && body.error === 'title_taken') return 'title_taken';
    if (res.status === 409) {
      // Without the newer copy every retry would be refused the same way.
      await refreshNote(id);
      return 'conflict';
    }
    return 'failed';
  }, [editMode, activeNoteId, editTitle, editContent, saveActiveNote, applyNote, refreshNote]);

  const createNote = useCallback(async (folderId: string | null = null) => {
    // Flush the current note's pending debounced edit before switching away
    // — otherwise its still-scheduled autosave timer gets cleared (by the
    // debounce effect re-running for the new note) without ever sending it,
    // silently dropping the last unsaved keystrokes.
    await flushSave();
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
    openNote(newNote.id);
    setEditMode(true);
  }, [notes, flushSave, openNote]);

  // ── Document import (PDF/EPUB/DOCX) ──────────────────────────────────────
  // Raw-body upload (matches SettingsModal's ZIP importVault, not
  // multipart/form-data) — headers carry filename/folder, body is the file
  // bytes untouched. Format dispatch + conversion runs server-side
  // (app/api/notes/import-document, by filename extension).
  const [pdfImporting, setPdfImporting] = useState(false);
  const importPdfFile = useCallback(async (file: File, folderId: string | null): Promise<void> => {
    await flushSave();
    setPdfImporting(true);
    try {
      const url = `/api/notes/import-document${folderId ? `?folder_id=${folderId}` : ''}`;
      const res = await apiFetch(url, {
        method: 'POST',
        body: file,
        headers: {
          'Content-Type': 'application/octet-stream', // dispatch is by filename extension, not this
          // Latin-1-only header value; a vault's titles are routinely
          // Cyrillic/German — see the matching decodeURIComponent server-side.
          'X-Filename': encodeURIComponent(file.name),
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSyncError(`Import failed: ${typeof data.error === 'string' ? data.error : `HTTP ${res.status}`}`);
        return;
      }
      setSyncError(null);
      const newNote: Note = data;
      setNotes(prev => [...prev, newNote]);
      openNote(newNote.id);
    } catch {
      setSyncError('Import failed: no connection to the server');
    } finally {
      setPdfImporting(false);
    }
  }, [flushSave, openNote]);

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
    if (!confirm('Delete folder and move its notes — including every subfolder — to Trash?')) return;
    // The delete is one transaction: on failure nothing moved and the folder
    // still stands, so clearing the tree anyway would show a whole subtree as
    // gone while every note sat untouched in the database — and absent from
    // Trash too, since nothing was deleted.
    const result = await send(`/api/folders/${id}`, { method: 'DELETE' }, 'Folder not deleted');
    if (!result.ok) return;
    // The server cascades to descendant folders (FK) and soft-deletes every
    // note in the whole subtree, not just this one folder — mirror that here
    // so orphaned subfolders/notes don't linger in the tree until a reload.
    const subtree = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parent_id && subtree.has(f.parent_id) && !subtree.has(f.id)) {
          subtree.add(f.id);
          grew = true;
        }
      }
    }
    setFolders(prev => prev.filter(f => !subtree.has(f.id)));
    setNotes(prev => {
      const removed = prev.filter(n => n.folder_id !== null && subtree.has(n.folder_id));
      const next = prev.filter(n => n.folder_id === null || !subtree.has(n.folder_id));
      if (removed.some(n => n.id === activeNoteId)) {
        openNote(next[0]?.id ?? null);
        setEditMode(false);
      }
      return next;
    });
  }, [activeNoteId, folders, send, openNote]);

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
    const result = await send(`/api/notes/${id}`, { method: 'DELETE' }, 'Not deleted');
    if (!result.ok) return;
    setNotes(prev => {
      const next = prev.filter(n => n.id !== id);
      if (activeNoteId === id) {
        openNote(next[0]?.id ?? null);
        setEditMode(false);
      }
      return next;
    });
  }, [activeNoteId, send, openNote]);

  const { onMoveDone } = cb;
  const moveNote = useCallback(async (folderId: string | null) => {
    if (!activeNoteId) return;
    // Not guarded by expected_updated_at — same reasoning as saveTags: a
    // folder move doesn't touch title/content.
    const result = await send<Note>(
      `/api/notes/${activeNoteId}`,
      { method: 'PATCH', body: JSON.stringify({ folder_id: folderId }) },
      'Not moved'
    );
    if (!result.ok) return;
    setNotes(prev => prev.map(n =>
      n.id === activeNoteId ? { ...n, folder_id: folderId } : n
    ));
    takeUpdatedAt(result.data);
    onMoveDone();
  }, [activeNoteId, onMoveDone, send, takeUpdatedAt]);

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
    notes, folders, loading, activeNote, activeNoteId,
    syncError, setSyncError,
    canOverwriteConflict: conflict !== null && conflict.id === activeNoteId, overwriteConflict,
    editMode, setEditMode, editContent, setEditContent, editTitle, setEditTitle,
    expandedFolders, toggleFolder, expandAncestors,
    flushSave, selectNote, saveNote, saveTags, addTag, removeTag,
    createNote, createFolder, deleteFolder, renameFolder, deleteNote, moveNote, moveFolder,
    reindexingNoteId, reindexNote,
    refreshNote, revertNote, loadText, reloadNotes,
    pdfImporting, importPdfFile,
  };
}
