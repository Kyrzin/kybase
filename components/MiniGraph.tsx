'use client';

// components/MiniGraph.tsx — the force-directed knowledge-graph canvas,
// extracted verbatim from KybaseApp. Owns the kybase_sem_threshold key.
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

const SEM_THRESHOLD_KEY = 'kybase_sem_threshold';

// ─── Mini Graph (force-directed) ─────────────────────────────────────────────
type GraphEdge = { from: string; to: string; kind?: 'semantic'; score?: number };
export type GraphData = { nodes: { id: string; title: string; type: 'note' | 'folder'; folderId?: string | null }[]; edges: GraphEdge[] };
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

export default function MiniGraph({ graphData, activeNoteId, onSelectNote, w = 320, h = 280, fitRef }: {
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
