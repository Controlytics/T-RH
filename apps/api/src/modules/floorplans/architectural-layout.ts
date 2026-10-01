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
}

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
}

export const rect = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
export const vDoor = (at: number, from: number, to: number, hinge: ArchDoor['hinge'], kind: ArchDoor['kind'] = 'ENTRY'): ArchDoor => ({ axis: 'x', at, from, to, hinge, kind });
export const hDoor = (at: number, from: number, to: number, hinge: ArchDoor['hinge'], kind: ArchDoor['kind'] = 'ENTRY'): ArchDoor => ({ axis: 'y', at, from, to, hinge, kind });

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
export function edgeDoor(room: ArchRoom, d: ArchDoor): { edge: number; offset: number; width: number; kind: ArchDoor['kind']; hinge: 'start' | 'end' | 'none' } {
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
    return { edge: i, offset: r6(startAlong / len), width: r6((d.to - d.from) / len), kind: d.kind, hinge };
  }
  throw new Error(`door ${d.axis}=${d.at} ${d.from}..${d.to} is on no edge of ${room.code}`);
}

/** The annotation layer as stored: columns and windows as boxes, stubs as segments. */
export function archAnnotations(b: ArchBuilding, a: ArchAnnotations) {
  const { nx, ny } = normalizer(b);
  const box = ([x0, y0, x1, y1]: [number, number, number, number]) =>
    ({ x: nx(x0), y: ny(y0), w: nx(x1) - nx(x0), h: ny(y1) - ny(y0) });
  return {
    // The dashboard draws this plan in the 2D ARCHITECTURAL style the operator
    // chose from three concepts (Layouts/CWH/concepts/concept-a-2d.png).
    style: 'architectural' as const,
    equipment: [], hvac: [], water: [], airflow: [], labels: [],
    columns: a.columns.map(box),
    windows: a.windows.map(box),
    walls: a.walls.map(([x1, y1, x2, y2]) => ({ x1: nx(x1), y1: ny(y1), x2: nx(x2), y2: ny(y2) })),
  };
}
