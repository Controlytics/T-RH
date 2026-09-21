/**
 * The QC floor, TRACED from the architectural drawing
 * `Layouts/CWH/QC Layout.png` (re-traced 2026-09-21).
 *
 * Every other plan in this repo is GENERATED — `draw-cwh-floorplan.ts` cuts a
 * rectangle into rooms with a guillotine split, which tessellates perfectly and
 * reads as a building, but is not the building. QC is the one floor we have an
 * actual drawing of, so its rooms are authored here as literal coordinates
 * instead of being invented. When the two disagree, this file wins.
 *
 * ─── WHICH IMAGE, AND WHY IT CHANGED ───────────────────────────────────
 * The first trace (2026-08-31) was taken from `QC Layout.png` at the repo
 * ROOT, which turned out to be a MOCKUP made from the drawing (tinted rooms,
 * live readings, a legend), not the drawing itself. The mockup is landscape
 * (1204x1046, building 1.11 wide-to-tall); the drawing is portrait (599x802,
 * building 0.74), and the room dimensions written on it add up to the
 * drawing's proportions, not the mockup's. The mockup had also redrawn the
 * north rooms deeper and moved two doors to the wrong end of their walls. On
 * 2026-09-21 the operator pointed at the drawing ("check that image once") and
 * chose a re-trace. Every rectangle below is measured from the drawing; the
 * room numbers, names, ceiling heights, dimension strings and instrument
 * placements did not move ("instrument ids should be remain those areas
 * only").
 *
 * ─── HOW THE NUMBERS WERE OBTAINED ───────────────────────────────────────
 * Wall positions were measured off the PNG, not eyeballed: dark-pixel runs
 * (>30 px) were scanned column-by-column and row-by-row and clustered into wall
 * lines with their spans. Door openings are the gaps in those walls,
 * cross-checked against the orange swing arcs (isolated by colour and
 * connected-component-labelled; an arc is sparse, an equipment block dense).
 * Each region was then read off 2x gridded crops of the drawing.
 *
 * Coordinates below are in the PNG's own pixel space and are converted to the
 * 0..1 proportions the schema stores by `norm()`. Keeping the pixels means the
 * next person can re-measure against the same image and compare like with like.
 *
 * ─── THE CANONICAL GRID (why edges repeat) ───────────────────────────────
 * Every room edge is one of a small set of measured wall positions, and
 * neighbours quote the SAME number — 440 is the corridor leg's right edge and
 * the east rooms' left edge, to the pixel. Never round an edge locally — if a
 * wall moves, move it for both rooms that share it. Where a wall's two faces
 * scan one or two pixels apart (287/289 at the north corridor's foot) ONE
 * number is chosen for both rooms.
 *
 * ─── WHERE THIS IS DELIBERATELY NOT THE DRAWING ──────────────────────────
 *   • SAMPLE PREPARATION ROOM (CWH-I/222) is an L — the drawing partitions off
 *     its bottom-right (the `2900 x 7240` space, walls at x=115 and y=433).
 *     Stored as its BOUNDING rectangle, so that internal partition is not
 *     drawn: splitting it would invent a wall the drawing does not have.
 *   • CORRIDOR-08 (CWH-I/217) is an L whose east end the CHANGE ROOM bites
 *     into (its top wall sits 19 px inside the corridor band, with the door in
 *     it). It is stored as THREE rectangles — the east-west run, the
 *     north-south leg, and the short east piece the change room shares its
 *     top wall with — with the `(2)` / `(3)` suffixes the SERVICE CORRIDOR
 *     precedent established. The two seams are the false walls accepted here.
 *   • There is no SHAFT-W and no AIRLOCK any more: both existed on the mockup
 *     and not on the drawing. The west edge of the building is the hatched
 *     outer wall; the change room meets DISSOLUTION ROOM-II directly.
 *
 * ─── THE REST OF THE DRAWING ─────────────────────────────────────
 * `QC_ANNOTATIONS` carries what is left — equipment blocks, the HVAC unit,
 * water points and free text — and each room's `meta` its drawn fill, finished
 * ceiling height and floor dimensions, in the two nullable JSONB columns added
 * by `20260831220000_floorplan_annotations`. **`meta.fill` OVERRIDES the grade
 * hue on this plan** (the grade legend was removed 2026-08-27; if it comes
 * back it must not key off the fill). The drawing is uncoloured, so the fills
 * are the mockup's soft tints, kept because they are what the operator
 * approved on screen.
 *
 * ─── THINGS IN THE PNG THAT ARE NOT HERE ──────────────────────────
 *   • The two `W` water circles and the exhaust arrows sit OUTSIDE the east
 *     wall and would be clipped by the building outline the renderer strokes;
 *     the water points are moved onto the east wall.
 *   • `DRAFT COPY` / `EXISTING LAYOUT` are drawing-status stamps.
 *   • The orange/green hatch strip below the south wall (y > 791) is outside
 *     the building.
 *   • The mockup's two airflow arrows are NOT on the drawing and are gone.
 */

export type Grade = 'A' | 'B' | 'C' | 'D' | 'CIRCULATION' | 'UTILITY';
export type Door = {
  wall: 'top' | 'right' | 'bottom' | 'left';
  offset: number;
  width: number;
  kind: 'ENTRY' | 'EXIT' | 'PASSAGE';
};

/**
 * The building's outer wall in PNG pixels — NOT the file's 599x802.
 *
 * The renderer strokes the viewBox border as the building outline and maps
 * every room proportionally inside it, so the proportions are taken against
 * the BUILDING: the inner face of the west wall (13), the top wall (5), the
 * outer face of the east service band (591) and the south wall (791).
 */
export const QC_BUILDING = { x0: 13, y0: 5, x1: 591, y1: 791 } as const;

/**
 * The plan's stored canvas. Only the RATIO matters — it sets the viewBox height.
 * Portrait, 0.74: the building's own shape. `canvasFor(23)` in the drawing
 * script would pick a landscape box; that is bypassed for this plan.
 */
export const QC_CANVAS = {
  width: QC_BUILDING.x1 - QC_BUILDING.x0,   // 578
  height: QC_BUILDING.y1 - QC_BUILDING.y0,  // 786
} as const;

export interface RoomMeta {
  /** The room's fill as drawn. Overrides the grade hue — see the header. */
  fill?: string;
  /** Finished ceiling height, as written: `2.7m`. */
  fch?: string;
  /** Floor dimensions in mm, as written: `4993 x 2534`. */
  dims?: string;
}

interface Traced {
  /** Room number from the drawing, e.g. `CWH-I/224`. Becomes `code`. */
  code: string;
  /** The room's name as drawn, e.g. `SAMPLE STORAGE ROOM`. Becomes `label`. */
  label: string | null;
  /** Pixel rectangle in the PNG: left, top, right, bottom. */
  px: [number, number, number, number];
  grade?: Grade;
  doors?: Door[];
  meta?: RoomMeta;
  /** Instrument code sited in this room, per `CWH.xlsx`'s Location column. */
  instrument?: string;
}

/**
 * The floor. Order follows the drawing top-left to bottom-right so the table
 * can be read against the image. The API re-sorts by code before rendering.
 *
 * Wall grid (px): x ∈ {13, 97, 156, 163, 202, 272, 381, 404, 440, 488, 510,
 * 586, 591}; y ∈ {5, 92, 155, 229, 240, 288, 567, 641, 681, 700, 791}.
 */
export const QC_ROOMS: Traced[] = [
  // ── North block ────────────────────────────────────────────────────────
  {
    code: 'CWH-I/231', label: 'HOT ZONE', px: [13, 5, 97, 155],
    meta: { fill: '#f1f7fe', fch: '2.7m', dims: '2925 x 5237' },
    instrument: 'CWH/RDU/015-00',
    // Wall gap y 123..155 on the right wall (arc at 72..97 × 123..143).
    doors: [{ wall: 'right', offset: 0.79, width: 0.21, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/230', label: 'WET LAB', px: [97, 5, 381, 155],
    meta: { fill: '#f1f7fe', fch: '2.7m', dims: '9830 x 5237' },
    instrument: 'CWH/RDU/022-00',
    // Wall gap y 118..150 on the right wall, into the lobby.
    doors: [{ wall: 'right', offset: 0.75, width: 0.21, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/229', label: 'SAMPLE DESTRUCTION ROOM', px: [13, 155, 156, 229],
    meta: { fill: '#f3f2fb', fch: '2.7m', dims: '4970 x 2500' },
    instrument: 'CWH/RDU/018-00',
    // Gap x 60..93 in the bottom wall — the mockup had this door at the RIGHT end.
    doors: [{ wall: 'bottom', offset: 0.33, width: 0.23, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/228', label: 'CHAMBER ROOM', px: [156, 155, 272, 229],
    meta: { fill: '#f3f2fb', fch: '2.7m', dims: '4000 x 2500' },
    instrument: 'CWH/RDU/017-00',
    // Gap x 192..220.
    doors: [{ wall: 'bottom', offset: 0.31, width: 0.24, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/227', label: 'WEIGHING ROOM', px: [272, 155, 381, 229],
    meta: { fill: '#f3f2fb', fch: '2.7m', dims: '3700 x 2500' },
    instrument: 'CWH/RDU/016-00',
    // Gap x 348..381.
    doors: [{ wall: 'bottom', offset: 0.70, width: 0.30, kind: 'ENTRY' }],
  },

  // ── North-east block ───────────────────────────────────────────────────
  {
    code: 'CWH-I/232', label: 'OFFICE-01', px: [440, 5, 510, 92],
    meta: { fill: '#f3f6fc', fch: '2.7m', dims: '2400 x 3000' }, grade: 'UTILITY',
    // Gap y 61..92 on the left wall, from the lobby.
    doors: [{ wall: 'left', offset: 0.64, width: 0.36, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/233', label: 'OFFICE-02', px: [510, 5, 586, 92],
    meta: { fill: '#f1f5fd', fch: '2.7m', dims: '2500 x 3000' }, grade: 'UTILITY',
    doors: [
      // Arc at 512..537 × 59..82, on the bottom wall.
      { wall: 'bottom', offset: 0.03, width: 0.33, kind: 'ENTRY' },
      // The green arc on the east wall at y 60..82: an outside door.
      { wall: 'right', offset: 0.63, width: 0.25, kind: 'EXIT' },
    ],
  },
  {
    code: 'CWH-I/226', label: 'INSTRUMENTATION ROOM-01', px: [440, 92, 586, 240],
    meta: { fill: '#f3f8f4', fch: '2.7m', dims: '4993 x 5100' },
    instrument: 'CWH/RDU/019-00',
    // Gap y 92..123 at the top of the left wall (arc 447..466 × 99..121).
    doors: [{ wall: 'left', offset: 0.0, width: 0.21, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/225', label: 'DISSOLUTION ROOM-I', px: [440, 240, 586, 567],
    meta: { fill: '#fcf9f0', fch: '2.7m', dims: '4993 x 11390' },
    instrument: 'CWH/RDU/021-00',
    // TWO doors on the corridor side — gaps y 290..315 and 461..486. The
    // mockup showed only the first.
    doors: [
      { wall: 'left', offset: 0.15, width: 0.08, kind: 'ENTRY' },
      { wall: 'left', offset: 0.68, width: 0.08, kind: 'ENTRY' },
    ],
  },
  {
    code: 'CWH-I/224', label: 'SAMPLE STORAGE ROOM', px: [440, 567, 586, 641],
    meta: { fill: '#f3f9f2', fch: '2.7m', dims: '4993 x 2534' },
    instrument: 'CWH/RDU/013-00',
    // Gap y 610..641 at the foot of the left wall.
    doors: [{ wall: 'left', offset: 0.58, width: 0.42, kind: 'ENTRY' }],
  },

  // ── Central block ──────────────────────────────────────────────────────
  // The bounding rectangle of an L — see the header note.
  {
    code: 'CWH-I/222', label: 'SAMPLE PREPARATION ROOM', px: [13, 288, 202, 641],
    meta: { fill: '#edf5fe', fch: '2.7m', dims: '6577 x 5017' },
    instrument: 'CWH/RDU/023-00',
    doors: [
      // Gap x 167..200 in the top wall, from the north corridor — at the RIGHT
      // end; the mockup had it at the left.
      { wall: 'top', offset: 0.81, width: 0.17, kind: 'ENTRY' },
      // Gaps x 84..112 and 168..199 in the bottom wall, onto CORRIDOR-08.
      { wall: 'bottom', offset: 0.38, width: 0.15, kind: 'PASSAGE' },
      { wall: 'bottom', offset: 0.82, width: 0.16, kind: 'PASSAGE' },
    ],
  },
  // HPLC has TWO doors onto the corridor leg — gaps y 324..355 and 574..606
  // in its right wall. The mockup drew it sealed, and the 2026-08-31 trace
  // recorded that as "no door on the drawing"; the drawing says otherwise.
  {
    code: 'CWH-I/223', label: 'HPLC ROOM', px: [202, 288, 381, 641],
    meta: { fill: '#eef7ed', fch: '2.7m', dims: '6180 x 12287' },
    instrument: 'CWH/RDU/020-00',
    doors: [
      { wall: 'right', offset: 0.10, width: 0.09, kind: 'ENTRY' },
      { wall: 'right', offset: 0.81, width: 0.09, kind: 'ENTRY' },
    ],
  },

  // ── South block ────────────────────────────────────────────────────────
  {
    code: 'CWH-I/220', label: 'WASH AREA-02', px: [13, 700, 163, 791],
    meta: { fill: '#fef1ee', fch: '2.7m', dims: '5200 x 3020' }, grade: 'UTILITY',
    // Gap x 131..158 in the top wall.
    doors: [{ wall: 'top', offset: 0.79, width: 0.18, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/219', label: 'GC ROOM', px: [163, 700, 404, 791],
    meta: { fill: '#fef4ea', fch: '2.7m', dims: '8350 x 3020' },
    instrument: 'CWH/RDU/014-00',
    // Gap x 370..404.
    doors: [{ wall: 'top', offset: 0.86, width: 0.14, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/218', label: 'DISSOLUTION ROOM-II', px: [404, 700, 488, 791],
    meta: { fill: '#fef1ec', fch: '2.7m', dims: '2850 x 3020' },
    instrument: 'CWH/RDU/024-00',
    // Gap x 404..435.
    doors: [{ wall: 'top', offset: 0.0, width: 0.37, kind: 'ENTRY' }],
  },
  // Its top wall sits at 681, inside the corridor band — see the header.
  {
    code: 'CWH-I/216', label: 'CHANGE ROOM', px: [488, 681, 586, 791],
    meta: { fill: '#f0f6fe', fch: '2.7m', dims: '3350 x 5070' }, grade: 'UTILITY',
    // Arc 488..513 × 653..675, above the top wall.
    doors: [{ wall: 'top', offset: 0.0, width: 0.26, kind: 'ENTRY' }],
  },

  // ── Circulation ────────────────────────────────────────────────────────
  {
    code: 'CWH-I/217', label: 'CORRIDOR-08', px: [13, 641, 488, 700],
    meta: { fill: '#f9fafc', fch: '2.7m', dims: '12857 x 2000' },
    grade: 'CIRCULATION', doors: [],
  },
  {
    code: 'CWH-I/217 (2)', label: 'CORRIDOR-08', px: [381, 288, 440, 641],
    meta: { fill: '#f9fafc', fch: '2.7m', dims: '2000 x 24225' },
    grade: 'CIRCULATION', doors: [],
  },
  // The short east piece above the change room, ending at the outside door.
  {
    code: 'CWH-I/217 (3)', label: 'CORRIDOR-08', px: [488, 641, 586, 681],
    meta: { fill: '#f9fafc', fch: '2.7m' },
    grade: 'CIRCULATION',
    // The blue arc on the east wall at y 645..670: an outside door.
    doors: [{ wall: 'right', offset: 0.1, width: 0.6, kind: 'EXIT' }],
  },
  // Unnumbered on the drawing — the "DRAFT COPY / EXISTING LAYOUT" stamps are
  // laid over this band, which is why it carries no label there.
  {
    code: 'CORRIDOR — NORTH', label: null, px: [13, 229, 381, 288],
    meta: { fill: '#f9fafc' },
    grade: 'CIRCULATION', doors: [],
  },
  // The entrance strip between the north rooms and the offices, running down
  // to the corridor leg. Four doors open onto it; it has none of its own.
  {
    code: 'LOBBY', label: null, px: [381, 5, 440, 288],
    meta: { fill: '#f9fafc' },
    grade: 'CIRCULATION', doors: [],
  },
  // The east service band, where the drawing puts its HVAC unit and the two
  // water points. Narrow on purpose — that is its measured width.
  {
    code: 'SHAFT-E', label: null, px: [586, 5, 591, 791],
    meta: { fill: '#ffffff' },
    grade: 'CIRCULATION', doors: [],
  },
];

/** PNG pixels -> the 0..1 proportions the schema stores. */
export function norm(px: [number, number, number, number]): { x: number; y: number; w: number; h: number } {
  const [x0, y0, x1, y1] = px;
  const W = QC_CANVAS.width, H = QC_CANVAS.height;
  return {
    x: (x0 - QC_BUILDING.x0) / W,
    y: (y0 - QC_BUILDING.y0) / H,
    w: (x1 - x0) / W,
    h: (y1 - y0) / H,
  };
}

/**
 * EVERYTHING ON THE PLAN THAT IS NOT A ROOM.
 *
 * Positions came from the same measurement pass as the walls: equipment
 * blocks are the dense orange hatch squares, the HVAC unit the green box in
 * the east band, both isolated by colour and connected-component-labelled.
 * Pixel coordinates again, normalized by `normAnnotations()` on the way out.
 *
 * These are STATIC. Nothing here senses anything — an HVAC symbol marks where
 * a unit is DRAWN, not a unit that reports, and it must never acquire a status
 * colour.
 */
export interface PlanAnnotations {
  /** Process equipment, drawn as a hatched block. `[x0,y0,x1,y1]` in PNG px. */
  equipment: [number, number, number, number][];
  /** Air handling / exhaust units, drawn in the service band. */
  hvac: [number, number, number, number][];
  /** Water points, drawn as a circled `W`. `[cx,cy]` in PNG px. */
  water: [number, number][];
  /** Airflow direction: a dashed run with an arrowhead at each end. None on this drawing. */
  airflow: { y: number; x0: number; x1: number }[];
  /** Free text written on the plan. `[x,y]` is the text's mid-left. */
  labels: { x: number; y: number; text: string }[];
}

export const QC_ANNOTATIONS: PlanAnnotations = {
  // Seven blocks. Three sit in HPLC's / DISSOLUTION-I's / SAMPLE STORAGE's
  // corners against the corridor or east wall; two in SAMPLE PREPARATION; one
  // at the foot of WASH AREA-02, clamped to the south wall.
  equipment: [
    [141, 291, 160, 310],
    [354, 291, 378, 315],
    [568, 291, 585, 315],
    [141, 615, 161, 634],
    [352, 615, 377, 639],
    [569, 615, 585, 638],
    [140, 785, 160, 791],
  ],
  // The one unit drawn inside the building, in the east band beside SAMPLE
  // STORAGE (measured to 593; clamped to the outer wall at 591).
  hvac: [
    [567, 613, 591, 639],
  ],
  // Both `W` circles are drawn outside the east wall; moved onto it.
  water: [
    [589, 72],
    [589, 656],
  ],
  airflow: [],
  labels: [
    { x: 505, y: 75, text: 'NOD' },
  ],
};

/** Annotation pixels -> the 0..1 proportions stored on `floorplans.annotations`. */
export function normAnnotations(a: PlanAnnotations = QC_ANNOTATIONS) {
  const W = QC_CANVAS.width, H = QC_CANVAS.height;
  const nx = (v: number) => (v - QC_BUILDING.x0) / W;
  const ny = (v: number) => (v - QC_BUILDING.y0) / H;
  const box = ([x0, y0, x1, y1]: [number, number, number, number]) =>
    ({ x: nx(x0), y: ny(y0), w: (x1 - x0) / W, h: (y1 - y0) / H });
  return {
    equipment: a.equipment.map(box),
    hvac: a.hvac.map(box),
    water: a.water.map(([x, y]) => ({ x: nx(x), y: ny(y) })),
    airflow: a.airflow.map((r) => ({ y: ny(r.y), x0: nx(r.x0), x1: nx(r.x1) })),
    labels: a.labels.map((l) => ({ x: nx(l.x), y: ny(l.y), text: l.text })),
  };
}
