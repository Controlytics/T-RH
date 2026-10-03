/**
 * The MODULE-F building: its GROUND FLOOR and its FIRST FLOOR, traced from the
 * two architectural drawings `Layouts/CWH/Mod-F Ground floor.pdf` and
 * `Layouts/CWH/Mod-F First floor.pdf` and drawn in the 2D ARCHITECTURAL style,
 * the way QC, QC Microbiology, QC 3 and Module-E are.
 *
 * Operator, 2026-10-01: "for module F there are 2 layouts ground floor and first
 * floor, we need to show as 2 seperate layouts in Module F,we need to give
 * option in Module F like Ground Floor and First floor,when user selected one
 * layout should be displayed".
 *
 * Until now Module-F was ONE generated plan: twenty boxes cut from a room
 * count, each coded with its instrument's code. It becomes two plans that share
 * a `floor.group` ("CWH — Module-F"); the dashboard lists the group once and
 * offers the two floors. The generated plan is RENAMED to the ground floor's
 * name rather than left beside them.
 *
 * ─── HOW THEY WERE MEASURED ──────────────────────────────────────────────
 * Both drawings are VECTOR PDFs (one page each, 1191 x 842 pt as displayed,
 * stored rotated 270°). As for Module-E, every wall is a pair of parallel lines
 * whose coordinates were READ from the file (`page.get_drawings()` through the
 * page's rotation matrix) and a partition is taken midway between its faces; a
 * door is the gap in those lines and its leaf the short line pair standing off
 * the wall. The numbers are PDF POINTS of each page as displayed — the two
 * pages do NOT share an origin or a scale, so each floor has its own canvas.
 *
 * ─── WHAT IS DRAWN ───────────────────────────────────────────────────────
 * GROUND FLOOR (28 rooms): the module (x 132.5-985.5, y 321.8-607.5) and the
 * stair-and-lift annex on its west side. The GRANULATION AREA (GF) is one room
 * of ten corners that takes in the bay the drawing only dimensions
 * (`4550 x 6000`); CORRIDOR-1 turns the corner under the entry rooms and
 * CORRIDOR-4 runs up to the change room, each one outline. The three rooms
 * north of the module on the drawing (the personnel entry, ENTRY MODULE-E&F,
 * the gents entry) are Module-E's and are on its plan.
 *
 * FIRST FLOOR (21 rooms): the same footprint. The GRANULATION AREA is one room
 * round the staircase, the duct shaft and the charging rooms; the two
 * TECHNICAL AREAS the drawing labels are ONE space — nothing divides them south
 * of the change-parts room — so they are one outline.
 *
 * On both: a sliding door, a lift door and an open side are an opening with no
 * leaf (a sliding or lift door also has its outlined bar); the cavity behind
 * the granulation area's south wall and, on the first floor, the duct opening
 * shaft are VOIDS; the hoppers and the RMG platform are outlined.
 *
 * ─── WHERE THIS IS NOT THE DRAWING ───────────────────────────────────────
 *   - Rooms with no name on the drawing are named for what they are: LIFT
 *     LOBBY (the drawing gives only `3000 X 3400` / `2600 X 3370`), and the
 *     two staircases are `STAIRCASE-A` (the annex) and `STAIRCASE-B`.
 *   - The ground floor's ACCESSORIES ROOM is drawn to the granulation area's
 *     wall; the drawing lines it 6.9 pt inside. The API dispensing room's
 *     5 pt notch beside the wash area IS drawn.
 *   - Not drawn: the movement arrows (the ground-floor drawing is the
 *     personnel-and-material movement layout), the pressure-zone hatching (the
 *     first-floor drawing is the differential-pressure zoning layout), stair
 *     treads, lift crosses, and the return-air riser linings the drawing shows
 *     as a hairline 5 pt inside some walls and round the columns.
 *
 * ─── WHICH INSTRUMENT IS WHERE ───────────────────────────────────────────
 * Sixteen of Module-F's seventeen, each in the room its `Location` names:
 *   ground — Binder preparation Area (038-00), Granulation Area(Near Office
 *   Room) (039-00), Blender Area-01 (040-00), Hold Area-01 (042-00), Blender
 *   Area-02 (044-00), 1.6KL Blender (071-00, the BLENDER AREA CWH-I/350);
 *   first — API / Excipient Dispensing Booth Area (033-00, 034-00), Sifting
 *   Holding Area (035-00), Binder Charging Area (036-00), Blender Charging
 *   Area-01 / -02 (041-00, 043-00).
 * FIVE are judgements, on the name alone:
 *   - 037-00 "Charging Area( Near RMG & FBP Area)" → the first-floor
 *     GRANULATION AREA, where the drawing has `RMG AREA @4MTR LVL`;
 *   - 056-00 / 057-00 "API / Excipient Dispensing Material Entry Area" → the
 *     API STAGING and EXCIPIENT STAGING rooms, which material enters the
 *     dispensing rooms through;
 *   - 058-00 "Staging Area (Near lift 1st Floor)" → MATERIAL STAGING AREA-01,
 *     the one room so named (it is beside STAIRCASE-B, not the lifts);
 *   - 071-00 "1.6KL Blender" → the ground-floor BLENDER AREA (CWH-I/350).
 * ONE IS NOT PLACED: 072-00 "3.5KL Blender". Neither Module-F drawing has a
 * room for a 3.5KL blender; the only room so labelled on any drawing is on
 * MODULE-E's (`BLENDER AREA (3.5KL BLENDER)`), and this instrument is
 * registered to Module-F. It is left without a room rather than guessed at.
 *
 * ─── DRAWN LARGER THAN THE DRAWING, IN TWO WAYS ──────────────────────────
 * Each floor is about 2.9 times as wide as it is tall and its instrument rooms
 * are small: laid out to the drawing's proportions, a dashboard panel showed it
 * in its top half with ten of the sixteen cards too small to read (the ID at 4
 * to 6 units). So, like QC 3's north row (operator there: "rooms are very small
 * and those data was showing very small"), the floors are DRAWN larger — see
 * `enlargeLayout` for exactly what stretches and what keeps its size:
 *   - both floors are half as tall again (`add` on the whole north-south span);
 *   - the narrow columns that hold an instrument are wider: on the ground
 *     floor the BLENDER AREA's (179.8-246.3) and HOLD AREA-01's (711.2-779.4),
 *     on the first floor the staging rooms' (207.7-267.7) and the dispensing
 *     rooms' (267.7-352.7).
 * The tables below hold the MEASURED numbers (`MODULE_F_*_TRACE`), so a
 * re-measure compares like with like; `MODULE_F_*_LAYOUT` is what is drawn.
 *
 * GRADES: `B` on the instrument rooms is what the generated plan held. The
 * corridors are CIRCULATION, everything else UTILITY. In this style a grade
 * only tints an EMPTY room.
 */
import {
  rect, vDoor, hDoor, vPair, hPair, vSlide, hSlide, hBar, vBar, enlargeLayout,
  type ArchLayout, type ArchRoom, type ArchFloor, type EnlargeSpec,
} from './architectural-layout.js';

/** The building both plans are floors of: the area's plan name before it had two. */
export const MODULE_F_GROUP = 'CWH — Module-F';
const floor = (label: string, order: number): ArchFloor => ({ group: MODULE_F_GROUP, label, order });
/** Both drawings carry an `N` arrow pointing to the right of the page. */
const NORTH = 90;

// ═════════════════════════════ GROUND FLOOR ═════════════════════════════════
// Wall lines (pt): x ∈ {64, 132.5, 179.8, 217.7, 246.3, 328.7, 341.3, 449, 543.3,
// 706.9, 711.2, 777.4, 779.4, 836.3, 875.7, 905.6, 932.7, 935.4, 952.1, 985.5};
// y ∈ {321.8, 369.5, 385.7, 389.4, 409.4, 415.4, 467, 470, 523.1, 524.5, 532.6,
// 544.6, 569.6, 591.6, 607.5}.
const G = { W: 64, CW: 132.5, E: 985.5, N: 321.8, S: 607.5 } as const;

const GROUND_ROOMS: ArchRoom[] = [
  // ── The annex: stair and material lifts ─────────────────────────────────
  { code: 'STAIRCASE-A', label: 'STAIRCASE', outline: rect(G.W, G.N, G.CW, 409.4), grade: 'UTILITY',
    doors: [hSlide(409.4, G.W, G.CW)] },                                           // open onto the lobby
  { code: 'LIFT LOBBY', label: null, outline: rect(G.W, 409.4, G.CW, 467), grade: 'UTILITY',
    meta: { dims: '3000 X 3400' }, doors: [vSlide(G.CW, 409.4, 450.6)] },          // open to the corridor
  { code: 'MAT. LIFT-02', label: null, outline: rect(G.W, 467, G.CW, 532.6), grade: 'UTILITY', doors: [vSlide(G.CW, 485.7, 514.2)] },
  { code: 'MAT. LIFT-01', label: null, outline: rect(G.W, 532.6, G.CW, G.S), grade: 'UTILITY', doors: [vSlide(G.CW, 551.1, 579.9)] },

  // ── The west end ────────────────────────────────────────────────────────
  { code: 'CWH-I/352', label: 'CORRIDOR-1', grade: 'CIRCULATION', meta: { fch: '3.0m', dims: '14500x2400mm' },
    outline: [[G.CW, G.N], [179.8, G.N], [179.8, 524.5], [246.3, 524.5], [246.3, G.S], [G.CW, G.S]],
    doors: [hSlide(G.S, 137.2, 175.2)] },                                          // the door to the RM warehouse
  { code: 'CWH-I/044', label: 'SIFTING AREA', outline: rect(179.8, G.N, 246.3, 369.5), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '2000 x 3400' }, doors: [hSlide(369.5, 198.7, 246.3)] },   // open to the blender area
  { code: 'CWH-I/350', label: 'BLENDER AREA', outline: rect(179.8, 369.5, 246.3, 467),
    grade: 'B', instrument: 'CWH/RDU/071-00', meta: { fch: '4.5m', dims: '5100 x 3400' }, doors: [] },
  { code: 'CWH-I/351', label: 'MAT. ENTRY/EXIT', outline: rect(179.8, 467, 217.7, 524.5), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '3000 x 1900' }, doors: [hSlide(467, 185, 213), hSlide(524.5, 185, 213)] },
  { code: 'CWH-I/349', label: 'PERSONNEL ENTRY', outline: rect(217.7, 467, 246.3, 524.5), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '3000 x 1400' },
    doors: [hDoor(467, 226, 242, 'to'), hDoor(524.5, 221.8, 239, 'from')] },      // from the blender area; from the corridor
  { code: 'STAIRCASE-B', label: 'STAIRCASE', outline: rect(246.3, G.N, 341.3, 389.4), grade: 'UTILITY',
    doors: [vSlide(341.3, 333, 378.7)] },                                          // open to the granulation area
  { code: 'CWH-I/034', label: 'WASH AREA-02', outline: rect(246.3, 389.4, 328.7, 467), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '4020 x 4250' }, doors: [vSlide(328.7, 401.4, 439.4)] },
  { code: 'CWH-I/033', label: 'OFFICE', outline: rect(246.3, 467, 328.7, 544.6), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '3990 x 4250' }, doors: [vDoor(328.7, 522.8, 540, 'to')] },
  { code: 'CWH-I/032', label: 'AIR LOCK-05', outline: rect(246.3, 544.6, 328.7, G.S), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '3000 X4250' },
    doors: [...vPair(246.3, 551.7, 587), ...vPair(328.7, 551.7, 587)] },           // from the corridor; from the granulation area

  // ── The process rooms ───────────────────────────────────────────────────
  { code: 'CWH-I/031', label: 'GRANULATION AREA(GF)', grade: 'B', instrument: 'CWH/RDU/039-00', meta: { fch: '4.7m', dims: '9210 x 11230' },
    outline: [
      [341.3, G.N], [449, G.N], [449, 415.4], [543.3, 415.4], [543.3, 470], [706.9, 470],
      [706.9, 591.6], [328.7, 591.6], [328.7, 389.4], [341.3, 389.4],
    ],
    doors: hPair(415.4, 452.2, 487.5) },                                           // BINDER PREPARATION's
  { code: 'CWH-I/035', label: 'BINDER PREPARATION', outline: rect(449, G.N, 543.3, 415.4),
    grade: 'B', instrument: 'CWH/RDU/038-00', meta: { fch: '4.7m', dims: '4600 x 4900' }, doors: [] },
  { code: 'CWH-I/036', label: 'BLENDER AREA-01', outline: rect(543.3, G.N, 711.2, 470),
    grade: 'B', instrument: 'CWH/RDU/040-00', meta: { fch: '4.7m', dims: '7525 x 8770' },
    doors: [hSlide(470, 657, 695), vSlide(711.2, 339.8, 377.8)] },
  { code: 'CWH-I/037', label: 'HOLD AREA-01', outline: rect(711.2, G.N, 779.4, 470),
    grade: 'B', instrument: 'CWH/RDU/042-00', meta: { fch: '3.0m', dims: '7475X3500' },
    doors: [hSlide(470, 715.8, 753.8), vSlide(779.4, 339.8, 377.8)] },
  { code: 'CWH-I/038', label: 'BLENDER AREA-02', outline: rect(779.4, G.N, 932.7, 470),
    grade: 'B', instrument: 'CWH/RDU/044-00', meta: { fch: '4.7m', dims: '7475X7980' },
    doors: [hSlide(470, 785.2, 823.2)] },

  // ── The east end: change rooms and airlocks off CORRIDOR-4 ──────────────
  { code: 'CWH-I/027', label: 'CHANGE ROOM MODULE-F', outline: rect(932.7, G.N, G.E, 385.7), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '3100x2500mm' }, doors: [hDoor(G.N, 953.8, 970.6, 'to')] },   // from the gents entry
  { code: 'CWH-I/028', label: 'CORRIDOR-4', grade: 'CIRCULATION', meta: { fch: '3.0m', dims: '2725x14430' },
    outline: [[706.9, 470], [932.7, 470], [932.7, 385.7], [G.E, 385.7], [G.E, 523.1], [706.9, 523.1]],
    doors: [
      hDoor(385.7, 957, 976.7, 'to'),                // the change room's
      ...vPair(706.9, 479, 514.5),                   // the granulation area's
      hDoor(523.1, 753, 773.5, 'to'),                // the accessories room's
      hDoor(523.1, 879.3, 897, 'from'),              // AIR LOCK-3's
      hDoor(523.1, 909, 926.8, 'from'),              // AIR LOCK-2's
    ] },
  { code: 'CWH-I/030', label: 'ACCESSORIES ROOM', outline: rect(706.9, 523.1, 777.4, G.S), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '4205X3280' }, doors: [] },
  { code: 'CWH-I/029', label: 'AIRLOCK-4', outline: rect(777.4, 523.1, 836.3, G.S), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '4205X3000' }, doors: [hSlide(523.1, 785.2, 822.1), hSlide(G.S, 784.8, 823.1)] },
  { code: 'CWH-I/354', label: 'LADIES PRIMARY CHANGE ROOM', outline: rect(836.3, 523.1, 875.7, G.S), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '4200X2000' }, doors: [] },
  { code: 'CWH-I/356', label: 'AIR LOCK-3', outline: rect(875.7, 523.1, 905.6, 569.6), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '2400X1500' }, doors: [vDoor(875.7, 545.4, 566, 'to')] },       // from the ladies primary change room
  { code: 'CWH-I/355', label: 'AIR LOCK-2', outline: rect(905.6, 523.1, 935.4, 569.6), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '2400X1500' }, doors: [vDoor(935.4, 545.1, 565.7, 'to')] },     // from the visitor change room
  { code: 'CWH-I/004', label: 'VISITOR/MANAGER CHANGE ROOM', outline: rect(935.4, 523.1, G.E, 569.6), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '2400X2380' },
    doors: [{ axis: 'x', at: G.E, from: 528.2, to: 546.2, hinge: 'from', kind: 'ENTRY', swing: 'out' }] },   // from the main corridor; its leaf stands outside
  { code: 'CWH-I/353', label: 'LADIES STREET WARE', outline: rect(875.7, 569.6, 952.1, G.S), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '1750X3975' }, doors: [vDoor(875.7, 579.4, 600, 'to')] },       // from the ladies primary change room
  { code: 'CWH-I/003', label: 'LADIES CHANGE ROOM', outline: rect(952.1, 569.6, G.E, G.S), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '1750X1500' },
    doors: [
      vDoor(952.1, 582, 600, 'to'),                                                // from the street-ware room
      { axis: 'x', at: G.E, from: 572, to: 589.7, hinge: 'to', kind: 'ENTRY', swing: 'out' },   // from the main corridor
    ] },
];

/** The ground floor AS MEASURED. */
export const MODULE_F_GROUND_TRACE: ArchLayout = {
  area: 'Module-F',
  planName: 'CWH — Module-F — Ground Floor',
  renamesPlan: MODULE_F_GROUP,
  floor: floor('Ground Floor', 0),
  north: NORTH,
  source: 'Layouts/CWH/Mod-F Ground floor.pdf',
  // The module, its annex, the columns in its walls, and the two leaves that
  // stand outside the east wall.
  building: { x0: 52, y0: 300, x1: 1012, y1: 632 },
  rooms: GROUND_ROOMS,
  annotations: {
    columns: [
      // North wall, middle row, south wall — five each, on the same five lines.
      [116.4, 309.7, 130.7, 323.8], [332.2, 309.7, 346.4, 323.8], [546.6, 309.7, 560.8, 323.8], [760.9, 309.7, 775.2, 323.8], [973.8, 310.2, 988.1, 324.3],
      [116.4, 452, 130.7, 466.2], [330.8, 450.6, 347.9, 467.6], [545.2, 450.6, 562.2, 467.6], [759.5, 450.6, 776.5, 467.6], [973.9, 452, 988.1, 466.2],
      [116.4, 594.2, 130.7, 608.5], [330.8, 592.9, 347.9, 609.9], [545.2, 592.9, 562.2, 609.9], [759.5, 592.9, 776.5, 609.9], [973.8, 594.2, 988.1, 608.5],
    ],
    // The two glazed panels (`CW`) in the east wall.
    windows: [[982.9, 394.5, 988.1, 427.5], [982.9, 482.5, 988.1, 513.8]],
    // The south wall, behind the granulation area's own.
    walls: [[328.7, G.S, 706.9, G.S]],
    equipment: [
      vBar(G.CW, 485.7, 514.2), vBar(G.CW, 551.1, 579.9),          // the two lift doors
      hBar(G.S, 137.2, 175.2),                                     // CORRIDOR-1, to the RM warehouse
      hBar(467, 185, 213), hBar(524.5, 185, 213),                  // the material entry: north, south
      vBar(328.7, 401.4, 439.4),                                   // WASH AREA-02
      hBar(470, 657, 695), vBar(711.2, 339.8, 377.8),              // BLENDER AREA-01: south, east
      hBar(470, 715.8, 753.8), vBar(779.4, 339.8, 377.8),          // HOLD AREA-01: south, east
      hBar(470, 785.2, 823.2),                                     // BLENDER AREA-02
      hBar(523.1, 785.2, 822.1), hBar(G.S, 784.8, 823.1),          // AIRLOCK-4: north, south
    ],
  },
};

/** Where the ground floor is drawn larger than measured — see the header. */
export const MODULE_F_GROUND_ENLARGE: EnlargeSpec = {
  x: [{ from: 179.8, to: 246.3, add: 34 }, { from: 711.2, to: 779.4, add: 34 }],
  y: [{ from: G.N, to: G.S, add: 143 }],
};
/** The ground floor AS DRAWN. */
export const MODULE_F_GROUND_LAYOUT: ArchLayout = enlargeLayout(MODULE_F_GROUND_TRACE, MODULE_F_GROUND_ENLARGE);

// ═════════════════════════════ FIRST FLOOR ══════════════════════════════════
// Wall lines (pt): x ∈ {96.3, 161.5, 207.7, 267.7, 272.7, 352.7, 361.5, 404, 431.2,
// 508.8, 581.9, 670.3, 718.5, 790.7, 832.9, 911.3, 993.7};
// y ∈ {238.3, 277, 297.4, 304.6, 316, 328.3, 362.2, 376.7, 379.5, 408.7, 440.2,
// 459.1, 474.7, 501.2, 504.2, 517.3}.
const F = { W: 96.3, CW: 161.5, E: 993.7, N: 238.3, S: 517.3 } as const;

const FIRST_ROOMS: ArchRoom[] = [
  // ── The annex ───────────────────────────────────────────────────────────
  { code: 'STAIRCASE-A', label: 'STAIR CASE', outline: rect(F.W, F.N, F.CW, 328.3), grade: 'UTILITY',
    doors: [hSlide(328.3, F.W, F.CW)] },
  { code: 'LIFT LOBBY', label: null, outline: rect(F.W, 328.3, F.CW, 379.5), grade: 'UTILITY',
    meta: { dims: '2600 X 3370' }, doors: [vSlide(F.CW, 328.3, 363.8)] },
  { code: 'MAT. LIFT-02', label: null, outline: rect(F.W, 379.5, F.CW, 440.2), grade: 'UTILITY', doors: [vSlide(F.CW, 398, 425.7)] },
  { code: 'MAT. LIFT-01', label: null, outline: rect(F.W, 440.2, F.CW, 504.2), grade: 'UTILITY', doors: [vSlide(F.CW, 458.5, 486.2)] },

  // ── The dispensing suite, off CORRIDOR-02 ───────────────────────────────
  { code: 'CWH-I/357', label: 'CORRIDOR-02', outline: rect(F.CW, F.N, 207.7, F.S), grade: 'CIRCULATION',
    meta: { fch: '3m', dims: '14605 x 2400' }, doors: [] },
  { code: 'CWH-I/043', label: 'WASH AREA-01', outline: rect(207.7, F.N, 272.7, 304.6), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '3300x3450mm' }, doors: [] },                       // its door opens into API staging
  { code: 'CWH-I/051', label: 'API STAGING', outline: rect(207.7, 304.6, 267.7, 376.7),
    grade: 'B', instrument: 'CWH/RDU/056-00', meta: { fch: '3.0m', dims: '3800x3150mm' },
    doors: [hDoor(304.6, 246.5, 262.8, 'to'), vSlide(207.7, 316.9, 353.8), vSlide(267.7, 316.9, 353.8)] },
  { code: 'CWH-I/053', label: 'DISPENSING CHANGE ROOM', outline: rect(207.7, 376.7, 267.7, 459.1), grade: 'UTILITY',
    meta: { fch: '3.0m', dims: '4360x3150mm' },
    // From the corridor, from API dispensing, from excipient dispensing: all three leaves stand in this room.
    doors: [vDoor(207.7, 437.8, 454.2, 'to'), vDoor(267.7, 381.6, 397.9, 'from'), vDoor(267.7, 437.8, 454.2, 'to')] },
  { code: 'CWH-I/052', label: 'EXCIPIENT STAGING', outline: rect(207.7, 459.1, 267.7, F.S),
    grade: 'B', instrument: 'CWH/RDU/057-00', meta: { fch: '3.0m', dims: '2650x3150mm' },
    doors: [vSlide(207.7, 467.4, 504.4), vSlide(267.7, 467.4, 504.4)] },
  { code: 'CWH-I/041', label: 'API DISPENSING', grade: 'B', instrument: 'CWH/RDU/033-00', meta: { fch: '3.0m', dims: '7030x4500mm' },
    outline: [[272.7, 277], [352.7, 277], [352.7, 408.7], [267.7, 408.7], [267.7, 304.6], [272.7, 304.6]],
    doors: [vSlide(352.7, 315.9, 353)] },
  { code: 'CWH-I/042', label: 'EXCIPIENT DISPENSING', outline: rect(267.7, 408.7, 352.7, F.S),
    grade: 'B', instrument: 'CWH/RDU/034-00', meta: { fch: '3.0m', dims: '5530x4500mm' },
    doors: [vSlide(352.7, 460.8, 497.8)] },
  { code: 'STAIRCASE-B', label: 'STAIRCASE', outline: rect(272.7, F.N, 361.5, 277), grade: 'UTILITY',
    doors: [vSlide(361.5, 243, 266)] },

  // ── The granulation area and the rooms that charge it ───────────────────
  { code: 'CWH-I/031', label: 'GRANULATION AREA', grade: 'B', instrument: 'CWH/RDU/037-00', meta: { fch: '2.8m', dims: '7450x8440mm' },
    outline: [
      [361.5, F.N], [404, F.N], [404, 297.4], [581.9, 297.4], [581.9, 362.2], [718.5, 362.2],
      [718.5, 501.2], [352.7, 501.2], [352.7, 277], [361.5, 277],
    ],
    doors: [...hPair(297.4, 513.7, 548), ...vPair(581.9, 322.5, 357)] },           // the binder charging area's; blender charging area-01's
  { code: 'CWH-I/040', label: 'MATERIAL STAGING AREA-01', outline: rect(431.2, F.N, 508.8, 297.4),
    grade: 'B', instrument: 'CWH/RDU/058-00', meta: { fch: '2.5m', dims: '2910x4100mm' },
    doors: [hSlide(297.4, 450.2, 508.8)] },                                        // open to the granulation area
  { code: 'CWH-I/039', label: 'BINDER CHARGING AREA', outline: rect(508.8, F.N, 581.9, 297.4),
    grade: 'B', instrument: 'CWH/RDU/036-00', meta: { fch: '2.8m', dims: '2910x3860mm' }, doors: [] },
  { code: 'CWH-I/046', label: 'BLENDER CHARGING AREA-01', outline: rect(581.9, F.N, 670.3, 362.2),
    grade: 'B', instrument: 'CWH/RDU/041-00', meta: { fch: '2.8m', dims: '6360x4680mm' }, doors: [] },
  { code: 'CWH-I/044', label: 'SIFTING / HOLDING AREA', outline: rect(670.3, F.N, 832.9, 316),
    grade: 'B', instrument: 'CWH/RDU/035-00', meta: { fch: '2.4m', dims: '8700x3860mm' },
    doors: [hSlide(316, 742.3, 779)] },
  { code: 'CWH-I/045', label: 'CORRIDOR-3', outline: rect(670.3, 316, 832.9, 362.2), grade: 'CIRCULATION',
    meta: { fch: '2.8m', dims: '2400x8700mm' },
    doors: [
      hSlide(362.2, 674.9, 711.8),                   // to the granulation area
      ...hPair(362.2, 793.5, 827.9),                 // the change-parts room's
      ...vPair(832.9, 321, 355.5),                   // blender charging area-02's
    ] },
  { code: 'CWH-I/047', label: 'BLENDER CHARGING AREA-02', outline: rect(832.9, F.N, 911.3, 362.2),
    grade: 'B', instrument: 'CWH/RDU/043-00', meta: { fch: '2.8m', dims: '6360x4150mm' }, doors: [] },
  { code: 'CWH-I/048', label: 'CHANGE PARTS STORAGE ROOM', outline: rect(790.7, 362.2, 911.3, 474.7), grade: 'UTILITY',
    meta: { fch: '2.8m', dims: '6000x6430mm' }, doors: [] },
  { code: 'TECHNICAL AREA', label: null, grade: 'UTILITY',
    outline: [[911.3, F.N], [F.E, F.N], [F.E, F.S], [718.5, F.S], [718.5, 362.2], [790.7, 362.2], [790.7, 474.7], [911.3, 474.7]],
    doors: [
      vDoor(911.3, 448.9, 466, 'to', 'EXIT'),        // the change-parts room's emergency exit
      ...vPair(F.E, 246.4, 280.8), ...vPair(F.E, 464.3, 498.8),   // from the main corridor
    ] },
];

/** The first floor AS MEASURED. */
export const MODULE_F_FIRST_TRACE: ArchLayout = {
  area: 'Module-F',
  planName: 'CWH — Module-F — First Floor',
  floor: floor('First Floor', 1),
  north: NORTH,
  source: 'Layouts/CWH/Mod-F First floor.pdf',
  building: { x0: 84, y0: 222, x1: 1006, y1: 534 },
  rooms: FIRST_ROOMS,
  annotations: {
    columns: [
      [146.9, 227, 160.7, 240.9], [357, 227, 370.9, 240.9], [565.8, 227, 579.6, 240.9], [774.6, 227, 788.4, 240.9], [982, 227, 995.8, 240.9],
      [146.9, 365.6, 160.7, 379.5], [355.7, 364.3, 372.2, 380.8], [564.4, 364.3, 581, 380.8], [773.2, 364.3, 789.8, 380.8], [982, 365.6, 995.8, 379.5],
      [146.9, 504.2, 160.7, 518], [355.7, 502.8, 372.2, 519.4], [564.4, 502.8, 581, 519.4], [773.2, 502.8, 789.8, 519.4], [982, 504.2, 995.8, 518],
    ],
    // The glazing: two panels in the east wall, five in the south wall, one in the annex's west wall.
    windows: [
      [991.6, 311.5, 995.8, 344.8], [991.6, 400.5, 995.8, 433.8],
      [167.9, 515.1, 201.1, 519.4], [376.8, 514.2, 410, 518.5], [525.6, 514.4, 558.8, 518.6], [622.2, 515.2, 655.4, 519.4], [867.8, 515.2, 901.1, 519.4],
      [94.2, 330.8, 98.4, 364.2],
    ],
    walls: [
      [404, F.N, 431.2, F.N],            // the duct opening shaft, at the north wall
      [352.7, F.S, 718.5, F.S],          // the south wall, behind the granulation area's own
    ],
    equipment: [
      vBar(F.CW, 398, 425.7), vBar(F.CW, 458.5, 486.2),            // the two lift doors
      vBar(207.7, 316.9, 353.8), vBar(267.7, 316.9, 353.8),        // API staging: west, east
      vBar(207.7, 467.4, 504.4), vBar(267.7, 467.4, 504.4),        // excipient staging: west, east
      vBar(352.7, 315.9, 353), vBar(352.7, 460.8, 497.8),          // the two dispensing rooms, into the granulation area
      hBar(316, 742.3, 779), hBar(362.2, 674.9, 711.8),            // CORRIDOR-3: north, south
      // The two charging hoppers, and the RMG platform at the 4 m level.
      [610, 273.2, 654.5, 343], [852.7, 280.8, 899.3, 350], [405.5, 364.2, 538.6, 409.5],
    ],
    labels: [{ x: 472, y: 389, text: 'RMG AREA @4MTR LVL' }],
  },
};

/** Where the first floor is drawn larger than measured — see the header. */
export const MODULE_F_FIRST_ENLARGE: EnlargeSpec = {
  x: [{ from: 207.7, to: 267.7, add: 56 }, { from: 267.7, to: 352.7, add: 18 }],
  y: [{ from: F.N, to: F.S, add: 140 }],
};
/** The first floor AS DRAWN. */
export const MODULE_F_FIRST_LAYOUT: ArchLayout = enlargeLayout(MODULE_F_FIRST_TRACE, MODULE_F_FIRST_ENLARGE);
