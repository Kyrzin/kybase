'use client';

// components/HistoryPanel.tsx — two modes of the right panel: History (one
// note's changes, the diff of each, restore and remove) and Changes (every
// change in the vault, newest first). Rendered by RightPanel.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEntry, ChangePage, ListedNote, RevisionDetail, RevisionKind, RevisionPage, RevisionSummary } from '@/lib/types';
import { apiFetch } from '@/lib/api-client';
import type { RevertResult } from '@/lib/useNotes';
import {
  actorKind, actorLabel, collapseUnchanged, diffTextLines, kindLabel, relativeTime, type DiffRow,
} from '@/lib/history-view';
import { Icons } from './Icons';

const PAGE_SIZE = 50;
// A rewrite of a huge note would otherwise put that many rows in the DOM.
const MAX_DIFF_ROWS = 2000;

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await apiFetch(path);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

type Notice = { error: boolean; text: string };

function revertNotice(result: RevertResult, title: string): Notice {
  switch (result) {
    case 'restored': return { error: false, text: 'Restored.' };
    case 'conflict': return { error: true, text: 'Not restored: the note changed meanwhile. Check the latest change and try again.' };
    case 'title_taken': return { error: true, text: `Not restored: another note is titled “${title}”.` };
    case 'unsaved': return { error: true, text: 'Not restored: your unsaved edits could not be saved.' };
    case 'failed': return { error: true, text: 'Not restored. Try again.' };
  }
}

function ChangeMeta({ changedBy, kind, at, now }: { changedBy: string; kind: RevisionKind; at: string; now: number }) {
  return (
    <>
      <span className={`history-actor ${actorKind(changedBy)}`}>{actorLabel(changedBy)}</span>
      <span className="history-kind">{kindLabel(kind)}</span>
      <span className="history-time" title={new Date(at).toLocaleString()}>{relativeTime(at, now)}</span>
    </>
  );
}

function DiffView({ rows }: { rows: DiffRow[] }) {
  const shown = rows.slice(0, MAX_DIFF_ROWS);
  const cut = rows.slice(MAX_DIFF_ROWS).filter(r => r.type !== 'skip').length;
  return (
    <div className="diff">
      {shown.map((r, i) => r.type === 'skip'
        ? <div key={i} className="diff-skip">⋯ {r.count} unchanged lines</div>
        : <div key={i} className={`diff-line ${r.type}`}>{r.text}</div>)}
      {cut > 0 && <div className="diff-skip">⋯ {cut} more lines not shown</div>}
    </div>
  );
}

function RevisionView({ detail, note, now, busy, onRestore, onRemove }: {
  detail: RevisionDetail;
  note: ListedNote | null;
  now: number;
  busy: boolean;
  onRestore: () => void;
  onRemove: () => void;
}) {
  const { before, after } = detail;
  // A create has no before: its text shows as one long addition.
  const rows = useMemo(() => {
    if (!after) return undefined;
    const lines = diffTextLines(before?.content ?? '', after.content);
    return lines && collapseUnchanged(lines);
  }, [before, after]);
  const isCurrent = !!before && !!note && before.title === note.title && before.content === note.content;

  return (
    <>
      <div className="history-row history-meta">
        <ChangeMeta changedBy={detail.changed_by} kind={detail.kind} at={detail.changed_at} now={now} />
      </div>
      {before && (
        <div className="history-actions">
          {isCurrent ? (
            <span className="history-hint">This is the current version.</span>
          ) : note && (
            <button className="history-restore" onClick={onRestore} disabled={busy} title="Put the note back as it was before this change">
              Restore this version
            </button>
          )}
          <button className="history-remove" onClick={onRemove} disabled={busy} title="Delete this saved version for good">
            Remove from history
          </button>
        </div>
      )}
      {!after ? (
        <div className="history-hint">
          {detail.kind === 'delete' ? 'The note was moved to the trash.'
            : detail.kind === 'restore' ? 'The note was restored from the trash.'
            : 'No text to show.'}
        </div>
      ) : (
        <>
          {before && before.title !== after.title && (
            <div className="history-title-change">
              Title: <del>{before.title}</del> → <ins>{after.title}</ins>
            </div>
          )}
          {rows === null ? (
            <div className="history-hint">This change is too large to show.</div>
          ) : rows && rows.length > 0 ? (
            <DiffView rows={rows} />
          ) : (
            <div className="history-hint">{before ? 'No change to the text.' : 'The note was created empty.'}</div>
          )}
        </>
      )}
    </>
  );
}

export default function HistoryPanel({ noteId, note, selectedId, onSelect, revertNote, refreshNote }: {
  noteId: string;
  note: ListedNote | null;
  selectedId: string | null;
  onSelect: (revisionId: string | null) => void;
  revertNote: (noteId: string, revisionId: string) => Promise<RevertResult>;
  refreshNote: (noteId: string) => Promise<void>;
}) {
  const [list, setList] = useState<{ revisions: RevisionSummary[]; nextOffset: number | null } | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detail, setDetail] = useState<{ id: string; data: RevisionDetail | null } | null>(null);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const loadSeq = useRef(0);

  const loadPage = useCallback((offset: number) => {
    // A reload supersedes whatever page was still on its way.
    const seq = offset === 0 ? ++loadSeq.current : loadSeq.current;
    const path = `/api/notes/${noteId}/revisions?limit=${PAGE_SIZE}&offset=${offset}`;
    return getJson<RevisionPage>(path).then(data => {
      if (seq !== loadSeq.current) return;
      setListFailed(!data);
      if (!data) return;
      setNow(Date.now());
      const nextOffset = data.has_more ? (data.next_offset ?? null) : null;
      setList(prev => {
        if (offset === 0 || !prev) return { revisions: data.revisions, nextOffset };
        const seen = new Set(prev.revisions.map(r => r.id));
        return { revisions: [...prev.revisions, ...data.revisions.filter(r => !seen.has(r.id))], nextOffset };
      });
    });
  }, [noteId]);

  useEffect(() => {
    loadPage(0);
    // Agents write while this tab is open; the note beside its history should include that.
    refreshNote(noteId);
  }, [loadPage, refreshNote, noteId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    getJson<RevisionDetail>(`/api/notes/${noteId}/revisions/${selectedId}`).then(data => {
      if (cancelled) return;
      setNow(Date.now());
      setDetail({ id: selectedId, data });
    });
    return () => { cancelled = true; };
  }, [noteId, selectedId]);

  const open = (revisionId: string | null) => {
    setNotice(null);
    onSelect(revisionId);
  };

  const loadMore = async () => {
    if (list?.nextOffset == null) return;
    setLoadingMore(true);
    await loadPage(list.nextOffset);
    setLoadingMore(false);
  };

  const restore = async (revision: RevisionDetail) => {
    if (!revision.before) return;
    if (!window.confirm('Restore the note to this version? Its current text stays in history.')) return;
    setBusy(true);
    setNotice(null);
    const result = await revertNote(noteId, revision.id);
    setBusy(false);
    setNotice(revertNotice(result, revision.before.title));
    // The revert is the newest change now — or, on a conflict, the change that blocked it.
    loadPage(0);
  };

  const remove = async (revisionId: string) => {
    if (!window.confirm('Remove this version from history for good? This cannot be undone.')) return;
    setBusy(true);
    setNotice(null);
    const res = await apiFetch(`/api/notes/${noteId}/revisions/${revisionId}`, { method: 'DELETE' }).catch(() => null);
    setBusy(false);
    if (!res || !(res.ok || res.status === 404)) {
      setNotice({ error: true, text: 'Not removed. Try again.' });
      return;
    }
    onSelect(null);
    setNotice({ error: false, text: 'Removed from history.' });
    loadPage(0);
  };

  const shown = selectedId && detail?.id === selectedId ? detail : null;

  return (
    <>
      <div className="right-panel-header history-header">
        {selectedId && (
          <button className="history-header-btn" onClick={() => open(null)} title="Back" aria-label="Back">‹</button>
        )}
        <span>History</span>
        <div style={{ flex: 1 }} />
        {!selectedId && (
          <button
            className="history-header-btn"
            onClick={() => { setNotice(null); loadPage(0); refreshNote(noteId); }}
            title="Reload"
            aria-label="Reload"
          >
            {Icons.refresh}
          </button>
        )}
      </div>
      <div className="right-panel-body">
        {notice && <div className={`history-notice${notice.error ? ' error' : ''}`} role="status">{notice.text}</div>}
        {selectedId ? (
          !shown ? (
            <div className="history-empty">Loading…</div>
          ) : !shown.data ? (
            <div className="history-empty">This change is no longer in the history.</div>
          ) : (
            <RevisionView
              detail={shown.data}
              note={note}
              now={now}
              busy={busy}
              onRestore={() => shown.data && restore(shown.data)}
              onRemove={() => remove(shown.id)}
            />
          )
        ) : listFailed && !list ? (
          <div className="history-empty">Could not load the history.</div>
        ) : !list ? (
          <div className="history-empty">Loading…</div>
        ) : list.revisions.length === 0 ? (
          <div className="history-empty">No changes recorded yet</div>
        ) : (
          <>
            {list.revisions.map(r => (
              <button key={r.id} className="history-item" onClick={() => open(r.id)}>
                <span className="history-row">
                  <ChangeMeta changedBy={r.changed_by} kind={r.kind} at={r.changed_at} now={now} />
                </span>
              </button>
            ))}
            {list.nextOffset !== null && (
              <button className="history-more" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

export function ChangesPanel({ actor, setActor, openChange }: {
  actor: string;
  setActor: (actor: string) => void;
  openChange: (noteId: string, revisionId: string) => void;
}) {
  const [list, setList] = useState<{ changes: ChangeEntry[]; nextOffset: number | null } | null>(null);
  const [actors, setActors] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [now, setNow] = useState(0);
  const loadSeq = useRef(0);

  const loadPage = useCallback((who: string, offset: number) => {
    // A reload — another actor picked, say — supersedes whatever page was still on its way.
    const seq = offset === 0 ? ++loadSeq.current : loadSeq.current;
    const filter = who ? `&actor=${encodeURIComponent(who)}` : '';
    return getJson<ChangePage>(`/api/changes?limit=${PAGE_SIZE}&offset=${offset}${filter}`).then(data => {
      if (seq !== loadSeq.current) return;
      setFailed(!data);
      if (!data) return;
      setNow(Date.now());
      setActors(data.actors);
      const nextOffset = data.has_more ? (data.next_offset ?? null) : null;
      setList(prev => {
        if (offset === 0 || !prev) return { changes: data.changes, nextOffset };
        const seen = new Set(prev.changes.map(c => c.revision_id));
        return { changes: [...prev.changes, ...data.changes.filter(c => !seen.has(c.revision_id))], nextOffset };
      });
    });
  }, []);

  useEffect(() => { loadPage(actor, 0); }, [loadPage, actor]);

  const loadMore = async () => {
    if (list?.nextOffset == null) return;
    setLoadingMore(true);
    await loadPage(actor, list.nextOffset);
    setLoadingMore(false);
  };

  // An actor picked earlier stays selectable even once no change of theirs is left.
  const options = actor && !actors.includes(actor) ? [actor, ...actors] : actors;

  return (
    <>
      <div className="right-panel-header history-header">
        <span>Changes</span>
        <div style={{ flex: 1 }} />
        <button className="history-header-btn" onClick={() => loadPage(actor, 0)} title="Reload" aria-label="Reload">
          {Icons.refresh}
        </button>
      </div>
      <div className="history-filter">
        <select
          className="focus-select"
          value={actor}
          onChange={e => { setList(null); setActor(e.target.value); }}
          aria-label="Show changes by"
        >
          <option value="">Everyone</option>
          {options.map(a => <option key={a} value={a}>{actorLabel(a)}</option>)}
        </select>
      </div>
      <div className="right-panel-body">
        {failed && !list ? (
          <div className="history-empty">Could not load the changes.</div>
        ) : !list ? (
          <div className="history-empty">Loading…</div>
        ) : list.changes.length === 0 ? (
          <div className="history-empty">No changes recorded yet</div>
        ) : (
          <>
            {list.changes.map(c => (
              <button
                key={c.revision_id}
                className="history-item"
                disabled={c.note_deleted}
                onClick={() => openChange(c.note_id, c.revision_id)}
              >
                <span className="history-row">
                  <span className="history-note">{c.note_title}</span>
                  <span className="history-time" title={new Date(c.changed_at).toLocaleString()}>{relativeTime(c.changed_at, now)}</span>
                </span>
                <span className="history-row">
                  <span className={`history-actor ${actorKind(c.changed_by)}`}>{actorLabel(c.changed_by)}</span>
                  <span className="history-kind">{kindLabel(c.kind)}{c.note_deleted && c.kind !== 'delete' && ' · in trash'}</span>
                </span>
              </button>
            ))}
            {list.nextOffset !== null && (
              <button className="history-more" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
