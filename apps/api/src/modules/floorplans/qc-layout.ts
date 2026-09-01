/**
 * The QC floor, TRACED from the operator's drawing (`QC Layout.png`, 2026-08-31).
 *
 * Every other plan in this repo is GENERATED — `draw-cwh-floorplan.ts` cuts a
 * rectangle into rooms with a guillotine split, which tessellates perfectly and
 * reads as a building, but is not the building. QC is the one floor we have an
 * actual drawing of, so its rooms are authored here as literal coordinates
 * instead of being invented. When the two disagree, this file wins.
 *
 * ─── HOW THE NUMBERS WERE OBTAINED ───────────────────────────────────────
 * Wall positions were measured off the PNG, not eyeballed: dark-pixel runs were
 * scanned column-by-column and row-by-row, and the resulting lines clustered.
 * Door openings came from the same scan (gaps in a wall) cross-checked against
 * the orange swing arcs, which were isolated by colour and clustered.
 *
 * Coordinates below are in the PNG's own pixel space and are converted to the
 * 0..1 proportions the schema stores by `norm()`. Keeping the pixels means the
 * next person can re-measure against the same image and compare like with like;
 * a table of pre-divided decimals would be unauditable.
 *
 * ─── THE CANONICAL GRID (why edges repeat) ───────────────────────────────
 * Every room edge is one of a small set of measured wall positions, and
 * neighbours quote the SAME number — 826 is DISSOLUTION-I's left edge and the
 * corridor's right edge, to the pixel. That is deliberate. The generator got
 * exact tessellation for free by construction; a hand-traced plan only gets it
 * by discipline, and a one-pixel disagreement between two rooms opens a
 * hairline gap that is visible at any zoom. Never round an edge locally — if a
 * wall moves, move it for both rooms that share it.
 *
 * ─── WHERE THIS IS DELIBERATELY NOT THE DRAWING ──────────────────────────
 * A room is stored as ONE rectangle (`x, y, w, h`). Two spaces on this floor
 * are not rectangles, so each is approximated, and the choice is recorded here
 * rather than left for someone to rediscover:
 *
 *   • SAMPLE PREPARATION ROOM (CWH-I/222) is an L — the drawing partitions off
 *     its bottom-right corner (the space annotated `2900 x 7240`). It is stored
 *     as its BOUNDING rectangle, so that one internal partition is not drawn.
 *     The alternative — splitting it into two rooms — would have to invent a
 *     wall that the drawing does not have, and a false wall on a floor plan is
 *     worse than a missing one: it says a space is closed when it is open.
 *
 *   • CORRIDOR-08 (CWH-I/217) is also an L, and the drawing labels its two legs
 *     separately (`12857 x 2000` east-west, `2000 x 24225` north-south). It IS
 *     split, into `CWH-I/217` and `CWH-I/217 (2)`, because a corridor's two legs
 *     read as two runs anyway and the `(2)` suffix is the precedent already used
 *     on this floor for SERVICE CORRIDOR. The seam where they meet is the one
 *     false wall accepted here.
 *
 * ─── THE REST OF THE DRAWING ─────────────────────────────────────
 * A plan is more than its rooms. `QC_ANNOTATIONS` below carries what is left —
 * equipment blocks, HVAC and exhaust units, water points and airflow arrows —
 * and each room's `meta` carries its drawn fill colour, its finished ceiling
 * height and its floor dimensions. They ride in two nullable JSONB columns
 * (`floorplan_rooms.meta`, `floorplans.annotations`) added by migration
 * `20260831220000_floorplan_annotations`, following the `doors`/`grade`
 * precedent: no new model, no new enum, and NULL on every generated plan, which
 * renders exactly as it did before.
 *
 * **`meta.fill` OVERRIDES the grade hue on this plan, deliberately.** The
 * draughtsman's colours say what a room is FOR; `grade` says how it is
 * classified. Both are true and neither is the other, so the drawing's colours
 * are reproduced while `grade` goes on carrying the classification for
 * everything that reads it. This is safe to do to the room fill because the
 * grade LEGEND was removed on 2026-08-27 (`fdf40ed`) — if a grade legend ever
 * comes back, it must not be keyed off the fill.
 *
 * ─── THREE THINGS IN THE PNG THAT ARE NOT HERE ──────────────────────
 *   • The `EXHAUST` arrows and the two `W` water circles are drawn OUTSIDE the
 *     building wall (up to x=1190, past the wall at x=1108). The renderer strokes
 *     the viewBox border as the building outline, so anything beyond it is
 *     clipped. The water points are moved onto the east wall, where they connect;
 *     the external exhaust arrows are omitted. Widening the canvas to fit them
 *     would detach the outline from the wall it represents.
 *   • `DRAFT COPY` and `EXISTING LAYOUT` are drawing-status stamps, not floor
 *     content, and a live monitoring screen captioned DRAFT COPY would be
 *     actively misleading about the readings on it. Omitted on purpose.
 *   • The `2900 x 7240` partition inside SAMPLE PREPARATION — see above.
 */

export type Grade = 'A' | 'B' | 'C' | 'D' | 'CIRCULATION' | 'UTILITY';
export type Door = {
  wall: 'top' | 'right' | 'bottom' | 'left';
  offset: number;
  width: number;
  kind: 'ENTRY' | 'EXIT' | 'PASSAGE';
};

/**
 * The building's outer wall in PNG pixels — NOT the file's 1204x1046.
 *
 * The renderer strokes the viewBox border as the building outline and maps
 * every room proportionally inside it, so the proportions have to be taken
 * against the BUILDING, not against the canvas it was drawn on. The PNG carries
 * a legend strip and margins outside the wall; normalising against those would
 * shrink the floor and float it off its own outline.
 */
export const QC_BUILDING = { x0: 26, y0: 21, x1: 1108, y1: 996 } as const;

/**
 * The plan's stored canvas. Only the RATIO matters — it sets the viewBox height.
 *
 * This bypasses `canvasFor(roomCount)` in the drawing script, whose job is to
 * keep a ROOM about the same size on screen across plans so the set reads as
 * one building rather than as drawings at different zooms. Bypassing it is
 * unavoidable — the drawing already decided this floor's proportions — but it
 * turns out not to cost anything: `canvasFor(23)` would pick a viewBox height
 * of 958, and the building's own proportions give 901, a 6% difference. If the
 * room count here ever changes a lot, re-check that the two have not diverged.
 */
export const QC_CANVAS = {
  width: QC_BUILDING.x1 - QC_BUILDING.x0,   // 1082
  height: QC_BUILDING.y1 - QC_BUILDING.y0,  // 975
} as const;

/**
 * What the drawing says about a room beyond its outline. Stored verbatim into
 * `floorplan_rooms.meta`.
 *
 * `fch` and `dims` are STRINGS, not numbers, because they are transcribed from a
 * drawing rather than computed — `2.7m` and `4993 x 11390` are what is written
 * on the plan, and re-deriving either from the stored geometry would produce a
 * different number, since the drawing is schematic and not to scale.
 */
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
 * The floor.
 *
 * Order follows the drawing top-left to bottom-right so the table can be read
 * against the image. The API re-sorts by code before rendering, so this order
 * carries no meaning at runtime.
 */
export const QC_ROOMS: Traced[] = [
  // ── North block ────────────────────────────────────────────────────────
  {
    code: 'CWH-I/231', label: 'HOT ZONE', px: [85, 27, 263, 223],
    meta: { fill: '#f1f7fe', fch: '2.7m', dims: '2925 x 5237' },
    instrument: 'CWH/RDU/015-00',
    doors: [{ wall: 'right', offset: 0.74, width: 0.24, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/230', label: 'WET LAB', px: [263, 27, 755, 223],
    meta: { fill: '#f1f7fe', fch: '2.7m', dims: '9830 x 5237' },
    instrument: 'CWH/RDU/022-00',
    doors: [{ wall: 'right', offset: 0.77, width: 0.19, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/229', label: 'SAMPLE DESTRUCTION ROOM', px: [85, 223, 310, 362],
    meta: { fill: '#f3f2fb', fch: '2.7m', dims: '4970 x 2500' },
    instrument: 'CWH/RDU/018-00',
    doors: [{ wall: 'bottom', offset: 0.85, width: 0.14, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/228', label: 'CHAMBER ROOM', px: [310, 223, 536, 362],
    meta: { fill: '#f3f2fb', fch: '2.7m', dims: '4000 x 2500' },
    instrument: 'CWH/RDU/017-00',
    doors: [{ wall: 'bottom', offset: 0.61, width: 0.15, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/227', label: 'WEIGHING ROOM', px: [536, 223, 755, 362],
    meta: { fill: '#f3f2fb', fch: '2.7m', dims: '3700 x 2500' },
    instrument: 'CWH/RDU/016-00',
    doors: [{ wall: 'bottom', offset: 0.83, width: 0.17, kind: 'ENTRY' }],
  },

  // ── North-east block ───────────────────────────────────────────────────
  {
    code: 'CWH-I/232', label: 'OFFICE-01', px: [826, 27, 953, 156],
    meta: { fill: '#f3f6fc', fch: '2.7m', dims: '2400 x 3000' }, grade: 'UTILITY',
    doors: [{ wall: 'left', offset: 0.66, width: 0.32, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/233', label: 'OFFICE-02', px: [953, 27, 1099, 156],
    meta: { fill: '#f1f5fd', fch: '2.7m', dims: '2500 x 3000' }, grade: 'UTILITY',
    doors: [{ wall: 'bottom', offset: 0.02, width: 0.26, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/226', label: 'INSTRUMENTATION ROOM-01', px: [826, 156, 1089, 394],
    meta: { fill: '#f3f8f4', fch: '2.7m', dims: '4993 x 5100' },
    instrument: 'CWH/RDU/019-00',
    doors: [{ wall: 'left', offset: 0.05, width: 0.14, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/225', label: 'DISSOLUTION ROOM-I', px: [826, 394, 1089, 688],
    meta: { fill: '#fcf9f0', fch: '2.7m', dims: '4993 x 11390' },
    instrument: 'CWH/RDU/021-00',
    doors: [{ wall: 'left', offset: 0.18, width: 0.14, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/224', label: 'SAMPLE STORAGE ROOM', px: [826, 688, 1089, 799],
    meta: { fill: '#f3f9f2', fch: '2.7m', dims: '4993 x 2534' },
    instrument: 'CWH/RDU/013-00',
    doors: [{ wall: 'left', offset: 0.48, width: 0.28, kind: 'ENTRY' }],
  },

  // ── Central block ──────────────────────────────────────────────────────
  //
  // The bounding rectangle of an L — see the header note. Three doors, all of
  // them real openings measured off the drawing: one from the north corridor
  // and two onto CORRIDOR-08 along the bottom.
  {
    code: 'CWH-I/222', label: 'SAMPLE PREPARATION ROOM', px: [42, 426, 424, 799],
    meta: { fill: '#edf5fe', fch: '2.7m', dims: '6577 x 5017' },
    instrument: 'CWH/RDU/023-00',
    doors: [
      { wall: 'top', offset: 0.02, width: 0.11, kind: 'ENTRY' },
      { wall: 'bottom', offset: 0.60, width: 0.09, kind: 'PASSAGE' },
      { wall: 'bottom', offset: 0.89, width: 0.10, kind: 'PASSAGE' },
    ],
  },
  // HPLC is drawn SEALED — all four of its walls scan as continuous, with no
  // gap and no swing arc. That is reproduced rather than corrected: inventing a
  // door would be inventing a means of escape on a GMP drawing. If the real
  // room has one, it belongs on the drawing first.
  {
    code: 'CWH-I/223', label: 'HPLC ROOM', px: [424, 426, 723, 799],
    meta: { fill: '#eef7ed', fch: '2.7m', dims: '6180 x 12287' },
    instrument: 'CWH/RDU/020-00',
    doors: [],
  },

  // ── South block ────────────────────────────────────────────────────────
  {
    code: 'CWH-I/220', label: 'WASH AREA-02', px: [42, 868, 298, 992],
    meta: { fill: '#fef1ee', fch: '2.7m', dims: '5200 x 3020' }, grade: 'UTILITY',
    doors: [{ wall: 'top', offset: 0.83, width: 0.14, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/219', label: 'GC ROOM', px: [298, 868, 718, 992],
    meta: { fill: '#fef4ea', fch: '2.7m', dims: '8350 x 3020' },
    instrument: 'CWH/RDU/014-00',
    doors: [{ wall: 'top', offset: 0.89, width: 0.10, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/218', label: 'DISSOLUTION ROOM-II', px: [718, 868, 917, 992],
    meta: { fill: '#fef1ec', fch: '2.7m', dims: '2850 x 3020' },
    instrument: 'CWH/RDU/024-00',
    doors: [{ wall: 'top', offset: 0.02, width: 0.22, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/216', label: 'CHANGE ROOM', px: [953, 868, 1099, 992],
    meta: { fill: '#f0f6fe', fch: '2.7m', dims: '3350 x 5070' }, grade: 'UTILITY',
    doors: [{ wall: 'top', offset: 0.02, width: 0.24, kind: 'ENTRY' }],
  },

  // ── Circulation ────────────────────────────────────────────────────────
  //
  // CORRIDOR-08's two legs. The drawing gives them one number and two dimension
  // strings; the schema gives a room one rectangle, so they are two rows.
  {
    code: 'CWH-I/217', label: 'CORRIDOR-08', px: [42, 799, 1099, 868],
    meta: { fill: '#f9fafc', fch: '2.7m', dims: '12857 x 2000' },
    grade: 'CIRCULATION', doors: [],
  },
  {
    code: 'CWH-I/217 (2)', label: 'CORRIDOR-08', px: [723, 426, 826, 799],
    meta: { fill: '#f9fafc', fch: '2.7m', dims: '2000 x 24225' },
    grade: 'CIRCULATION', doors: [],
  },
  // Unnumbered on the drawing — the "DRAFT COPY / EXISTING LAYOUT" banner is
  // laid over this band, which is why it carries no label there.
  {
    code: 'CORRIDOR — NORTH', label: null, px: [42, 362, 826, 426],
    meta: { fill: '#f9fafc' },
    grade: 'CIRCULATION', doors: [],
  },
  {
    code: 'LOBBY', label: null, px: [755, 27, 826, 362],
    meta: { fill: '#f9fafc' },
    grade: 'CIRCULATION', doors: [],
  },
  {
    code: 'AIRLOCK', label: null, px: [917, 868, 953, 992],
    meta: { fill: '#dce4f2' },
    grade: 'CIRCULATION', doors: [],
  },
  // The two service shafts, which is where the drawing puts its AHU and exhaust
  // units. They are narrow on purpose — that is their measured width.
  {
    code: 'SHAFT-W', label: null, px: [34, 27, 85, 362],
    meta: { fill: '#ffffff' },
    grade: 'CIRCULATION', doors: [],
  },
  {
    code: 'SHAFT-E', label: null, px: [1089, 156, 1099, 799],
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
 * Positions came from the same measurement pass as the walls: equipment blocks
 * are the dense orange hatch clusters, HVAC/exhaust units the saturated green
 * ones, both isolated by colour and connected-component-labelled; the airflow
 * runs were found by scanning the corridor bands for long dashed green rows.
 * Pixel coordinates again, normalized by `normAnnotations()` on the way out.
 *
 * These are STATIC. Nothing here senses anything — an HVAC symbol marks where a
 * unit is DRAWN, not a unit that reports, and it must never acquire a status
 * colour, or a plan will appear to be telling you an air handler is healthy on
 * the strength of a draughtsman having drawn a box.
 */
export interface PlanAnnotations {
  /** Process equipment, drawn as a hatched block. `[x0,y0,x1,y1]` in PNG px. */
  equipment: [number, number, number, number][];
  /** Air handling / exhaust units, drawn in the service shafts. */
  hvac: [number, number, number, number][];
  /** Water points, drawn as a circled `W`. `[cx,cy]` in PNG px. */
  water: [number, number][];
  /** Airflow direction: a dashed run with an arrowhead at each end. */
  airflow: { y: number; x0: number; x1: number }[];
  /** Free text written on the plan. `[x,y]` is the text's mid-left. */
  labels: { x: number; y: number; text: string }[];
}

export const QC_ANNOTATIONS: PlanAnnotations = {
  // Six blocks. The two straddling a wall (in HPLC's corners) are drawn that
  // way on the plan — equipment sited against a partition, not a tracing slip.
  equipment: [
    [318, 433, 352, 464],
    [681, 434, 716, 467],
    [683, 761, 717, 793],
    [337, 769, 365, 793],
    [265, 960, 292, 984],
    [677, 967, 705, 985],
  ],
  // All three sit in the EAST service shaft, which is why that shaft is kept as
  // a room despite being only 10px wide: it is where the plant is.
  // Clamped to end at 1105. Measured, these run to 1112 — three pixels PAST the
  // outer wall at 1108 — so drawn faithfully they are clipped by the building
  // outline and render as half a box. They sit in the east service shaft; that
  // is where they are put.
  hvac: [
    [1089, 265, 1105, 313],
    [1089, 517, 1105, 558],
    [1089, 752, 1105, 797],
  ],
  // Moved onto the east wall from x=1117 and x=1140, both of which are OUTSIDE
  // the building outline and would be clipped. See the header note.
  water: [
    [1092, 126],
    [1092, 829],
  ],
  // Two runs along the south corridor, each arrowheaded at both ends: the
  // corridor is swept in both directions, which is the claim the drawing makes.
  airflow: [
    { y: 834, x0: 85, x1: 536 },
    { y: 842, x0: 645, x1: 953 },
  ],
  labels: [
    { x: 953, y: 150, text: 'NOD' },
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
    airflow: a.airflow.map((f) => ({ y: ny(f.y), x0: nx(f.x0), x1: nx(f.x1) })),
    labels: a.labels.map((l) => ({ x: nx(l.x), y: ny(l.y), text: l.text })),
  };
}
