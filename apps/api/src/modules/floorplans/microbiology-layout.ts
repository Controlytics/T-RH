/**
 * The QC Microbiology floor, traced from the architectural drawing
 * `Layouts/CWH/Microbiology.png` (1427 x 642) and drawn in the 2D
 * ARCHITECTURAL style, the way "CWH — QC" is (`qc-layout-2.ts`).
 *
 * Operator, 2026-10-01: "same like qc layout there Microbiology layout image in
 * folder make layout as per that image same like qc".
 *
 * This REPLACES the 2026-09-21 trace of the same image, which had only
 * rectangles to work with (22 of them, doors as rough wall fractions). What the
 * re-trace has that it did not:
 *   - Rooms are POLYGONS on the wall CENTRE lines: INCUBATOR ROOM-01 is the one
 *     L-shape the drawing has (it was two pieces, `INCUBATOR-01` and
 *     `INCUBATOR-01 (2)`), so the floor is 21 rooms.
 *   - Every door is the gap MEASURED in its wall, on the edge of the room its
 *     swing arc opens into, hung on the end the drawing hangs it on: 25 leaves —
 *     21 single doors and two pairs. The older trace gave a door as a rough
 *     fraction of one side of a box, with no hinge side.
 *   - The four structural COLUMNS (the orange hatched squares along the south
 *     row; the older trace took them for equipment) and seven WINDOWS.
 *
 * HOW IT WAS MEASURED: partitions are double lines ~6 px apart, found by
 * dark-pixel projections and taken at their CENTRE (neighbours share a wall at
 * its centre line, so they tessellate exactly); each wall's extent, and so each
 * door gap, by run-length along that line; every gap cross-checked against its
 * swing arc, leaf and door-frame mark, found by colour (18 orange arcs, two
 * black, the green one, the blue pair, the red pair). The pixel numbers are
 * kept as-is so the next person can re-measure against the same file.
 *
 * Wall grid (px, centre lines): x ∈ {0, 157, 297, 433, 488, 570.5, 707, 719,
 * 844, 949, 1057, 1134, 1177, 1381}; y ∈ {80, 178.5, 230.5, 323, 382.5, 415,
 * 512.5, 660}.
 *
 * ─── THE DRAWING IS CUT OFF AT THE BOTTOM ──────────────────────────────────
 * The image ends at y 642, through the south row (INCUBATOR ROOM-01, GENERAL
 * LAB, DECONTAMINATION, WASH ROOM-01, WATER WET ANALYSIS ROOM). Their written
 * depths (2415 mm, and 4015 mm for the incubator, at ~0.06 px/mm) all put the
 * south wall at y ≈ 660, and INCUBATOR ROOM-02's written 9550 mm agrees, so the
 * building is closed at y 660 — 18 px past the image. That wall is COMPUTED
 * from the drawing's own dimension strings; every other edge is measured. The
 * two columns the image cuts through are stored to the image's edge. If a
 * fuller drawing turns up, re-measure both.
 *
 * ─── WHERE THIS IS DELIBERATELY NOT THE DRAWING ──────────────────────────
 *   - INCUBATOR ROOM-02's east side is a CAVITY wall: its own glazed partition
 *     at x 143-150 and the labs' wall at x 165, 15 px apart. It is drawn as ONE
 *     wall on the cavity's centre, x 157, and the BREAKABLE GLASS panel and the
 *     BSC room's window are put on that line.
 *   - The EMERGENCY EXIT pair in INCUBATOR ROOM-02's north wall swings OUT of
 *     the building on the drawing. A door is drawn on the room it belongs to,
 *     so here it swings in.
 *   - The HPHV STERILIZER (a pass-through autoclave standing in the wall
 *     between the COOLING ZONE and STERILIZATION, y 82-175) is not drawn; that
 *     wall runs straight through it. Nor is the cross-over bench (`COB`) in the
 *     CHANGE ROOM. The dashboard draws rooms, doors and structure, no equipment.
 *   - INCUBATOR ROOM-01 carries no room number on the drawing; its code stays
 *     `INCUBATOR-01`. `CWH/RDU/051-00` reads `Incubator room (Microbiology)`
 *     with no number and is sited there, as before. Move it to `CWH-I/360` if
 *     the registry means the other incubator room.
 *   - Two leaves of a pair are stored 1 px apart: the door check refuses two
 *     doors that touch on one edge once their fractions are rounded.
 *
 * GRADES: `C` on the eight instrument rooms is what their instruments' own
 * limits gave when the floor was first traced; a room already on the plan keeps
 * the grade it has. The rest are the older trace's — corridors CIRCULATION,
 * everything else UTILITY. In this style a grade only tints an EMPTY room.
 */
import { rect, vDoor, hDoor, type ArchLayout, type ArchRoom } from './architectural-layout.js';

const ROOMS: ArchRoom[] = [
  // ── West ───────────────────────────────────────────────────────────────
  { code: 'CWH-I/360', label: 'INCUBATOR ROOM-02', outline: rect(0, 80, 157, 660), grade: 'UTILITY',
    meta: { dims: '9550 x 2550' },
    doors: [
      hDoor(80, 44, 84.5, 'from', 'EXIT'), hDoor(80, 85.5, 126, 'to', 'EXIT'),   // the red pair: emergency exit
      vDoor(157, 488, 529.5, 'from'), vDoor(157, 530.5, 572, 'to'),              // the blue pair, from INCUBATOR ROOM-01
    ] },
  // The L: under the three LAF rooms to the corridor wall, then down the west
  // side of the GENERAL LAB.
  { code: 'INCUBATOR-01', label: 'INCUBATOR ROOM-01', grade: 'C', instrument: 'CWH/RDU/051-00',
    meta: { dims: '5190 x 4015' },
    outline: [[157, 415], [570.5, 415], [570.5, 512.5], [488, 512.5], [488, 660], [157, 660]],
    doors: [vDoor(570.5, 432, 487, 'from')] },                                    // from CORRIDOR-09

  // ── North-west block ───────────────────────────────────────────────────
  { code: 'CWH-I/208', label: 'CORRIDOR-10', outline: rect(157, 80, 570.5, 178.5), grade: 'CIRCULATION',
    meta: { dims: '6555 x 1500' }, doors: [] },
  { code: 'CWH-I/211', label: 'BIO SAFETY CABINET', outline: rect(157, 178.5, 297, 415), grade: 'C', instrument: 'CWH/RDU/047-00',
    meta: { fch: '2.7m', dims: '2055 x 3795' },
    doors: [hDoor(178.5, 225, 282, 'to')] },
  { code: 'CWH-I/210', label: 'LAF-2', outline: rect(297, 178.5, 433, 415), grade: 'C', instrument: 'CWH/RDU/046-00',
    meta: { fch: '2.7m', dims: '2150 x 3795' },
    doors: [hDoor(178.5, 365, 422, 'to')] },
  { code: 'CWH-I/209', label: 'LAF-1', outline: rect(433, 178.5, 570.5, 415), grade: 'C', instrument: 'CWH/RDU/045-00',
    meta: { dims: '2150 x 3795' },
    doors: [hDoor(178.5, 446, 502, 'from')] },

  // ── North ──────────────────────────────────────────────────────────────
  { code: 'CWH-I/207', label: 'COOLING ZONE', outline: rect(570.5, 80, 844, 230.5), grade: 'UTILITY',
    meta: { dims: '4400 x 2405' },
    doors: [
      vDoor(570.5, 95, 148, 'from'),        // from CORRIDOR-10
      hDoor(230.5, 590, 632, 'from'),       // from the BUFFER ROOM
      hDoor(230.5, 720, 760, 'to'),         // the black arc: from CH.RM-03
    ] },
  { code: 'CWH-I/214', label: 'STERILIZATION', outline: rect(844, 80, 1057, 230.5), grade: 'UTILITY',
    meta: { dims: '3400 x 2405' },
    doors: [hDoor(230.5, 989, 1043, 'to')] },                                     // from MEDIA PREPARATION
  { code: 'CWH-I/215', label: 'MEDIA STORAGE', outline: rect(1057, 80, 1381, 230.5), grade: 'C', instrument: 'CWH/RDU/052-00',
    meta: { dims: '5245 x 2405' },
    doors: [hDoor(230.5, 1069, 1123, 'from')] },                                  // from MEDIA PREPARATION

  // ── Middle ─────────────────────────────────────────────────────────────
  { code: 'CWH-I/206', label: 'BUFFER ROOM', outline: rect(570.5, 230.5, 707, 323), grade: 'UTILITY',
    meta: { dims: '2150 x 1420' },
    doors: [hDoor(323, 590, 632, 'from')] },                                      // from CH.RM-02
  { code: 'CWH-I/212', label: 'CH.RM-03', outline: rect(707, 230.5, 844, 323), grade: 'UTILITY',
    meta: { dims: '2150 x 1420' },
    doors: [hDoor(323, 720, 762, 'from')] },                                      // from CH.RM-01
  { code: 'CWH-I/205', label: 'CH.RM-02', outline: rect(570.5, 323, 707, 415), grade: 'UTILITY',
    meta: { dims: '2150 x 1420' },
    doors: [vDoor(707, 336, 380, 'from')] },                                      // the black arc: from CH.RM-01
  { code: 'CWH-I/204', label: 'CH.RM-01', outline: rect(707, 323, 844, 415), grade: 'UTILITY',
    meta: { dims: '2150 x 1420' },
    doors: [hDoor(415, 723, 766, 'from')] },                                      // from CORRIDOR-09
  { code: 'CWH-I/213', label: 'MEDIA PREPARATION', outline: rect(844, 230.5, 1134, 415), grade: 'C', instrument: 'CWH/RDU/049-00',
    meta: { dims: '4675 x 2940' },
    doors: [hDoor(415, 1062, 1117, 'to')] },                                      // from CORRIDOR-09
  { code: 'CWH-I/197', label: 'OFFICE ROOM-01', outline: rect(1134, 230.5, 1381, 382.5), grade: 'UTILITY',
    meta: { dims: '3970 x 2400' }, doors: [] },
  { code: 'CWH-I/196', label: 'CHANGE ROOM', outline: rect(1134, 382.5, 1381, 512.5), grade: 'UTILITY',
    meta: { dims: '3970 x 2040' },
    doors: [
      hDoor(382.5, 1151, 1206, 'from'),     // from OFFICE ROOM-01
      vDoor(1381, 441, 498, 'to', 'EXIT'),  // the green arc: the exterior door
    ] },

  // ── CORRIDOR-09 ────────────────────────────────────────────────────────
  { code: 'CWH-I/203', label: 'CORRIDOR-09', outline: rect(570.5, 415, 1134, 512.5), grade: 'CIRCULATION',
    meta: { fch: '2.7m', dims: '9175 x 1500' },
    doors: [
      vDoor(1134, 444, 498, 'to'),          // from the CHANGE ROOM
      hDoor(512.5, 740, 793, 'to'),         // from DECONTAMINATION
      hDoor(512.5, 970, 1025, 'to'),        // from WASH ROOM-01
    ] },

  // ── South row (south walls computed — see the header) ──────────────────
  { code: 'CWH-I/201', label: 'GENERAL LAB', outline: rect(488, 512.5, 719, 660), grade: 'C', instrument: 'CWH/RDU/050-00',
    meta: { dims: '3700 x 2415' },
    doors: [hDoor(512.5, 592, 646, 'from')] },
  { code: 'CWH-I/200', label: 'DECONTAMINATION', outline: rect(719, 512.5, 949, 660), grade: 'UTILITY',
    meta: { dims: '3700 x 2415' }, doors: [] },
  { code: 'CWH-I/199', label: 'WASH ROOM-01', outline: rect(949, 512.5, 1177, 660), grade: 'UTILITY',
    meta: { dims: '3650 x 2415' }, doors: [] },
  { code: 'CWH-I/198', label: 'WATER WET ANALYSIS ROOM', outline: rect(1177, 512.5, 1381, 660), grade: 'C', instrument: 'CWH/RDU/048-00',
    meta: { dims: '3260 x 2415' },
    doors: [hDoor(512.5, 1194, 1249, 'from')] },
];

export const MICROBIOLOGY_LAYOUT: ArchLayout = {
  area: 'QC Microbiology',
  planName: 'CWH — QC Microbiology',
  source: 'Layouts/CWH/Microbiology.png',
  // The canvas: the rooms' extent plus the band the outer walls, the north
  // windows and the east column stand in.
  building: { x0: -8, y0: 70, x1: 1398, y1: 670 },
  rooms: ROOMS,
  annotations: {
    // The orange hatched squares, one bay apart (~453 px) along the south row.
    columns: [
      [0, 586, 26, 632], [436, 586, 484, 632], [888, 586, 949, 642], [1343, 585, 1398, 642],
    ],
    windows: [
      // The grey bars in the north wall.
      [312, 75, 384, 85], [495, 75, 567, 85], [697, 75, 767, 85], [1206, 75, 1277, 85],
      // OFFICE ROOM-01's window in the east wall.
      [1376, 271, 1386, 342],
      // The west partition (drawn at x 143-170, here on the wall line x 157):
      // the BREAKABLE GLASS panel off CORRIDOR-10, and the BSC room's window.
      [152, 90, 162, 172], [152, 271, 162, 342],
    ],
    walls: [],
  },
};
