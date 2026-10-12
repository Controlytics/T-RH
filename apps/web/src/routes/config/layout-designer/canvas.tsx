import { useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent } from 'react';
import {
  rectanglePoints, sharedEdges, centroid, pointInPolygon, segmentOnEdge,
  type Point, type Polygon, type SharedEdge,
} from '@digilog/shared';
import { polygonWalls, polygonDoorPlacements, doorToEdgeOpening, type RoomDoor } from '@/routes/dashboard/room-geometry';
import { snapPoint, nearestEdgePoint, SNAP_TOL, GRID } from './snapping';
import { isBoxTool, isSegmentTool, type DesignerAction, type DesignerState } from './tools';
import {
  DESIGNER_FILL, DOOR_WIDTH, MAX_DOORS, WINDOW_DEPTH,
  type DesignerAnnotations, type DesignerLink, type DesignerPlan, type DesignerRoom,
  type StructureBox, type StructureLabel, type StructureLayer, type StructureSegment,
} from './types';

/**
 * The drawing surface of the Layout Designer: an SVG in a 1000-wide viewBox
 * whose height follows the plan's canvas aspect, with pointer events turned
 * into tool actions and geometry callbacks. Every coordinate the callbacks
 * receive is in PLAN UNITS (0..1) — the same units the API stores — so nothing
 * here needs to know how big the canvas is on screen.
 *
 * Rendering is deliberately close to the dashboard's: the same wall and door
 * helpers over the same shared geometry, so what is drawn here is what the
 * floor will show.
 */
export const VB_W = 1000;

export interface CanvasProps {
  plan: DesignerPlan;
  state: DesignerState;
  dispatch: Dispatch<DesignerAction>;
  /** A polygon awaiting its code (drawn, not yet saved), shown dashed. */
  pending: Polygon | null;
  tracingSrc: string | null;
  guideOpacity: number;
  showGrid: boolean;
  onClosePolygon: () => void;
  onMoveRoom: (roomId: string, points: Polygon) => void;
  onCornerChange: (roomId: string, points: Polygon) => void;
  /** A corner ADDED on edge `edge` at `point` (double-click a wall). Separate from
   *  `onCornerChange` because it RENUMBERS the edges after it, so the page must
   *  move each door and opening with its wall (audit 2026-10-12 finding 3). */
  onInsertCorner: (roomId: string, edge: number, point: { x: number; y: number }) => void;
  onPlaceDoor: (roomId: string, door: RoomDoor) => void;
  onLink: (fromId: string, toId: string, shared: SharedEdge | null) => void;
  /** The 2D layer (2026-10-05): drawn, and edited through these two callbacks; the page writes the whole object. */
  annotations: DesignerAnnotations;
  arch: boolean;
  onAddStructure: (layer: StructureLayer, element: StructureBox | StructureSegment | StructureLabel) => void;
  onMoveStructure: (layer: StructureLayer, index: number, element: StructureBox | StructureSegment | StructureLabel) => void;
}
type StructureEl = StructureBox | StructureSegment | StructureLabel;

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function roomPolygon(room: Pick<DesignerRoom, 'x' | 'y' | 'w' | 'h' | 'points'>): Polygon {
  return room.points ?? rectanglePoints({ x: room.x, y: room.y, w: room.w, h: room.h });
}

export function DesignerCanvas({
  plan, state, dispatch, pending, tracingSrc, guideOpacity, showGrid,
  onClosePolygon, onMoveRoom, onCornerChange, onInsertCorner, onPlaceDoor, onLink,
  annotations, arch, onAddStructure, onMoveStructure,
}: CanvasProps) {
  const vbH = Math.round((VB_W * plan.imageHeight) / plan.imageWidth);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  /** A room or corner being dragged, with its preview outline. */
  const [drag, setDrag] = useState<{ kind: 'move' | 'corner'; roomId: string; index?: number; origin: Point; start: Polygon; preview: Polygon; moved: boolean } | null>(null);
  /** A box being dragged out by a box tool, or a structure element being moved (2026-10-05). */
  const [sdrag, setSdrag] = useState<
    | { kind: 'box'; layer: 'columns' | 'equipment'; from: Point; to: Point }
    | { kind: 'move'; layer: StructureLayer; index: number; origin: Point; start: StructureEl; preview: StructureEl; moved: boolean }
    | null
  >(null);
  const boxTool = isBoxTool(state.tool), segmentTool = isSegmentTool(state.tool);
  // Escape discards a box being dragged out (review, 2026-10-05): the page's
  // keydown cancels the reducer's drawing, but this drag is canvas-local and
  // the release would otherwise still place the box — an unwanted §11 write.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSdrag(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toPlan = (e: { clientX: number; clientY: number }): Point => {
    const el = svgRef.current;
    if (!el) return { x: 0, y: 0 };
    const b = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - b.left) / (b.width || 1))),
      y: Math.min(1, Math.max(0, (e.clientY - b.top) / (b.height || 1))),
    };
  };
  const px = (p: Point) => ({ x: r6(p.x * VB_W), y: r6(p.y * vbH) });
  const pxPoly = (poly: Polygon) => poly.map(px);
  const pointsAttr = (poly: Polygon) => pxPoly(poly).map((p) => `${p.x},${p.y}`).join(' ');

  const selectedRoomId = state.selection?.kind === 'room' || state.selection?.kind === 'corner' || state.selection?.kind === 'door'
    ? state.selection.roomId : null;
  const outlinesExcept = (id: string | null) => plan.rooms.filter((r) => r.id !== id).map(roomPolygon);
  const drawingTool = state.tool === 'room' || state.tool === 'corridor';

  // ── Background: draw a corner, or deselect ─────────────────────────────────
  const onBackgroundDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const raw = toPlan(e);
    if (boxTool) {
      const p = snapPoint(raw, [], { grid: showGrid });
      setSdrag({ kind: 'box', layer: state.tool === 'column' ? 'columns' : 'equipment', from: p, to: p });
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (segmentTool) {
      const d = state.drawing ?? [];
      if (d.length === 0) { dispatch({ type: 'addCorner', point: raw }); return; }
      const snapped = segmentOnEdge(d[0], raw, plan.rooms.map(roomPolygon));
      const a = snapped.a, b = snapped.b;
      if (state.tool === 'window') {
        // A window is stored as the thin box the traces store: along the
        // segment, WINDOW_DEPTH deep, centred on the wall line.
        const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
        const box = horizontal
          ? { x: r6(Math.min(a.x, b.x)), y: r6(a.y - WINDOW_DEPTH / 2), w: r6(Math.abs(b.x - a.x)), h: WINDOW_DEPTH }
          : { x: r6(a.x - WINDOW_DEPTH / 2), y: r6(Math.min(a.y, b.y)), w: WINDOW_DEPTH, h: r6(Math.abs(b.y - a.y)) };
        if (box.w <= 0 || box.h <= 0) { dispatch({ type: 'flash', message: 'A window needs two different points.' }); return; }
        // A window on a wall at the plan's border would start just outside it
        // (review, 2026-10-05); the API refuses any coordinate below 0.
        box.x = r6(Math.max(0, Math.min(1 - box.w, box.x)));
        box.y = r6(Math.max(0, Math.min(1 - box.h, box.y)));
        onAddStructure('windows', box);
      } else {
        if (a.x === b.x && a.y === b.y) { dispatch({ type: 'flash', message: 'A wall stub needs two different points.' }); return; }
        onAddStructure('walls', { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
      dispatch({ type: 'cancel' });
      return;
    }
    if (state.tool === 'label') {
      onAddStructure('labels', { x: r6(raw.x), y: r6(raw.y), text: 'Label' });
      return;
    }
    if (drawingTool) {
      const d = state.drawing ?? [];
      // A click on the first corner closes the outline.
      if (d.length >= 3 && Math.hypot(raw.x - d[0].x, raw.y - d[0].y) <= SNAP_TOL) { onClosePolygon(); return; }
      const last = d.length ? d[d.length - 1] : null;
      const p = snapPoint(raw, outlinesExcept(null), { grid: showGrid, shiftFrom: e.shiftKey ? last : null });
      dispatch({ type: 'addCorner', point: p });
      return;
    }
    if (state.tool === 'select') dispatch({ type: 'select', selection: null });
  };

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const raw = toPlan(e);
    if (sdrag?.kind === 'box') { setSdrag({ ...sdrag, to: snapPoint(raw, [], { grid: showGrid }) }); return; }
    if (sdrag?.kind === 'move') {
      // The TRANSLATION is clamped so the whole element stays inside the plan
      // (review, 2026-10-05) — the room move's rule. Clamping each coordinate
      // alone let a box's origin stop at the edge while its far side went past
      // it, and the API then refused the whole layer as VALIDATION_ERROR.
      const s = sdrag.start as unknown as Record<string, number | string>;
      const num = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : null);
      const xs = [num('x'), num('x1'), num('x2'), num('x') != null && num('w') != null ? num('x')! + num('w')! : null].filter((v): v is number => v != null);
      const ys = [num('y'), num('y1'), num('y2'), num('y') != null && num('h') != null ? num('y')! + num('h')! : null].filter((v): v is number => v != null);
      const dx = raw.x - sdrag.origin.x, dy = raw.y - sdrag.origin.y;
      const tx = Math.min(1 - Math.max(...xs), Math.max(-Math.min(...xs), dx));
      const ty = Math.min(1 - Math.max(...ys), Math.max(-Math.min(...ys), dy));
      const preview: Record<string, number | string> = { ...s };
      for (const k of ['x', 'x1', 'x2']) if (typeof s[k] === 'number') preview[k] = r6((s[k] as number) + tx);
      for (const k of ['y', 'y1', 'y2']) if (typeof s[k] === 'number') preview[k] = r6((s[k] as number) + ty);
      setSdrag({ ...sdrag, preview: preview as unknown as StructureEl, moved: Math.abs(tx) > 1e-6 || Math.abs(ty) > 1e-6 });
      return;
    }
    if (segmentTool && state.drawing?.length) setHover(raw);
    if (drawingTool) {
      const d = state.drawing ?? [];
      const last = d.length ? d[d.length - 1] : null;
      setHover(snapPoint(raw, outlinesExcept(null), { grid: showGrid, shiftFrom: e.shiftKey ? last : null }));
    }
    if (!drag) return;
    if (drag.kind === 'move') {
      const dx = raw.x - drag.origin.x, dy = raw.y - drag.origin.y;
      // Refuse a move that would leave the plan: clamp the translation so
      // every corner stays inside 0..1.
      const minX = Math.min(...drag.start.map((p) => p.x)), maxX = Math.max(...drag.start.map((p) => p.x));
      const minY = Math.min(...drag.start.map((p) => p.y)), maxY = Math.max(...drag.start.map((p) => p.y));
      const tx = Math.min(1 - maxX, Math.max(-minX, dx)), ty = Math.min(1 - maxY, Math.max(-minY, dy));
      setDrag({ ...drag, preview: drag.start.map((p) => ({ x: r6(p.x + tx), y: r6(p.y + ty) })), moved: Math.abs(tx) > 1e-6 || Math.abs(ty) > 1e-6 });
    } else if (drag.kind === 'corner' && drag.index !== undefined) {
      const p = snapPoint(raw, outlinesExcept(drag.roomId), { grid: showGrid });
      const preview = drag.start.map((c, i) => (i === drag.index ? p : c));
      setDrag({ ...drag, preview, moved: true });
    }
  };

  const onUp = () => {
    if (sdrag?.kind === 'box') {
      const d = sdrag; setSdrag(null);
      const x = Math.min(d.from.x, d.to.x), y = Math.min(d.from.y, d.to.y);
      const w = r6(Math.abs(d.to.x - d.from.x)), h = r6(Math.abs(d.to.y - d.from.y));
      if (w < GRID / 2 || h < GRID / 2) { dispatch({ type: 'flash', message: 'Drag out a box to place it.' }); return; }
      onAddStructure(d.layer, { x: r6(x), y: r6(y), w, h });
      return;
    }
    if (sdrag?.kind === 'move') {
      const d = sdrag; setSdrag(null);
      if (d.moved) onMoveStructure(d.layer, d.index, d.preview);
      return;
    }
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) return;
    if (d.kind === 'move') onMoveRoom(d.roomId, d.preview);
    else onCornerChange(d.roomId, d.preview);
  };

  // ── Rooms ──────────────────────────────────────────────────────────────────
  const onRoomDown = (e: ReactPointerEvent<SVGGElement>, room: DesignerRoom) => {
    if (e.button !== 0) return;
    if (drawingTool) return; // the background handler draws through rooms
    if (boxTool || segmentTool || state.tool === 'label') return; // the structure tools draw through rooms too
    e.stopPropagation();
    if (state.tool === 'link') {
      if (!state.linkFrom) { dispatch({ type: 'linkFirst', roomId: room.id }); return; }
      if (state.linkFrom === room.id) { dispatch({ type: 'flash', message: 'Pick a different room to link to.' }); return; }
      const from = plan.rooms.find((r) => r.id === state.linkFrom);
      if (!from) { dispatch({ type: 'cancel' }); return; }
      const shared = sharedEdges(roomPolygon(from), roomPolygon(room));
      onLink(from.id, room.id, shared[0] ?? null);
      return;
    }
    if (state.tool === 'door') {
      const poly = roomPolygon(room);
      const n = nearestEdgePoint(toPlan(e), poly);
      if (n.dist > SNAP_TOL * 2) { dispatch({ type: 'flash', message: 'Click on a wall of the room to place a door.' }); return; }
      if ((room.doors ?? []).length >= MAX_DOORS) { dispatch({ type: 'flash', message: `A room can carry at most ${MAX_DOORS} doors.` }); return; }
      const offset = r6(Math.min(Math.max(n.t - DOOR_WIDTH / 2, 0), 1 - DOOR_WIDTH));
      const clash = (room.doors ?? []).some((d) => {
        const o = doorToEdgeOpening(d, room.points ?? null);
        return o && o.edge === n.edge && offset < o.offset + o.width && o.offset < offset + DOOR_WIDTH;
      });
      if (clash) { dispatch({ type: 'flash', message: 'There is already a door here.' }); return; }
      dispatch({ type: 'select', selection: { kind: 'room', roomId: room.id } });
      onPlaceDoor(room.id, { edge: n.edge, offset, width: DOOR_WIDTH, kind: 'ENTRY' });
      return;
    }
    // select: pick and start a move
    dispatch({ type: 'select', selection: { kind: 'room', roomId: room.id } });
    const start = roomPolygon(room);
    setDrag({ kind: 'move', roomId: room.id, origin: toPlan(e), start, preview: start, moved: false });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onStructureDown = (e: ReactPointerEvent<SVGElement>, layer: StructureLayer, index: number, el: StructureEl) => {
    if (e.button !== 0 || state.tool !== 'select') return;
    e.stopPropagation();
    dispatch({ type: 'select', selection: { kind: 'structure', layer, index } });
    setSdrag({ kind: 'move', layer, index, origin: toPlan(e), start: el, preview: el, moved: false });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onCornerDown = (e: ReactPointerEvent<SVGCircleElement>, room: DesignerRoom, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dispatch({ type: 'select', selection: { kind: 'corner', roomId: room.id, index } });
    const start = roomPolygon(room);
    setDrag({ kind: 'corner', roomId: room.id, index, origin: toPlan(e), start, preview: start, moved: false });
  };

  const onEdgeDoubleClick = (e: React.MouseEvent<SVGLineElement>, room: DesignerRoom, edge: number) => {
    e.stopPropagation();
    const p = snapPoint(toPlan(e), outlinesExcept(room.id), { grid: showGrid });
    onInsertCorner(room.id, edge, p);
  };

  const drawingPx = state.drawing ? pxPoly(state.drawing) : [];
  const gridStep = GRID * VB_W;

  return (
    <svg
      ref={svgRef}
      data-testid="designer-canvas"
      viewBox={`0 0 ${VB_W} ${vbH}`}
      className="h-auto w-full select-none rounded-xl border border-slate-300 bg-white"
      style={{ cursor: drawingTool || boxTool || segmentTool || state.tool === 'label' ? 'crosshair' : state.tool === 'door' ? 'copy' : state.tool === 'link' ? 'alias' : 'default', touchAction: 'none' }}
      onPointerDown={onBackgroundDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => setHover(null)}
      role="img"
      aria-label={`${plan.name}: ${plan.rooms.length} rooms`}
    >
      <defs>
        <pattern id="ld-grid" width={gridStep} height={gridStep} patternUnits="userSpaceOnUse">
          <circle cx={0} cy={0} r={0.8} fill="#cbd5e1" />
        </pattern>
      </defs>
      <rect x={0} y={0} width={VB_W} height={vbH} fill="#f8fafc" stroke="#1f2937" strokeWidth={3} />
      {showGrid && <rect x={0} y={0} width={VB_W} height={vbH} fill="url(#ld-grid)" pointerEvents="none" />}
      {tracingSrc && (
        <image href={tracingSrc} x={0} y={0} width={VB_W} height={vbH} opacity={guideOpacity} preserveAspectRatio="xMidYMid meet" pointerEvents="none" />
      )}

      {plan.rooms.map((room) => {
        const isSelected = room.id === selectedRoomId;
        const poly = drag && drag.roomId === room.id ? drag.preview : roomPolygon(room);
        const outline = pxPoly(poly);
        const doorOpenings = (room.doors ?? []).flatMap((d) => { const o = doorToEdgeOpening(d, room.points ?? null); return o ? [o] : []; });
        const linkOpenings = plan.links
          .filter((l) => l.kind === 'OPENING' && l.fromRoomId === room.id && l.fromEdge != null && l.offset != null && l.width != null)
          .map((l) => ({ edge: l.fromEdge!, offset: l.offset!, width: l.width! }));
        const walls = polygonWalls(outline, [...doorOpenings, ...linkOpenings]);
        // One placement per stored door, KEEPING the stored index, so a click on
        // a leaf selects the right entry of `room.doors` for Remove.
        const doors = (room.doors ?? []).map((d, i) => ({ i, p: polygonDoorPlacements(outline, [d])[0] })).filter((x) => x.p);
        const c = px(centroid(poly));
        const isLinkFrom = state.linkFrom === room.id;
        return (
          <g
            key={room.id}
            data-testid={`room-${room.code}`}
            onPointerDown={(e) => onRoomDown(e, room)}
            style={{ cursor: state.tool === 'select' ? 'move' : undefined }}
          >
            <polygon
              points={outline.map((p) => `${p.x},${p.y}`).join(' ')}
              fill={isSelected ? '#dbeafe' : isLinkFrom ? '#ede9fe' : DESIGNER_FILL[room.grade ?? ''] ?? '#ffffff'}
              stroke="none"
            />
            {/* The 2D look (2026-10-05): a navy wall with a light core, the dashboard's own; the standard look is unchanged. */}
            {walls.map((s, i) => (
              <line key={`w${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={isSelected ? '#2563eb' : arch ? '#1e293b' : '#1f2937'} strokeWidth={arch ? 7 : 2.5} strokeLinecap={arch ? 'square' : undefined} />
            ))}
            {arch && walls.map((s, i) => (
              <line key={`wi${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke="#e2e8f0" strokeWidth={2.2} strokeLinecap="square" pointerEvents="none" />
            ))}
            {doors.map(({ i, p: d }) => {
              const doorSelected = state.selection?.kind === 'door' && state.selection.roomId === room.id && state.selection.index === i;
              const ink = doorSelected ? '#2563eb' : '#0ea5e9';
              return (
                <g
                  key={`d${i}`}
                  data-testid={`door-${room.code}-${i}`}
                  onPointerDown={(e) => {
                    if (state.tool !== 'select') return;
                    e.stopPropagation();
                    dispatch({ type: 'select', selection: { kind: 'door', roomId: room.id, index: i } });
                  }}
                  style={{ cursor: state.tool === 'select' ? 'pointer' : undefined }}
                >
                  {/* A wide transparent stroke over the opening: the hit area. */}
                  <line x1={d.start.x1} y1={d.start.y1} x2={d.start.x2} y2={d.start.y2} stroke="transparent" strokeWidth={12} />
                  <line x1={d.leaf.x1} y1={d.leaf.y1} x2={d.leaf.x2} y2={d.leaf.y2} stroke={ink} strokeWidth={doorSelected ? 2.4 : arch ? 2.5 : 1.6} pointerEvents="none" />
                  <path d={d.arc} fill="none" stroke={ink} strokeWidth={arch ? 1.3 : 1} strokeDasharray={arch ? '4 3' : '3 2'} pointerEvents="none" />
                </g>
              );
            })}
            <text x={c.x} y={c.y} textAnchor="middle" fontSize={Math.max(8, Math.min(12, VB_W / 80))} fontWeight={700} fill="#111827" pointerEvents="none">
              {room.code}
            </text>
            {room.label && (
              <text x={c.x} y={c.y + 11} textAnchor="middle" fontSize={8} fill="#475569" pointerEvents="none">{room.label}</text>
            )}
            {/* Edges (double-click inserts a corner) and corner handles, on the selected room. */}
            {isSelected && state.tool === 'select' && outline.map((p, i) => {
              const q = outline[(i + 1) % outline.length];
              return (
                <line
                  key={`e${i}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y}
                  stroke="transparent" strokeWidth={10}
                  data-testid={`edge-${room.code}-${i}`}
                  onDoubleClick={(e) => onEdgeDoubleClick(e, room, i)}
                  onPointerDown={(e) => e.stopPropagation()}
                  style={{ cursor: 'copy' }}
                />
              );
            })}
            {isSelected && state.tool === 'select' && outline.map((p, i) => (
              <circle
                key={`c${i}`} cx={p.x} cy={p.y} r={5}
                fill={state.selection?.kind === 'corner' && state.selection.index === i ? '#2563eb' : '#ffffff'}
                stroke="#2563eb" strokeWidth={1.5}
                onPointerDown={(e) => onCornerDown(e, room, i)}
                style={{ cursor: 'grab' }}
                data-testid={`corner-${room.code}-${i}`}
              />
            ))}
          </g>
        );
      })}

      {/* Connectors: a dashed line between centres, the selected one highlighted. */}
      {plan.links.filter((l) => l.kind === 'CONNECTOR').map((l) => {
        const a = plan.rooms.find((r) => r.id === l.fromRoomId), b = plan.rooms.find((r) => r.id === l.toRoomId);
        if (!a || !b) return null;
        const ca = px(centroid(roomPolygon(a))), cb = px(centroid(roomPolygon(b)));
        const selected = state.selection?.kind === 'link' && state.selection.linkId === l.id;
        return (
          <g key={l.id} onPointerDown={(e) => { e.stopPropagation(); dispatch({ type: 'select', selection: { kind: 'link', linkId: l.id } }); }} style={{ cursor: 'pointer' }}>
            <line x1={ca.x} y1={ca.y} x2={cb.x} y2={cb.y} stroke="transparent" strokeWidth={10} />
            <line x1={ca.x} y1={ca.y} x2={cb.x} y2={cb.y} stroke={selected ? '#2563eb' : '#0ea5e9'} strokeWidth={selected ? 2.2 : 1.4} strokeDasharray="6 4" />
            {l.label && <text x={(ca.x + cb.x) / 2} y={(ca.y + cb.y) / 2 - 3} textAnchor="middle" fontSize={8} fill="#0ea5e9">{l.label}</text>}
          </g>
        );
      })}
      {/* Openings are clickable through their from-room's edge midpoint. */}
      {plan.links.filter((l) => l.kind === 'OPENING' && l.fromEdge != null && l.offset != null && l.width != null).map((l) => {
        const a = plan.rooms.find((r) => r.id === l.fromRoomId);
        if (!a) return null;
        const poly = pxPoly(roomPolygon(a));
        const p1 = poly[l.fromEdge!], p2 = poly[(l.fromEdge! + 1) % poly.length];
        if (!p1 || !p2) return null;
        const t = l.offset! + l.width! / 2;
        const m = { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t };
        const selected = state.selection?.kind === 'link' && state.selection.linkId === l.id;
        return (
          <circle
            key={l.id} cx={m.x} cy={m.y} r={selected ? 6 : 4.5}
            fill={selected ? '#2563eb' : '#0ea5e9'} fillOpacity={0.85} stroke="#ffffff" strokeWidth={1}
            onPointerDown={(e) => { e.stopPropagation(); dispatch({ type: 'select', selection: { kind: 'link', linkId: l.id } }); }}
            style={{ cursor: 'pointer' }}
            data-testid={`opening-${l.id}`}
          />
        );
      })}

      {/* The 2D structure layer (2026-10-05): columns, windows, wall stubs, equipment, labels — selectable and draggable with the Select tool. */}
      <g data-testid="ld-structure">
        {annotations.walls.map((s, i) => {
          const el = sdrag?.kind === 'move' && sdrag.layer === 'walls' && sdrag.index === i ? (sdrag.preview as StructureSegment) : s;
          const sel = state.selection?.kind === 'structure' && state.selection.layer === 'walls' && state.selection.index === i;
          return (
            <g key={`sw${i}`} data-testid={`structure-walls-${i}`} data-structure="wall" onPointerDown={(e) => onStructureDown(e, 'walls', i, s)} style={{ cursor: state.tool === 'select' ? 'move' : undefined }}>
              <line x1={el.x1 * VB_W} y1={el.y1 * vbH} x2={el.x2 * VB_W} y2={el.y2 * vbH} stroke="transparent" strokeWidth={12} />
              <line x1={el.x1 * VB_W} y1={el.y1 * vbH} x2={el.x2 * VB_W} y2={el.y2 * vbH} stroke={sel ? '#2563eb' : '#1e293b'} strokeWidth={arch ? 7 : 2.5} strokeLinecap="butt" pointerEvents="none" />
              {arch && <line x1={el.x1 * VB_W} y1={el.y1 * vbH} x2={el.x2 * VB_W} y2={el.y2 * vbH} stroke="#e2e8f0" strokeWidth={2.2} strokeLinecap="butt" pointerEvents="none" />}
            </g>
          );
        })}
        {(['windows', 'columns', 'equipment'] as const).map((layer) => annotations[layer].map((b, i) => {
          const el = sdrag?.kind === 'move' && sdrag.layer === layer && sdrag.index === i ? (sdrag.preview as StructureBox) : b;
          const sel = state.selection?.kind === 'structure' && state.selection.layer === layer && state.selection.index === i;
          const look = layer === 'windows' ? { fill: '#e0f2fe', stroke: '#0369a1' } : layer === 'columns' ? { fill: '#cbd5e1', stroke: '#1e293b' } : { fill: '#ffffff', stroke: '#1e293b' };
          return (
            <rect key={`${layer}${i}`} data-testid={`structure-${layer}-${i}`} data-structure={layer === 'windows' ? 'window' : layer === 'columns' ? 'column' : 'equipment'}
              x={el.x * VB_W} y={el.y * vbH} width={el.w * VB_W} height={el.h * vbH}
              fill={look.fill} stroke={sel ? '#2563eb' : look.stroke} strokeWidth={sel ? 2.4 : 1.5}
              onPointerDown={(e) => onStructureDown(e, layer, i, b)} style={{ cursor: state.tool === 'select' ? 'move' : undefined }} />
          );
        }))}
        {annotations.labels.map((l, i) => {
          const el = sdrag?.kind === 'move' && sdrag.layer === 'labels' && sdrag.index === i ? (sdrag.preview as StructureLabel) : l;
          const sel = state.selection?.kind === 'structure' && state.selection.layer === 'labels' && state.selection.index === i;
          return (
            <text key={`lb${i}`} data-testid={`structure-labels-${i}`} data-structure="label" x={el.x * VB_W} y={el.y * vbH} textAnchor="middle" fontSize={8} fill={sel ? '#2563eb' : '#334155'} letterSpacing="0.04em"
              onPointerDown={(e) => onStructureDown(e, 'labels', i, l)} style={{ cursor: state.tool === 'select' ? 'move' : undefined }}>{el.text}</text>
          );
        })}
        {sdrag?.kind === 'box' && (
          <rect x={Math.min(sdrag.from.x, sdrag.to.x) * VB_W} y={Math.min(sdrag.from.y, sdrag.to.y) * vbH}
            width={Math.abs(sdrag.to.x - sdrag.from.x) * VB_W} height={Math.abs(sdrag.to.y - sdrag.from.y) * vbH}
            fill="#bfdbfe" fillOpacity={0.5} stroke="#2563eb" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />
        )}
        {segmentTool && state.drawing?.length === 1 && hover && (
          <line x1={state.drawing[0].x * VB_W} y1={state.drawing[0].y * vbH} x2={hover.x * VB_W} y2={hover.y * vbH} stroke="#2563eb" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />
        )}
      </g>

      {/* A room drawn but not yet named. */}
      {pending && (
        <polygon points={pointsAttr(pending)} fill="#bfdbfe" fillOpacity={0.5} stroke="#2563eb" strokeWidth={2} strokeDasharray="6 3" pointerEvents="none" />
      )}

      {/* The outline being drawn: corners, edges so far, and a rubber band to the pointer. */}
      {drawingPx.length > 0 && (
        <g pointerEvents="none">
          <polyline points={drawingPx.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#2563eb" strokeWidth={2} />
          {hover && (
            <line x1={drawingPx[drawingPx.length - 1].x} y1={drawingPx[drawingPx.length - 1].y} x2={px(hover).x} y2={px(hover).y} stroke="#2563eb" strokeWidth={1.2} strokeDasharray="4 3" />
          )}
          {drawingPx.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={i === 0 ? 6 : 4} fill={i === 0 ? '#ffffff' : '#2563eb'} stroke="#2563eb" strokeWidth={1.5} />
          ))}
        </g>
      )}
      {hover && drawingTool && !drawingPx.length && (
        <circle cx={px(hover).x} cy={px(hover).y} r={3} fill="#2563eb" pointerEvents="none" />
      )}
      {/* The pointer inside a room while drawing is fine — a room may be drawn over another only by mistake; nothing here forbids it, the server accepts any simple polygon. */}
      {hover && drawingTool && plan.rooms.some((r) => pointInPolygon(hover, roomPolygon(r))) && (
        <title>Inside an existing room</title>
      )}
    </svg>
  );
}
