'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Note, Folder, SearchHit } from '@/lib/types';

const TOKEN_KEY = 'kybase_token';
const FOCUS_KEY = 'kybase_focus_folder';
const SEM_THRESHOLD_KEY = 'kybase_sem_threshold';

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

// ─── Markdown Parser ─────────────────────────────────────────────────────────
// Content is escaped for &/</> before any HTML is generated, but quotes are
// left alone so they read naturally in text — attribute values built from
// user text must go through escapeAttr(), and URLs through safeUrl(), or a
// note containing e.g. [x](" onerror="...") breaks out of the attribute.
export function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}

export function safeUrl(url: string): string {
  return /^(https?:|mailto:|\/|#)/i.test(url.trim()) ? url : '#';
}

export function parseMarkdown(text: string): string {
  if (!text) return '';
  const html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/`([^`]+)`/g, '<code style="background:#1e1e2e;padding:2px 6px;border-radius:3px;font-size:0.9em">$1</code>')
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_: string, __: string, code: string) =>
      `<pre style="background:#1e1e2e;padding:12px;border-radius:6px;overflow-x:auto;margin:8px 0"><code>${code.trim()}</code></pre>`)
    .replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:3px solid #6c7086;padding-left:12px;color:#a6adc8;margin:8px 0">$1</blockquote>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #313244;margin:16px 0">')
    .replace(/^- \[x\] (.+)$/gm, '<li style="margin-left:16px">☑ $1</li>')
    .replace(/^- \[ \] (.+)$/gm, '<li style="margin-left:16px">☐ $1</li>')
    .replace(/^- (.+)$/gm, '<li style="margin-left:16px">$1</li>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_: string, alt: string, url: string) =>
      `<img src="${escapeAttr(safeUrl(url))}" alt="${escapeAttr(alt)}" style="max-width:100%;border-radius:6px;margin:8px 0">`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_: string, label: string, url: string) =>
      `<a href="${escapeAttr(safeUrl(url))}" style="color:#89b4fa;text-decoration:underline">${label}</a>`)
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
  return `<p>${html}</p>`;
}

export function renderWithWikilinks(html: string, notes: Note[]): string {
  return html.replace(/\[\[([^\]]+)\]\]/g, (_: string, raw: string) => {
    const title = raw.split(/[|#]/)[0].trim();
    const exists = notes.some(n => n.title.toLowerCase() === title.toLowerCase());
    return `<span class="wikilink ${exists ? 'exists' : 'missing'}" data-title="${escapeAttr(title)}">[[${raw}]]</span>`;
  });
}

// ─── Icons ───────────────────────────────────────────────────────────────────
const Icons = {
  folder: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>,
  folderOpen: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v1" /><path d="M5 12h14l-2 7H7z" /></svg>,
  file: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>,
  search: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>,
  plus: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>,
  trash: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>,
  ai: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></svg>,
  link: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>,
  graph: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><circle cx="4" cy="6" r="2" /><circle cx="20" cy="6" r="2" /><circle cx="4" cy="18" r="2" /><circle cx="20" cy="18" r="2" /><line x1="9.5" y1="10.5" x2="5.5" y2="7.5" /><line x1="14.5" y1="10.5" x2="18.5" y2="7.5" /><line x1="9.5" y1="13.5" x2="5.5" y2="16.5" /><line x1="14.5" y1="13.5" x2="18.5" y2="16.5" /></svg>,
  settings: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
  edit: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>,
  eye: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>,
  sidebar: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>,
  chevron: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>,
  newFolder: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></svg>,
};

// ─── Mini Graph (force-directed) ─────────────────────────────────────────────
type GraphEdge = { from: string; to: string; kind?: 'semantic'; score?: number };
type GraphData = { nodes: { id: string; title: string; type: 'note' | 'folder'; folderId?: string | null }[]; edges: GraphEdge[] };
type NodeState = { id: string; title: string; x: number; y: number; vx: number; vy: number; type: 'note' | 'folder'; folderId?: string | null };

const FRICTION = 0.85, REPULSION = 3000, SPRING_K = 0.04, REST_LEN = 80, GRAVITY = 0.012;

// Stable pastel HSL color derived from folder ID
const getFolderColorHSL = (folderId: string | null | undefined, lightnessOffset = 0): string => {
  if (!folderId) return `hsl(228, 12%, ${50 + lightnessOffset}%)`;
  let hash = 0;
  for (let i = 0; i < folderId.length; i++) hash = folderId.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash % 360);
  const l = Math.max(20, Math.min(85, 68 + lightnessOffset));
  return `hsl(${hue}, 65%, ${l}%)`;
};

function MiniGraph({ graphData, activeNoteId, onSelectNote, w = 320, h = 280, fitRef }: {
  graphData: GraphData;
  activeNoteId: string | null;
  onSelectNote?: (id: string) => void;
  w?: number;
  h?: number;
  fitRef?: React.RefObject<(() => void) | null>;
}) {
  const W = w, H = h;
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const nodesRef     = useRef<Map<string, NodeState>>(new Map());
  const camRef       = useRef({ x: W / 2, y: H / 2, zoom: 1 });
  const targetCamRef = useRef({ x: W / 2, y: H / 2, zoom: 1 });
  const dragRef      = useRef<{ nodeId: string | null; startX: number; startY: number; lastX: number; lastY: number; panning: boolean }>
                             ({ nodeId: null, startX: 0, startY: 0, lastX: 0, lastY: 0, panning: false });
  const hoveredRef   = useRef<string | null>(null);
  const wakeRef      = useRef<() => void>(() => {});

  // Controls
  const [showCtrl,    setShowCtrl]    = useState(false);
  const [paused,      setPaused]      = useState(false);
  const [showFolders, setShowFolders] = useState(true);
  const [allLabels,   setAllLabels]   = useState(false);
  const [graphQuery,  setGraphQuery]  = useState('');
  const [hideOrphans, setHideOrphans] = useState(false);
  const [semEnabled,  setSemEnabled]  = useState(true);
  const [semThreshold, setSemThreshold] = useState(() => {
    if (typeof window === 'undefined') return 0.8;
    const v = parseFloat(localStorage.getItem(SEM_THRESHOLD_KEY) ?? '');
    return Number.isFinite(v) && v >= 0.6 && v <= 0.95 ? v : 0.8;
  });
  const ctrlRef = useRef({ paused: false, showFolders: true, allLabels: false, graphQuery: '', hideOrphans: false });
  useEffect(() => {
    ctrlRef.current = { paused, showFolders, allLabels, graphQuery, hideOrphans };
    wakeRef.current();
  }, [paused, showFolders, allLabels, graphQuery, hideOrphans]);

  // Semantic edges are filtered client-side: graphData carries every pair the
  // API returned (≥0.6), the slider narrows the view without refetching.
  const edges = useMemo(
    () => graphData.edges.filter(e => e.kind !== 'semantic' || (semEnabled && (e.score ?? 0) >= semThreshold)),
    [graphData.edges, semEnabled, semThreshold]
  );

  // Sync nodes — keep existing positions, place new ones on a circle
  useEffect(() => {
    const prev = nodesRef.current;
    const next = new Map<string, NodeState>();
    graphData.nodes.forEach((n, i) => {
      if (prev.has(n.id)) {
        next.set(n.id, { ...prev.get(n.id)!, title: n.title, type: n.type, folderId: n.folderId });
      } else {
        const angle = (i / Math.max(graphData.nodes.length, 1)) * Math.PI * 2;
        const r = Math.max(Math.min(W, H) * 0.3, Math.sqrt(graphData.nodes.length) * REST_LEN * 0.6);
        next.set(n.id, { id: n.id, title: n.title, type: n.type, folderId: n.folderId, x: W / 2 + Math.cos(angle) * r, y: H / 2 + Math.sin(angle) * r, vx: 0, vy: 0 });
      }
    });
    nodesRef.current = next;
  }, [graphData]);

  // Helpers
  const degreeMap = useMemo(() => {
    const m = new Map<string, number>();
    edges.forEach(({ from, to }) => { m.set(from, (m.get(from) ?? 0) + 1); m.set(to, (m.get(to) ?? 0) + 1); });
    return m;
  }, [edges]);

  const nodeRadius = (id: string) => id.startsWith('f:') ? 7 : 4 + (degreeMap.get(id) ?? 0) * 1.2;

  const zoomToFit = useCallback(() => {
    const noteNodes = Array.from(nodesRef.current.values()).filter(n => n.type === 'note');
    if (!noteNodes.length) return;
    const xs = noteNodes.map(n => n.x), ys = noteNodes.map(n => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 40;
    const zoom = Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxY - minY || 1), 2);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    camRef.current    = { x: cx, y: cy, zoom };
    targetCamRef.current = { x: cx, y: cy, zoom };
  }, [W, H]);

  useEffect(() => { if (fitRef) fitRef.current = zoomToFit; }, [fitRef, zoomToFit]);

  // Smooth pan to active note
  useEffect(() => {
    if (!activeNoteId) return;
    const node = nodesRef.current.get(activeNoteId);
    if (!node) return;
    targetCamRef.current.x = node.x;
    targetCamRef.current.y = node.y;
    wakeRef.current();
  }, [activeNoteId]);

  const toWorld = (cx: number, cy: number) => {
    const cam = camRef.current;
    return { x: (cx - W / 2) / cam.zoom + cam.x, y: (cy - H / 2) / cam.zoom + cam.y };
  };

  const hitTest = (cx: number, cy: number): string | null => {
    const cam = camRef.current;
    const ns = Array.from(nodesRef.current.values());
    // Folders on top → check first
    for (const n of [...ns.filter(n => n.type === 'folder'), ...ns.filter(n => n.type !== 'folder')]) {
      const sx = (n.x - cam.x) * cam.zoom + W / 2;
      const sy = (n.y - cam.y) * cam.zoom + H / 2;
      const r  = (n.type === 'folder' ? 7 : nodeRadius(n.id)) * cam.zoom + 4;
      if ((cx - sx) ** 2 + (cy - sy) ** 2 <= r * r) return n.id;
    }
    return null;
  };

  const canvasXY = (e: React.MouseEvent<HTMLCanvasElement> | React.WheelEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (W / rect.width), y: (e.clientY - rect.top) * (H / rect.height) };
  };

  // RAF loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    // Stabilized physics step: softened repulsion + velocity cap + smooth folder lerp
    const step = () => {
      const nodes = Array.from(nodesRef.current.values());
      const drag  = dragRef.current;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (drag.nodeId === a.id || a.type === 'folder') continue;
        let fx = (W / 2 - a.x) * GRAVITY, fy = (H / 2 - a.y) * GRAVITY;
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          const b = nodes[j];
          if (b.type === 'folder') continue;
          const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy, d = Math.sqrt(d2) || 1;
          // Softened repulsion — prevents force spikes when nodes overlap
          fx += (dx / d) * REPULSION / (d2 + 400); fy += (dy / d) * REPULSION / (d2 + 400);
          const minD = nodeRadius(a.id) + nodeRadius(b.id) + 10;
          if (d < minD) { const cf = (minD - d) / d * 0.6; fx += dx * cf; fy += dy * cf; }
        }
        edges.forEach(({ from, to, kind }) => {
          const oid = from === a.id ? to : to === a.id ? from : null;
          if (!oid) return;
          const b = nodesRef.current.get(oid);
          if (!b || b.type === 'folder') return;
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
          // Semantic edges pull weaker — suggestions shouldn't reshape the layout like explicit links
          const k = SPRING_K * (kind === 'semantic' ? 0.4 : 1);
          fx += (dx / d) * (d - REST_LEN) * k; fy += (dy / d) * (d - REST_LEN) * k;
        });
        a.vx = (a.vx + fx) * FRICTION; a.vy = (a.vy + fy) * FRICTION;
        // Velocity cap — prevents node teleportation
        const spd = Math.sqrt(a.vx * a.vx + a.vy * a.vy);
        if (spd > 5) { a.vx = a.vx / spd * 5; a.vy = a.vy / spd * 5; }
        a.x += a.vx; a.y += a.vy;
      }
      // Folders: smooth centroid lerp, not instant snap
      nodes.forEach(node => {
        if (node.type !== 'folder' || drag.nodeId === node.id) return;
        const peers = edges
          .filter(e => e.from === node.id || e.to === node.id)
          .map(e => nodesRef.current.get(e.from === node.id ? e.to : e.from))
          .filter((n): n is NodeState => !!n && n.type === 'note');
        if (peers.length) {
          const tx = peers.reduce((s, n) => s + n.x, 0) / peers.length;
          const ty = peers.reduce((s, n) => s + n.y, 0) / peers.length;
          node.x += (tx - node.x) * 0.08; node.y += (ty - node.y) * 0.08;
        }
      });
    };

    // Warm-start: 80 synchronous iterations → graph appears settled instantly
    for (let s = 0; s < 80; s++) step();
    zoomToFit();

    let raf = -1;
    let sleeping = false;

    const wake = () => { if (sleeping) { sleeping = false; raf = requestAnimationFrame(tick); } };
    wakeRef.current = wake;
    canvas.addEventListener('mousedown',  wake);
    canvas.addEventListener('mousemove',  wake);
    canvas.addEventListener('touchstart', wake, { passive: true });
    canvas.addEventListener('touchmove',  wake, { passive: true });
    canvas.addEventListener('wheel',      wake, { passive: true });

    const tick = () => {
      const nodes = Array.from(nodesRef.current.values());
      const drag  = dragRef.current;
      const ctrl  = ctrlRef.current;

      if (!ctrl.paused) step();

      // Smooth camera lerp toward target (for active-note navigation)
      const cam = camRef.current, tgt = targetCamRef.current;
      cam.x    += (tgt.x    - cam.x)    * 0.1;
      cam.y    += (tgt.y    - cam.y)    * 0.1;
      cam.zoom += (tgt.zoom - cam.zoom) * 0.1;

      ctx.clearRect(0, 0, W, H);

      // Dot grid — screen space, shifts with camera for spatial depth
      const gs = 30 * cam.zoom;
      if (gs > 5) {
        const offX = ((W / 2 - cam.x * cam.zoom) % gs + gs) % gs;
        const offY = ((H / 2 - cam.y * cam.zoom) % gs + gs) % gs;
        ctx.fillStyle = '#252535';
        for (let gx = offX - gs; gx < W + gs; gx += gs)
          for (let gy = offY - gs; gy < H + gs; gy += gs) {
            ctx.beginPath(); ctx.arc(gx, gy, 0.85, 0, Math.PI * 2); ctx.fill();
          }
      }

      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-cam.x, -cam.y);

      // Focus dimming + graph search filter
      const hovId = hoveredRef.current || activeNoteId;
      const hovNode = hovId ? nodesRef.current.get(hovId) : null;
      const hovFolderId = hovNode?.folderId;
      const hovNeighbors = hovId ? new Set(
        edges.filter(e => e.from === hovId || e.to === hovId).map(e => e.from === hovId ? e.to : e.from)
      ) : null;
      const hasQuery = !!ctrl.graphQuery;
      const isHi = (node: NodeState) => {
        if (hasQuery && !node.title.toLowerCase().includes(ctrl.graphQuery.toLowerCase())) return false;
        if (!hovId) return true;
        if (node.id === hovId) return true;
        if (hovNeighbors?.has(node.id)) return true;
        if (hovFolderId && node.folderId === hovFolderId) return true;
        return false;
      };

      const vis = nodes.filter(n => {
        if (n.type === 'folder') return ctrl.showFolders;
        if (ctrl.hideOrphans && (degreeMap.get(n.id) ?? 0) === 0) return false;
        return true;
      });
      const visE = ctrl.showFolders ? edges : edges.filter(e => {
        const a = nodesRef.current.get(e.from), b = nodesRef.current.get(e.to);
        return a?.type !== 'folder' && b?.type !== 'folder';
      });

      // Curved edges (quadratic bezier)
      visE.forEach(({ from, to, kind }) => {
        const a = nodesRef.current.get(from), b = nodesRef.current.get(to);
        if (!a || !b) return;
        const isFE  = a.type === 'folder' || b.type === 'folder';
        const isSem = kind === 'semantic';
        const hi   = !isFE && (from === activeNoteId || to === activeNoteId);
        const dim  = (!!hovId || hasQuery) && !isHi(a) && !isHi(b);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
        ctx.globalAlpha = dim ? 0.05 : isFE ? 0.18 : isSem ? (hi ? 0.55 : 0.28) : hi ? 0.65 : 0.35;
        if (isFE) ctx.setLineDash([3 / cam.zoom, 5 / cam.zoom]);
        else if (isSem) ctx.setLineDash([4 / cam.zoom, 4 / cam.zoom]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx - (dy / len) * len * 0.1, my + (dx / len) * len * 0.1, b.x, b.y);
        let edgeColor = '#6c7086';
        if (isFE) edgeColor = '#f9e2af';
        else if (isSem) edgeColor = '#94e2d5';
        else if (a.folderId && a.folderId === b.folderId) edgeColor = getFolderColorHSL(a.folderId, -5);
        else if (hi) edgeColor = '#89b4fa';
        ctx.strokeStyle = edgeColor;
        ctx.lineWidth = (hi ? 1.4 : 0.7) / cam.zoom;
        ctx.stroke();
        if (isFE || isSem) ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      });

      // Nodes: notes first, folders on top
      [...vis.filter(n => n.type !== 'folder'), ...vis.filter(n => n.type === 'folder')].forEach(node => {
        const isFol = node.type === 'folder';
        const isAct = node.id === activeNoteId;
        const isLnk = !isFol && edges.some(e => (e.from === activeNoteId && e.to === node.id) || (e.to === activeNoteId && e.from === node.id));
        const isHov = node.id === hoveredRef.current;
        const r     = isFol ? 7 : nodeRadius(node.id);
        const dim   = (!!hovId || hasQuery) && !isHi(node);

        ctx.globalAlpha = dim ? 0.1 : 1;
        const folderColor     = getFolderColorHSL(node.folderId);
        const folderColorDark = getFolderColorHSL(node.folderId, -15);
        if (isAct) { ctx.shadowColor = folderColor; ctx.shadowBlur = 18 / cam.zoom; }
        else if (isHov) { ctx.shadowColor = '#cdd6f4'; ctx.shadowBlur = 10 / cam.zoom; }

        if (isFol) {
          const d = isHov ? 9 : 7;
          ctx.beginPath();
          ctx.moveTo(node.x, node.y - d); ctx.lineTo(node.x + d, node.y);
          ctx.lineTo(node.x, node.y + d); ctx.lineTo(node.x - d, node.y);
          ctx.closePath();
          ctx.fillStyle = isHov ? '#fde68a' : '#f9e2af';
        } else {
          // Radial gradient colored by folder membership
          const gr = ctx.createRadialGradient(node.x - r * .3, node.y - r * .35, r * .05, node.x, node.y, r);
          if (isAct) {
            gr.addColorStop(0, '#ffffff');
            gr.addColorStop(0.3, folderColor);
            gr.addColorStop(1, folderColorDark);
          } else if (isLnk) {
            gr.addColorStop(0, getFolderColorHSL(node.folderId, 15));
            gr.addColorStop(1, folderColor);
          } else {
            gr.addColorStop(0, folderColor);
            gr.addColorStop(1, folderColorDark);
          }
          ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
          ctx.fillStyle = gr;
        }
        ctx.fill();
        ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

        const showLbl = !dim && (isFol || isAct || isHov || ctrl.allLabels || (cam.zoom > 0.65 && (isLnk || r > 6)));
        if (showLbl) {
          const lbl = node.title.length > 20 ? node.title.slice(0, 18) + '…' : node.title;
          const fs = Math.max(7, 9 / cam.zoom);
          ctx.font = `${isAct || isFol ? '600' : '400'} ${fs}px 'DM Sans', sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          const tw = ctx.measureText(lbl).width;
          const lx = node.x, ly = node.y + (isFol ? 9 : r) + 2;
          // Pill label background
          const pd = 4, bx = lx - tw / 2 - pd, by = ly - 1, bw = tw + pd * 2, bh = fs + 4, rr = 3;
          ctx.fillStyle = 'rgba(17,17,27,0.82)';
          ctx.beginPath();
          ctx.moveTo(bx + rr, by); ctx.lineTo(bx + bw - rr, by);
          ctx.arcTo(bx + bw, by, bx + bw, by + rr, rr); ctx.lineTo(bx + bw, by + bh - rr);
          ctx.arcTo(bx + bw, by + bh, bx + bw - rr, by + bh, rr); ctx.lineTo(bx + rr, by + bh);
          ctx.arcTo(bx, by + bh, bx, by + bh - rr, rr); ctx.lineTo(bx, by + rr);
          ctx.arcTo(bx, by, bx + rr, by, rr); ctx.closePath(); ctx.fill();
          ctx.fillStyle = isFol ? '#f9e2af' : isAct ? '#ffffff' : getFolderColorHSL(node.folderId, 20);
          ctx.fillText(lbl, lx, ly);
        }
        ctx.globalAlpha = 1;
      });

      ctx.restore();

      const energy = nodes.filter(n => n.type !== 'folder').reduce((s, n) => s + n.vx * n.vx + n.vy * n.vy, 0);
      const camLive = Math.abs(cam.x - tgt.x) + Math.abs(cam.y - tgt.y) + Math.abs(cam.zoom - tgt.zoom) > 0.5;
      if (!ctrl.paused && energy < 0.05 && !drag.nodeId && !drag.panning && !camLive) {
        sleeping = true; return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('mousedown',  wake);
      canvas.removeEventListener('mousemove',  wake);
      canvas.removeEventListener('touchstart', wake);
      canvas.removeEventListener('touchmove',  wake);
      canvas.removeEventListener('wheel',      wake);
    };
  }, [graphData, edges, activeNoteId, degreeMap, W, H, zoomToFit]);

  // Unified pointer position from mouse or touch
  const clientXY = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const src = 'touches' in e
      ? (e.touches[0] ?? e.changedTouches[0])
      : e;
    return src ? { clientX: src.clientX, clientY: src.clientY } : null;
  };

  const getPos = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const pt = clientXY(e);
    if (!pt) return null;
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: (pt.clientX - rect.left) * (W / rect.width),
      y: (pt.clientY - rect.top)  * (H / rect.height),
    };
  };

  const pinchRef = useRef<{ dist: number } | null>(null);

  const pointerDown = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if ('touches' in e && e.touches.length === 2) return; // handled by pinch
    const pos = getPos(e);
    if (!pos) return;
    const nodeId = hitTest(pos.x, pos.y);
    dragRef.current = { nodeId, startX: pos.x, startY: pos.y, lastX: pos.x, lastY: pos.y, panning: !nodeId };
  };

  const pointerMove = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    // Pinch-to-zoom (two fingers)
    if ('touches' in e && e.touches.length === 2) {
      e.preventDefault();
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      if (pinchRef.current) {
        const delta = dist / pinchRef.current.dist;
        const mx = (t1.clientX + t2.clientX) / 2;
        const my = (t1.clientY + t2.clientY) / 2;
        const rect = canvasRef.current!.getBoundingClientRect();
        const cx = (mx - rect.left) * (W / rect.width);
        const cy = (my - rect.top)  * (H / rect.height);
        const before = toWorld(cx, cy);
        camRef.current.zoom = Math.max(0.3, Math.min(4, camRef.current.zoom * delta));
        const after = toWorld(cx, cy);
        camRef.current.x += before.x - after.x;
        camRef.current.y += before.y - after.y;
      }
      pinchRef.current = { dist };
      return;
    }
    pinchRef.current = null;

    const pos = getPos(e);
    if (!pos) return;
    const d = dragRef.current;
    if (!('touches' in e)) hoveredRef.current = hitTest(pos.x, pos.y);
    if (d.nodeId) {
      const w = toWorld(pos.x, pos.y);
      const n = nodesRef.current.get(d.nodeId);
      if (n) { n.x = w.x; n.y = w.y; n.vx = 0; n.vy = 0; }
    } else if (d.panning) {
      const zoom = camRef.current.zoom;
      camRef.current.x -= (pos.x - d.lastX) / zoom;
      camRef.current.y -= (pos.y - d.lastY) / zoom;
    }
    d.lastX = pos.x; d.lastY = pos.y;
  };

  const pointerUp = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    pinchRef.current = null;
    const pos = getPos(e);
    if (!pos) return;
    const d = dragRef.current;
    const moved = Math.abs(pos.x - d.startX) + Math.abs(pos.y - d.startY);
    if (d.nodeId && moved < 8) onSelectNote?.(d.nodeId);
    dragRef.current = { nodeId: null, startX: 0, startY: 0, lastX: 0, lastY: 0, panning: false };
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x, y } = canvasXY(e);
    const before = toWorld(x, y);
    const nz = Math.max(0.3, Math.min(4, camRef.current.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    camRef.current.zoom = nz; targetCamRef.current.zoom = nz;
    const after = toWorld(x, y);
    camRef.current.x += before.x - after.x; camRef.current.y += before.y - after.y;
    targetCamRef.current.x = camRef.current.x; targetCamRef.current.y = camRef.current.y;
  };

  return (
    <div style={{ position: 'relative', width: W, height: H }}>
      <canvas
        ref={canvasRef}
        style={{ width: W, height: H, background: '#11111b', cursor: 'grab', display: 'block', touchAction: 'none' }}
        onMouseDown={pointerDown}
        onMouseMove={pointerMove}
        onMouseUp={pointerUp}
        onMouseLeave={() => { dragRef.current = { nodeId: null, startX: 0, startY: 0, lastX: 0, lastY: 0, panning: false }; hoveredRef.current = null; }}
        onTouchStart={pointerDown}
        onTouchMove={pointerMove}
        onTouchEnd={pointerUp}
        onWheel={onWheel}
      />
      {/* Floating graph controls */}
      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 5, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <button
          onClick={() => setShowCtrl(v => !v)}
          style={{ background: 'rgba(24,24,37,0.88)', border: `1px solid ${showCtrl ? '#89b4fa' : '#313244'}`, borderRadius: 6, color: showCtrl ? '#89b4fa' : '#585b70', cursor: 'pointer', padding: '2px 7px', fontSize: 11, backdropFilter: 'blur(8px)', fontFamily: 'inherit', lineHeight: '18px' }}
        >⚙</button>
        {showCtrl && (
          <div style={{ background: 'rgba(30,30,46,0.65)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '8px 10px', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', display: 'flex', flexDirection: 'column', gap: 7, minWidth: 166, fontSize: 12, color: '#a6adc8', boxShadow: '0 12px 40px rgba(0,0,0,0.5)' }}>
            <input
              type="text"
              placeholder="Filter nodes…"
              value={graphQuery}
              onChange={e => setGraphQuery(e.target.value)}
              style={{ background: '#11111b', border: '1px solid #313244', borderRadius: 4, padding: '4px 7px', color: '#cdd6f4', fontSize: 11, outline: 'none', width: '100%', fontFamily: 'inherit' }}
            />
            {([['Pause physics', paused, setPaused], ['Show folders', showFolders, setShowFolders], ['All labels', allLabels, setAllLabels], ['Hide orphans', hideOrphans, setHideOrphans], ['Semantic links', semEnabled, setSemEnabled]] as [string, boolean, (v: boolean) => void][]).map(([label, val, set]) => (
              <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox" checked={val} onChange={e => set(e.target.checked)} style={{ accentColor: '#89b4fa', cursor: 'pointer' }} />
                {label}
              </label>
            ))}
            {semEnabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#585b70' }}>
                  <span>Similarity ≥</span>
                  <span style={{ color: '#94e2d5' }}>{semThreshold.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.6} max={0.95} step={0.01}
                  value={semThreshold}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    setSemThreshold(v);
                    localStorage.setItem(SEM_THRESHOLD_KEY, String(v));
                  }}
                  style={{ accentColor: '#94e2d5', cursor: 'pointer', width: '100%' }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

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
  const [settingsProvider, setSettingsProvider] = useState<'ollama' | 'google' | 'openai'>('ollama');
  const [settingsGoogleKey, setSettingsGoogleKey] = useState('');
  const [settingsOpenaiKey, setSettingsOpenaiKey] = useState('');
  const [settingsOllamaModel, setSettingsOllamaModel] = useState('nomic-embed-text');
  const [settingsSaving, setSettingsSaving]   = useState(false);
  const [settingsStatus, setSettingsStatus]   = useState<string | null>(null);
  const [reindexRunning, setReindexRunning]   = useState(false);
  const [importRunning, setImportRunning]     = useState(false);

  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingFolderName, setRenamingFolderName] = useState('');
  const [toolbarEditingTitle, setToolbarEditingTitle] = useState(false);

  const [movingNote, setMovingNote]     = useState(false);
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

  // ── Load settings when modal opens ──────────────────────────────────────────
  useEffect(() => {
    if (!settingsOpen) return;
    apiFetch('/api/settings').then(r => r.json()).then(data => {
      setSettingsProvider(data.provider ?? 'ollama');
      setSettingsOllamaModel(data.ollamaModel ?? 'nomic-embed-text');
      setSettingsStatus(null);
    });
  }, [settingsOpen]);

  const saveSettings = async () => {
    setSettingsSaving(true);
    setSettingsStatus(null);
    try {
      const body: Record<string, string> = { provider: settingsProvider, ollamaModel: settingsOllamaModel };
      if (settingsGoogleKey) body.googleApiKey = settingsGoogleKey;
      if (settingsOpenaiKey) body.openaiApiKey = settingsOpenaiKey;
      const res = await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
      const data = await res.json();
      if (data.reindexTriggered) {
        setSettingsStatus('Saved. Reindexing…');
        setReindexRunning(true);
        const ri = await apiFetch('/api/admin/reindex', { method: 'POST' });
        const riData = await ri.json();
        setSettingsStatus(`Done. Reindexed ${riData.reindexed} notes.`);
        setReindexRunning(false);
      } else {
        setSettingsStatus('Settings saved.');
      }
    } catch {
      setSettingsStatus('Failed to save.');
    } finally {
      setSettingsSaving(false);
    }
  };

  const exportVault = async () => {
    setSettingsStatus('Exporting…');
    try {
      const res = await apiFetch('/api/export');
      if (!res.ok) { setSettingsStatus('Export failed.'); return; }
      const blob = await res.blob();
      const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'kybase-export.zip';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setSettingsStatus('Export downloaded.');
    } catch {
      setSettingsStatus('Export failed.');
    }
  };

  const importVault = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = ''; // allow re-selecting the same file
    if (!file) return;
    setImportRunning(true);
    setSettingsStatus('Importing…');
    try {
      const res = await apiFetch('/api/import', {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/zip' },
      });
      const data = await res.json();
      if (!res.ok) { setSettingsStatus(data.error ?? 'Import failed.'); return; }
      setSettingsStatus(`Imported ${data.imported}, updated ${data.updated}, skipped ${data.skipped}. Embeddings index in the background.`);
      const [notesData, foldersData] = await Promise.all([
        apiFetch('/api/notes').then(r => r.json()),
        apiFetch('/api/folders').then(r => r.json()),
      ]);
      setNotes(notesData);
      setFolders(foldersData);
    } catch {
      setSettingsStatus('Import failed.');
    } finally {
      setImportRunning(false);
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
      <style>{`
        * { margin: 0; padding: 0; box-sizing: border-box; }

        .kybase-app { font-family: 'DM Sans', sans-serif; background: #1e1e2e; color: #cdd6f4; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }

        .topbar { height: 48px; background: #181825; border-bottom: 1px solid #313244; display: flex; align-items: center; padding: 0 12px; gap: 8px; flex-shrink: 0; }
        .topbar-brand { font-weight: 700; font-size: 14px; color: #89b4fa; letter-spacing: -0.3px; display: flex; align-items: center; gap: 6px; }
        .topbar-brand span { background: linear-gradient(135deg,#89b4fa,#b4befe); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .topbar-btn { background: none; border: none; color: #6c7086; cursor: pointer; padding: 8px; border-radius: 4px; display: flex; align-items: center; transition: all 0.15s; min-width: 36px; min-height: 36px; justify-content: center; }
        .topbar-btn:hover { color: #cdd6f4; background: #313244; }
        .topbar-btn.active { color: #89b4fa; background: #313244; }
        .topbar-sep { flex: 1; }
        .topbar-note-title { font-size: 13px; color: #a6adc8; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }

        .main-layout { flex: 1; display: flex; overflow: hidden; position: relative; }

        .sidebar-overlay { display: none; }

        .sidebar { width: 260px; background: #181825; border-right: 1px solid #313244; display: flex; flex-direction: column; flex-shrink: 0; transition: margin-left 0.25s ease; }
        .sidebar.closed { margin-left: -260px; }
        .sidebar-header { padding: 10px 12px; display: flex; align-items: center; gap: 4px; border-bottom: 1px solid #252535; }
        .sidebar-header button { background: none; border: none; color: #6c7086; cursor: pointer; padding: 6px; border-radius: 4px; display: flex; align-items: center; transition: all 0.15s; min-width: 32px; min-height: 32px; justify-content: center; }
        .sidebar-header button:hover { color: #cdd6f4; background: #313244; }
        .focus-select { flex: 1; min-width: 0; background: #252535; border: 1px solid #313244; border-radius: 6px; color: #cdd6f4; font-size: 13px; font-family: inherit; padding: 6px 8px; cursor: pointer; outline: none; transition: border-color 0.15s; }
        .focus-select:hover, .focus-select:focus { border-color: #89b4fa; }
        .focus-select option { background: #1e1e2e; }

        .search-box { margin: 8px 10px; position: relative; }
        .search-box input { width: 100%; background: #11111b; border: 1px solid #313244; border-radius: 6px; color: #cdd6f4; padding: 9px 10px 9px 30px; font-size: 14px; font-family: inherit; outline: none; transition: border-color 0.15s; }
        .search-box input:focus { border-color: #89b4fa; }
        .search-box .search-icon { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); color: #585b70; }

        .tree-container { flex: 1; overflow-y: auto; padding: 4px 0; -webkit-overflow-scrolling: touch; }
        .tree-container::-webkit-scrollbar { width: 4px; }
        .tree-container::-webkit-scrollbar-thumb { background: #313244; border-radius: 2px; }

        .tree-item { display: flex; align-items: center; gap: 6px; padding: 9px 12px; cursor: pointer; font-size: 14px; transition: background 0.1s; position: relative; min-height: 44px; }
        .tree-item:hover { background: #252535; }
        .tree-item.active { background: #313244; }
        .tree-item.active::before { content: ''; position: absolute; left: 0; top: 2px; bottom: 2px; width: 2px; background: #89b4fa; border-radius: 0 2px 2px 0; }
        .tree-icon { color: #585b70; display: flex; flex-shrink: 0; }
        .tree-item.active .tree-icon { color: #89b4fa; }
        .tree-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #bac2de; }
        .tree-item.active .tree-label { color: #cdd6f4; font-weight: 500; }
        .chevron { display: flex; color: #585b70; transition: transform 0.15s; flex-shrink: 0; }
        .tree-action { background: none; border: none; color: #45475a; cursor: pointer; padding: 6px; border-radius: 3px; display: flex; align-items: center; transition: all 0.1s; opacity: 0; min-width: 28px; min-height: 28px; justify-content: center; }
        .tree-item:hover .tree-action { opacity: 1; }
        .tree-action:hover { color: #cdd6f4; background: #313244; }
        .tree-action.delete:hover { color: #f38ba8; }
        .folder-item .tree-label { font-weight: 500; color: #a6adc8; }

        .editor-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
        .editor-toolbar { min-height: 44px; background: #1e1e2e; border-bottom: 1px solid #252535; display: flex; align-items: center; padding: 0 12px; gap: 4px; flex-wrap: wrap; overflow-x: auto; }
        .editor-toolbar button { background: none; border: none; color: #6c7086; cursor: pointer; padding: 6px 10px; border-radius: 4px; display: flex; align-items: center; gap: 4px; font-size: 13px; font-family: inherit; transition: all 0.15s; min-height: 36px; white-space: nowrap; }
        .editor-toolbar button:hover { color: #cdd6f4; background: #313244; }
        .editor-toolbar button.active { color: #89b4fa; background: #313244; }
        .editor-toolbar .sep { flex: 1; }
        .tag-pill { font-size: 11px; background: #313244; color: #89b4fa; padding: 2px 8px; border-radius: 10px; font-weight: 500; white-space: nowrap; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; transition: background 0.15s; }
        .tag-pill:hover { background: #45475a; }
        .tag-pill .tag-x { opacity: 0; color: #f38ba8; font-size: 13px; line-height: 1; transition: opacity 0.15s; }
        .tag-pill:hover .tag-x { opacity: 0.7; }
        .tag-pill .tag-x:hover { opacity: 1; }
        .editor-toolbar .tag-add-btn { font-size: 11px; color: #6c7086; background: none; border: 1px dashed #45475a; padding: 2px 8px; border-radius: 10px; cursor: pointer; font-weight: 500; font-family: inherit; white-space: nowrap; min-height: 0; transition: all 0.15s; }
        .editor-toolbar .tag-add-btn:hover { color: #89b4fa; border-color: #89b4fa; background: #313244; }
        .tag-input { font-size: 11px; background: #313244; border: 1px solid #89b4fa; border-radius: 10px; color: #cdd6f4; padding: 2px 8px; width: 90px; outline: none; font-family: inherit; }
        .tag-filter-bar { padding: 8px 12px 0; }
        .tag-filter-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; background: #313244; color: #89b4fa; padding: 3px 10px; border-radius: 10px; font-weight: 500; border: 1px solid #45475a; }
        .tag-filter-chip span { cursor: pointer; color: #f38ba8; font-size: 14px; line-height: 1; }
        .tag-filter-chip span:hover { color: #f5a3b8; }

        .editor-content { flex: 1; overflow-y: auto; padding: 24px 32px; -webkit-overflow-scrolling: touch; }
        .editor-content::-webkit-scrollbar { width: 6px; }
        .editor-content::-webkit-scrollbar-thumb { background: #313244; border-radius: 3px; }
        .editor-content textarea { width: 100%; height: 100%; background: transparent; border: none; color: #cdd6f4; font-family: 'JetBrains Mono', monospace; font-size: 14px; line-height: 1.7; resize: none; outline: none; }

        .markdown-preview { font-size: 15px; line-height: 1.75; color: #cdd6f4; max-width: 760px; }
        .markdown-preview h1 { font-size: 26px; font-weight: 700; color: #cdd6f4; margin: 0 0 16px; padding-bottom: 8px; border-bottom: 1px solid #313244; }
        .markdown-preview h2 { font-size: 20px; font-weight: 600; color: #cdd6f4; margin: 24px 0 12px; }
        .markdown-preview h3 { font-size: 16px; font-weight: 600; color: #bac2de; margin: 20px 0 8px; }
        .markdown-preview p { margin: 8px 0; }
        .markdown-preview strong { color: #f5c2e7; }
        .markdown-preview li { color: #bac2de; }

        .wikilink { color: #89b4fa; cursor: pointer; text-decoration: none; border-bottom: 1px dashed #89b4fa44; transition: all 0.15s; padding: 0 2px; }
        .wikilink:hover { background: #89b4fa22; border-bottom-color: #89b4fa; }
        .wikilink.missing { color: #a6adc8; border-bottom-style: dotted; border-bottom-color: #a6adc844; }
        .wikilink.missing:hover { background: #a6adc822; }

        .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #585b70; gap: 12px; }
        .empty-state-text { font-size: 14px; }

        .right-panel { background: #181825; border-left: 1px solid #313244; flex-shrink: 0; overflow-y: auto; display: flex; flex-direction: column; -webkit-overflow-scrolling: touch; position: relative; }
        .panel-resize-handle { position: absolute; left: 0; top: 0; bottom: 0; width: 4px; cursor: col-resize; z-index: 10; background: transparent; transition: background 0.15s; }
        .panel-resize-handle:hover { background: #89b4fa44; }
        .right-panel::-webkit-scrollbar { width: 4px; }
        .right-panel::-webkit-scrollbar-thumb { background: #313244; border-radius: 2px; }
        .right-panel-header { padding: 12px 14px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #6c7086; border-bottom: 1px solid #252535; }
        .right-panel-body { padding: 12px; }

        .backlink-item { padding: 10px 12px; background: #11111b; border-radius: 6px; margin-bottom: 8px; cursor: pointer; transition: background 0.15s; }
        .backlink-item:hover { background: #1e1e2e; }
        .backlink-title { font-size: 13px; font-weight: 600; color: #89b4fa; margin-bottom: 4px; }
        .backlink-excerpt { font-size: 12px; color: #6c7086; line-height: 1.5; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }

        .ai-search-bar { padding: 12px; border-bottom: 1px solid #252535; }
        .ai-input-row { display: flex; gap: 6px; }
        .ai-input-row input { flex: 1; background: #11111b; border: 1px solid #313244; border-radius: 6px; color: #cdd6f4; padding: 9px 10px; font-size: 14px; font-family: inherit; outline: none; }
        .ai-input-row input:focus { border-color: #b4befe; }
        .ai-input-row button { background: linear-gradient(135deg,#89b4fa,#b4befe); border: none; color: #1e1e2e; padding: 0 14px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; font-family: inherit; transition: opacity 0.15s; min-height: 38px; }
        .ai-input-row button:hover { opacity: 0.85; }
        .ai-input-row button:disabled { opacity: 0.5; cursor: not-allowed; }

        .ai-result-item { padding: 10px 12px; background: #11111b; border-radius: 6px; margin-bottom: 8px; cursor: pointer; transition: all 0.15s; border-left: 3px solid transparent; }
        .ai-result-item:hover { background: #1e1e2e; border-left-color: #b4befe; }
        .ai-result-title { font-size: 13px; font-weight: 600; color: #b4befe; margin-bottom: 2px; }
        .ai-result-excerpt { font-size: 11px; color: #6c7086; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .ai-result-tags { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
        .ai-result-tags span { font-size: 10px; background: #313244; color: #89b4fa; padding: 1px 6px; border-radius: 8px; }

        .ai-loading { display: flex; align-items: center; justify-content: center; padding: 24px; color: #6c7086; font-size: 13px; gap: 8px; }
        .ai-spinner { width: 16px; height: 16px; border: 2px solid #313244; border-top-color: #89b4fa; border-radius: 50%; animation: spin 0.6s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        @media (max-width: 767px) {
          .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 50; }
          .sidebar-overlay.visible { display: block; }
          .sidebar { position: fixed; top: 48px; left: 0; bottom: 0; z-index: 60; margin-left: 0; transition: transform 0.25s ease; transform: translateX(-260px); box-shadow: 4px 0 24px rgba(0,0,0,0.4); }
          .sidebar.open { transform: translateX(0); }
          .sidebar.closed { transform: translateX(-260px); }
          .topbar-note-title { max-width: 120px; }
          .right-panel { position: fixed; left: 0; right: 0; bottom: 0; width: 100% !important; height: 55vh; border-top: 1px solid #313244; border-left: none; border-radius: 12px 12px 0 0; z-index: 65; box-shadow: 0 -4px 24px rgba(0,0,0,0.5); }
          .right-panel.graph-fullscreen { height: 100dvh; border-radius: 0; top: 0; }
          .panel-resize-handle { display: none; }
          .drawer-handle { display: flex; justify-content: center; padding: 8px 0 4px; cursor: grab; flex-shrink: 0; }
          .drawer-handle::after { content: ''; width: 36px; height: 4px; background: #45475a; border-radius: 2px; display: block; }
          .editor-content { padding: 16px; }
          .tree-action { opacity: 1; }
        }

        @media (min-width: 768px) {
          .drawer-handle { display: none; }
          .right-panel { transition: width 0.25s ease; }
        }
      `}</style>

      <div className="kybase-app">
        {/* Top Bar */}
        <div className="topbar">
          <button className="topbar-btn" onClick={() => setSidebarOpen(v => !v)}>
            {Icons.sidebar}
          </button>
          <div className="topbar-brand">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="3" width="18" height="18" rx="3" stroke="url(#g1)" strokeWidth="2" />
              <path d="M8 12h8M12 8v8" stroke="url(#g1)" strokeWidth="2" strokeLinecap="round" />
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
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <path d="M8 12h8M12 8v8" strokeLinecap="round" />
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
      {settingsOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={e => { if (e.target === e.currentTarget) setSettingsOpen(false); }}>
          <div style={{ background: 'rgba(30,30,46,0.85)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', border: '1px solid rgba(69,71,90,0.6)', borderRadius: 12, padding: 24, width: 'min(420px, calc(100vw - 32px))', boxShadow: '0 8px 48px rgba(0,0,0,0.6)', maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <span style={{ fontWeight: 600, fontSize: 15, color: '#cdd6f4' }}>Embedding Provider</span>
              <button onClick={() => setSettingsOpen(false)} style={{ background: 'none', border: 'none', color: '#585b70', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
            </div>

            <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>Provider</label>
            <select value={settingsProvider} onChange={e => setSettingsProvider(e.target.value as 'ollama' | 'google' | 'openai')} style={{ width: '100%', background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 16, outline: 'none' }}>
              <option value="ollama">Ollama (local, free)</option>
              <option value="google">Google text-embedding-004 (free tier)</option>
              <option value="openai">OpenAI text-embedding-3-small</option>
            </select>

            {settingsProvider === 'ollama' && (
              <>
                <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>Model</label>
                <input value={settingsOllamaModel} onChange={e => setSettingsOllamaModel(e.target.value)} placeholder="nomic-embed-text" style={{ width: '100%', background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 16, outline: 'none' }} />
              </>
            )}

            {settingsProvider === 'google' && (
              <>
                <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>Google API Key</label>
                <input type="password" value={settingsGoogleKey} onChange={e => setSettingsGoogleKey(e.target.value)} placeholder="AIza… (leave blank to keep current)" style={{ width: '100%', background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 16, outline: 'none' }} />
                <div style={{ fontSize: 11, color: '#585b70', marginBottom: 16, lineHeight: 1.5 }}>Free tier: 1500 requests/day. Get a key: aistudio.google.com/apikey</div>
              </>
            )}

            {settingsProvider === 'openai' && (
              <>
                <label style={{ fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 6 }}>OpenAI API Key</label>
                <input type="password" value={settingsOpenaiKey} onChange={e => setSettingsOpenaiKey(e.target.value)} placeholder="sk-… (leave blank to keep current)" style={{ width: '100%', background: '#11111b', border: '1px solid #313244', borderRadius: 6, color: '#cdd6f4', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', marginBottom: 16, outline: 'none' }} />
              </>
            )}

            <div style={{ fontSize: 11, color: '#6c7086', background: '#11111b', borderRadius: 6, padding: '8px 10px', marginBottom: 16 }}>
              Switching the provider automatically re-indexes all notes.
            </div>

            {settingsStatus && (
              <div style={{ fontSize: 12, color: reindexRunning ? '#f9e2af' : '#a6e3a1', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                {reindexRunning && <div style={{ width: 10, height: 10, border: '2px solid #313244', borderTopColor: '#f9e2af', borderRadius: '50%', animation: 'spin 0.6s linear infinite', flexShrink: 0 }} />}
                {settingsStatus}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={async () => {
                  setReindexRunning(true);
                  setSettingsStatus('Reindexing…');
                  try {
                    const ri = await apiFetch('/api/admin/reindex', { method: 'POST' });
                    const riData = await ri.json();
                    setSettingsStatus(`Done. Reindexed ${riData.reindexed} notes.`);
                  } catch {
                    setSettingsStatus('Reindex failed.');
                  } finally {
                    setReindexRunning(false);
                  }
                }}
                disabled={reindexRunning || settingsSaving}
                style={{ flex: 1, background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#cdd6f4', padding: '9px 0', fontSize: 13, fontWeight: 600, cursor: reindexRunning || settingsSaving ? 'not-allowed' : 'pointer', opacity: reindexRunning || settingsSaving ? 0.7 : 1, fontFamily: 'inherit' }}
              >
                {reindexRunning ? 'Indexing…' : 'Reindex'}
              </button>
              <button
                onClick={saveSettings}
                disabled={settingsSaving || reindexRunning}
                style={{ flex: 2, background: '#89b4fa', border: 'none', borderRadius: 6, color: '#1e1e2e', padding: '9px 0', fontSize: 13, fontWeight: 600, cursor: settingsSaving || reindexRunning ? 'not-allowed' : 'pointer', opacity: settingsSaving || reindexRunning ? 0.7 : 1, fontFamily: 'inherit' }}
              >
                {settingsSaving ? 'Saving…' : 'Save & Apply'}
              </button>
            </div>

            <div style={{ borderTop: '1px solid #313244', marginTop: 16, paddingTop: 12 }}>
              <div style={{ fontSize: 11, color: '#6c7086', marginBottom: 8 }}>
                Vault backup — markdown files with frontmatter, folders as directories.
                Import skips notes whose titles already exist.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={exportVault}
                  disabled={importRunning}
                  style={{ flex: 1, background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#cdd6f4', padding: '9px 0', fontSize: 13, fontWeight: 600, cursor: importRunning ? 'not-allowed' : 'pointer', opacity: importRunning ? 0.7 : 1, fontFamily: 'inherit' }}
                >
                  Export .zip
                </button>
                <label
                  style={{ flex: 1, background: '#313244', border: '1px solid #45475a', borderRadius: 6, color: '#cdd6f4', padding: '9px 0', fontSize: 13, fontWeight: 600, cursor: importRunning ? 'not-allowed' : 'pointer', opacity: importRunning ? 0.7 : 1, fontFamily: 'inherit', textAlign: 'center' }}
                >
                  {importRunning ? 'Importing…' : 'Import .zip'}
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    disabled={importRunning}
                    onChange={e => importVault(e.target)}
                    style={{ display: 'none' }}
                  />
                </label>
              </div>
            </div>
          </div>
        </div>
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
