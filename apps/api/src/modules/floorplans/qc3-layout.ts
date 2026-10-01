/**
 * The QC 3 floor, traced from the architectural drawing
 * `Layouts/CWH/QC 3 Layout.png` (874 x 895) and drawn in the 2D ARCHITECTURAL
 * style, the way "CWH — QC" (`qc-layout-2.ts`) and "CWH — QC Microbiology"
 * (`microbiology-layout.ts`) are.
 *
 * Operator, 2026-10-01: "there is QC 3 image was there as same like QC and
 * microbiology layout do this one also,everything should 100 % matched doors
 * and room lines everything".
 *
 * This REPLACES the 2026-09-21 trace of the same image, which had only
 * rectangles to work with: 35 of them, the corridor in four pieces, the hold
 * area in two, a made-up `GD ENTRY` room to square the building off, doors as
 * rough fractions of a box side (four of them on walls that have no door),
 * and no columns or windows.
 *
 * ─── HOW IT WAS MEASURED ─────────────────────────────────────────────────
 * Partitions on this drawing are single lines — magenta, a pink-red variant,
 * orange (the north row and the east rooms), black (the change room, the wash
 * area, the main block's east wall). Each was found by long-run scans per
 * colour and taken where it is drawn; every door gap by the run-length along
 * its wall, cross-checked against the door's orange swing arc and grey leaf,
 * found by colour. The pixel numbers are kept as-is so the next person can
 * re-measure against the same file.
 *
 * Wall lines (px): x ∈ {21.5, 192.5, 238.5, 249.5, 311.5, 312.5, 338, 386.5,
 * 387, 450.5, 461.5, 506, 640.5, 696, 786, 845}; y ∈ {6, 54, 74.5, 120, 131.5,
 * 134.5, 178, 211.5, 283, 332.5, 375, 438.5, 482, 494.5, 511.5, 530.5, 593.5,
 * 663.5, 665.5, 709.5, 785.5}. (311.5 / 386.5 are the north row's partitions,
 * 312.5 / 387 the offices' — different walls, a pixel apart.)
 *
 * ─── WHAT THE DRAWING SHOWS, AND HOW IT IS STORED ───────────────────────
 *   - THE BUILDING IS AN L: the main block (x 21.5-696, y 6-785.5) and the
 *     east band (x 696-845, y 6-530.5). South of the band is the open yard the
 *     drawing dimensions `8100 X 3700`, with a `GD ENTRY` gate — outside the
 *     building, and not drawn. The rooms tile the L exactly; nothing fills the
 *     yard.
 *   - CORRIDOR-11 is ONE space that runs right round the middle block. A room
 *     is one outline and an outline cannot have a hole, so it is two pieces of
 *     one code: `CWH-I/235` (the north band and both legs, a U) and `CWH-I/235
 *     (2)` (the south band). The view draws pieces of one code with no wall
 *     between them.
 *   - The three WEIGHING AREAS (II, I, III) are open bays: no wall and no door
 *     on their corridor side. Stored as an opening the full length of that
 *     side. The HOTZONE ROOM opens into the WET LAB the same way, through a
 *     28 px gap in the wall between them — the drawing gives it no leaf.
 *   - 30 doors with a leaf: 16 single and 14 double (the "3"-shaped arcs — two
 *     leaves meeting in the middle), so 44 leaves; with the four openings, 48
 *     entries. Two doubles open OUT of the building: the corridor's exits in
 *     the south wall. The KF / AUTO TITRATOR ROOM has no door to the corridor:
 *     it is entered from the WET LAB through the AIRLOCK.
 *   - The HOLD AREA wraps the WASH AREA's east side; one L-shaped room. The
 *     drawing closes the lobby beside the wash area with a SLIDING door (the
 *     magenta bar on y 54): stored as a wall stub and an outlined bar.
 *   - STRUCTURE: the 16 interior columns (a 4 x 4 grid of hatched squares),
 *     7 in the west wall and 3 in the east; 6 windows in the west wall and the
 *     BREAKABLE GLASS panel in the south wall; the two pass boxes in the north
 *     row's partitions, outlined.
 *
 * ─── WHERE THIS IS NOT THE DRAWING ───────────────────────────────────────
 *   - A wall is drawn at the 2D style's weight where the drawing has a single
 *     line, and resumes at a door's jamb.
 *   - Not drawn: the hold area's floor grid, the hand-wash symbol by the
 *     change room, the `EE` stamps, the yard, its gate and the plant strip
 *     south of the building, and the free-standing column in the yard.
 *
 * GRADES: `C` on the twelve instrument rooms is what their instruments' own
 * limits gave when the floor was first traced; a room already on the plan
 * keeps the grade it has. The corridor is CIRCULATION, everything else
 * UTILITY. In this style a grade only tints an EMPTY room.
 */
import { rect, vDoor, hDoor, vPair, hPair, type ArchLayout, type ArchRoom } from './architectural-layout.js';

const ROOMS: ArchRoom[] = [
  // ── West column ────────────────────────────────────────────────────────
  { code: 'CWH-I/245', label: 'WORKING STANDARD & REFERENCE STANDARD STORAGE ROOM', outline: rect(21.5, 6, 192.5, 134.5),
    grade: 'C', instrument: 'CWH/RDU/003-00', meta: { fch: '2.5m', dims: '7550 x 5640' },
    doors: vPair(192.5, 99, 128) },
  { code: 'CWH-I/244', label: 'WEIGHING AREA-II', outline: rect(21.5, 134.5, 192.5, 178), grade: 'UTILITY',
    meta: { fch: '2.5m', dims: '7600 x 1900' },
    doors: [vDoor(192.5, 134.5, 178, 'none', 'PASSAGE')] },                       // an open bay
  { code: 'CWH-I/243', label: 'SAMPLE PREPARATION ROOM-I', outline: rect(21.5, 178, 192.5, 438.5),
    grade: 'C', instrument: 'CWH/RDU/010-00', meta: { fch: '2.5m', dims: '7550 x 11600' },
    doors: [...vPair(192.5, 183, 212), ...vPair(192.5, 404, 433)] },
  { code: 'CWH-I/241', label: 'WEIGHING AREA-I', outline: rect(21.5, 438.5, 192.5, 482), grade: 'UTILITY',
    meta: { fch: '2.5m', dims: '7600 x 1900' },
    doors: [vDoor(192.5, 438.5, 482, 'none', 'PASSAGE')] },                       // an open bay
  { code: 'CWH-I/240', label: 'SAMPLE RECEIPT & SAMPLE STORAGE ROOM', outline: rect(21.5, 482, 192.5, 665.5),
    grade: 'C', instrument: 'CWH/RDU/026-00', meta: { fch: '2.5m', dims: '7550 x 8120' },
    doors: [vDoor(192.5, 605, 626, 'from')] },
  { code: 'CWH-I/234', label: 'CHANGE ROOM', outline: rect(21.5, 665.5, 192.5, 785.5), grade: 'UTILITY',
    meta: { fch: '2.5m', dims: '7550 x 5320' },
    doors: [vDoor(192.5, 669, 690, 'from'), ...hPair(785.5, 28, 59, 'EXIT')] },   // from the corridor; the exterior pair

  // ── North row ──────────────────────────────────────────────────────────
  { code: 'CWH-I/246', label: 'LCMS ROOM', outline: rect(192.5, 6, 249.5, 74.5),
    grade: 'C', instrument: 'CWH/RDU/012-00', meta: { fch: '2.5m', dims: '2500 x 2900' },
    doors: [hDoor(74.5, 197, 217, 'from')] },
  // Its door opens INTO the corridor, so it is stored on the corridor.
  { code: 'CWH-I/247', label: 'UNCLEANED GLASS WARE HOLD ROOM', outline: rect(249.5, 6, 311.5, 74.5), grade: 'UTILITY',
    meta: { fch: '2.5m', dims: '2730 x 2900' }, doors: [] },
  { code: 'CWH-I/248', label: 'GLASS WARE CLEANING & DRYING ROOM', outline: rect(311.5, 6, 386.5, 74.5), grade: 'UTILITY',
    meta: { fch: '2.5m', dims: '3280 x 2900' },
    doors: [hDoor(74.5, 363, 383, 'to')] },
  { code: 'CWH-I/249', label: 'CLEANED GLASS WARE STORAGE ROOM', outline: rect(386.5, 6, 450.5, 74.5), grade: 'UTILITY',
    meta: { fch: '2.5m', dims: '2800 x 2900' },
    doors: [hDoor(74.5, 426, 446, 'to')] },
  { code: 'CWH-I/250', label: 'LCMS ROOM-II', outline: rect(450.5, 6, 506, 74.5),
    grade: 'C', instrument: 'CWH/RDU/002-01', meta: { fch: '2.5m', dims: '2430 x 2900' },
    doors: [hDoor(74.5, 481, 501, 'to')] },

  // ── Middle block ───────────────────────────────────────────────────────
  { code: 'CWH-I/242', label: 'HPLC ROOM', outline: rect(238.5, 120, 338, 663.5),
    grade: 'C', instrument: 'CWH/RDU/011-00', meta: { fch: '2.8m', dims: '4400 x 24250' },
    doors: [...vPair(238.5, 280, 310), ...vPair(238.5, 476, 506)] },
  { code: 'CWH-I/252', label: 'DISSOLUTION & UV ROOM', outline: rect(338, 120, 461.5, 332.5),
    grade: 'C', instrument: 'CWH/RDU/006-00', meta: { fch: '2.5m', dims: '5450 x 9500' },
    doors: vPair(461.5, 126, 155) },
  { code: 'CWH-I/254', label: 'WEIGHING AREA-III', outline: rect(338, 332.5, 461.5, 375), grade: 'UTILITY',
    meta: { fch: '2.5m', dims: '5450 x 1900' },
    doors: [vDoor(461.5, 332.5, 375, 'none', 'PASSAGE')] },                       // an open bay
  { code: 'CWH-I/255', label: 'MALVERN/AAS/BET INSTRUMENT ROOM', outline: rect(338, 375, 461.5, 494.5),
    grade: 'C', instrument: 'CWH/RDU/007-00', meta: { fch: '2.5m', dims: '5450 x 5280' },
    doors: vPair(461.5, 460, 490) },
  { code: 'CWH-I/256', label: 'GC / GCMS ROOM', outline: rect(338, 494.5, 461.5, 663.5),
    grade: 'C', instrument: 'CWH/RDU/008-00', meta: { fch: '2.5m', dims: '5450 x 7500' },
    doors: [vDoor(461.5, 639, 659, 'to')] },
  { code: 'CWH-I/236', label: 'OFFICE-01', outline: rect(238.5, 709.5, 312.5, 785.5), grade: 'UTILITY',
    meta: { dims: '3350 x 3250' }, doors: [hDoor(709.5, 243, 264, 'from')] },
  { code: 'CWH-I/237', label: 'OFFICE-02', outline: rect(312.5, 709.5, 387, 785.5), grade: 'UTILITY',
    meta: { dims: '3350 x 3250' }, doors: [hDoor(709.5, 317, 338, 'from')] },
  { code: 'CWH-I/238', label: 'OFFICE-03', outline: rect(387, 709.5, 461.5, 785.5), grade: 'UTILITY',
    meta: { dims: '3350 x 3250' }, doors: [hDoor(709.5, 391, 412, 'from')] },

  // ── East column ────────────────────────────────────────────────────────
  { code: 'CWH-I/251', label: 'TRAINING/MEETING ROOM', outline: rect(506, 6, 696, 131.5), grade: 'UTILITY',
    meta: { fch: '2.5m', dims: '8400 x 5520' }, doors: vPair(506, 98, 127) },
  { code: 'CWH-I/253', label: 'REVIEWERs ROOM', outline: rect(506, 131.5, 696, 211.5), grade: 'UTILITY',
    meta: { fch: '2.5m', dims: '8400 x 3500' }, doors: vPair(506, 138, 166) },
  { code: 'CWH-I/258', label: 'HOTZONE ROOM (FUME HOOD)', outline: rect(506, 211.5, 696, 283), grade: 'UTILITY',
    meta: { fch: '2.7m', dims: '8400 x 3120' },
    doors: [hDoor(283, 535, 563, 'none', 'PASSAGE')] },                           // the gap into the WET LAB, no leaf
  { code: 'CWH-I/257', label: 'WET LAB', outline: rect(506, 283, 696, 511.5),
    grade: 'C', instrument: 'CWH/RDU/009-00', meta: { fch: '2.5m', dims: '8400 x 10200' },
    doors: [...vPair(506, 288, 317), ...vPair(506, 477.5, 506.5)] },
  { code: 'CWH-I/260', label: 'KF/AUTO TITRATOR ROOM', outline: rect(506, 511.5, 640.5, 593.5),
    grade: 'C', instrument: 'CWH/RDU/005-00', meta: { fch: '2.5m', dims: '5950 x 3650' },
    doors: [vDoor(640.5, 569, 589, 'to')] },                                      // from the AIRLOCK
  { code: 'CWH-I/259', label: 'AIRLOCK', outline: rect(640.5, 511.5, 696, 593.5), grade: 'UTILITY',
    meta: { fch: '2.5m', dims: '2170 x 3650' },
    doors: [hDoor(511.5, 645, 665, 'to')] },                                      // from the WET LAB
  { code: 'CWH-I/261', label: 'SIEVE ANALYZER & BD APPARATUS ROOM', outline: rect(506, 593.5, 696, 663.5),
    grade: 'C', instrument: 'CWH/RDU/004-00', meta: { fch: '2.5m', dims: '8300 x 3050' },
    doors: [vDoor(506, 639, 659, 'to')] },
  { code: 'CWH-I/239', label: 'OFFICE-04', outline: rect(506, 663.5, 696, 785.5), grade: 'UTILITY',
    meta: { fch: '2.5m', dims: '8300 x 5430' },
    doors: [vDoor(506, 667, 688, 'from')] },

  // ── East band ──────────────────────────────────────────────────────────
  { code: 'CWH-I/188', label: 'WASH AREA', outline: rect(696, 6, 786, 54), grade: 'UTILITY',
    meta: { fch: '2.5m', dims: '3600 x 2000' }, doors: [] },
  // L-shaped: the lobby east of the wash area, and the hall below both. The
  // wash area's door opens into the lobby.
  { code: 'CWH-I/187', label: 'HOLD AREA', grade: 'UTILITY', meta: { fch: '2.5m', dims: '6450 x 21100' },
    outline: [[786, 6], [845, 6], [845, 530.5], [696, 530.5], [696, 54], [786, 54]],
    doors: [vDoor(786, 12, 31, 'from')] },

  // ── CORRIDOR-11: one space, two pieces of one code ─────────────────────
  // The north band and both legs. Its doors: room 247's, which opens into it,
  // and the two exits in the south wall, which open OUT of the building.
  { code: 'CWH-I/235', label: 'CORRIDOR-11', grade: 'CIRCULATION', meta: { fch: '2.5m', dims: '10000 x 2000' },
    outline: [
      [192.5, 74.5], [506, 74.5], [506, 785.5], [461.5, 785.5], [461.5, 120],
      [238.5, 120], [238.5, 785.5], [192.5, 785.5],
    ],
    doors: [
      hDoor(74.5, 288, 308, 'to'),
      ...hPair(785.5, 465, 501, 'EXIT', 'out'),      // the EE exit, to CORRIDOR-1
      ...hPair(785.5, 197, 235, 'EXIT', 'out'),
    ] },
  // The south band, between the two legs.
  { code: 'CWH-I/235 (2)', label: 'CORRIDOR-11', outline: rect(238.5, 663.5, 461.5, 709.5), grade: 'CIRCULATION',
    meta: { fch: '2.5m', dims: '10000 x 2000' }, doors: [] },
];

// The 4 x 4 grid of hatched squares, one bay apart each way.
const COL_X: [number, number][] = [[172, 193], [338, 360], [506, 528], [674, 696]];
const COL_Y: [number, number][] = [[8, 30], [260, 284], [512, 536], [764, 786]];

export const QC3_LAYOUT: ArchLayout = {
  area: 'QC 3',
  planName: 'CWH — QC 3',
  source: 'Layouts/CWH/QC 3 Layout.png',
  // The canvas: the L, the columns standing outside its west and east walls,
  // and — below the south wall — the leaves of the two exits, which open out.
  building: { x0: 0, y0: -4, x1: 870, y1: 814 },
  rooms: ROOMS,
  annotations: {
    columns: [
      ...COL_Y.flatMap(([y0, y1]) => COL_X.map(([x0, x1]): [number, number, number, number] => [x0, y0, x1, y1])),
      // Set into the west wall, half outside it.
      ...[8, 135, 261, 388, 514, 640, 765].map((y): [number, number, number, number] => [7, y, 24, y + 17]),
      // ...and the east wall, down to where the building steps in.
      [845, 7, 863, 25], [845, 260, 863, 280], [845, 512, 863, 531],
    ],
    windows: [
      // The blue bars in the west wall.
      [17, 59, 26, 100], [17, 186, 26, 227], [17, 313, 26, 353], [17, 439, 26, 479], [17, 565, 26, 606], [17, 691, 26, 731],
      // The BREAKABLE GLASS panel in OFFICE-04's south wall.
      [646, 781, 674, 790],
    ],
    // The short wall beside the hold area's sliding door (y 54).
    walls: [[834, 54, 845, 54]],
    // The sliding door itself, and the two pass boxes in the north row's partitions.
    equipment: [
      [788, 55, 837, 61],
      [303, 42, 333, 56], [365, 37, 396, 51],
    ],
  },
};
