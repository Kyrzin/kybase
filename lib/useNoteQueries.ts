'use client';

import { useState, useEffect, useRef } from 'react';
import type { ListedNote, NoteSummary, Backlink } from './types';
import type { GraphEdge } from './graph';
import { apiFetch } from './api-client';

// Debounced: server-side search scans all note text. A blank query is no search.
export function useNoteSearch(query: string): NoteSummary[] | null {
  const [hits, setHits] = useState<NoteSummary[] | null>(null);
  const seqRef = useRef(0);
  const q = query.trim() ? query : '';
  if (!q && hits !== null) setHits(null);
  useEffect(() => {
    const seq = ++seqRef.current;
    if (!q) return;
    const timer = setTimeout(() => {
      apiFetch(`/api/notes?content=false&q=${encodeURIComponent(q)}`)
        .then(r => (r.ok ? r.json() : null))
        .then((found: NoteSummary[] | null) => {
          if (seq === seqRef.current && Array.isArray(found)) setHits(found);
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  return q ? hits : null;
}

export function useBacklinks(noteId: string | null, shown: boolean): Backlink[] | 'loading' | 'failed' {
  const [answer, setAnswer] = useState<{ noteId: string; backlinks: Backlink[] | null } | null>(null);
  useEffect(() => {
    if (!shown || !noteId) return;
    let cancelled = false;
    apiFetch(`/api/notes/${noteId}/backlinks`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((found: Backlink[] | null) => {
        if (!cancelled) setAnswer({ noteId, backlinks: Array.isArray(found) ? found : null });
      });
    return () => { cancelled = true; };
  }, [noteId, shown]);
  if (!noteId) return [];
  if (!answer || answer.noteId !== noteId) return 'loading';
  return answer.backlinks ?? 'failed';
}

// Refetched shortly after the notes change: a save may add or remove links.
export function useGraphLinks(shown: boolean, notes: ListedNote[]): GraphEdge[] {
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const fetchedRef = useRef(false);
  useEffect(() => {
    if (!shown) {
      fetchedRef.current = false;
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      apiFetch('/api/graph/links')
        .then(r => (r.ok ? r.json() : null))
        .then((found: GraphEdge[] | null) => {
          if (cancelled || !Array.isArray(found)) return;
          fetchedRef.current = true;
          setEdges(found);
        })
        .catch(() => {});
    }, fetchedRef.current ? 1_000 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [shown, notes]);
  return edges;
}
