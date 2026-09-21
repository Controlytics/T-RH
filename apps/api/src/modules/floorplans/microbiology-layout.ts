/**
 * The QC Microbiology floor, TRACED from the architectural drawing
 * `Layouts/CWH/Microbiology.png` (1427x642, 2026-09-21).
 *
 * Operator: "do the same for qc 3 and microbiology layouts". Same method as
 * `qc-layout.ts`: wall runs scanned, door openings from the orange swing arcs,
 * every edge read off 2x gridded crops, and the dimension strings written on
 * the drawing used as the cross-check (~0.06 px/mm).
 *
 * ─── THE DRAWING IS CUT OFF AT THE BOTTOM ──────────────────────────────────
 * The image ends at y 642 through the south row (GENERAL LAB, DECONTAMINATION,
 * WASH ROOM-01, WATER WET ANALYSIS ROOM, INCUBATOR ROOM-01). Their written
 * depths (2415 mm, and 4015 mm for the incubator) all put the south wall at
 * y ≈ 660, and INCUBATOR ROOM-02's written height (9550 mm) agrees, so the
 * building is closed at y 660 — 18 px past the image — and those rooms' south
 * walls are COMPUTED from the drawing's own dimension strings. Every other
 * edge is measured. If a fuller drawing turns up, re-measure that wall.
 *
 * ─── WHERE THIS IS DELIBERATELY NOT THE DRAWING ──────────────────────────
 *   • INCUBATOR ROOM-01 is an L (it wraps under the corridor's west end) and
 *     carries no room number; stored as `INCUBATOR-01` plus an `INCUBATOR-01
 *     (2)` piece, which the view draws as one space.
 *   • The west edge is the image's edge (x 0): INCUBATOR ROOM-02's west wall
 *     is the drawing's border. The band east of x 1383 (`WD`, the `COB` duct)
 *     is outside the plan.
 *   • The HPHV STERILIZER between the COOLING ZONE and STERILIZATION is drawn
 *     as an equipment block — it is a pass-through autoclave, not a room; the
 *     four hatched blocks in the south row and INCUBATOR ROOM-02 likewise.
 *   • The narrow breakable-glass strip between INCUBATOR ROOM-02 and the BIO
 *     SAFETY CABINET room (x 143..165) is folded into the BSC room.
 *   • `SDB-5` / `SDA-10` panel tags and the `EE` stamps are not carried.
 *
 * `CWH/RDU/051-00` reads `Incubator room (Microbiology)` with no number; it is
 * sited in INCUBATOR ROOM-01 (the larger room, holding the instrument tile).
 * Move it to `CWH-I/360` if the registry means the other.
 */
import type { TracedLayout, TracedRoom } from './traced-layout.js';

const B = { x0: 0, y0: 83, x1: 1383, y1: 660 } as const;

/**
 * Wall grid (px): x ∈ {0, 150, 294, 431, 491, 574, 710, 716, 841, 946, 1054,
 * 1137, 1174, 1383}; y ∈ {83, 181, 227, 320, 386, 413, 515, 660}.
 */
const LAF = '#fdf2fb';
const CLEAN = '#eefaf8';
const GREEN = '#f3fbef';
const CYAN = '#eefafb';
const PLUS = '#fff7ef';
const RED = '#fff5f5';

const ROOMS: TracedRoom[] = [
  // ── West ───────────────────────────────────────────────────────────────
  {
    code: 'CWH-I/360', label: 'INCUBATOR ROOM-02', px: [0, 83, 150, 660],
    meta: { fill: GREEN, dims: '9550 x 2550' },
    doors: [{ wall: 'right', offset: 0.68, width: 0.16, kind: 'PASSAGE' }],
  },
  {
    code: 'INCUBATOR-01', label: 'INCUBATOR ROOM-01', px: [150, 515, 491, 660],
    meta: { fill: GREEN, dims: '5190 x 4015' }, instrument: 'CWH/RDU/051-00',
    doors: [],
  },
  {
    code: 'INCUBATOR-01 (2)', label: 'INCUBATOR ROOM-01', px: [150, 413, 574, 515],
    meta: { fill: GREEN },
    doors: [{ wall: 'right', offset: 0.33, width: 0.34, kind: 'ENTRY' }],
  },

  // ── North-west block ───────────────────────────────────────────────────
  {
    code: 'CWH-I/208', label: 'CORRIDOR-10', px: [150, 83, 574, 181],
    meta: { fill: GREEN, dims: '6555 x 1500' }, grade: 'CIRCULATION',
    // Open into the COOLING ZONE over the top of its east end.
    doors: [{ wall: 'right', offset: 0.2, width: 0.43, kind: 'PASSAGE' }],
  },
  {
    code: 'CWH-I/211', label: 'BIO SAFETY CABINET', px: [150, 181, 294, 413],
    meta: { fill: LAF, fch: '2.7m', dims: '2055 x 3795' }, instrument: 'CWH/RDU/047-00',
    doors: [{ wall: 'top', offset: 0.54, width: 0.24, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/210', label: 'LAF-2', px: [294, 181, 431, 413],
    meta: { fill: LAF, fch: '2.7m', dims: '2150 x 3795' }, instrument: 'CWH/RDU/046-00',
    doors: [{ wall: 'top', offset: 0.54, width: 0.31, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/209', label: 'LAF-1', px: [431, 181, 574, 413],
    meta: { fill: LAF, dims: '2150 x 3795' }, instrument: 'CWH/RDU/045-00',
    doors: [{ wall: 'top', offset: 0.19, width: 0.29, kind: 'ENTRY' }],
  },

  // ── North-centre ───────────────────────────────────────────────────────
  {
    code: 'CWH-I/207', label: 'COOLING ZONE', px: [574, 83, 841, 227],
    meta: { fill: LAF, dims: '4400 x 2405' },
    doors: [
      { wall: 'left', offset: 0.14, width: 0.29, kind: 'PASSAGE' },
      { wall: 'bottom', offset: 0.09, width: 0.11, kind: 'ENTRY' },
    ],
  },
  {
    code: 'CWH-I/214', label: 'STERILIZATION', px: [841, 83, 1054, 227],
    meta: { fill: CLEAN, dims: '3400 x 2405' },
    doors: [{ wall: 'bottom', offset: 0.71, width: 0.18, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/215', label: 'MEDIA STORAGE', px: [1054, 83, 1383, 227],
    meta: { fill: CLEAN, dims: '5245 x 2405' }, instrument: 'CWH/RDU/052-00',
    doors: [{ wall: 'bottom', offset: 0.085, width: 0.115, kind: 'ENTRY' }],
  },

  // ── Middle row ─────────────────────────────────────────────────────────
  {
    code: 'CWH-I/206', label: 'BUFFER ROOM', px: [574, 227, 710, 320],
    meta: { fill: GREEN, dims: '2150 x 1420' },
    doors: [{ wall: 'left', offset: 0.55, width: 0.33, kind: 'PASSAGE' }],
  },
  {
    code: 'CWH-I/212', label: 'CH.RM-03', px: [710, 227, 841, 320],
    meta: { fill: RED, dims: '2150 x 1420' },
    doors: [{ wall: 'left', offset: 0.54, width: 0.32, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/205', label: 'CH.RM-02', px: [574, 320, 710, 413],
    meta: { fill: RED, dims: '2150 x 1420' },
    doors: [],
  },
  {
    code: 'CWH-I/204', label: 'CH.RM-01', px: [710, 320, 841, 413],
    meta: { fill: RED, dims: '2150 x 1420' },
    doors: [{ wall: 'bottom', offset: 0.15, width: 0.27, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/213', label: 'MEDIA PREPARATION', px: [841, 227, 1137, 413],
    meta: { fill: GREEN, dims: '4675 x 2940' }, instrument: 'CWH/RDU/049-00',
    doors: [{ wall: 'bottom', offset: 0.76, width: 0.135, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/197', label: 'OFFICE ROOM-01', px: [1137, 227, 1383, 386],
    meta: { fill: PLUS, dims: '3970 x 2400' }, grade: 'UTILITY',
    doors: [],
  },
  {
    code: 'CWH-I/196', label: 'CHANGE ROOM', px: [1137, 386, 1383, 515],
    meta: { fill: PLUS, dims: '3970 x 2040' }, grade: 'UTILITY',
    doors: [
      { wall: 'top', offset: 0.2, width: 0.07, kind: 'ENTRY' },
      { wall: 'right', offset: 0.42, width: 0.45, kind: 'EXIT' },
    ],
  },

  // ── CORRIDOR-09 ────────────────────────────────────────────────────────
  {
    code: 'CWH-I/203', label: 'CORRIDOR-09', px: [574, 413, 1137, 515],
    meta: { fill: CYAN, fch: '2.7m', dims: '9175 x 1500' }, grade: 'CIRCULATION',
    doors: [
      { wall: 'right', offset: 0.33, width: 0.35, kind: 'ENTRY' },
      { wall: 'bottom', offset: 0.3, width: 0.07, kind: 'ENTRY' },
      { wall: 'bottom', offset: 0.71, width: 0.04, kind: 'ENTRY' },
    ],
  },

  // ── South row (south walls computed — see the header) ──────────────────
  {
    code: 'CWH-I/201', label: 'GENERAL LAB', px: [491, 515, 716, 660],
    meta: { fill: GREEN, dims: '3700 x 2415' }, instrument: 'CWH/RDU/050-00',
    doors: [{ wall: 'top', offset: 0.46, width: 0.22, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/200', label: 'DECONTAMINATION', px: [716, 515, 946, 660],
    meta: { fill: PLUS, dims: '3700 x 2415' }, grade: 'UTILITY',
    doors: [],
  },
  {
    code: 'CWH-I/199', label: 'WASH ROOM-01', px: [946, 515, 1174, 660],
    meta: { fill: PLUS, dims: '3650 x 2415' }, grade: 'UTILITY',
    doors: [],
  },
  {
    code: 'CWH-I/198', label: 'WATER WET ANALYSIS ROOM', px: [1174, 515, 1383, 660],
    meta: { fill: CYAN, dims: '3260 x 2415' }, instrument: 'CWH/RDU/048-00',
    doors: [{ wall: 'top', offset: 0.14, width: 0.2, kind: 'ENTRY' }],
  },
];

export const MICROBIOLOGY_LAYOUT: TracedLayout = {
  area: 'QC Microbiology',
  source: 'Layouts/CWH/Microbiology.png',
  building: B,
  rooms: ROOMS,
  annotations: {
    equipment: [
      [799, 83, 841, 175],    // HPHV STERILIZER, between COOLING ZONE and STERILIZATION
      [437, 586, 481, 631],   // INCUBATOR ROOM-01
      [891, 586, 945, 641],   // DECONTAMINATION
      [1343, 585, 1383, 640], // WATER WET ANALYSIS ROOM (clamped to the east wall)
      [1, 587, 24, 632],      // INCUBATOR ROOM-02
    ],
    hvac: [],
    water: [],
    airflow: [],
    labels: [
      { x: 803, y: 130, text: 'HPHV STERILIZER' },
    ],
  },
};
