/**
 * The MODULE-E floor, traced from the architectural drawing
 * `Layouts/CWH/Module-E layout.pdf` and drawn in the 2D ARCHITECTURAL style,
 * the way "CWH — QC" (`qc-layout-2.ts`), "CWH — QC Microbiology"
 * (`microbiology-layout.ts`) and "CWH — QC 3" (`qc3-layout.ts`) are.
 *
 * Operator, 2026-10-01: "do module-e layout also same like qc".
 *
 * Until now this floor was GENERATED (`draw-cwh-floorplan.ts`): ten boxes cut
 * from a room count, each coded with its instrument's own code. This replaces
 * it with the building as drawn.
 *
 * ─── HOW IT WAS MEASURED ─────────────────────────────────────────────────
 * The drawing is a VECTOR PDF (one page, 1191 x 842 pt as displayed; the page
 * is stored rotated 270°), so nothing was scanned off pixels: every wall is a
 * pair of parallel lines whose coordinates were READ from the file
 * (`page.get_drawings()` through the page's rotation matrix), and a partition
 * is taken on the line midway between its two faces. A door is the gap in
 * those lines; its leaf is a short line pair standing off the wall, and the
 * end it stands on is the hinge. The numbers below are PDF POINTS of the page
 * as displayed, kept as read so the next person can compare like with like.
 *
 * Wall lines (pt): x ∈ {200.5, 233.5, 252.8, 267.3, 290.7, 305.4, 326.8, 363.9,
 * 382.6, 389.9, 435, 483.5, 497.4, 506.5, 558.9, 592.2, 611.1, 629.9, 730.9,
 * 820.3, 838.7, 900.6, 974.5, 1001, 1023.9, 1061.4};
 * y ∈ {253.5, 312.3, 321.2, 331.2, 379.7, 389.9, 399.9, 417.7, 418.2, 418.3,
 * 434, 439.7, 449.5, 451, 484.5, 488.4, 491.6, 536, 567.5, 580.5}.
 * (417.7 is the partition under the change room and the personal entry, 418.2
 * the south-west block's north wall, 418.3 the central duct's south wall —
 * three different walls.)
 *
 * ─── WHAT THE DRAWING SHOWS, AND HOW IT IS STORED ───────────────────────
 *   - THE MODULE is the block inside its four outer walls (x 200.5-1061.4,
 *     y 253.5-580.5), 25 rooms. West of it the drawing has the CONNECTING
 *     CORRIDOR (CWH-I/075), two staircases and the SCRAP EXIT (CWH-I/076);
 *     east of it the MAIN CORRIDOR (CWH-I/338) and the entrance. They are
 *     outside the module's walls and are not drawn — the QC 3 floor leaves
 *     its yard out the same way.
 *   - THE GRANULATION AREA (CWH-I/014) is ONE room the drawing labels twice,
 *     WEST SIDE and EAST SIDE: no wall divides them. One outline of 24
 *     corners, which goes round the central return duct, the column casings
 *     and the binder-preparation alcove.
 *   - API DISPENSING (CWH-I/020) is an L: the bay north of it (the drawing
 *     dimensions it `2660x3180mm` and gives it no name) has no wall on its
 *     south side.
 *   - TWO rooms carry the code CWH-I/017 on the drawing: the BLENDING AREA
 *     (10302 x 4320) and, in the south-west block, the BLENDER AREA (3.5KL
 *     BLENDER). A plan cannot hold one code twice; the second is stored as
 *     `CWH-I/017 (3.5KL BLENDER)`, the drawing's own words.
 *   - RETURN DUCT CUTOUTS — the strip beside the sifting room, the box under
 *     API dispensing, the long one under the blending area — and the casings
 *     round the middle row of columns are VOIDS: no room covers them, the
 *     rooms around them wall them in, and where no room does a wall stub
 *     closes the gap. So are the cavities the drawing leaves between the
 *     south-west block and its neighbours and behind the granulation area's
 *     south wall.
 *   - SLIDING DOORS (the drawing's bar between two bulbs): twelve. Each is an
 *     opening with no leaf plus an outlined bar where the panel hangs.
 *     BINDER PREPARATION has no door at all: it opens into the granulation
 *     area through a 40 pt gap in its south wall.
 *   - 19 doors with a leaf: 16 single and 3 double (38.5 pt gaps, two leaves
 *     meeting in the middle), so 22 leaves; with the 13 leafless openings, 35
 *     entries. A door is stored on the room its leaf opens INTO. One opens OUT
 *     of the building: the GENTS ENTRY's exit in the south wall.
 *   - STRUCTURE: 17 columns (five in the north wall, eight in the middle row
 *     in pairs, four in the south wall); four windows and the BREAKABLE GLASS
 *     emergency panel in the north wall; the view panel (`VP`) in the blender
 *     area's west wall and the glazed panel in its east wall.
 *
 * ─── WHERE THIS IS NOT THE DRAWING ───────────────────────────────────────
 *   - A wall is drawn at the 2D style's weight where the drawing has two fine
 *     lines 1 pt apart, and the outer walls (6 pt on the drawing) at the same.
 *   - The east rooms run to the east wall's centre line (1061.4); the drawing
 *     lines the two southern ones 3.4 pt inside it.
 *   - The CHANGE ROOM CWH (CWH-I/054) is lined on the drawing: a second wall
 *     line 5.8 pt inside its west wall and 5.5 pt inside its south one. Drawn
 *     as two stubs beside the partition it made a black band twice the weight
 *     of every other wall; the room is drawn to the partition and the lining
 *     is left out.
 *   - Not drawn: the nine numbered sensor marks (01-06, 08-10) — they are
 *     positions on the drawing, not the eight instruments this floor has; the
 *     toilet's fixtures and cubicle; the red bar in the personal entry; the
 *     fine boundary lines in the cavity round the south-west block.
 *
 * ─── WHICH INSTRUMENT IS WHERE ───────────────────────────────────────────
 * Each of the eight sits in the room its own `Location` attribute names:
 * Excipient Dispensing Area (029-00), API Dispensing Area (030-00), Granulation
 * Area (032-00), API Staging Area (059-00), Excipient Staging Area (060-00),
 * Shifter Area (061-00, the SIFTING ROOM), Air Lock-02 (090-00). ONE is a
 * judgement: 031-00 says "Blender Area", and it is placed in the BLENDER AREA
 * (3.5KL BLENDER) rather than the BLENDING AREA, on the name.
 *
 * GRADES: `B` on the eight instrument rooms is what the generated plan held
 * for them. The corridor is CIRCULATION, everything else UTILITY. In this
 * style a grade only tints an EMPTY room.
 */
import { rect, vDoor, hDoor, vPair, hPair, type ArchLayout, type ArchRoom, type ArchDoor } from './architectural-layout.js';

type Box = [number, number, number, number];

// The four outer walls, on their centre lines.
const W = 200.5, E = 1061.4, N = 253.5, S = 580.5;

/** A sliding door: an opening with no leaf. */
const vSlide = (at: number, from: number, to: number): ArchDoor => vDoor(at, from, to, 'none', 'PASSAGE');
const hSlide = (at: number, from: number, to: number): ArchDoor => hDoor(at, from, to, 'none', 'PASSAGE');

const ROOMS: ArchRoom[] = [
  // ── North row, west to east ─────────────────────────────────────────────
  { code: 'CWH-I/023', label: 'PERSONAL AIR LOCK', outline: rect(W, N, 233.5, 321.2), grade: 'UTILITY',
    meta: { fch: '3150mm', dims: '3180x1565mm' },
    // From the central warehouse, and on into excipient dispensing: both leaves stand in this room.
    doors: [hDoor(N, 209.5, 227.9, 'from'), hDoor(321.2, 209.9, 227.9, 'from')] },
  // Its door opens into excipient dispensing, and is stored there.
  { code: 'CWH-I/022', label: 'WASH AREA-02', outline: rect(233.5, N, 267.3, 321.2), grade: 'UTILITY',
    meta: { fch: '3150mm', dims: '1600x3180mm' }, doors: [] },
  { code: 'CWH-I/021', label: 'EXCIPIENT STAGING', outline: rect(267.3, N, 326.8, 321.2),
    grade: 'B', instrument: 'CWH/RDU/060-00', meta: { fch: '3150mm', dims: '2850x3180mm' },
    doors: [hSlide(N, 276.7, 317), hSlide(321.2, 276.8, 317.2)] },
  { code: 'CWH-I/055', label: 'API STAGING', outline: rect(382.6, N, 435, 321.2),
    grade: 'B', instrument: 'CWH/RDU/059-00', meta: { dims: '2500x3180mm' },
    doors: [hSlide(N, 390.7, 427), hSlide(321.2, 390.7, 427)] },
  // Its double door opens into the granulation area, and is stored there.
  { code: 'CWH-I/018', label: 'SIFTING ROOM', grade: 'B', instrument: 'CWH/RDU/061-00', meta: { dims: '3015x3180mm' },
    outline: [[435, N], [497.4, N], [497.4, 312.3], [483.5, 312.3], [483.5, 321.2], [435, 321.2]], doors: [] },
  { code: 'CWH-I/017', label: 'BLENDING AREA', outline: rect(629.9, N, 838.7, 399.9), grade: 'UTILITY',
    meta: { fch: '5100mm', dims: '10302x4320mm' },
    doors: [vSlide(629.9, 263.7, 304), vSlide(838.7, 271.5, 321.9)] },
  { code: 'CWH-I/016', label: 'AIR LOCK-02', outline: rect(838.7, N, 900.6, 379.7),
    grade: 'B', instrument: 'CWH/RDU/090-00', meta: { fch: '3150mm', dims: '3020x6150' },
    doors: [hSlide(N, 847, 896)] },
  { code: 'CWH-I/054', label: 'CHANGE ROOM CWH', outline: rect(900.6, N, 974.5, 417.7), grade: 'UTILITY',
    meta: { dims: '7790x3435' },
    // From the central warehouse; and from the personal entry — both leaves stand in this room.
    doors: [hDoor(N, 909.6, 927.5, 'from'), vDoor(974.5, 389.5, 407.8, 'to')] },
  { code: 'CWH-I/337', label: 'HK STORE ROOM', outline: rect(974.5, N, 1023.9, 331.2), grade: 'UTILITY',
    meta: { dims: '3680x2300' }, doors: [hDoor(331.2, 979.2, 996.8, 'from')] },
  { code: 'CWH-I/005', label: 'LADIES TOILET', outline: rect(1023.9, N, E, 331.2), grade: 'UTILITY',
    meta: { dims: '3680x1600' }, doors: [vDoor(E, 284.1, 297.5, 'to')] },                       // from the main corridor

  // ── The dispensing rooms ────────────────────────────────────────────────
  { code: 'CWH-I/019', label: 'EXCIPIENT DISPENSING', outline: rect(W, 321.2, 326.8, 399.9),
    grade: 'B', instrument: 'CWH/RDU/029-00', meta: { fch: '3150mm', dims: '6000x3855mm' },
    doors: [hDoor(321.2, 238, 255.9, 'to')] },                                                  // WASH AREA-02's
  { code: 'CWH-I/020', label: 'API DISPENSING', grade: 'B', instrument: 'CWH/RDU/030-00', meta: { fch: '3150mm', dims: '5315 X 3350' },
    outline: [[326.8, N], [382.6, N], [382.6, 321.2], [435, 321.2], [435, 389.9], [326.8, 389.9]],
    doors: [vSlide(326.8, 337.9, 378.2), vSlide(435, 340.4, 380.8)] },

  // ── The granulation area: WEST SIDE and EAST SIDE, one room ─────────────
  { code: 'CWH-I/014', label: 'GRANULATION AREA', grade: 'B', instrument: 'CWH/RDU/032-00', meta: { fch: '5000mm', dims: '18590x4675mm' },
    outline: [
      [506.5, N], [629.9, N], [629.9, 399.9],
      // round the central return duct and the two column casings under it
      [558.9, 399.9], [558.9, 418.3], [592.2, 418.3], [592.2, 434], [611.1, 434], [611.1, 418.3],
      [820.3, 418.3], [820.3, 434], [838.7, 434],
      // the wash area's corner
      [838.7, 484.5], [730.9, 484.5], [730.9, 567.5],
      [305.4, 567.5],
      // the binder-preparation alcove, the column casing and the duct beside it
      [305.4, 449.5], [363.9, 449.5], [363.9, 439.7], [389.9, 439.7], [389.9, 389.9],
      [435, 389.9], [435, 321.2], [506.5, 321.2],
    ],
    doors: hPair(321.2, 443.2, 480.9) },                                                        // the SIFTING ROOM's
  { code: 'CWH-I/015', label: 'BINDER PREPARATION', outline: rect(305.4, 399.9, 363.9, 449.5), grade: 'UTILITY',
    meta: { fch: '3150mm', dims: '2800x2400mm' },
    doors: [hSlide(449.5, 310.4, 350.9)] },                                                     // open to the granulation area

  // ── The south-west block ────────────────────────────────────────────────
  { code: 'CWH-I/099', label: 'PERSONNEL ENTRY', outline: rect(W, 418.2, 252.8, 451), grade: 'UTILITY',
    meta: { dims: '1530 X 2500' },
    doors: [vDoor(W, 422.2, 440.6, 'from'), vDoor(252.8, 422.4, 440.6, 'from')] },              // from the connecting corridor; from the blender area
  { code: 'CWH-I/100', label: 'MATERIAL ENTRY', outline: rect(W, 451, 252.8, 488.4), grade: 'UTILITY',
    meta: { dims: '1750 X 2500' },
    doors: [vSlide(W, 454.5, 484.9), vSlide(252.8, 454.5, 487.9)] },
  { code: 'CWH-I/017 (3.5KL BLENDER)', label: 'BLENDER AREA', grade: 'B', instrument: 'CWH/RDU/031-00', meta: { dims: '4320 X 4380' },
    outline: [[252.8, 418.2], [290.7, 418.2], [290.7, S], [W, S], [W, 488.4], [252.8, 488.4]], doors: [] },

  // ── Airlock side: the corridor and what opens off it ────────────────────
  { code: 'CWH-I/011', label: 'CORRIDOR', outline: rect(838.7, 379.7, 900.6, 536), grade: 'CIRCULATION',
    meta: { fch: '3150mm', dims: '3020x7630mm' },
    doors: [
      ...vPair(838.7, 440.6, 479.1),                 // the granulation area's
      vDoor(900.6, 424, 442.5, 'from'),              // CHANGE ROOM MODULE-E's
      ...vPair(900.6, 495.7, 534.3),                 // the inspection room's
      hDoor(536, 839.4, 859.3, 'to'),                // the OFFICE's
    ] },
  { code: 'CWH-I/012', label: 'OFFICE', outline: rect(838.7, 536, 900.6, S), grade: 'UTILITY',
    meta: { fch: '3150', dims: '3020X2000' }, doors: [] },
  { code: 'CWH-I/013', label: 'WASH AREA-01', outline: rect(730.9, 484.5, 838.7, S), grade: 'UTILITY',
    meta: { fch: '3150mm', dims: '5290x4560mm' }, doors: [hSlide(484.5, 734.2, 774.6)] },

  // ── The entry rooms, east ───────────────────────────────────────────────
  { code: 'CWH-I/024', label: 'PERSONAL ENTRY MOD-E/MOD-F/CWH', outline: rect(974.5, 331.2, E, 417.7), grade: 'UTILITY',
    meta: { dims: '3955x4000' }, doors: [vDoor(E, 333, 351.7, 'from')] },                       // from the main corridor
  { code: 'CWH-I/010', label: 'CHANGE ROOM MODULE-E', outline: rect(900.6, 417.7, 974.5, 491.6), grade: 'UTILITY',
    meta: { fch: '3150mm', dims: '3620x3610mm' }, doors: [vDoor(974.5, 468.6, 486.5, 'to')] },  // from ENTRY MODULE-E&F
  { code: 'CWH-I/025', label: 'ENTRY MODULE-E&F', outline: rect(974.5, 417.7, E, 491.6), grade: 'UTILITY',
    meta: { fch: '3150mm', dims: '4075x3610mm' }, doors: [hDoor(417.7, 1025.2, 1043.1, 'to')] }, // from the personal entry
  { code: 'CWH-I/030', label: 'ACCESSORIES / POLY BAG INSPECTION ROOM', outline: rect(900.6, 491.6, 1001, S), grade: 'UTILITY',
    meta: { fch: '3150mm', dims: '4920x4210mm' }, doors: [] },
  { code: 'CWH-I/026', label: 'GENTS ENTRY MOD-F', outline: rect(1001, 491.6, E, S), grade: 'UTILITY',
    meta: { fch: '3150mm', dims: '2780x4210mm' },
    doors: [
      hDoor(491.6, 1025.3, 1043.3, 'to'),                                                       // from ENTRY MODULE-E&F
      { axis: 'y', at: S, from: 1027.2, to: 1045.2, hinge: 'to', kind: 'EXIT', swing: 'out' },   // out, to Module-F
    ] },
];

/** The twelve sliding doors, as the bar the drawing puts in the wall: [x0, y0, x1, y1]. */
const hBar = (y: number, x0: number, x1: number): Box => [x0, y - 1.5, x1, y + 1.5];
const vBar = (x: number, y0: number, y1: number): Box => [x - 1.5, y0, x + 1.5, y1];

export const MODULE_E_LAYOUT: ArchLayout = {
  area: 'Module-E',
  planName: 'CWH — Module-E',
  source: 'Layouts/CWH/Module-E layout.pdf',
  // The canvas, in the page's points: the module, the columns standing in its
  // outer walls and — below the south wall — the leaf of the exit, which opens out.
  building: { x0: 190, y0: 240, x1: 1072, y1: 608 },
  rooms: ROOMS,
  annotations: {
    columns: [
      // In the north wall.
      [365.4, 250.4, 381.1, 265.4], [593.3, 250.4, 609, 265.9], [821.3, 250.4, 837, 265.5], [941.9, 250.4, 957, 265.5], [1048.6, 250.4, 1063.7, 265.5],
      // The middle row, in pairs.
      [365.8, 401, 381.4, 416.7], [366.1, 417.3, 381.2, 432.4], [593.5, 401, 609.2, 416.7], [594.1, 417.3, 609.2, 432.4],
      [821.3, 400.9, 837.2, 416.7], [822.1, 417.3, 837.2, 432.4], [1048.6, 401.6, 1063.7, 416.7], [1048.6, 417.3, 1063.7, 432.4],
      // In the south wall.
      [366.1, 568.5, 381.2, 583.6], [594.1, 568.5, 609.2, 583.6], [822.1, 568.5, 837.2, 583.6], [1048.6, 568.5, 1063.7, 583.6],
    ],
    windows: [
      // The north wall's four windows, and its BREAKABLE GLASS emergency panel.
      [438.1, 250.4, 474.4, 256.5], [541, 250.4, 577.2, 256.5], [642.6, 250.4, 678.8, 256.5], [751.4, 250.4, 787.8, 256.5],
      [507, 250.4, 528.4, 256.5],
      // The blender area: the view panel in its west wall, the glazed panel in its east.
      [198.5, 540.3, 202.5, 560.5], [288.7, 517, 292.7, 540],
    ],
    walls: [
      // Where a void meets an outer wall, or has no room on one side.
      [497.4, N, 506.5, N],              // the duct beside the sifting room, at the north wall
      [363.9, 399.9, 389.9, 399.9],      // the column casing's north side
      [W, 399.9, W, 418.2],              // the west wall, between the dispensing room and the south-west block
      [290.7, S, 730.9, S],              // the south wall, behind the granulation area's own
    ],
    equipment: [
      hBar(N, 276.7, 317), hBar(321.2, 276.8, 317.2),          // excipient staging: north, south
      hBar(N, 390.7, 427), hBar(321.2, 390.7, 427),            // API staging: north, south
      vBar(326.8, 337.9, 378.2), vBar(435, 340.4, 380.8),      // API dispensing: west, east
      vBar(629.9, 263.7, 304), vBar(838.7, 271.5, 321.9),      // the blending area: west, east
      hBar(N, 847, 896),                                       // AIR LOCK-02, north
      hBar(484.5, 734.2, 774.6),                               // WASH AREA-01
      vBar(W, 454.5, 484.9), vBar(252.8, 454.5, 487.9),        // the material entry: west, east
    ],
    labels: [{ x: 700, y: 411.4, text: 'RETURN DUCT CUTOUT' }],
  },
};
