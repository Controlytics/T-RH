/**
 * The shape every floor drawn in the 2D ARCHITECTURAL style shares
 * (`annotations.style = 'architectural'`; the dashboard draws such a plan with
 * double walls, status-washed rooms, one card per instrument and a side panel).
 *
 * `qc-layout-2.ts` (2026-10-01) was the first and these are its types and its
 * conversions, lifted out unchanged when the Microbiology floor became the
 * second (`microbiology-layout-2.ts`, same day) — a trace is authored in the
 * DRAWING's own pixels: rooms as polygons on the wall centre lines, doors as
 * the gaps measured in those walls, and the building's structure (columns,
 * windows, partition stubs) as boxes and segments. Everything here turns that
 * into what the schema stores, 0..1 against the building.
 */

export type Grade = 'A' | 'B' | 'C' | 'D' | 'CIRCULATION' | 'UTILITY';
export type Pt = [number, number];

/** The plan's canvas in drawing pixels: the OUTER faces of the exterior walls. */
export interface ArchBuilding { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

/** A door as MEASURED: the gap on one wall line of the room it opens into. */
export interface ArchDoor {
  /** 'x' = a vertical wall at x = `at`; 'y' = a horizontal wall at y = `at`. */
  axis: 'x' | 'y';
  at: number;
  /** The gap along the wall, px. */
  from: number;
  to: number;
  kind: 'ENTRY' | 'EXIT' | 'PASSAGE';
  /** The end the leaf is hung on, in DRAWING terms: 'from' (the lower
   *  coordinate) or 'to'; 'none' = an opening with no leaf. Read off the image:
   *  the swing arc meets the wall at the FREE end. */
  hinge: 'from' | 'to' | 'none';
  /** 'out' = the leaf swings AWAY from the room the door is stored on — an
   *  exterior door that opens out of the building (Microbiology's emergency
   *  exit). Absent = into the room, as every other door. */
  swing?: 'out';
}

export interface ArchRoom {
  code: string;
  /** The room's name. A room of this code already on the plan keeps ITS label. */
  label: string | null;
  /** Clockwise on screen (y down), px. */
  outline: Pt[];
  grade?: Grade;
  doors: ArchDoor[];
  instrument?: string;
  /** Transcribed off the drawing, never computed: ceiling height, floor dimensions. */
  meta?: { fch?: string; dims?: string };
}

/** Plan annotations in drawing px. Boxes are [x0, y0, x1, y1]. */
export interface ArchAnnotations {
  columns: [number, number, number, number][];
  windows: [number, number, number, number][];
  /** Partition stubs that are not a room boundary: [x1, y1, x2, y2]. */
  walls: [number, number, number, number][];
  /** Fixed plant the drawing shows as an outlined box — an autoclave built
   *  into a wall, a cross-over bench. Drawn as an outline, never a status. */
  equipment?: [number, number, number, number][];
  /** A caption the drawing prints on such a box. */
  labels?: { x: number; y: number; text: string }[];
}

/**
 * One of several FLOORS of a building (Module-F, 2026-10-01: a ground floor and
 * a first floor, "we need to give option in Module F like Ground Floor and
 * First floor"). Plans that share a `group` are one building; the dashboard
 * lists the group once and offers its floors, lowest `order` first, by `label`.
 */
export interface ArchFloor { group: string; label: string; order: number }

/** One floor, as the generic draw script takes it. */
export interface ArchLayout {
  /** The functional-location AREA this floor is, exactly as stored. */
  area: string;
  /** The plan it is drawn ON. */
  planName: string;
  /** The source image, relative to the repo root. */
  source: string;
  building: ArchBuilding;
  rooms: ArchRoom[];
  annotations: ArchAnnotations;
  /** Set when the area has more than one plan: which floor this one is. */
  floor?: ArchFloor;
  /** The plan this floor's plan was called before it was one of several: it is
   *  RENAMED to `planName` (and audited) rather than left beside the new ones. */
  renamesPlan?: string;
  /** Where NORTH is on the drawing, in degrees clockwise from the top of the
   *  plan, when the drawing marks it. Absent = not marked. */
  north?: number;
}

export const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
export const vDoor = (at: number, from: number, to: number, hinge: ArchDoor['hinge'], kind: ArchDoor['kind'] = 'ENTRY'): ArchDoor => ({ axis: 'x', at, from, to, hinge, kind });
export const hDoor = (at: number, from: number, to: number, hinge: ArchDoor['hinge'], kind: ArchDoor['kind'] = 'ENTRY'): ArchDoor => ({ axis: 'y', at, from, to, hinge, kind });

/**
 * A DOUBLE door: two leaves hung on the two jambs, meeting in the middle. The
 * leaves are stored 1 px apart — the room check refuses two doors that touch
 * on one edge once their fractions are rounded.
 */
function pair(axis: ArchDoor['axis'], at: number, from: number, to: number, kind: ArchDoor['kind'], swing?: 'out'): ArchDoor[] {
  const mid = (from + to) / 2;
  const extra = swing ? { swing } : {};
  return [
    { axis, at, from, to: mid - 0.5, hinge: 'from', kind, ...extra },
    { axis, at, from: mid + 0.5, to, hinge: 'to', kind, ...extra },
  ];
}
export const vPair = (at: number, from: number, to: number, kind: ArchDoor['kind'] = 'ENTRY', swing?: 'out') => pair('x', at, from, to, kind, swing);
export const hPair = (at: number, from: number, to: number, kind: ArchDoor['kind'] = 'ENTRY', swing?: 'out') => pair('y', at, from, to, kind, swing);

/** A SLIDING door, a lift door or an open bay: an opening with no leaf. */
export const vSlide = (at: number, from: number, to: number): ArchDoor => vDoor(at, from, to, 'none', 'PASSAGE');
export const hSlide = (at: number, from: number, to: number): ArchDoor => hDoor(at, from, to, 'none', 'PASSAGE');
/** The bar a sliding door's panel is drawn as, on its wall: [x0, y0, x1, y1]. */
export const hBar = (y: number, x0: number, x1: number): [number, number, number, number] => [x0, y - 1.5, x1, y + 1.5];
export const vBar = (x: number, y0: number, y1: number): [number, number, number, number] => [x - 1.5, y0, x + 1.5, y1];

/**
 * A stretch of one axis that is DRAWN `add` units longer than the drawing has
 * it: everything from `from` to `to` spreads out evenly, everything past `to`
 * moves `add` along.
 */
export interface EnlargeBand { from: number; to: number; add: number }
export interface EnlargeSpec { x?: EnlargeBand[]; y?: EnlargeBand[] }

/** A coordinate on the drawing → where it is drawn, for one axis's bands. */
export function axisMap(bands: EnlargeBand[] = []): (v: number) => number {
  return (v) => bands.reduce((n, b) => n + Math.min(1, Math.max(0, (v - b.from) / (b.to - b.from))) * b.add, v);
}

/** Under this size a box is a column, a window's or a sliding door's thickness:
 *  it keeps its size and moves with the wall line it stands on. */
const RIGID_SIZE = 20;

/**
 * A trace drawn LARGER than the drawing in places (Module-F, 2026-10-01; QC 3's
 * north row was the first, by hand). A floor whose rooms are too small for an
 * instrument's card at the size a dashboard panel shows it is stretched where
 * that is, and nowhere else. The trace keeps the MEASURED numbers; this maps
 * them, so a re-measure compares like with like. What stretches and what does
 * not:
 *   - every corner, stub and caption moves through the axis maps, so rooms
 *     that tiled still tile and a wall two rooms shared is still shared;
 *   - an opening with NO leaf (a sliding door, a lift door, an open bay)
 *     stretches with its wall, and so does its bar;
 *   - a HINGED door keeps its width — a leaf is as long as the door is wide,
 *     and a stretched one would sweep the room — and moves with the wall line
 *     nearest its doorway, so a door drawn beside a corner stays beside that
 *     corner; the two leaves of a double door move together;
 *   - a COLUMN keeps its size, and a window or a bar its thickness: each moves
 *     with the wall line nearest it, so a column in a wall stays in that wall.
 */
export function enlargeLayout(layout: ArchLayout, spec: EnlargeSpec): ArchLayout {
  const fx = axisMap(spec.x), fy = axisMap(spec.y);
  const xs = [...new Set(layout.rooms.flatMap((r) => r.outline.map(([x]) => x)))];
  const ys = [...new Set(layout.rooms.flatMap((r) => r.outline.map(([, y]) => y)))];
  const nearest = (lines: number[], v: number) => lines.reduce((best, g) => (Math.abs(g - v) < Math.abs(best - v) ? g : best), lines[0]);
  /** One side of a box: its two ends mapped, or — when it is a thickness — moved rigidly with its wall line. */
  const span = (lo: number, hi: number, f: (v: number) => number, lines: number[]): [number, number] => {
    if (hi - lo > RIGID_SIZE) return [f(lo), f(hi)];
    const g = nearest(lines, (lo + hi) / 2);
    const shift = f(g) - g;
    return [lo + shift, hi + shift];
  };
  const box = ([x0, y0, x1, y1]: [number, number, number, number]): [number, number, number, number] => {
    const [a0, a1] = span(x0, x1, fx, xs), [b0, b1] = span(y0, y1, fy, ys);
    return [a0, b0, a1, b1];
  };
  const room = (r: ArchRoom): ArchRoom => {
    const door = (d: ArchDoor): ArchDoor => {
      const along = d.axis === 'x' ? fy : fx, across = d.axis === 'x' ? fx : fy;
      if (d.hinge === 'none') return { ...d, at: across(d.at), from: along(d.from), to: along(d.to) };
      // The doorway: this leaf, and the other leaf of a double door (1 unit away on the same wall).
      const mates = r.doors.filter((o) => o.hinge !== 'none' && o.axis === d.axis && o.at === d.at
        && (o === d || Math.abs(o.from - d.to) <= 1.01 || Math.abs(d.from - o.to) <= 1.01));
      const mid = (Math.min(...mates.map((o) => o.from)) + Math.max(...mates.map((o) => o.to))) / 2;
      // The wall's own two ends are wall lines, so the nearest one is never past
      // either: the doorway stays on its wall, and two doors on one wall keep their order.
      const g = nearest(d.axis === 'x' ? ys : xs, mid);
      const shift = along(g) - g;
      return { ...d, at: across(d.at), from: d.from + shift, to: d.to + shift };
    };
    return { ...r, outline: r.outline.map(([x, y]) => [fx(x), fy(y)] as Pt), doors: r.doors.map(door) };
  };
  const sum = (bands: EnlargeBand[] = []) => bands.reduce((n, b) => n + b.add, 0);
  const a = layout.annotations;
  return {
    ...layout,
    building: { ...layout.building, x1: layout.building.x1 + sum(spec.x), y1: layout.building.y1 + sum(spec.y) },
    rooms: layout.rooms.map(room),
    annotations: {
      columns: a.columns.map(box),
      windows: a.windows.map(box),
      walls: a.walls.map(([x1, y1, x2, y2]) => [fx(x1), fy(y1), fx(x2), fy(y2)] as [number, number, number, number]),
      ...(a.equipment ? { equipment: a.equipment.map(box) } : {}),
      ...(a.labels ? { labels: a.labels.map((l) => ({ ...l, x: fx(l.x), y: fy(l.y) })) } : {}),
    },
  };
}

/** The plan's stored canvas: only the RATIO matters (it sets the viewBox height). */
export function archCanvas(b: ArchBuilding): { width: number; height: number } {
  return { width: b.x1 - b.x0, height: b.y1 - b.y0 };
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Drawing px -> the 0..1 proportions the schema stores, to six places. */
function normalizer(b: ArchBuilding) {
  const { width: W, height: H } = archCanvas(b);
  return { nx: (x: number) => r6((x - b.x0) / W), ny: (y: number) => r6((y - b.y0) / H) };
}

/** A room's outline as normalized points. */
export function archPoints(b: ArchBuilding, room: ArchRoom): { x: number; y: number }[] {
  const { nx, ny } = normalizer(b);
  return room.outline.map(([x, y]) => ({ x: nx(x), y: ny(y) }));
}

/**
 * A measured door → `{edge, offset, width, kind}` on the room's own outline:
 * the edge that lies on the wall line and covers the gap; `offset` measured
 * from that edge's START corner along its direction, as fractions of its
 * length (the polygon convention). Throws when no edge carries the gap — a
 * door on the wrong room is a measuring mistake, never something to guess.
 */
export function edgeDoor(room: ArchRoom, d: ArchDoor): { edge: number; offset: number; width: number; kind: ArchDoor['kind']; hinge: 'start' | 'end' | 'none'; swing?: 'out' } {
  const pts = room.outline;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const onLine = d.axis === 'x' ? (x1 === d.at && x2 === d.at) : (y1 === d.at && y2 === d.at);
    if (!onLine) continue;
    const s = d.axis === 'x' ? y1 : x1;
    const e = d.axis === 'x' ? y2 : x2;
    const lo = Math.min(s, e), hi = Math.max(s, e);
    if (d.from < lo - 0.5 || d.to > hi + 0.5) continue;
    const len = hi - lo;
    // Along the edge's direction: from its start corner.
    const startAlong = e >= s ? d.from - s : s - d.to;
    // 'from' is the LOWER coordinate; the edge may run either way.
    const ascending = e >= s;
    const hinge = d.hinge === 'none' ? 'none' : ((d.hinge === 'from') === ascending ? 'start' : 'end');
    return { edge: i, offset: r6(startAlong / len), width: r6((d.to - d.from) / len), kind: d.kind, hinge, ...(d.swing === 'out' ? { swing: 'out' as const } : {}) };
  }
  throw new Error(`door ${d.axis}=${d.at} ${d.from}..${d.to} is on no edge of ${room.code}`);
}

/**
 * The annotation layer as stored: columns and windows as boxes, stubs as
 * segments. `plan` adds what belongs to the plan rather than to the drawing's
 * structure — which floor of a building it is, and where north is; a plan with
 * neither stores exactly what it always did.
 */
export function archAnnotations(b: ArchBuilding, a: ArchAnnotations, plan: { floor?: ArchFloor; north?: number } = {}) {
  const { nx, ny } = normalizer(b);
  const box = ([x0, y0, x1, y1]: [number, number, number, number]) =>
    ({ x: nx(x0), y: ny(y0), w: nx(x1) - nx(x0), h: ny(y1) - ny(y0) });
  return {
    ...(plan.floor ? { floor: { group: plan.floor.group, label: plan.floor.label, order: plan.floor.order } } : {}),
    ...(plan.north !== undefined ? { north: plan.north } : {}),
    // The dashboard draws this plan in the 2D ARCHITECTURAL style the operator
    // chose from three concepts (Layouts/CWH/concepts/concept-a-2d.png).
    style: 'architectural' as const,
    equipment: (a.equipment ?? []).map(box),
    hvac: [], water: [], airflow: [],
    labels: (a.labels ?? []).map((l) => ({ x: nx(l.x), y: ny(l.y), text: l.text })),
    columns: a.columns.map(box),
    windows: a.windows.map(box),
    walls: a.walls.map(([x1, y1, x2, y2]) => ({ x1: nx(x1), y1: ny(y1), x2: nx(x2), y2: ny(y2) })),
  };
}
