'use client';

// components/RightPanel.tsx — the collapsible right dock: backlinks list,
// knowledge graph, AI search, or the note outline, selected by `rightPanel`.
// Extracted from KybaseApp; all data and view state comes in as props.
import { useMemo } from 'react';
import type { Note, SearchHit } from '@/lib/types';
import { extractHeadings } from '@/lib/markdown';
import { Icons } from './Icons';
import MiniGraph, { type GraphData } from './MiniGraph';

export default function RightPanel(p: {
  rightPanel: 'backlinks' | 'graph' | 'ai' | 'outline';
  graphFullscreen: boolean;
  setGraphFullscreen: (fn: (v: boolean) => boolean) => void;
  panelWidth: number;
  panelResizeRef: React.MutableRefObject<{ active: boolean; startX: number; startW: number }>;
  backlinks: Note[];
  activeNote: Note | null;
  activeNoteId: string | null;
  selectNote: (id: string) => void;
  winSize: { w: number; h: number };
  graphData: GraphData;
  graphFitRef: React.MutableRefObject<(() => void) | null>;
  toggleFolder: (id: string) => void;
  setSidebarOpen: (v: boolean) => void;
  setRightPanel: (v: 'backlinks' | 'graph' | 'ai' | 'outline' | null) => void;
  aiQuery: string;
  setAiQuery: (v: string) => void;
  handleAiSearch: () => void;
  aiLoading: boolean;
  aiResults: SearchHit[] | null;
  filterByTag: (tag: string) => void;
  editMode: boolean;
  setEditMode: (v: boolean) => void;
  editContent: string;
}) {
  const {
    rightPanel, graphFullscreen, setGraphFullscreen, panelWidth, panelResizeRef,
    backlinks, activeNote, activeNoteId, selectNote, winSize, graphData, graphFitRef,
    toggleFolder, setSidebarOpen, setRightPanel,
    aiQuery, setAiQuery, handleAiSearch, aiLoading, aiResults, filterByTag,
    editMode, setEditMode, editContent,
  } = p;

  // Outline follows the live draft while editing, the saved note otherwise.
  const outlineSource = editMode ? editContent : (activeNote?.content ?? '');
  const headings = useMemo(
    () => (rightPanel === 'outline' ? extractHeadings(outlineSource) : []),
    [rightPanel, outlineSource]
  );

  const jumpToHeading = (slug: string) => {
    const scroll = () => document.getElementById(slug)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (editMode) {
      // The textarea has no anchors — switch to Preview, then scroll once the
      // rendered headings (with their ids) are in the DOM.
      setEditMode(false);
      setTimeout(scroll, 80);
    } else {
      scroll();
    }
    if (winSize.w < 768) setRightPanel(null);
  };
  return (
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
                    toggleFolder(fid);
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

      {rightPanel === 'outline' && (
        <>
          <div className="right-panel-header">Outline{headings.length > 0 && ` (${headings.length})`}</div>
          <div className="right-panel-body">
            {!activeNote ? (
              <div style={{ color: '#585b70', fontSize: 13, textAlign: 'center', padding: 24 }}>No note selected</div>
            ) : headings.length === 0 ? (
              <div style={{ color: '#585b70', fontSize: 13, textAlign: 'center', padding: 24 }}>No headings in this note</div>
            ) : headings.map(h => (
              <div
                key={h.slug}
                onClick={() => jumpToHeading(h.slug)}
                title={h.text}
                style={{
                  padding: '5px 10px',
                  paddingLeft: 10 + (h.level - 1) * 16,
                  fontSize: h.level === 1 ? 13.5 : 12.5,
                  fontWeight: h.level === 1 ? 600 : 400,
                  color: h.level === 1 ? '#cdd6f4' : '#a6adc8',
                  cursor: 'pointer',
                  borderRadius: 6,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(137,180,250,0.08)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                {h.text}
              </div>
            ))}
          </div>
        </>
      )}

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
  );
}
