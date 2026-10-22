'use client';

// components/SigmaGraph.tsx — knowledge graph on sigma.js (WebGL). Notes are laid
// out once with ForceAtlas2 into islands, one per top-level folder; labels are
// culled by density, so a large vault stays readable and cheap to draw.

import { useEffect, useMemo, useRef, useState } from 'react';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import noverlap from 'graphology-layout-noverlap';
import type Sigma from 'sigma';
import type { NodeHoverDrawingFunction } from 'sigma/rendering';

type GraphEdge = { from: string; to: string; kind?: 'semantic'; score?: number };
export type GraphData = {
  // `group`: the note's top-level folder. Each group is drawn as an island.
  nodes: { id: string; title: string; type: 'note' | 'folder'; folderId?: string | null; group?: string | null }[];
  edges: GraphEdge[];
  // Top-level folders in sidebar order; islands take colours in this order.
  groups?: { id: string; name: string }[];
};

const SEM_THRESHOLD_KEY = 'kybase_sem_threshold';
const ISLAND_COLORS = ['#89b4fa', '#a6e3a1', '#f9e2af', '#cba6f7', '#fab387', '#94e2d5',
  '#f5c2e7', '#74c7ec', '#f38ba8', '#b4befe', '#eba0ac', '#89dceb'];
const LOOSE_COLOR = '#7f849c';
const DIM_COLOR = '#2a2b3c';
const FONT = "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif";
const GOLDEN = 2.39996;
const LABEL_MAX = 28;

// Labels on the canvas stay short; the full title shows on hover and for the open note.
const shortLabel = (title: string) => (title.length > LABEL_MAX ? title.slice(0, LABEL_MAX - 1) + '…' : title);

type IslandMeta = { id: string; name: string; color: string };
type Island = IslandMeta & { x: number; y: number; r: number };

// An island's wash and name follow its notes, also after one is dragged.
function islandsOf(g: Graph, metas: IslandMeta[]): Island[] {
  const out: Island[] = [];
  for (const m of metas) {
    const pts: { x: number; y: number; size: number }[] = [];
    g.forEachNode((_, a) => { if (a.group === m.id) pts.push({ x: a.x, y: a.y, size: a.size }); });
    if (pts.length < 2) continue;
    const x = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
    const y = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
    out.push({ ...m, x, y, r: Math.max(...pts.map(p => Math.hypot(p.x - x, p.y - y) + p.size)) });
  }
  return out;
}

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

// sigma blends WebGL colours as premultiplied without premultiplying them, so
// a translucent edge comes out nearly at full brightness. Edges get an opaque
// colour already mixed with the background instead.
const BACKGROUND = [14, 15, 24];
const over = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number, b: number) => Math.round(c * a + b * (1 - a));
  return `rgb(${mix((n >> 16) & 255, BACKGROUND[0])}, ${mix((n >> 8) & 255, BACKGROUND[1])}, ${mix(n & 255, BACKGROUND[2])})`;
};

// Two-level layout, so islands never melt into one ball: each top-level
// folder is laid out on its own links into a compact patch, then the patches
// are placed as large discs that may not overlap — islands with many links
// between them end up side by side — and the notes are moved onto them.
function buildGraph(data: GraphData, semEnabled: boolean, semThreshold: number) {
  const g = new Graph({ type: 'undirected' });
  const groups = data.groups ?? [];
  const color = new Map(groups.map((gr, i) => [gr.id, ISLAND_COLORS[i % ISLAND_COLORS.length]]));

  for (const n of data.nodes) {
    if (n.type !== 'note' || g.hasNode(n.id)) continue;
    g.addNode(n.id, {
      label: shortLabel(n.title),
      title: n.title,
      group: n.group ?? '',
      color: (n.group && color.get(n.group)) || LOOSE_COLOR,
      x: 0, y: 0, size: 3,
    });
  }
  for (const e of data.edges) {
    if (e.from === e.to || !g.hasNode(e.from) || !g.hasNode(e.to) || g.hasEdge(e.from, e.to)) continue;
    const semantic = e.kind === 'semantic';
    if (semantic && (!semEnabled || (e.score ?? 0) < semThreshold)) continue;
    const group = g.getNodeAttribute(e.from, 'group') as string;
    const same = !!group && group === g.getNodeAttribute(e.to, 'group');
    g.addEdge(e.from, e.to, {
      size: semantic ? 0.5 : 0.7,
      color: semantic ? over('#94e2d5', 0.14) : same ? over(color.get(group)!, 0.4) : over('#7f849c', 0.18),
    });
  }
  g.forEachNode(id => g.setNodeAttribute(id, 'size', 2.5 + Math.sqrt(g.degree(id)) * 1.3));

  // 1. Each island alone.
  const members = new Map<string, string[]>();
  g.forEachNode((id, a) => {
    const list = members.get(a.group) ?? [];
    list.push(id);
    members.set(a.group, list);
  });
  const patches = new Map<string, { r: number }>();
  members.forEach((ids, group) => {
    const sub = new Graph({ type: 'undirected' });
    ids.forEach((id, k) => sub.addNode(id, {
      x: Math.cos(k * GOLDEN) * 5 * Math.sqrt(k + 1), y: Math.sin(k * GOLDEN) * 5 * Math.sqrt(k + 1),
      size: g.getNodeAttribute(id, 'size'),
    }));
    g.forEachEdge((_, __, s, t) => {
      if (sub.hasNode(s) && sub.hasNode(t) && !sub.hasEdge(s, t)) sub.addEdge(s, t);
    });
    if (sub.order > 1) {
      forceAtlas2.assign(sub, {
        iterations: 300,
        settings: { ...forceAtlas2.inferSettings(sub), gravity: 1.5, scalingRatio: 3, adjustSizes: true },
      });
      noverlap.assign(sub, { maxIterations: 100, settings: { margin: 2, ratio: 1.1 } });
    }
    let cx = 0, cy = 0;
    sub.forEachNode((_, a) => { cx += a.x; cy += a.y; });
    cx /= sub.order; cy /= sub.order;
    let r = 0;
    sub.forEachNode((id, a) => {
      g.mergeNodeAttributes(id, { x: a.x - cx, y: a.y - cy });
      r = Math.max(r, Math.hypot(a.x - cx, a.y - cy) + a.size);
    });
    patches.set(group, { r: Math.max(r, 10) });
  });

  // 2. Islands as discs, pulled together by the links between them.
  const meta = new Graph({ type: 'undirected' });
  let slot = 0;
  patches.forEach(({ r }, group) => {
    slot++;
    meta.addNode(group || 'loose', {
      x: Math.cos(slot * GOLDEN) * 60 * Math.sqrt(slot), y: Math.sin(slot * GOLDEN) * 60 * Math.sqrt(slot), size: r,
    });
  });
  g.forEachEdge((_, __, s, t, sa, ta) => {
    const a = sa.group || 'loose', b = ta.group || 'loose';
    if (a === b) return;
    if (meta.hasEdge(a, b)) meta.updateEdgeAttribute(a, b, 'weight', w => (w ?? 0) + 1);
    else meta.addEdge(a, b, { weight: 1 });
  });
  forceAtlas2.assign(meta, {
    iterations: 400,
    getEdgeWeight: 'weight',
    settings: { gravity: 1, scalingRatio: 6, adjustSizes: true, strongGravityMode: true },
  });
  noverlap.assign(meta, { maxIterations: 300, settings: { margin: 25, ratio: 1.05 } });

  // 3. Notes onto their island.
  g.forEachNode((id, a) => {
    const c = meta.getNodeAttributes(a.group || 'loose');
    g.mergeNodeAttributes(id, { x: a.x + c.x, y: a.y + c.y });
  });

  const metas = groups.map(gr => ({ id: gr.id, name: gr.name.replace(/^\d+\.\s*/, ''), color: color.get(gr.id)! }));
  return { g, metas };
}

// The default hover box is white; on a dark canvas it glares.
const drawHover: NodeHoverDrawingFunction = (ctx, data, settings) => {
  const label = data.label ?? '';
  const size = settings.labelSize;
  ctx.font = `600 ${size}px ${settings.labelFont}`;
  const tw = ctx.measureText(label).width;
  const x = data.x + data.size + 5, y = data.y - size / 2 - 4, w = tw + 10, h = size + 8;
  ctx.beginPath();
  ctx.arc(data.x, data.y, data.size + 2.5, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (!label) return;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4);
  ctx.fillStyle = 'rgba(17, 17, 27, 0.94)';
  ctx.fill();
  ctx.strokeStyle = data.color;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 5, y + h / 2 + 0.5);
};

export default function SigmaGraph({
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
  const containerRef = useRef<HTMLDivElement>(null);
  const washRef = useRef<HTMLCanvasElement>(null);
  const namesRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const selectRef = useRef(onSelectNote);
  const dataRef = useRef(graphData);
  const sizeRef = useRef({ w, h });
  const cameraRef = useRef<{ x: number; y: number; ratio: number; angle: number } | null>(null);
  // Where the user dragged notes to; kept when the graph is laid out again.
  const placedRef = useRef(new Map<string, { x: number; y: number }>());
  // Set when the graph itself selected a note: the camera then stays put.
  const clickedRef = useRef<string | null>(null);
  // `focus`: the selected note stays lit with its links until another is
  // selected or the empty canvas is clicked. A hover shows its own links
  // meanwhile and hands back to the focus when it ends.
  const viewRef = useRef({ hovered: null as string | null, focus: activeNoteId, active: activeNoteId, query: '', hideOrphans: false, allLabels: false });

  const [showCtrl, setShowCtrl] = useState(false);
  const [query, setQuery] = useState('');
  const [semEnabled, setSemEnabled] = useState(true);
  const [semThreshold, setSemThreshold] = useState(0.8);
  const [hideOrphans, setHideOrphans] = useState(false);
  const [allLabels, setAllLabels] = useState(false);
  const [noWebGL, setNoWebGL] = useState(false);
  useEffect(() => {
    const v = parseFloat(localStorage.getItem(SEM_THRESHOLD_KEY) ?? '');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (Number.isFinite(v) && v >= 0.6 && v <= 0.95) setSemThreshold(v);
  }, []);
  useEffect(() => { selectRef.current = onSelectNote; }, [onSelectNote]);
  useEffect(() => { dataRef.current = graphData; }, [graphData]);

  // The app hands over a new graphData object on many unrelated updates (a
  // note opened, its text loaded). Only a change to notes, groups or links
  // lays the graph out again; anything else must not touch the view.
  const structure = useMemo(() => {
    const nodes = graphData.nodes.filter(n => n.type === 'note').map(n => `${n.id}:${n.group ?? ''}`).sort().join(',');
    const edges = graphData.edges.map(e => `${e.from}>${e.to}:${e.kind === 'semantic' ? (e.score ?? 0).toFixed(3) : ''}`).sort().join(',');
    const groups = (graphData.groups ?? []).map(g => `${g.id}:${g.name}`).join(',');
    return `${nodes}#${edges}#${groups}`;
  }, [graphData]);

  useEffect(() => {
    let killed = false;
    let renderer: Sigma | null = null;
    let raf = 0;
    // sigma draws with WebGL; without it there is nothing to show but a note.
    const canvasProbe = document.createElement('canvas');
    if (!canvasProbe.getContext('webgl2') && !canvasProbe.getContext('webgl')) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNoWebGL(true);
      return;
    }
    const { g, metas } = buildGraph(dataRef.current, semEnabled, semThreshold);
    placedRef.current.forEach((p, id) => { if (g.hasNode(id)) g.mergeNodeAttributes(id, p); });
    let islands = islandsOf(g, metas);
    graphRef.current = g;
    const view = viewRef.current;

    // The note being looked at — hovered, else selected — and its neighbours,
    // recomputed only when it changes: reducers ask for it once per node.
    const spotlight = { id: null as string | null, neighbours: new Set<string>(), labelled: new Set<string>() };
    const spot = () => {
      const id = view.hovered ?? (view.focus && g.hasNode(view.focus) ? view.focus : null);
      if (id !== spotlight.id) {
        spotlight.id = id;
        spotlight.neighbours = id ? new Set(g.neighbors(id)) : new Set();
        // Name the best-linked neighbours only: all of them would pile up.
        spotlight.labelled = new Set([...spotlight.neighbours].sort((a, b) => g.degree(b) - g.degree(a)).slice(0, 8));
      }
      return spotlight;
    };

    const drawIslands = () => {
      const canvas = washRef.current, names = namesRef.current;
      if (!renderer || !canvas || !names) return;
      const { w: cw, h: ch } = sizeRef.current;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
      }
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      const lit = spot().id;
      const litGroup = lit ? g.getNodeAttribute(lit, 'group') : null;
      islands.forEach((isl, i) => {
        const c = renderer!.graphToViewport({ x: isl.x, y: isl.y });
        const e = renderer!.graphToViewport({ x: isl.x + isl.r, y: isl.y });
        const rad = Math.hypot(e.x - c.x, e.y - c.y) + 14;
        const dim = !!lit && litGroup !== isl.id;
        const wash = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rad);
        wash.addColorStop(0, rgba(isl.color, dim ? 0.03 : 0.1));
        wash.addColorStop(1, rgba(isl.color, 0));
        ctx.fillStyle = wash;
        ctx.beginPath();
        ctx.arc(c.x, c.y, rad, 0, Math.PI * 2);
        ctx.fill();
        const el = names.children[i] as HTMLElement | undefined;
        if (el) {
          el.style.transform = `translate(${c.x}px, ${c.y - rad}px) translate(-50%, -100%)`;
          el.style.opacity = dim ? '0.35' : '0.9';
        }
      });
    };

    if (namesRef.current) {
      namesRef.current.replaceChildren(...islands.map(isl => {
        const el = document.createElement('div');
        el.textContent = isl.name;
        el.style.cssText = `position:absolute;left:0;top:0;white-space:nowrap;font:600 12.5px ${FONT};color:${isl.color};text-shadow:0 0 6px rgba(0,0,0,0.9)`;
        return el;
      }));
    }

    import('sigma').then(({ default: SigmaRenderer }) => {
      if (killed || !containerRef.current) return;
      try {
        renderer = new SigmaRenderer(g, containerRef.current, {
        renderLabels: true,
        labelFont: FONT,
        labelSize: 11,
        labelWeight: '500',
        labelColor: { color: '#bac2de' },
        labelDensity: view.allLabels ? 100 : 0.6,
        labelGridCellSize: 90,
        labelRenderedSizeThreshold: view.allLabels ? 0 : 7,
        defaultEdgeType: 'line',
        defaultDrawNodeHover: drawHover,
        zIndex: true,
        stagePadding: 50,
        minCameraRatio: 0.05,
        maxCameraRatio: 4,
        nodeReducer: (id, data) => {
          const res = { ...data } as Record<string, unknown>;
          if (view.hideOrphans && g.degree(id) === 0) res.hidden = true;
          if (view.query) {
            const hit = String(data.label ?? '').toLowerCase().includes(view.query);
            if (!hit) { res.color = DIM_COLOR; res.label = ''; } else res.forceLabel = true;
          } else {
            const lit = spot();
            if (lit.id && (id === lit.id || lit.neighbours.has(id))) {
              res.zIndex = 2;
              if (lit.labelled.has(id)) res.forceLabel = true;
              if (id === lit.id) { res.label = data.title; res.forceLabel = true; }
            } else if (lit.id) { res.color = DIM_COLOR; res.label = ''; res.zIndex = 0; }
          }
          if (id === view.active) { res.highlighted = true; res.zIndex = 3; res.label = data.title; }
          return res;
        },
        edgeReducer: (id, data) => {
          const res = { ...data } as Record<string, unknown>;
          if (view.query) res.hidden = true;
          else {
            const lit = spot().id;
            if (lit) {
              const [s, t] = g.extremities(id);
              if (s === lit || t === lit) { res.color = over('#cdd6f4', 0.75); res.size = 1.3; res.zIndex = 2; }
              else res.hidden = true;
            }
          }
          return res;
        },
        });
      } catch {
        setNoWebGL(true);
        return;
      }
      rendererRef.current = renderer;
      if (cameraRef.current) renderer.getCamera().setState(cameraRef.current);
      renderer.on('enterNode', ({ node }) => {
        view.hovered = node;
        renderer!.refresh({ skipIndexation: true });
      });
      renderer.on('leaveNode', () => {
        view.hovered = null;
        renderer!.refresh({ skipIndexation: true });
      });
      renderer.on('clickNode', ({ node }) => {
        clickedRef.current = node;
        view.focus = node;
        selectRef.current?.(node);
        renderer!.refresh({ skipIndexation: true });
      });
      // A click on empty canvas lets go of the focus; the note stays open. A
      // drag pans and does not count as a click.
      renderer.on('clickStage', () => {
        view.focus = null;
        renderer!.refresh({ skipIndexation: true });
      });
      // Drag a note and its whole folder comes along, drawn to it like iron
      // to a magnet: notes near it catch up first, far ones lag, and while the
      // pointer moves the island huddles a little closer around it; on release
      // it settles back into its own shape at the new place. The camera stays
      // put, and the frozen bounding box keeps the view from rescaling.
      const HUDDLE = 0.8;
      let dragged: string | null = null;
      let cur = { x: 0, y: 0 };
      let followers: { id: string; ox: number; oy: number; ease: number }[] = [];
      let settle = 0;
      const step = () => {
        raf = 0;
        const k = dragged ? HUDDLE : 1;
        for (const f of followers) {
          const a = g.getNodeAttributes(f.id);
          const x = a.x + (cur.x + f.ox * k - a.x) * f.ease;
          const y = a.y + (cur.y + f.oy * k - a.y) * f.ease;
          g.mergeNodeAttributes(f.id, { x, y });
          placedRef.current.set(f.id, { x, y });
        }
        islands = islandsOf(g, metas);
        if (dragged || ++settle < 90) raf = requestAnimationFrame(step);
        else followers = [];
      };
      renderer.on('downNode', ({ node }) => {
        dragged = node;
        if (!renderer!.getCustomBBox()) renderer!.setCustomBBox(renderer!.getBBox());
        const a0 = g.getNodeAttributes(node);
        cur = { x: a0.x, y: a0.y };
        followers = [];
        if (!a0.group) return;
        const mates: { id: string; ox: number; oy: number; d: number }[] = [];
        g.forEachNode((id, a) => {
          if (id === node || a.group !== a0.group) return;
          mates.push({ id, ox: a.x - a0.x, oy: a.y - a0.y, d: Math.hypot(a.x - a0.x, a.y - a0.y) });
        });
        const far = Math.max(1e-9, ...mates.map(m => m.d));
        followers = mates.map(m => ({ id: m.id, ox: m.ox, oy: m.oy, ease: 0.06 + 0.3 * (1 - m.d / far) }));
      });
      renderer.on('moveBody', ({ event }) => {
        if (!dragged) return;
        const p = renderer!.viewportToGraph(event);
        g.mergeNodeAttributes(dragged, { x: p.x, y: p.y });
        placedRef.current.set(dragged, { x: p.x, y: p.y });
        cur = { x: p.x, y: p.y };
        settle = 0;
        if (!raf && followers.length) raf = requestAnimationFrame(step);
        islands = islandsOf(g, metas);
        event.preventSigmaDefault();
        event.original.preventDefault();
        event.original.stopPropagation();
      });
      const release = () => { dragged = null; };
      renderer.on('upNode', release);
      renderer.on('upStage', release);
      renderer.on('afterRender', drawIslands);
      drawIslands();
    });

    return () => {
      killed = true;
      if (raf) cancelAnimationFrame(raf);
      if (renderer) cameraRef.current = renderer.getCamera().getState();
      renderer?.kill();
      rendererRef.current = null;
    };
  }, [structure, semEnabled, semThreshold]);

  // A renamed note only needs its label.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    let changed = false;
    for (const n of graphData.nodes) {
      if (g.hasNode(n.id) && g.getNodeAttribute(n.id, 'title') !== n.title) {
        g.mergeNodeAttributes(n.id, { label: shortLabel(n.title), title: n.title });
        changed = true;
      }
    }
    if (changed) rendererRef.current?.refresh();
  }, [graphData]);

  // A new panel size keeps the graph and the camera.
  useEffect(() => {
    sizeRef.current = { w, h };
    rendererRef.current?.resize();
    rendererRef.current?.refresh({ skipIndexation: true });
  }, [w, h]);

  // The open note is highlighted and becomes the focus. Opened from the graph, the view stays where
  // the click was; opened elsewhere, the camera eases to it only when it is
  // off screen.
  useEffect(() => {
    viewRef.current.active = activeNoteId;
    viewRef.current.focus = activeNoteId;
    const renderer = rendererRef.current, g = graphRef.current;
    if (!renderer || !g) return;
    renderer.refresh({ skipIndexation: true });
    const fromGraph = clickedRef.current === activeNoteId;
    clickedRef.current = null;
    if (!activeNoteId || fromGraph || !g.hasNode(activeNoteId)) return;
    const p = renderer.graphToViewport(g.getNodeAttributes(activeNoteId) as { x: number; y: number });
    const { w: cw, h: ch } = sizeRef.current;
    if (p.x > 40 && p.x < cw - 40 && p.y > 40 && p.y < ch - 40) return;
    const d = renderer.getNodeDisplayData(activeNoteId);
    if (d) renderer.getCamera().animate({ x: d.x, y: d.y }, { duration: 400 });
  }, [activeNoteId]);

  useEffect(() => {
    viewRef.current.query = query.trim().toLowerCase();
    rendererRef.current?.refresh({ skipIndexation: true });
  }, [query]);

  useEffect(() => {
    viewRef.current.hideOrphans = hideOrphans;
    rendererRef.current?.refresh({ skipIndexation: true });
  }, [hideOrphans]);

  useEffect(() => {
    viewRef.current.allLabels = allLabels;
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setSetting('labelDensity', allLabels ? 100 : 0.6);
    renderer.setSetting('labelRenderedSizeThreshold', allLabels ? 0 : 7);
  }, [allLabels]);

  useEffect(() => {
    if (fitRef) fitRef.current = () => { rendererRef.current?.getCamera().animatedReset({ duration: 300 }); };
  }, [fitRef]);

  return (
    <div style={{ position: 'relative', width: w, height: h, borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)', background: 'radial-gradient(circle at 50% 50%, #13141f 0%, #0b0c14 70%)' }}>
      <canvas ref={washRef} style={{ position: 'absolute', inset: 0, width: w, height: h, pointerEvents: 'none' }} />
      <div ref={containerRef} style={{ position: 'absolute', inset: 0, width: w, height: h }} />
      <div ref={namesRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }} />
      {noWebGL && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: '#a6adc8', fontSize: 13.5, lineHeight: 1.5 }}>
          The graph needs WebGL. Update your browser or turn on hardware acceleration.
        </div>
      )}
      <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 5, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <button
          onClick={() => setShowCtrl(v => !v)}
          style={{
            background: 'rgba(20, 22, 34, 0.85)', border: `1px solid ${showCtrl ? '#89b4fa' : 'rgba(255,255,255,0.1)'}`,
            borderRadius: 8, color: showCtrl ? '#89b4fa' : '#9399b2', cursor: 'pointer', padding: '7px 14px', fontSize: 14,
            backdropFilter: 'blur(12px)', fontFamily: 'inherit', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          ⚙ Settings
        </button>
        {showCtrl && (
          <div style={{
            background: 'rgba(18, 20, 32, 0.92)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: 10,
            padding: '14px 16px', backdropFilter: 'blur(20px)', display: 'flex', flexDirection: 'column', gap: 11,
            minWidth: 230, fontSize: 14, color: '#cdd6f4', boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
          }}>
            <input
              type="text"
              placeholder="Search graph..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              style={{
                background: 'rgba(11, 12, 20, 0.9)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6,
                padding: '8px 11px', color: '#f5e0dc', fontSize: 13, outline: 'none', width: '100%', fontFamily: 'inherit',
              }}
            />
            {([
              ['All labels', allLabels, setAllLabels],
              ['Hide orphans', hideOrphans, setHideOrphans],
              ['Semantic links', semEnabled, setSemEnabled],
            ] as [string, boolean, (v: boolean) => void][]).map(([label, val, set]) => (
              <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none', fontSize: 13.5, color: '#bac2de' }}>
                <input type="checkbox" checked={val} onChange={e => set(e.target.checked)} style={{ accentColor: '#89b4fa', width: 15, height: 15 }} />
                {label}
              </label>
            ))}
            {semEnabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: '#a6adc8' }}>
                  <span>Similarity ≥</span>
                  <span style={{ color: '#94e2d5', fontWeight: 600 }}>{semThreshold.toFixed(2)}</span>
                </div>
                <input
                  type="range" min={0.6} max={0.95} step={0.01} value={semThreshold}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    setSemThreshold(v);
                    localStorage.setItem(SEM_THRESHOLD_KEY, String(v));
                  }}
                  style={{ accentColor: '#94e2d5', width: '100%' }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
