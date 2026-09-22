import { useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent } from 'react';
import {
  rectanglePoints, sharedEdges, centroid, pointInPolygon,
  type Point, type Polygon, type SharedEdge,
} from '@digilog/shared';
import { polygonWalls, polygonDoorPlacements, doorToEdgeOpening, type RoomDoor } from '@/routes/dashboard/room-geometry';
import { snapPoint, nearestEdgePoint, SNAP_TOL, GRID } from './snapping';
import type { DesignerAction, DesignerState } from './tools';
import { DESIGNER_FILL, DOOR_WIDTH, MAX_DOORS, type DesignerLink, type DesignerPlan, type DesignerRoom } from './types';

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
  onPlaceDoor: (roomId: string, door: RoomDoor) => void;
  onLink: (fromId: string, toId: string, shared: SharedEdge | null) => void;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function roomPolygon(room: Pick<DesignerRoom, 'x' | 'y' | 'w' | 'h' | 'points'>): Polygon {
  return room.points ?? rectanglePoints({ x: room.x, y: room.y, w: room.w, h: room.h });
}

export function DesignerCanvas({
  plan, state, dispatch, pending, tracingSrc, guideOpacity, showGrid,
  onClosePolygon, onMoveRoom, onCornerChange, onPlaceDoor, onLink,
}: CanvasProps) {
  const vbH = Math.round((VB_W * plan.imageHeight) / plan.imageWidth);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  /** A room or corner being dragged, with its preview outline. */
  const [drag, setDrag] = useState<{ kind: 'move' | 'corner'; roomId: string; index?: number; origin: Point; start: Polygon; preview: Polygon; moved: boolean } | null>(null);

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

  const onCornerDown = (e: ReactPointerEvent<SVGCircleElement>, room: DesignerRoom, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    dispatch({ type: 'select', selection: { kind: 'corner', roomId: room.id, index } });
    const start = roomPolygon(room);
    setDrag({ kind: 'corner', roomId: room.id, index, origin: toPlan(e), start, preview: start, moved: false });
  };

  const onEdgeDoubleClick = (e: React.MouseEvent<SVGLineElement>, room: DesignerRoom, edge: number) => {
    e.stopPropagation();
    const poly = roomPolygon(room);
    const p = snapPoint(toPlan(e), outlinesExcept(room.id), { grid: showGrid });
    const next = [...poly.slice(0, edge + 1), p, ...poly.slice(edge + 1)];
    onCornerChange(room.id, next);
  };

  const drawingPx = state.drawing ? pxPoly(state.drawing) : [];
  const gridStep = GRID * VB_W;

  return (
    <svg
      ref={svgRef}
      data-testid="designer-canvas"
      viewBox={`0 0 ${VB_W} ${vbH}`}
      className="h-auto w-full select-none rounded-xl border border-slate-300 bg-white"
      style={{ cursor: drawingTool ? 'crosshair' : state.tool === 'door' ? 'copy' : state.tool === 'link' ? 'alias' : 'default', touchAction: 'none' }}
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
        const doors = polygonDoorPlacements(outline, room.doors);
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
            {walls.map((s, i) => (
              <line key={`w${i}`} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={isSelected ? '#2563eb' : '#1f2937'} strokeWidth={2.5} />
            ))}
            {doors.map((d, i) => (
              <g key={`d${i}`} pointerEvents="none">
                <line x1={d.leaf.x1} y1={d.leaf.y1} x2={d.leaf.x2} y2={d.leaf.y2} stroke="#0ea5e9" strokeWidth={1.6} />
                <path d={d.arc} fill="none" stroke="#0ea5e9" strokeWidth={1} strokeDasharray="3 2" />
              </g>
            ))}
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
