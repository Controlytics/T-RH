/**
 * "CWH — QC Layout-2" (2026-10-01) — the QC floor traced from
 * `Layouts/CWH/QC Layout-2.png` (1083 x 1452), a clean, text-free, higher
 * resolution drawing of the SAME floor as `QC Layout.png` (`qc-layout.ts`).
 *
 * Operator: "in layouts folder there is one image QC Layout-2 image, In QC add
 * that one as another layout, it should match with 100% complete design with
 * image". Asked, they chose: move the 12 QC instruments onto this layout; draw
 * the COLUMNS and WINDOWS; the name above.
 *
 * What makes it closer to the drawing than the first trace, which had only
 * rectangles to work with:
 *   - Rooms are POLYGONS (Layout Designer, 2026-09-22): SAMPLE PREPARATION and
 *     HPLC are the interlocking L-shapes the drawing has (the first trace stored
 *     each as its bounding box and lost the partition), and the CORRIDOR is ONE
 *     polygon — north arm, central spine and south arm — with no seams at all.
 *   - Every door is the gap measured in the wall, on the edge of the room its
 *     swing arc opens into, including the four EXTERIOR doors (two west
 *     openings off the corridor, Office-02's and the Change Room's east doors).
 *   - Columns (the orange hatched squares), windows (blue marks in the
 *     partitions, red-framed lights in the outer walls) and the two partition
 *     STUBS are the plan's annotation layer — `columns` / `windows` / `walls`.
 *
 * HOW IT WAS MEASURED: walls are double lines ~4 px apart, located by dark-pixel
 * projections and taken at their CENTRE (rooms share a wall at its centre line,
 * so neighbours tessellate exactly); each wall's extent by run-length along that
 * line, which also gives every door gap; doors cross-checked one-for-one against
 * the 20 orange swing arcs; columns and windows by colour clustering. The pixel
 * numbers are kept as-is so the next person can re-measure against the same file.
 *
 * Names and room numbers are NOT on this drawing. They are the QC drawing's —
 * the same floor — and the build script carries each room's label, grade and
 * meta over from the existing "CWH — QC" rooms by code, so edits made there
 * since are kept.
 *
 * Wall grid (px, centre lines): x ∈ {23, 176.5, 206, 283, 293, 365.5, 492.5,
 * 689, 730.5, 796, 880, 922.5, 1055}; y ∈ {10, 160, 281, 413, 431.5, 520,
 * 781.5, 1024.5, 1161.5, 1266.5, 1426}. 23 / 10 / 1055 / 1426 are the INNER
 * faces of the outer walls; the walls themselves are the band out to BUILDING.
 */

// The types and the px -> stored conversions are shared with every floor drawn
// in this style since the Microbiology floor became the second (same day);
// they were lifted out of this file unchanged. The names below are kept as
// aliases so this file still reads against its own test.
import {
  rect, vDoor, hDoor, edgeDoor, archCanvas, archPoints, archAnnotations,
  type Grade, type ArchDoor, type ArchRoom, type ArchAnnotations,
} from './architectural-layout.js';

export type { Grade };
export type Door2 = ArchDoor;
/** `label` is used only when the existing QC plan has no room of this code. */
export type Room2 = ArchRoom;
export { edgeDoor };

/** The outer faces of the exterior walls — the plan's canvas. The rooms stop at
 *  the inner faces, so the band between is the wall, with its windows and the
 *  south columns sitting in it. */
export const QC2_BUILDING = { x0: 5, y0: 2, x1: 1074, y1: 1452 } as const;

export const QC2_ROOMS: Room2[] = [
  // ── North block ─────────────────────────────────────────────────────────
  { code: 'CWH-I/231', label: 'HOT ZONE', outline: rect(23, 10, 176.5, 281), instrument: 'CWH/RDU/015-00',
    doors: [vDoor(176.5, 223, 267, 'to')] },                       // arc x124-180: opens into HOT ZONE
  { code: 'CWH-I/230', label: 'WET LAB', outline: rect(176.5, 10, 689, 281), instrument: 'CWH/RDU/022-00',
    doors: [vDoor(689, 223, 267, 'to')] },                         // onto the spine
  { code: 'CWH-I/229', label: 'SAMPLE DESTRUCTION ROOM', outline: rect(23, 281, 283, 413), instrument: 'CWH/RDU/018-00',
    doors: [hDoor(413, 118, 161, 'to')] },
  { code: 'CWH-I/228', label: 'CHAMBER ROOM', outline: rect(283, 281, 492.5, 413), instrument: 'CWH/RDU/017-00',
    doors: [hDoor(413, 348, 392, 'to')] },
  { code: 'CWH-I/227', label: 'WEIGHING ROOM', outline: rect(492.5, 281, 689, 413), instrument: 'CWH/RDU/016-00',
    doors: [hDoor(413, 629, 673, 'to')] },
  // ── East block ──────────────────────────────────────────────────────────
  { code: 'CWH-I/232', label: 'OFFICE-01', outline: rect(796, 10, 922.5, 160), grade: 'UTILITY',
    doors: [vDoor(796, 110, 153, 'to')] },
  { code: 'CWH-I/233', label: 'OFFICE-02', outline: rect(922.5, 10, 1055, 160), grade: 'UTILITY',
    doors: [vDoor(922.5, 107, 152, 'to'), vDoor(1055, 108, 152, 'to', 'EXIT')] },   // the green arc: an exterior door
  { code: 'CWH-I/226', label: 'INSTRUMENTATION ROOM-01', outline: rect(796, 160, 1055, 431.5), instrument: 'CWH/RDU/019-00',
    doors: [vDoor(796, 177, 221, 'from')] },
  { code: 'CWH-I/225', label: 'DISSOLUTION ROOM-I', outline: rect(796, 431.5, 1055, 1024.5), instrument: 'CWH/RDU/021-00',
    doors: [vDoor(796, 524, 567, 'from'), vDoor(796, 833, 876, 'to')] },
  { code: 'CWH-I/224', label: 'SAMPLE STORAGE ROOM', outline: rect(796, 1024.5, 1055, 1161.5), instrument: 'CWH/RDU/013-00',
    doors: [vDoor(796, 1103, 1147, 'to')] },
  // ── Centre: the two L-shaped rooms ─────────────────────────────────────
  // The partition steps from x 365.5 (upper) to x 206 (lower) along y 781.5.
  { code: 'CWH-I/222', label: 'SAMPLE PREPARATION ROOM', instrument: 'CWH/RDU/023-00',
    outline: [[23, 520], [365.5, 520], [365.5, 781.5], [206, 781.5], [206, 1161.5], [23, 1161.5]],
    doors: [hDoor(520, 310, 354, 'to'), hDoor(1161.5, 151, 195, 'to')] },
  { code: 'CWH-I/223', label: 'HPLC ROOM', instrument: 'CWH/RDU/020-00',
    outline: [[365.5, 520], [689, 520], [689, 1161.5], [206, 1161.5], [206, 781.5], [365.5, 781.5]],
    doors: [vDoor(689, 589, 634, 'from'), vDoor(689, 1045, 1092, 'to'), hDoor(1161.5, 310, 354, 'to')] },
  // ── South block ─────────────────────────────────────────────────────────
  { code: 'CWH-I/220', label: 'WASH AREA-02', outline: rect(23, 1266.5, 293, 1426), grade: 'UTILITY',
    doors: [hDoor(1266.5, 236, 279, 'to')] },
  { code: 'CWH-I/219', label: 'GC ROOM', outline: rect(293, 1266.5, 730.5, 1426), instrument: 'CWH/RDU/014-00',
    doors: [hDoor(1266.5, 670, 713, 'to')] },
  { code: 'CWH-I/218', label: 'DISSOLUTION ROOM-II', outline: rect(730.5, 1266.5, 880, 1426), instrument: 'CWH/RDU/024-00',
    doors: [hDoor(1266.5, 743, 786, 'from')] },
  { code: 'CWH-I/216', label: 'CHANGE ROOM', outline: rect(880, 1161.5, 1055, 1426), grade: 'UTILITY',
    doors: [vDoor(880, 1176, 1222, 'from'), vDoor(1055, 1176, 1220, 'from', 'EXIT')] },  // the blue arc: an exterior door
  // ── The corridor: ONE space ─────────────────────────────────────────────
  // Spine x 689-796 from the north wall to y 1161.5; north arm y 413-520 to
  // the west wall; south arm y 1161.5-1266.5 from the west wall to x 880.
  // Two exterior openings on the west wall (the blue "Y" marks).
  { code: 'CWH-I/217', label: 'CORRIDOR-08', grade: 'CIRCULATION',
    outline: [
      [689, 10], [796, 10], [796, 1161.5], [880, 1161.5], [880, 1266.5],
      [23, 1266.5], [23, 1161.5], [689, 1161.5], [689, 520], [23, 520], [23, 413], [689, 413],
    ],
    doors: [vDoor(23, 1184, 1245, 'none', 'EXIT'), vDoor(23, 437, 498, 'none', 'EXIT')] },
];

/** Plan annotations in drawing px. Boxes are [x0, y0, x1, y1]. */
export type Annotations2 = ArchAnnotations;

export const QC2_ANNOTATIONS: Annotations2 = {
  // The orange hatched squares (cyan-framed): four at the corners of HPLC /
  // SAMPLE PREPARATION, two on the east wall, four set into the south wall.
  columns: [
    [248, 519, 298, 571], [630, 519, 690, 578], [1017, 518, 1072, 579],
    [249, 1102, 298, 1153], [630, 1104, 687, 1163], [1017, 1106, 1072, 1163],
    [249, 1417, 292, 1452], [659, 1429, 686, 1452], [830, 1429, 856, 1452], [1026, 1429, 1058, 1452],
  ],
  windows: [
    // Blue vision panels in the partitions.
    [172, 36, 181, 102], [685, 35, 694, 102], [792, 35, 801, 101],
    [279, 313, 288, 381], [684, 313, 694, 381], [792, 313, 801, 381],
    [362, 617, 371, 685], [792, 617, 801, 684],
    [202, 930, 211, 997], [685, 930, 694, 997], [792, 929, 801, 996],
    // Windows in the outer walls (red frame, green jambs), west and east.
    [6, 315, 24, 379], [6, 618, 24, 683], [6, 930, 24, 995],
    [1056, 315, 1073, 379], [1056, 618, 1073, 683], [1056, 931, 1073, 995],
  ],
  walls: [
    [365.5, 781.5, 365.5, 871],   // the half-height stub into HPLC
    [175, 781.5, 206, 781.5],     // the short return into SAMPLE PREPARATION
  ],
};

// ── Conversion to what the schema stores (0..1 against the building) ───────

export const QC2_CANVAS = archCanvas(QC2_BUILDING);

/** A room's outline as normalized points. */
export function points2(room: Room2): { x: number; y: number }[] {
  return archPoints(QC2_BUILDING, room);
}

/** The annotation layer as stored: columns and windows as boxes, stubs as segments. */
export function annotations2() {
  return archAnnotations(QC2_BUILDING, QC2_ANNOTATIONS);
}

/** The plan this floor is drawn ON (2026-10-01, later the same day, operator:
 *  "2d layout was good replace with that QC layout" -> "One plan: CWH — QC"):
 *  the QC area's own plan, replacing its older trace. It was drawn first as a
 *  second plan, `QC2_RETIRED_PLAN_NAME`, which the draw script now deletes. */
export const QC2_PLAN_NAME = 'CWH — QC';
export const QC2_RETIRED_PLAN_NAME = 'CWH — QC Layout-2';
export const QC2_SOURCE = 'Layouts/CWH/QC Layout-2.png';
