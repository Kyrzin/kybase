'use client';

// components/MiniGraph.tsx — Elegant, high-performance force-directed knowledge-graph
// Feature-rich visualizer with label collision culling, spotlight focus, particle flow, and noble aesthetics.

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

const SEM_THRESHOLD_KEY = 'kybase_sem_threshold';

// ─── Types & Constants ────────────────────────────────────────────────────────
type GraphEdge = { from: string; to: string; kind?: 'semantic'; score?: number };
export type GraphData = {
  nodes: { id: string; title: string; type: 'note' | 'folder'; folderId?: string | null }[];
  edges: GraphEdge[];
};
type NodeState = {
  id: string;
  title: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  type: 'note' | 'folder';
  folderId?: string | null;
};

const FRICTION = 0.72;
const REPULSION = 2400;
const SPRING_K = 0.035;
const REST_LEN = 95;
const GRAVITY = 0.012;

// Elegant jewel-tone HSL palette derived from folder ID
const getFolderColorHSL = (folderId: string | null | undefined, lightnessOffset = 0, satOffset = 0): string => {
  if (!folderId) return `hsl(230, ${15 + satOffset}%, ${55 + lightnessOffset}%)`;
  let hash = 0;
  for (let i = 0; i < folderId.length; i++) hash = folderId.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash % 360);
  const sat = Math.max(50, Math.min(85, 68 + satOffset));
  const light = Math.max(25, Math.min(82, 64 + lightnessOffset));
  return `hsl(${hue}, ${sat}%, ${light}%)`;
};

export default function MiniGraph({
  graphData,
  activeNoteId,
  onSelectNote,
  w = 320,
  h = 280,
  fitRef,
}: {
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
  const dragRef      = useRef<{ nodeId: string | null; startX: number; startY: number; lastX: number; lastY: number; panning: boolean }>({
    nodeId: null, startX: 0, startY: 0, lastX: 0, lastY: 0, panning: false,
  });
  const hoveredRef   = useRef<string | null>(null);
  const wakeRef      = useRef<() => void>(() => {});
  const warmedRef    = useRef(false);
  const animTimeRef  = useRef(0);
  const alphaRef     = useRef(1.0);

  // Controls
  const [showCtrl,     setShowCtrl]     = useState(false);
  const [paused,       setPaused]       = useState(false);
  const [showFolders,  setShowFolders]  = useState(true);
  const [allLabels,    setAllLabels]    = useState(false);
  const [graphQuery,   setGraphQuery]   = useState('');
  const [hideOrphans,  setHideOrphans]  = useState(false);
  const [semEnabled,   setSemEnabled]   = useState(true);
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

  // Semantic edges filtering
  const edges = useMemo(
    () => graphData.edges.filter(e => e.kind !== 'semantic' || (semEnabled && (e.score ?? 0) >= semThreshold)),
    [graphData.edges, semEnabled, semThreshold]
  );

  // Sync nodes — keep existing positions, position new ones in circle
  useEffect(() => {
    const prev = nodesRef.current;
    const next = new Map<string, NodeState>();
    graphData.nodes.forEach((n, i) => {
      if (prev.has(n.id)) {
        next.set(n.id, { ...prev.get(n.id)!, title: n.title, type: n.type, folderId: n.folderId });
      } else {
        const angle = (i / Math.max(graphData.nodes.length, 1)) * Math.PI * 2;
        const r = Math.max(Math.min(W, H) * 0.3, Math.sqrt(graphData.nodes.length) * REST_LEN * 0.6);
        next.set(n.id, {
          id: n.id,
          title: n.title,
          type: n.type,
          folderId: n.folderId,
          x: W / 2 + Math.cos(angle) * r,
          y: H / 2 + Math.sin(angle) * r,
          vx: 0,
          vy: 0,
        });
      }
    });
    nodesRef.current = next;
  }, [graphData, W, H]);

  // Node degrees for sizing
  const degreeMap = useMemo(() => {
    const m = new Map<string, number>();
    edges.forEach(({ from, to }) => {
      m.set(from, (m.get(from) ?? 0) + 1);
      m.set(to, (m.get(to) ?? 0) + 1);
    });
    return m;
  }, [edges]);

  const nodeRadius = useCallback((id: string) => {
    if (id.startsWith('f:')) return 7;
    const deg = degreeMap.get(id) ?? 0;
    return Math.min(14, 4.5 + Math.sqrt(deg) * 1.8);
  }, [degreeMap]);

  const zoomToFit = useCallback(() => {
    const noteNodes = Array.from(nodesRef.current.values()).filter(n => n.type === 'note');
    if (!noteNodes.length) return;
    const xs = noteNodes.map(n => n.x), ys = noteNodes.map(n => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 50;
    const zoom = Math.min(Math.max(0.4, Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxY - minY || 1))), 1.8);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    camRef.current = { x: cx, y: cy, zoom };
    targetCamRef.current = { x: cx, y: cy, zoom };
  }, [W, H]);

  useEffect(() => { if (fitRef) fitRef.current = zoomToFit; }, [fitRef, zoomToFit]);

  // Smooth camera pan to active note
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
    for (const n of [...ns.filter(n => n.type === 'folder'), ...ns.filter(n => n.type !== 'folder')]) {
      const sx = (n.x - cam.x) * cam.zoom + W / 2;
      const sy = (n.y - cam.y) * cam.zoom + H / 2;
      const r  = (n.type === 'folder' ? 8 : nodeRadius(n.id)) * cam.zoom + 5;
      if ((cx - sx) ** 2 + (cy - sy) ** 2 <= r * r) return n.id;
    }
    return null;
  };

  const canvasXY = (e: React.MouseEvent<HTMLCanvasElement> | React.WheelEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (W / rect.width), y: (e.clientY - rect.top) * (H / rect.height) };
  };

  // Main Animation & Physics Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    // Physics Step with cooling temperature alpha
    const step = () => {
      const alpha = alphaRef.current;
      if (alpha < 0.003) return; // Simulation settled completely

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
          
          // Softened repulsion — smooth force curve without near-zero spikes
          fx += (dx / d) * (REPULSION / (d2 + 1200));
          fy += (dy / d) * (REPULSION / (d2 + 1200));

          // Soft collision buffer (prevents harsh bouncing / vibration)
          const minD = nodeRadius(a.id) + nodeRadius(b.id) + 14;
          const overlap = minD - d;
          if (overlap > 0) {
            const push = (overlap / d) * 0.15;
            fx += dx * push;
            fy += dy * push;
          }
        }

        edges.forEach(({ from, to, kind }) => {
          const oid = from === a.id ? to : to === a.id ? from : null;
          if (!oid) return;
          const b = nodesRef.current.get(oid);
          if (!b || b.type === 'folder') return;
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
          const k = SPRING_K * (kind === 'semantic' ? 0.3 : 1);
          fx += (dx / d) * (d - REST_LEN) * k;
          fy += (dy / d) * (d - REST_LEN) * k;
        });

        // Apply forces scaled by cooling temperature alpha
        a.vx = (a.vx + fx * alpha) * FRICTION;
        a.vy = (a.vy + fy * alpha) * FRICTION;

        // Velocity cap — prevents node snapping/teleportation
        const spd = Math.sqrt(a.vx * a.vx + a.vy * a.vy);
        if (spd > 3.0) {
          a.vx = (a.vx / spd) * 3.0;
          a.vy = (a.vy / spd) * 3.0;
        }
        a.x += a.vx;
        a.y += a.vy;
      }

      // Cool simulation temperature
      alphaRef.current = alpha * 0.975;

      // Smooth lerp for folder centroids
      nodes.forEach(node => {
        if (node.type !== 'folder' || drag.nodeId === node.id) return;
        const peers = edges
          .filter(e => e.from === node.id || e.to === node.id)
          .map(e => nodesRef.current.get(e.from === node.id ? e.to : e.from))
          .filter((n): n is NodeState => !!n && n.type === 'note');
        if (peers.length) {
          const tx = peers.reduce((s, n) => s + n.x, 0) / peers.length;
          const ty = peers.reduce((s, n) => s + n.y, 0) / peers.length;
          node.x += (tx - node.x) * 0.08;
          node.y += (ty - node.y) * 0.08;
        }
      });
    };

    if (!warmedRef.current) {
      if (!ctrlRef.current.paused) {
        for (let s = 0; s < 70; s++) step();
      }
      warmedRef.current = true;
    } else if (!ctrlRef.current.paused) {
      // alphaRef only ever cools (× 0.975 per step) and never resets on its
      // own — once it decays under the 0.003 floor, step() permanently
      // no-ops. Every later remount (a note added, edges/threshold changed)
      // places or re-links nodes without ever pushing them apart again, so
      // they sit wherever they land — including on top of each other,
      // forever. Reheat here so the per-frame loop below can actually
      // re-equilibrate the new layout instead of staying frozen.
      alphaRef.current = Math.max(alphaRef.current, 0.5);
    }
    zoomToFit();

    let raf = -1;
    let sleeping = false;

    const wake = () => {
      if (sleeping) {
        sleeping = false;
        raf = requestAnimationFrame(tick);
      }
    };
    wakeRef.current = wake;

    canvas.addEventListener('mousedown',  wake);
    canvas.addEventListener('mousemove',  wake);
    canvas.addEventListener('touchstart', wake, { passive: true });
    canvas.addEventListener('touchmove',  wake, { passive: true });
    canvas.addEventListener('wheel',      wake, { passive: true });

    const tick = () => {
      animTimeRef.current += 0.02;
      const tTime = animTimeRef.current;
      const nodes = Array.from(nodesRef.current.values());
      const drag  = dragRef.current;
      const ctrl  = ctrlRef.current;

      if (!ctrl.paused) step();

      // Camera lerp
      const cam = camRef.current, tgt = targetCamRef.current;
      cam.x    += (tgt.x    - cam.x)    * 0.12;
      cam.y    += (tgt.y    - cam.y)    * 0.12;
      cam.zoom += (tgt.zoom - cam.zoom) * 0.12;

      ctx.clearRect(0, 0, W, H);

      // Deep Dark Background Vignette
      const bgGrad = ctx.createRadialGradient(W / 2, H / 2, W * 0.1, W / 2, H / 2, W * 0.7);
      bgGrad.addColorStop(0, '#13141f');
      bgGrad.addColorStop(1, '#0b0c14');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);

      // Subtle Spatial Dot Grid
      const gs = 32 * cam.zoom;
      if (gs > 6) {
        const offX = ((W / 2 - cam.x * cam.zoom) % gs + gs) % gs;
        const offY = ((H / 2 - cam.y * cam.zoom) % gs + gs) % gs;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        for (let gx = offX - gs; gx < W + gs; gx += gs) {
          for (let gy = offY - gs; gy < H + gs; gy += gs) {
            ctx.beginPath();
            ctx.arc(gx, gy, 0.75, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-cam.x, -cam.y);

      // Focus spotlight logic: 1st and 2nd degree neighbors
      const hovId = hoveredRef.current || activeNoteId;
      const hovNode = hovId ? nodesRef.current.get(hovId) : null;
      const hovFolderId = hovNode?.folderId;

      // Recomputed every frame, not memoized — hovId comes from a ref
      // (hoveredRef) that changes on mousemove without a React re-render, so
      // this can't be a real useMemo (which only reruns on render/deps
      // changes); calling the Hook here would violate Rules of Hooks anyway,
      // since tick() is a plain callback, not a component or custom Hook.
      const directNeighbors = (() => {
        if (!hovId) return new Set<string>();
        const s = new Set<string>();
        edges.forEach(e => {
          if (e.from === hovId) s.add(e.to);
          else if (e.to === hovId) s.add(e.from);
        });
        return s;
      })();

      const secondDegreeNeighbors = (() => {
        if (!hovId) return new Set<string>();
        const s = new Set<string>();
        directNeighbors.forEach(nid => {
          edges.forEach(e => {
            if (e.from === nid && e.to !== hovId) s.add(e.to);
            else if (e.to === nid && e.from !== hovId) s.add(e.from);
          });
        });
        return s;
      })();

      const hasQuery = !!ctrl.graphQuery;
      const getNodeHighlightState = (node: NodeState): 'active' | 'direct' | 'second' | 'dimmed' | 'normal' => {
        if (hasQuery) {
          return node.title.toLowerCase().includes(ctrl.graphQuery.toLowerCase()) ? 'direct' : 'dimmed';
        }
        if (!hovId) return 'normal';
        if (node.id === hovId) return 'active';
        if (directNeighbors.has(node.id)) return 'direct';
        if (secondDegreeNeighbors.has(node.id)) return 'second';
        if (hovFolderId && node.folderId === hovFolderId) return 'second';
        return 'dimmed';
      };

      const visNodes = nodes.filter(n => {
        if (n.type === 'folder') return ctrl.showFolders;
        if (ctrl.hideOrphans && (degreeMap.get(n.id) ?? 0) === 0) return false;
        return true;
      });

      const visEdges = ctrl.showFolders
        ? edges
        : edges.filter(e => {
            const a = nodesRef.current.get(e.from), b = nodesRef.current.get(e.to);
            return a?.type !== 'folder' && b?.type !== 'folder';
          });

      // Render Edges
      visEdges.forEach(({ from, to, kind }) => {
        const a = nodesRef.current.get(from), b = nodesRef.current.get(to);
        if (!a || !b) return;

        const isFE  = a.type === 'folder' || b.type === 'folder';
        const isSem = kind === 'semantic';
        const stateA = getNodeHighlightState(a);
        const stateB = getNodeHighlightState(b);

        const isEdgeHighlighted = (from === activeNoteId || to === activeNoteId || from === hoveredRef.current || to === hoveredRef.current);
        const isEdgeDimmed = hovId && !isEdgeHighlighted && stateA === 'dimmed' && stateB === 'dimmed';

        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx * dx + dy * dy) || 1;
        const cpx = mx - (dy / len) * len * 0.08;
        const cpy = my + (dx / len) * len * 0.08;

        ctx.globalAlpha = isEdgeDimmed ? 0.06 : isFE ? 0.2 : isSem ? (isEdgeHighlighted ? 0.6 : 0.3) : isEdgeHighlighted ? 0.75 : 0.4;

        if (isFE) ctx.setLineDash([3 / cam.zoom, 4 / cam.zoom]);
        else if (isSem) ctx.setLineDash([4 / cam.zoom, 4 / cam.zoom]);

        // Gradient Edge Stroke between connected node colors
        let strokeStyle: string | CanvasGradient = '#6c7086';
        if (isFE) strokeStyle = '#f9e2af';
        else if (isSem) strokeStyle = '#94e2d5';
        else if (a.folderId && a.folderId === b.folderId) strokeStyle = getFolderColorHSL(a.folderId, 5);
        else if (isEdgeHighlighted) strokeStyle = '#89b4fa';
        else {
          const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
          grad.addColorStop(0, getFolderColorHSL(a.folderId, 0));
          grad.addColorStop(1, getFolderColorHSL(b.folderId, 0));
          strokeStyle = grad;
        }

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = (isEdgeHighlighted ? 1.6 : 0.85) / cam.zoom;
        ctx.stroke();

        if (isFE || isSem) ctx.setLineDash([]);

        // Animated Particle Flow along highlighted edges
        if (isEdgeHighlighted && !isFE) {
          ctx.globalAlpha = 0.9;
          const pProgress = (tTime * 0.8 + ((a.x * 7 + b.y * 3) % 100) / 100) % 1;
          // Quadratic Bezier point at t
          const t = pProgress;
          const px = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * cpx + t * t * b.x;
          const py = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * cpy + t * t * b.y;

          ctx.beginPath();
          ctx.arc(px, py, (2.2 / cam.zoom), 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        }

        ctx.globalAlpha = 1;
      });

      // Label Bounding Box Occupancy Grid (to prevent text overlap)
      const placedLabels: { x: number; y: number; w: number; h: number }[] = [];

      // Render Nodes & Labels
      const sortedVis = [...visNodes.filter(n => n.type !== 'folder'), ...visNodes.filter(n => n.type === 'folder')];

      sortedVis.forEach(node => {
        const isFol = node.type === 'folder';
        const isAct = node.id === activeNoteId;
        const isHov = node.id === hoveredRef.current;
        const hState = getNodeHighlightState(node);
        const r = isFol ? 8 : nodeRadius(node.id);

        let alpha = 1;
        if (hState === 'dimmed') alpha = 0.12;
        else if (hState === 'second') alpha = 0.65;

        ctx.globalAlpha = alpha;

        const folderColor = getFolderColorHSL(node.folderId, 5, 10);
        const folderColorDark = getFolderColorHSL(node.folderId, -20, 10);

        // Animated Active Pulse Ring
        if (isAct) {
          const pulseR = r + Math.sin(tTime * 4) * 3 + 4;
          ctx.beginPath();
          ctx.arc(node.x, node.y, pulseR, 0, Math.PI * 2);
          ctx.strokeStyle = folderColor;
          ctx.lineWidth = 1.5 / cam.zoom;
          ctx.globalAlpha = alpha * (0.4 + Math.sin(tTime * 4) * 0.2);
          ctx.stroke();
          ctx.globalAlpha = alpha;
        }

        // Soft outer glow halo for active / hovered / hub nodes
        if ((isAct || isHov || r > 8) && alpha > 0.3) {
          const haloGrad = ctx.createRadialGradient(node.x, node.y, r * 0.5, node.x, node.y, r * 2.4);
          haloGrad.addColorStop(0, isHov ? 'rgba(255, 255, 255, 0.4)' : folderColor);
          haloGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
          ctx.beginPath();
          ctx.arc(node.x, node.y, r * 2.4, 0, Math.PI * 2);
          ctx.fillStyle = haloGrad;
          ctx.fill();
        }

        if (isFol) {
          // Diamond shape for folders
          const d = isHov ? 10 : 8;
          ctx.beginPath();
          ctx.moveTo(node.x, node.y - d);
          ctx.lineTo(node.x + d, node.y);
          ctx.lineTo(node.x, node.y + d);
          ctx.lineTo(node.x - d, node.y);
          ctx.closePath();
          ctx.fillStyle = isHov ? '#fde68a' : '#f9e2af';
          ctx.fill();
          ctx.strokeStyle = '#d4a373';
          ctx.lineWidth = 1 / cam.zoom;
          ctx.stroke();
        } else {
          // Sphere Gradient Node
          const gr = ctx.createRadialGradient(node.x - r * 0.3, node.y - r * 0.35, r * 0.1, node.x, node.y, r);
          if (isAct) {
            gr.addColorStop(0, '#ffffff');
            gr.addColorStop(0.35, folderColor);
            gr.addColorStop(1, folderColorDark);
          } else if (isHov) {
            gr.addColorStop(0, '#ffffff');
            gr.addColorStop(0.5, folderColor);
            gr.addColorStop(1, folderColorDark);
          } else {
            gr.addColorStop(0, folderColor);
            gr.addColorStop(1, folderColorDark);
          }

          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
          ctx.fillStyle = gr;
          ctx.fill();

          ctx.strokeStyle = isAct ? '#ffffff' : 'rgba(255, 255, 255, 0.2)';
          ctx.lineWidth = (isAct ? 1.5 : 0.6) / cam.zoom;
          ctx.stroke();
        }

        // Smart Label Rendering with Occlusion Culling
        const isPriorityLabel = isAct || isHov || (hasQuery && hState === 'direct');
        const isSecondaryLabel = ctrl.allLabels || (cam.zoom > 0.65 && (hState === 'direct' || r > 7.5 || isFol));
        const shouldAttemptLabel = alpha > 0.3 && (isPriorityLabel || isSecondaryLabel);

        if (shouldAttemptLabel) {
          const lbl = node.title.length > 22 ? node.title.slice(0, 20) + '…' : node.title;
          const fs = Math.max(7.5, 9.5 / cam.zoom);
          ctx.font = `${isAct || isFol || isHov ? '600' : '400'} ${fs}px -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif`;
          const tw = ctx.measureText(lbl).width;

          const lx = node.x;
          const ly = node.y + (isFol ? 10 : r) + 3;
          const pd = 5;
          const bx = lx - tw / 2 - pd;
          const by = ly - 1;
          const bw = tw + pd * 2;
          const bh = fs + 5;

          // Check Label Overlap (unless it's a high-priority hovered/active label)
          let hasOverlap = false;
          if (!isPriorityLabel) {
            for (const box of placedLabels) {
              if (bx < box.x + box.w && bx + bw > box.x && by < box.y + box.h && by + bh > box.y) {
                hasOverlap = true;
                break;
              }
            }
          }

          if (!hasOverlap) {
            placedLabels.push({ x: bx, y: by, w: bw, h: bh });

            // Glassmorphism Pill Label Background
            ctx.fillStyle = isAct
              ? 'rgba(24, 25, 38, 0.94)'
              : isHov
              ? 'rgba(20, 21, 33, 0.92)'
              : 'rgba(15, 16, 24, 0.84)';
            ctx.strokeStyle = isAct ? folderColor : 'rgba(255, 255, 255, 0.12)';
            ctx.lineWidth = 1 / cam.zoom;

            const rr = 4;
            ctx.beginPath();
            ctx.moveTo(bx + rr, by);
            ctx.lineTo(bx + bw - rr, by);
            ctx.arcTo(bx + bw, by, bx + bw, by + rr, rr);
            ctx.lineTo(bx + bw, by + bh - rr);
            ctx.arcTo(bx + bw, by + bh, bx + bw - rr, by + bh, rr);
            ctx.lineTo(bx + rr, by + bh);
            ctx.arcTo(bx, by + bh, bx, by + bh - rr, rr);
            ctx.lineTo(bx, by + rr);
            ctx.arcTo(bx, by, bx + rr, by, rr);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = isFol ? '#f9e2af' : isAct ? '#ffffff' : isHov ? '#e0e6f8' : getFolderColorHSL(node.folderId, 22);
            ctx.fillText(lbl, lx, ly + 1);
          }
        }

        ctx.globalAlpha = 1;
      });

      ctx.restore();

      // Energy check for idle simulation sleep
      const energy = nodes.filter(n => n.type !== 'folder').reduce((s, n) => s + n.vx * n.vx + n.vy * n.vy, 0);
      const camLive = Math.abs(cam.x - tgt.x) + Math.abs(cam.y - tgt.y) + Math.abs(cam.zoom - tgt.zoom) > 0.3;

      // Gate sleep on hoveredRef, NOT hovId: hovId falls back to activeNoteId,
      // which is almost always set, so the loop never slept and burned CPU the
      // whole time the graph was open. Only a live hover needs continuous
      // frames; the active-note spotlight (and its edge particles) freeze into
      // a static focus frame until the next hover/select/drag wakes the loop.
      if (!ctrl.paused && energy < 0.02 && !drag.nodeId && !drag.panning && !camLive && !hoveredRef.current) {
        sleeping = true;
        return;
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
  }, [graphData, edges, activeNoteId, degreeMap, nodeRadius, W, H, zoomToFit]);

  // Pointer interactions
  const clientXY = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const src = 'touches' in e ? (e.touches[0] ?? e.changedTouches[0]) : e;
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
    if ('touches' in e && e.touches.length === 2) return;
    const pos = getPos(e);
    if (!pos) return;
    const nodeId = hitTest(pos.x, pos.y);
    dragRef.current = { nodeId, startX: pos.x, startY: pos.y, lastX: pos.x, lastY: pos.y, panning: !nodeId };
  };

  const pointerMove = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
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
      alphaRef.current = Math.max(alphaRef.current, 0.35);
      wakeRef.current();
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
    camRef.current.zoom = nz;
    targetCamRef.current.zoom = nz;
    const after = toWorld(x, y);
    camRef.current.x += before.x - after.x;
    camRef.current.y += before.y - after.y;
    targetCamRef.current.x = camRef.current.x;
    targetCamRef.current.y = camRef.current.y;
  };

  return (
    <div style={{ position: 'relative', width: W, height: H, borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)' }}>
      <canvas
        ref={canvasRef}
        style={{ width: W, height: H, background: '#0b0c14', cursor: 'grab', display: 'block', touchAction: 'none' }}
        onMouseDown={pointerDown}
        onMouseMove={pointerMove}
        onMouseUp={pointerUp}
        onMouseLeave={() => {
          dragRef.current = { nodeId: null, startX: 0, startY: 0, lastX: 0, lastY: 0, panning: false };
          hoveredRef.current = null;
        }}
        onTouchStart={pointerDown}
        onTouchMove={pointerMove}
        onTouchEnd={pointerUp}
        onWheel={onWheel}
      />
      {/* Floating graph control panel */}
      <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 5, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <button
          onClick={() => setShowCtrl(v => !v)}
          style={{
            background: 'rgba(20, 22, 34, 0.85)',
            border: `1px solid ${showCtrl ? '#89b4fa' : 'rgba(255,255,255,0.1)'}`,
            borderRadius: 8,
            color: showCtrl ? '#89b4fa' : '#9399b2',
            cursor: 'pointer',
            padding: '7px 14px',
            fontSize: 14,
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            fontFamily: 'inherit',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            transition: 'all 0.2s ease',
          }}
        >
          ⚙ Settings
        </button>
        {showCtrl && (
          <div style={{
            background: 'rgba(18, 20, 32, 0.92)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: 10,
            padding: '14px 16px',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 11,
            minWidth: 230,
            fontSize: 14,
            color: '#cdd6f4',
            boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
          }}>
            <input
              type="text"
              placeholder="Search graph..."
              value={graphQuery}
              onChange={e => setGraphQuery(e.target.value)}
              style={{
                background: 'rgba(11, 12, 20, 0.9)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 6,
                padding: '8px 11px',
                color: '#f5e0dc',
                fontSize: 13,
                outline: 'none',
                width: '100%',
                fontFamily: 'inherit',
              }}
            />
            {([
              ['Pause physics', paused, setPaused],
              ['Show folders', showFolders, setShowFolders],
              ['All labels', allLabels, setAllLabels],
              ['Hide orphans', hideOrphans, setHideOrphans],
              ['Semantic links', semEnabled, setSemEnabled],
            ] as [string, boolean, (v: boolean) => void][]).map(([label, val, set]) => (
              <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none', fontSize: 13.5, color: '#bac2de' }}>
                <input type="checkbox" checked={val} onChange={e => set(e.target.checked)} style={{ accentColor: '#89b4fa', cursor: 'pointer', width: 15, height: 15 }} />
                {label}
              </label>
            ))}
            {semEnabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 3 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: '#a6adc8' }}>
                  <span>Similarity ≥</span>
                  <span style={{ color: '#94e2d5', fontWeight: 600 }}>{semThreshold.toFixed(2)}</span>
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
