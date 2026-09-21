/**
 * The QC 3 floor, TRACED from the architectural drawing
 * `Layouts/CWH/QC 3 Layout.png` (874x895, 2026-09-21).
 *
 * Operator: "do the same for qc 3 and microbiology layouts" — the same as the
 * QC floor: rooms as literal measured coordinates off the drawing, instruments
 * left in the rooms their `Location` attribute names.
 *
 * ─── HOW THE NUMBERS WERE OBTAINED ───────────────────────────────────────
 * Wall runs were scanned (dark and magenta pixel runs, clustered), door
 * openings taken from the orange swing arcs (colour-isolated, labelled), and
 * every edge then read off 2x gridded crops of the drawing. The dimension
 * strings on the drawing were used as the cross-check: at ~0.0228 px/mm every
 * room's written size agrees with its measured box to within a wall.
 *
 * ─── THE BUILDING IS AN L ─────────────────────────────────────────────────
 * Full width (x 22..846) down to y 531, where the HOLD AREA ends; below that
 * the east wall is at x 695 and the space east of it is the `GD ENTRY` yard
 * the drawing dimensions `8100 x 3700`. A plan is a rectangle, so that yard is
 * stored as a UTILITY room with the drawing's own words on it rather than left
 * as a hole (a void reads as a missing room).
 *
 * ─── WHERE THIS IS DELIBERATELY NOT THE DRAWING ──────────────────────────
 *   • CORRIDOR-11 (CWH-I/235) is one space drawn as a ring with two legs; it
 *     is stored as FOUR rectangles (`CWH-I/235`, `(2)`, `(3)`, `(4)`), and the
 *     view draws adjoining CIRCULATION rooms as one space, so no seam shows.
 *   • The HOLD AREA (CWH-I/187) wraps around the WASH AREA at its top; it is
 *     stored as its main box plus a `(2)` piece beside the wash area, and the
 *     13 px sliver west of the wash area is folded into the wash area.
 *   • The structural columns (hatched squares along the walls) are not drawn.
 *   • The `EE` / `GD ENTRY` / `BREAKABLE GLASS` stamps and the plant strip
 *     south of the building are outside it.
 * No annotation layer: the drawing carries no HVAC, water or airflow symbols
 * inside the building, so the plan draws no symbol legend.
 */
import type { TracedLayout, TracedRoom } from './traced-layout.js';

const B = { x0: 22, y0: 6, x1: 846, y1: 786 } as const;

/**
 * Wall grid (px): x ∈ {22, 192, 238, 250, 312, 338, 387, 450, 462, 506, 640,
 * 695, 775, 846}; y ∈ {6, 54, 74, 120, 131, 134, 178, 211, 282, 336, 375,
 * 438, 482, 494, 511, 531, 594, 663, 709, 786}.
 */
const LAB = '#f3f6fc';
const OFFICE = '#fbf7ef';
const CORRIDOR = '#f9fafc';

const ROOMS: TracedRoom[] = [
  // ── West column ────────────────────────────────────────────────────────
  {
    code: 'CWH-I/245', label: 'WORKING STANDARD & REFERENCE STANDARD STORAGE ROOM', px: [22, 6, 192, 134],
    meta: { fill: LAB, fch: '2.5m', dims: '7550 x 5640' }, instrument: 'CWH/RDU/003-00',
    doors: [{ wall: 'right', offset: 0.73, width: 0.2, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/244', label: 'WEIGHING AREA-II', px: [22, 134, 192, 178],
    meta: { fill: LAB, fch: '2.5m', dims: '7600 x 1900' },
    // No arc on the drawing: reached through SAMPLE PREPARATION ROOM-I.
    doors: [],
  },
  {
    code: 'CWH-I/243', label: 'SAMPLE PREPARATION ROOM-I', px: [22, 178, 192, 438],
    meta: { fill: LAB, fch: '2.5m', dims: '7550 x 11600' }, instrument: 'CWH/RDU/010-00',
    doors: [
      { wall: 'right', offset: 0.03, width: 0.09, kind: 'ENTRY' },
      { wall: 'right', offset: 0.88, width: 0.09, kind: 'ENTRY' },
    ],
  },
  {
    code: 'CWH-I/241', label: 'WEIGHING AREA-I', px: [22, 438, 192, 482],
    meta: { fill: LAB, fch: '2.5m', dims: '7600 x 1900' },
    doors: [],
  },
  {
    code: 'CWH-I/240', label: 'SAMPLE RECEIPT & SAMPLE STORAGE ROOM', px: [22, 482, 192, 663],
    meta: { fill: LAB, fch: '2.5m', dims: '7550 x 8120' }, instrument: 'CWH/RDU/026-00',
    doors: [{ wall: 'right', offset: 0.69, width: 0.1, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/234', label: 'CHANGE ROOM', px: [22, 663, 192, 786],
    meta: { fill: OFFICE, fch: '2.5m', dims: '7550 x 5320' }, grade: 'UTILITY',
    doors: [
      { wall: 'right', offset: 0.06, width: 0.15, kind: 'ENTRY' },
      { wall: 'right', offset: 0.83, width: 0.15, kind: 'ENTRY' },
      { wall: 'bottom', offset: 0.04, width: 0.18, kind: 'EXIT' },
    ],
  },

  // ── North row, over the corridor ───────────────────────────────────────
  {
    code: 'CWH-I/246', label: 'LCMS ROOM', px: [192, 6, 250, 74],
    meta: { fill: LAB, fch: '2.5m', dims: '2500 x 2900' }, instrument: 'CWH/RDU/012-00',
    doors: [{ wall: 'bottom', offset: 0.17, width: 0.25, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/247', label: 'UNCLEANED GLASS WARE HOLD ROOM', px: [250, 6, 312, 74],
    meta: { fill: LAB, fch: '2.5m', dims: '2730 x 2900' },
    doors: [{ wall: 'bottom', offset: 0.63, width: 0.23, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/248', label: 'GLASS WARE CLEANING & DRYING ROOM', px: [312, 6, 387, 74],
    meta: { fill: LAB, fch: '2.5m', dims: '3280 x 2900' },
    doors: [{ wall: 'bottom', offset: 0.68, width: 0.21, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/249', label: 'CLEANED GLASS WARE STORAGE ROOM', px: [387, 6, 450, 74],
    meta: { fill: LAB, fch: '2.5m', dims: '2800 x 2900' },
    doors: [{ wall: 'bottom', offset: 0.62, width: 0.23, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/250', label: 'LCMS ROOM-II', px: [450, 6, 506, 74],
    meta: { fill: LAB, fch: '2.5m', dims: '2430 x 2900' }, instrument: 'CWH/RDU/002-01',
    doors: [{ wall: 'bottom', offset: 0.57, width: 0.27, kind: 'ENTRY' }],
  },

  // ── Middle column ──────────────────────────────────────────────────────
  {
    code: 'CWH-I/242', label: 'HPLC ROOM', px: [238, 120, 338, 663],
    meta: { fill: LAB, fch: '2.8m', dims: '4400 x 24250' }, instrument: 'CWH/RDU/011-00',
    doors: [
      { wall: 'left', offset: 0.3, width: 0.04, kind: 'ENTRY' },
      { wall: 'left', offset: 0.66, width: 0.05, kind: 'ENTRY' },
    ],
  },
  {
    code: 'CWH-I/252', label: 'DISSOLUTION & UV ROOM', px: [338, 120, 462, 336],
    meta: { fill: LAB, fch: '2.5m', dims: '5450 x 9500' }, instrument: 'CWH/RDU/006-00',
    doors: [
      { wall: 'right', offset: 0.03, width: 0.13, kind: 'ENTRY' },
      { wall: 'left', offset: 0.64, width: 0.12, kind: 'PASSAGE' },
    ],
  },
  {
    code: 'CWH-I/254', label: 'WEIGHING AREA-III', px: [338, 336, 462, 375],
    meta: { fill: LAB, fch: '2.5m', dims: '5450 x 1900' },
    doors: [],
  },
  {
    code: 'CWH-I/255', label: 'MALVERN/AAS/BET INSTRUMENT ROOM', px: [338, 375, 462, 494],
    meta: { fill: LAB, fch: '2.5m', dims: '5450 x 5280' }, instrument: 'CWH/RDU/007-00',
    doors: [{ wall: 'right', offset: 0.72, width: 0.19, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/256', label: 'GC / GCMS ROOM', px: [338, 494, 462, 663],
    meta: { fill: LAB, fch: '2.5m', dims: '5450 x 7500' }, instrument: 'CWH/RDU/008-00',
    doors: [
      { wall: 'right', offset: 0.86, width: 0.1, kind: 'ENTRY' },
      { wall: 'left', offset: 0.1, width: 0.15, kind: 'PASSAGE' },
    ],
  },
  {
    code: 'CWH-I/236', label: 'OFFICE-01', px: [238, 709, 312, 786],
    meta: { fill: OFFICE, dims: '3350 x 3250' }, grade: 'UTILITY',
    doors: [{ wall: 'top', offset: 0.15, width: 0.19, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/237', label: 'OFFICE-02', px: [312, 709, 387, 786],
    meta: { fill: OFFICE, dims: '3350 x 3250' }, grade: 'UTILITY',
    doors: [
      { wall: 'top', offset: 0.08, width: 0.25, kind: 'ENTRY' },
      { wall: 'bottom', offset: 0.35, width: 0.29, kind: 'EXIT' },
    ],
  },
  {
    code: 'CWH-I/238', label: 'OFFICE-03', px: [387, 709, 462, 786],
    meta: { fill: OFFICE, dims: '3350 x 3250' }, grade: 'UTILITY',
    doors: [{ wall: 'top', offset: 0.07, width: 0.24, kind: 'ENTRY' }],
  },

  // ── East column ────────────────────────────────────────────────────────
  {
    code: 'CWH-I/251', label: 'TRAINING/MEETING ROOM', px: [506, 6, 695, 131],
    meta: { fill: OFFICE, fch: '2.5m', dims: '8400 x 5520' }, grade: 'UTILITY',
    doors: [{ wall: 'left', offset: 0.78, width: 0.19, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/253', label: 'REVIEWERs ROOM', px: [506, 131, 695, 211],
    meta: { fill: OFFICE, fch: '2.5m', dims: '8400 x 3500' }, grade: 'UTILITY',
    doors: [{ wall: 'left', offset: 0.08, width: 0.3, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/258', label: 'HOTZONE ROOM (FUME HOOD)', px: [506, 211, 695, 282],
    meta: { fill: LAB, fch: '2.7m', dims: '8400 x 3120' },
    doors: [{ wall: 'left', offset: 0.65, width: 0.35, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/257', label: 'WET LAB', px: [506, 282, 695, 511],
    meta: { fill: LAB, fch: '2.5m', dims: '8400 x 10200' }, instrument: 'CWH/RDU/009-00',
    doors: [
      { wall: 'left', offset: 0.03, width: 0.13, kind: 'ENTRY' },
      { wall: 'left', offset: 0.86, width: 0.06, kind: 'ENTRY' },
    ],
  },
  {
    code: 'CWH-I/260', label: 'KF/AUTO TITRATOR ROOM', px: [506, 511, 640, 594],
    meta: { fill: LAB, fch: '2.5m', dims: '5950 x 3650' }, instrument: 'CWH/RDU/005-00',
    doors: [
      { wall: 'left', offset: 0, width: 0.27, kind: 'ENTRY' },
      { wall: 'right', offset: 0, width: 0.25, kind: 'PASSAGE' },
    ],
  },
  {
    code: 'CWH-I/259', label: 'AIRLOCK', px: [640, 511, 695, 594],
    meta: { fill: CORRIDOR, fch: '2.5m', dims: '2170 x 3650' }, grade: 'UTILITY',
    doors: [{ wall: 'right', offset: 0, width: 0.25, kind: 'EXIT' }],
  },
  {
    code: 'CWH-I/261', label: 'SIEVE ANALYZER & BD APPARATUS ROOM', px: [506, 594, 695, 663],
    meta: { fill: LAB, fch: '2.5m', dims: '8300 x 3050' }, instrument: 'CWH/RDU/004-00',
    doors: [{ wall: 'left', offset: 0.67, width: 0.23, kind: 'ENTRY' }],
  },
  {
    code: 'CWH-I/239', label: 'OFFICE-04', px: [506, 663, 695, 786],
    meta: { fill: OFFICE, fch: '2.5m', dims: '8300 x 5430' }, grade: 'UTILITY',
    doors: [
      { wall: 'left', offset: 0.1, width: 0.1, kind: 'ENTRY' },
      { wall: 'left', offset: 0.8, width: 0.2, kind: 'ENTRY' },
      { wall: 'bottom', offset: 0.89, width: 0.11, kind: 'EXIT' },
    ],
  },

  // ── East band ──────────────────────────────────────────────────────────
  {
    code: 'CWH-I/188', label: 'WASH AREA', px: [695, 6, 775, 54],
    meta: { fill: OFFICE, fch: '2.5m', dims: '3600 x 2000' }, grade: 'UTILITY', doors: [],
  },
  {
    code: 'CWH-I/187 (2)', label: 'HOLD AREA', px: [775, 6, 846, 54],
    meta: { fill: '#fdf1fa' }, grade: 'UTILITY', doors: [],
  },
  {
    code: 'CWH-I/187', label: 'HOLD AREA', px: [695, 54, 846, 531],
    meta: { fill: '#fdf1fa', fch: '2.5m', dims: '6450 x 21100' }, grade: 'UTILITY', doors: [],
  },
  // Outside the east wall below the hold area — see the header.
  {
    code: 'GD ENTRY', label: null, px: [695, 531, 846, 786],
    meta: { fill: '#f8fafc', dims: '8100 x 3700' }, grade: 'UTILITY', doors: [],
  },

  // ── CORRIDOR-11: one space, four rectangles ────────────────────────────
  {
    code: 'CWH-I/235', label: 'CORRIDOR-11', px: [192, 74, 506, 120],
    meta: { fill: CORRIDOR, fch: '2.5m', dims: '10000 x 2000' }, grade: 'CIRCULATION', doors: [],
  },
  {
    code: 'CWH-I/235 (2)', label: 'CORRIDOR-11', px: [192, 120, 238, 786],
    meta: { fill: CORRIDOR, fch: '2.5m', dims: '2000 x 31750' }, grade: 'CIRCULATION',
    doors: [{ wall: 'bottom', offset: 0.1, width: 0.8, kind: 'EXIT' }],
  },
  {
    code: 'CWH-I/235 (3)', label: 'CORRIDOR-11', px: [462, 120, 506, 786],
    meta: { fill: CORRIDOR, fch: '2.5m', dims: '2000 x 31750' }, grade: 'CIRCULATION',
    // `CWH-I/143 CORRIDOR-1` continues south of this exit.
    doors: [{ wall: 'bottom', offset: 0.1, width: 0.8, kind: 'EXIT' }],
  },
  {
    code: 'CWH-I/235 (4)', label: 'CORRIDOR-11', px: [238, 663, 462, 709],
    meta: { fill: CORRIDOR, fch: '2.5m', dims: '10000 x 2000' }, grade: 'CIRCULATION', doors: [],
  },
];

export const QC3_LAYOUT: TracedLayout = {
  area: 'QC 3',
  source: 'Layouts/CWH/QC 3 Layout.png',
  building: B,
  rooms: ROOMS,
  annotations: null,
};
