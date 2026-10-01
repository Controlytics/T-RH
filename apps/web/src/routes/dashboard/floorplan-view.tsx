import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useSensorWords } from '@/hooks/use-failure-text';
import { Link, useNavigate } from 'react-router-dom';
import {
  worstStatus,
  formatDecimals,
  rectanglePoints,
  largestInscribedRect,
  inscribedRects,
  mirrorOpening,
  centroid,
  type InstrumentStatus,
  type Polygon,
  type EdgeOpening,
} from '@digilog/shared';
import { statusClasses } from './status';
import { outOfSpec, NOT_AVAILABLE } from './set-point';
import {
  useFloorplans,
  useTelemetryOverview,
  formatSlot,
  ROOM_GRADES,
  ROOM_GRADE_META,
  type RoomGrade,
  type FloorplanRoomShape,
  type FloorplanLinkShape,
  type OverviewRow,
} from './use-telemetry';
import {
  polygonWalls, polygonDoorPlacements, polygonSharedOpenings, doorToEdgeOpening, tileLayout,
  CHIP_HEIGHT_FACTOR, CHIP_GAP, FULL_CODE_GAP, VALUES_TOP_GAP,
  CODE_LINE_H, TILE_CODE_FONT, LOCATION_LINE_H, TILE_LOCATION_FONT, TILE_HEADER_H, avoidDoorSwings, avoidObstacles, placeCard, placeRoomName, NAME_LINE, swingSquare, MAX_TILE_FONT,
  type PixelBox,
} from './room-geometry';

/**
 * The base code of a continuation piece — `CWH-I/217 (2)` → `CWH-I/217` —
 * upper-cased for comparison, or null when the code carries no ` (N)` suffix.
 * The suffix is the drawing script's own convention for a corridor stored as
 * more than one rectangle (`SERVICE CORRIDOR (2)`, the QC `CWH-I/217 (2)`).
 */
/**
 * THE DRAWN FLOOR FITS ITS ROOMS (operator, 2026-09-22: "empty space is
 * showing more below the rooms, if there no gap below the rooms in last line
 * then dont give space, layout should be auto adjust"; then "below the rooms
 * and below border line there is so much gap … border line should auto
 * adjust"). The viewBox used to be the plan's whole canvas, so a plan whose
 * rooms stop at 60 % of the height drew a blank band under them. This is the
 * extent the view shows instead: the bounding box of the DRAWN rooms (a scoped
 * view fits the rooms it shows) plus a small margin so a wall on the edge is
 * not clipped. Plan units 0..1; never wider than the canvas. No rooms = the
 * whole canvas, as before.
 *
 * SLIVERS DO NOT SET THE EXTENT. A room thinner than `SLIVER` in either axis
 * (QC's SHAFT-E is a 0.9 %-wide service strip running the full height) is a
 * line on the drawing, not a space the reader looks for, and letting it pin
 * the border to the canvas edge is exactly the blank band the operator saw
 * after moving every real room up. It is still DRAWN; the part past the
 * border is clipped. A plan of nothing but slivers keeps them.
 *
 * The annotation layer no longer takes part: it is not drawn on the dashboard
 * since the same day ("other symbols remove those").
 */
export const SLIVER = 0.015;

export function planExtent(
  rooms: Pick<FloorplanRoomShape, 'x' | 'y' | 'w' | 'h' | 'points'>[],
  margin = 0.01,
  /** Columns and windows (2026-10-01): they sit IN the outer walls, outside
   *  every room, and a frame fitted to the rooms alone would cut them off. */
  extra: { x: number; y: number; w: number; h: number }[] = [],
): { x: number; y: number; w: number; h: number } {
  const real = rooms.filter((r) => r.w >= SLIVER && r.h >= SLIVER);
  const use = real.length ? real : rooms;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of use) {
    for (const p of r.points ?? rectanglePoints({ x: r.x, y: r.y, w: r.w, h: r.h })) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  if (Number.isFinite(minX)) {
    for (const b of extra) {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1 };
  // The MARGIN stops at the canvas; what is drawn never does. In full screen a
  // plan is re-proportioned (`fillHeight`) and an outward door's swing, which
  // keeps its size while the canvas gets shorter, can reach past the canvas
  // edge — clamped there, QC 3's two exits were cut off at the bottom.
  const x = Math.min(minX, Math.max(0, minX - margin)), y = Math.min(minY, Math.max(0, minY - margin));
  const x2 = Math.max(maxX, Math.min(1, maxX + margin)), y2 = Math.max(maxY, Math.min(1, maxY + margin));
  return { x, y, w: Math.max(0.05, x2 - x), h: Math.max(0.05, y2 - y) };
}

/**
 * The viewBox HEIGHT at which a plan exactly fills a box `box` px in size — a
 * plan is always 1000 units wide, so its height is what sets its proportions.
 *
 * FULL SCREEN draws a plan to the SCREEN's proportions, not the drawing's
 * (operator, 2026-10-01: "when i opened microbiology layout in full screen its
 * exactly filt to full screen but, QC 3 and QC layouts only there is center of
 * the screen not adjusted to full screen"). Microbiology is 2.2 wide to tall
 * and a screen is about 1.9, so it nearly filled one as drawn; QC 3 is 1.02
 * and QC 0.74, and at the drawing's proportions they stood in the middle with
 * half the screen empty either side.
 *
 * It is the ROOMS that are re-proportioned, never the type: every wall, door
 * and column is laid out again in the stretched frame and every card, name and
 * arc is then drawn in it at its own shape, so nothing is squashed. Each room
 * touches the same neighbours through the same doors; what no longer holds, in
 * full screen only, is the drawing's scale between width and height. In its
 * panel a plan keeps the drawing's proportions.
 *
 * `extentAt(h)` is the plan's drawn extent (fractions of the canvas) at a
 * given height — it depends on the height only through an outward door's
 * swing, so a few rounds settle it. No box yet (the first frame, or a test
 * without layout) = the drawing's own height.
 */
export function fillHeight(
  naturalVbH: number,
  extentAt: (vbH: number) => { w: number; h: number },
  box: { w: number; h: number } | null,
): number {
  if (!box || !(box.w > 0) || !(box.h > 0)) return naturalVbH;
  let vbH = naturalVbH;
  for (let i = 0; i < 4; i++) {
    const e = extentAt(vbH);
    vbH = (e.w * VB_W * box.h) / (box.w * e.h);
  }
  return vbH;
}

/**
 * The outline a room draws, in viewBox units: its polygon when it has one
 * (Layout Designer, 2026-09-22), else its box as four corners. The ONE place
 * the rectangle-or-polygon question is answered on the dashboard.
 */
export function roomOutline(
  room: Pick<FloorplanRoomShape, 'x' | 'y' | 'w' | 'h' | 'points'>,
  vbW: number,
  vbH: number,
): Polygon {
  const pts = room.points ?? rectanglePoints({ x: room.x, y: room.y, w: room.w, h: room.h });
  return pts.map((p) => ({ x: p.x * vbW, y: p.y * vbH }));
}

/**
 * The link OPENINGS that land on THIS room's edges: its own as stored, and a
 * neighbour's mirrored onto the edge the two share. Only rooms actually DRAWN
 * count — in a scoped view an opening onto a hidden room would open a wall
 * onto nothing. Connectors add no opening.
 */
export function roomOpenings(
  room: FloorplanRoomShape,
  links: FloorplanLinkShape[],
  drawn: { room: FloorplanRoomShape }[],
  vbW: number,
  vbH: number,
): EdgeOpening[] {
  const out: EdgeOpening[] = [];
  for (const l of links) {
    if (l.kind !== 'OPENING' || l.fromEdge == null || l.offset == null || l.width == null) continue;
    if (l.fromRoomId === room.id) {
      if (drawn.some((d) => d.room.id === l.toRoomId)) out.push({ edge: l.fromEdge, offset: l.offset, width: l.width });
    } else if (l.toRoomId === room.id) {
      const from = drawn.find((d) => d.room.id === l.fromRoomId)?.room;
      if (!from) continue;
      const m = mirrorOpening(
        roomOutline(from, vbW, vbH),
        { edge: l.fromEdge, offset: l.offset, width: l.width },
        roomOutline(room, vbW, vbH),
        0.5,
      );
      if (m) out.push(m);
    }
  }
  return out;
}

/**
 * The DOORS of the rooms around this one, mirrored onto the edge this room
 * shares with each (2026-10-01). A door is stored once, on the room it opens
 * into, but every room strokes its own walls — so without this the room on the
 * other side draws a solid wall straight across the gap and the door
 * disappears. Only drawn rooms count; the leaf and swing stay with the owner.
 */
export function neighbourDoorOpenings(
  room: FloorplanRoomShape,
  drawn: { room: FloorplanRoomShape }[],
  vbW: number,
  vbH: number,
): EdgeOpening[] {
  const mine = roomOutline(room, vbW, vbH);
  const out: EdgeOpening[] = [];
  for (const { room: o } of drawn) {
    if (o.id === room.id || !o.doors?.length) continue;
    const theirs = roomOutline(o, vbW, vbH);
    for (const d of o.doors) {
      const opening = doorToEdgeOpening(d, o.points ?? null);
      if (!opening) continue;
      const m = mirrorOpening(theirs, opening, mine, 0.5);
      if (m) out.push(m);
    }
  }
  return out;
}

/**
 * Which rooms a plan draws (2026-10-01). Unscoped: all of them. Scoped to a
 * location: the WHOLE plan when any room shows one of its instruments (the
 * plan is that floor), nothing when none does — the view then says no
 * instrument of this location is placed on the plan.
 */
export function roomsToDraw<T extends { rows: unknown[] }>(all: T[], scoped: boolean): T[] {
  if (!scoped) return all;
  return all.some((r) => r.rows.length > 0) ? all : [];
}

export function continuationBase(code: string): string | null {
  const m = /^(.+) \(\d+\)$/.exec(code.trim());
  return m ? m[1].toUpperCase() : null;
}

/**
 * Whether two rooms are ONE space the schema had to store as two rectangles:
 * both circulation (a corridor and its legs), or pieces of one code
 * (`X` and `X (2)`, or `X (2)` and `X (3)`). The view draws no wall along
 * the seam between such a pair.
 */
export function sameSpace(
  a: { code: string; grade: string | null },
  b: { code: string; grade: string | null },
): boolean {
  if (a.grade === 'CIRCULATION' && b.grade === 'CIRCULATION') return true;
  const baseA = continuationBase(a.code) ?? a.code.trim().toUpperCase();
  const baseB = continuationBase(b.code) ?? b.code.trim().toUpperCase();
  return baseA === baseB;
}
import { Button } from '@/components/ui/button';

/**
 * The floor, DRAWN.
 *
 * This does NOT render the uploaded plan image. Showing the scan with
 * transparent hotspots over it reads as a photo with rectangles stuck on top:
 * the rooms are invisible until hovered, and the drawing's own ink competes with
 * the status colours it is supposed to be carrying. The image is a tracing guide
 * in the editor only.
 *
 * Rooms are stored as proportions (0..1), so they map straight onto an SVG
 * viewBox — the layout is resolution-independent and stays crisp at any zoom.
 *
 * A value chip prints the READING WITH ITS UNIT and nothing else — "21.5 °C",
 * "45 %RH" — and its COLOUR carries the state (operator, 2026-09-22: "just
 * show value with units"). Until then each chip also carried a glyph (▲ ◷ ◑ ·)
 * so that colour never stood alone; the operator chose the bare value, and
 * the consequence is stated once here: on the floor, status is now colour
 * alone, named by the legend under the plan. The room's own state word
 * survives in the tile's aria-label, and the readings table still pairs
 * colour with a word.
 */

/** viewBox width. Height follows the plan's aspect ratio. */
const VB_W = 1000;

/**
 * ARCHITECTURAL DRAWING (operator reference `graphical.png`, 2026-08-13;
 * restyled to docs/superpowers/specs/2026-08-24-graphical-view-visual-design.md).
 *
 * Rooms are drawn with dark walls, like a plan. STATUS colour lives in the value
 * CHIPS and nowhere else on the drawing: a floor tinted BY STATUS cannot show two
 * readings disagreeing — one room, one colour — whereas a green temperature chip
 * beside a red humidity chip says exactly what is wrong. The room fill carries a
 * different reading entirely (cleanroom grade, see ZONE below) at a chroma low
 * enough that it can never be mistaken for an alarm.
 *
 * Chip colours are SEMANTIC and deliberately not theme colours: a site that
 * themes the app purple must not end up with a purple "out of spec".
 *
 * FOUR colours, one per condition (operator, 2026-09-22: "if in limits green
 * color, if its crossed or below the limits show red, if error highlight with
 * other color, if offline also show with other color"): green = in limit,
 * red = a limit crossed, VIOLET = the probe itself has failed or saturated
 * (the administered `Error` / `OL` word), amber = offline (the reading is old)
 * or partial. Until that day a failed probe painted the same red as a breach,
 * so a dead sensor and a real excursion were one colour, and a dead sensor is
 * a THIRD thing: not a breach (nothing was measured) and not a silence (the
 * logger is still talking). `ERROR` is a chip tone, not an `InstrumentStatus`:
 * the server reports it as `sensorError` / `rangeError` beside a null slot,
 * and nothing here re-derives it.
 */
export type ChipTone = InstrumentStatus | 'ERROR';
const CHIP: Record<ChipTone, { bg: string }> = {
  OUT_OF_SPEC: { bg: '#dc2626' },
  ERROR: { bg: '#7c3aed' },
  STALE: { bg: '#d97706' },
  PARTIAL: { bg: '#d97706' },
  NO_DATA: { bg: '#64748b' },
  OK: { bg: '#15803d' },
};

/**
 * The legend's order and wording: in limit, then the three faults, then the
 * two "cannot say". `sample` is what a chip of that tone actually prints, so
 * the legend shows the reader the very thing they will see on the floor.
 */
const LEGEND: readonly { tone: ChipTone; label: string; sample: string }[] = [
  { tone: 'OK', label: statusClasses('OK').label, sample: '21.7 °C' },
  { tone: 'OUT_OF_SPEC', label: statusClasses('OUT_OF_SPEC').label, sample: '28.4 °C' },
  { tone: 'ERROR', label: 'Sensor error', sample: 'Error' },
  { tone: 'STALE', label: statusClasses('STALE').label, sample: '21.7 °C' },
  { tone: 'PARTIAL', label: statusClasses('PARTIAL').label, sample: '21.7 °C' },
  { tone: 'NO_DATA', label: statusClasses('NO_DATA').label, sample: NOT_AVAILABLE },
];

/**
 * The two value chips an instrument tile prints, each with its tone. Pure and
 * exported so the colour rule above is pinned by a test rather than by eye.
 *
 * A failed or saturated probe gets a chip of its own rather than being
 * omitted: a room whose probe has died must not look like a room with nothing
 * in it. A slot the server judged out of limit is red whatever the instrument's
 * overall status; a slot inside its limits on an instrument that is OUT_OF_SPEC
 * (because the OTHER slot breached) is green, not red. One chip per reading is
 * the whole reason status lives on the chips and not on the room.
 *
 * A slot with NO reading prints `NA` in grey (NO_DATA), the word the readings
 * table uses for the same fact — so a tile ALWAYS has its two rows (operator,
 * 2026-09-22: "below the instrument ID temperature and humidity data was not
 * showing"; on that day 98 of 100 instruments had never reported, and their
 * tiles printed the code over nothing, which reads as a broken tile rather
 * than as a silent instrument).
 */
export function tileValues(
  row: Pick<OverviewRow, 'temperature' | 'humidity' | 'limits' | 'status' | 'decimals' | 'sensorError' | 'rangeError'>,
  words: { failure: string; outOfRange: string },
): { text: string; st: ChipTone; bad: boolean }[] {
  const tempV = row.temperature?.value ?? null;
  const rhV = row.humidity?.value ?? null;
  const lim = row.limits;
  const tempBad = outOfSpec(tempV, lim?.tempMin, lim?.tempMax);
  const rhBad = outOfSpec(rhV, lim?.rhMin, lim?.rhMax);
  const toneFor = (bad: boolean): ChipTone =>
    bad ? 'OUT_OF_SPEC' : row.status === 'OUT_OF_SPEC' ? 'OK' : row.status;

  const values: { text: string; st: ChipTone; bad: boolean }[] = [];
  if (row.rangeError?.temperature) {
    values.push({ text: words.outOfRange, st: 'ERROR', bad: false });
  } else if (row.sensorError?.temperature) {
    values.push({ text: words.failure, st: 'ERROR', bad: false });
  } else if (tempV !== null) {
    values.push({ text: formatSlot(row.temperature, row.decimals.temperature, '°C'), st: toneFor(tempBad), bad: tempBad });
  } else {
    values.push({ text: NOT_AVAILABLE, st: 'NO_DATA', bad: false });
  }
  if (row.rangeError?.humidity) {
    values.push({ text: words.outOfRange, st: 'ERROR', bad: false });
  } else if (row.sensorError?.humidity) {
    values.push({ text: words.failure, st: 'ERROR', bad: false });
  } else if (rhV !== null) {
    values.push({ text: formatSlot(row.humidity, row.decimals.humidity, '%RH'), st: toneFor(rhBad), bad: rhBad });
  } else {
    values.push({ text: NOT_AVAILABLE, st: 'NO_DATA', bad: false });
  }
  return values;
}

/**
 * THE 2D ARCHITECTURAL STYLE (2026-10-01, operator: "2d layout was good
 * replace with that QC layout", choosing concept A of three —
 * `Layouts/CWH/concepts/concept-a-2d.png`). A plan opts in through
 * `annotations.style = 'architectural'` ("CWH — QC", and "CWH — QC
 * Microbiology" since later the same day: "same like qc"); every other
 * plan draws exactly as before.
 *
 * What it changes, and the one rule it reverses: the ROOM FLOOR is tinted by
 * the room's status here (a wash, not the chip colour), because that is the
 * design chosen. A room with two readings that disagree still shows both on
 * its card, so nothing is hidden by the wash. Walls are drawn double, doors
 * as a dark leaf with a dashed swing, and each instrument is a CARD (header
 * band with its ID, its Location, both readings) rather than chips.
 *
 * THE LOOK IS "VIVID STATUS" since 2026-10-01 (operator: "these layouts look
 * wise not good, make those layout more professional and beautiful and
 * colorful ui"; shown three concept images — `Layouts/CWH/concepts/look-*.png`
 * — and chose A). What that is, all of it paint and none of it geometry:
 *   - the room floor is a GRADIENT of its status colour (`wash` → `washTo`),
 *     an empty room a cool blue-white, a corridor a warm cream; the plate under
 *     the building is plain white — the grid went;
 *   - walls are navy with a light-blue core; a partition stub is drawn the same
 *     way (it was one solid dark line, heavier than the walls beside it);
 *   - a card's header band is a gradient of its tone, and each reading sits in
 *     a PILL: see `readingPill`;
 *   - room names are darker and semi-bold.
 * Status keeps its four colours and its words; nothing here re-derives it.
 */
export const ARCH = {
  wallOuter: '#1e3a5f',
  wallInner: '#bfdbfe',
  doorLeaf: '#1e3a5f',
  doorSwing: '#2563eb',
  ground: '#ffffff',
  columnFill: '#e2e8f0',
  columnInk: '#64748b',
  windowFill: '#bae6fd',
  windowInk: '#0284c7',
  roomName: '#1e293b',
  roomCode: '#64748b',
  /** Floor washes per tone: the top of the gradient (and the legend's swatch)... */
  wash: {
    OK: '#f0fdf4', OUT_OF_SPEC: '#fef2f2', ERROR: '#f5f3ff', STALE: '#fffbeb', PARTIAL: '#fffbeb', NO_DATA: '#f8fafc',
  } as Record<ChipTone, string>,
  /** ...and the bottom of it. */
  washTo: {
    OK: '#d1fae5', OUT_OF_SPEC: '#fecaca', ERROR: '#ddd6fe', STALE: '#fde68a', PARTIAL: '#fde68a', NO_DATA: '#e2e8f0',
  } as Record<ChipTone, string>,
  /** A room with no instrument, top and bottom; and a corridor. */
  emptyWash: '#f8fbff',
  emptyWashTo: '#e8f1fb',
  corridor: '#fff7e6',
  /** The lighter end of a card's header band, per tone; the darker end is the chip colour. */
  bandFrom: {
    OK: '#22c55e', OUT_OF_SPEC: '#f87171', ERROR: '#a78bfa', STALE: '#fbbf24', PARTIAL: '#fbbf24', NO_DATA: '#cbd5e1',
  } as Record<ChipTone, string>,
  /** An IN-LIMIT reading's pill: the quantity's own tint. */
  pill: {
    temperature: { bg: '#ffedd5', ink: '#9a3412' },
    humidity: { bg: '#dbeafe', ink: '#1e40af' },
  },
} as const;

/**
 * The pill a reading sits in on a card, and its ink.
 *
 * IN LIMIT, the pill is a soft tint of the QUANTITY — orange for temperature,
 * blue for humidity — with dark ink of the same hue: the two readings can be
 * told apart at a glance without their units. ANYTHING ELSE (out of limit, a
 * sensor error, offline, no reading) the pill is SOLID in the status colour
 * with white ink, so a state can never be mistaken for a quantity's tint —
 * an offline amber beside an in-limit temperature's orange is the pair that
 * would otherwise read alike.
 */
export function readingPill(st: ChipTone, quantity: 'temperature' | 'humidity'): { bg: string; ink: string; solid: boolean } {
  if (st === 'OK') return { ...ARCH.pill[quantity], solid: false };
  return { bg: CHIP[st].bg, ink: '#ffffff', solid: true };
}

/** The canvas width the 2D style's line weights were drawn for ("CWH — QC"). */
export const ARCH_REF_CANVAS_W = 1069;
/**
 * A plan at least this many times as wide as it is tall has its legend UNDER
 * it; only a plan clearly taller than wide (QC, 0.74) keeps the panel beside
 * it. It was 1.5 — landscape plans only — until the operator asked for the
 * legend under QC 3, which is nearly square (1.02): "give legend on below the
 * layout".
 */
export const LEGEND_UNDER_RATIO = 0.9;

/** Worst first: what a card's band and a room's wash show when readings differ. */
const TONE_ORDER: readonly ChipTone[] = ['OUT_OF_SPEC', 'ERROR', 'STALE', 'PARTIAL', 'NO_DATA', 'OK'];

/**
 * One instrument's tone on a card: its worst reading (a breach, then a failed
 * probe), else the server's status for the instrument. Nothing is re-derived:
 * the per-reading tones are `tileValues`', the rest is `row.status`.
 */
export function cardTone(
  row: Parameters<typeof tileValues>[0],
  words: { failure: string; outOfRange: string },
): ChipTone {
  const sts = tileValues(row, words).map((v) => v.st);
  if (sts.includes('OUT_OF_SPEC') || row.status === 'OUT_OF_SPEC') return 'OUT_OF_SPEC';
  if (sts.includes('ERROR')) return 'ERROR';
  return row.status;
}

/** A room's tone: the worst of its instruments', or null for a room with none. */
export function roomTone(
  rows: Parameters<typeof tileValues>[0][],
  words: { failure: string; outOfRange: string },
): ChipTone | null {
  if (!rows.length) return null;
  const tones = rows.map((r) => cardTone(r, words));
  return TONE_ORDER.find((t) => tones.includes(t)) ?? 'OK';
}

/** The side panel's counts — one bucket per instrument, so they sum. */
export function archSummary(
  rows: Parameters<typeof tileValues>[0][],
  words: { failure: string; outOfRange: string },
): { total: number; ok: number; outOfLimit: number; fault: number; other: number } {
  const out = { total: rows.length, ok: 0, outOfLimit: 0, fault: 0, other: 0 };
  for (const r of rows) {
    const t = cardTone(r, words);
    if (t === 'OK') out.ok += 1;
    else if (t === 'OUT_OF_SPEC') out.outOfLimit += 1;
    else if (t === 'ERROR') out.fault += 1;
    else out.other += 1;
  }
  return out;
}

/** The portrait card's height at scale 1 — the band `avoidDoorSwings` keeps clear
 *  in a room the tile grid lays out (see `CARD_SHAPES` for the full geometry). */
const CARD_H = 104;
/** The extra height a card takes when its Location wraps to a second line —
 *  each shape's `line`; this is the design cards'. */
const CARD_LINE = 15;

/**
 * A card's Location, on ONE line or TWO (2026-10-01, operator: "cwh/rdu/018-00
 * instrument location name is large its not visible increase the font" — its
 * Location is "Sieving& Sample destruction chamber room(QC)", 44 characters,
 * which on one line in a small room printed at about 5px). Longer than
 * `max` characters, it breaks at the space nearest its middle, so the font is
 * sized by the longer HALF; a label with no space stays on one line.
 *
 * An opening bracket is a break point too (Microbiology, same day:
 * "LAF-1(Microbiology)" has no space at all, and in a narrow room it has to
 * wrap) — the bracket starts the second line. A space still wins when it is
 * nearer the middle.
 */
export function splitLabel(text: string, max = 20): string[] {
  const t = text.trim();
  if (t.length <= max) return [t];
  const mid = t.length / 2;
  let best = -1;
  for (let i = 1; i < t.length; i++) {
    const breaks = t[i] === ' ' || (t[i] === '(' && t[i - 1] !== ' ');
    if (breaks && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  if (best < 0) return [t];
  const two = [t.slice(0, best).trim(), t.slice(t[best] === ' ' ? best + 1 : best).trim()];
  // THREE lines for a Location so long that its halves are still half as long
  // again as the card wraps at (QC 3, CWH/RDU/003-00: "Working standard &
  // reference Standard storage Room (or) stability Room", 68 characters — in
  // two lines it printed at 7.9 units). A label two lines serve keeps two.
  if (Math.max(two[0].length, two[1].length) <= max * 1.5) return two;
  const words = t.split(/\s+/);
  let three = two, longest = Math.max(two[0].length, two[1].length);
  for (let a = 1; a < words.length - 1; a++) {
    for (let b = a + 1; b < words.length; b++) {
      const lines = [words.slice(0, a).join(' '), words.slice(a, b).join(' '), words.slice(b).join(' ')];
      const len = Math.max(...lines.map((l) => l.length));
      if (len < longest) { longest = len; three = lines; }
    }
  }
  return three;
}

/**
 * The card SHAPES, at scale 1. `std` is the concept's portrait card; `wide` is
 * a landscape card with no TEMP / HUMIDITY captions, for a SHORT room where
 * the portrait card would have to shrink to clear a door swing (SAMPLE
 * DESTRUCTION ROOM: its Location printed at ~5px). A one-instrument room tries
 * both and keeps whichever prints the Location LARGER.
 *
 * `tall` and `compact` are for the rooms where NEITHER does (Microbiology,
 * 2026-10-01: the three LAF / BSC rooms are ~100 units wide and the WATER WET
 * ANALYSIS room has a door swing in one corner and a column in the other —
 * their Locations printed at about 6 units, the size the operator had already
 * called "not visible" on QC). `tall` is a narrow card with the two readings
 * STACKED; `compact` is the wide card with less air in it. They are tried only
 * when the first two print the Location under `LEGIBLE_LOC_FONT`, so a room
 * the design's own card serves keeps it — every QC card is unchanged.
 *
 * `mini` is for a room too NARROW for the instrument ID (QC 3, same day,
 * operator: "rooms are very small at top" — the two LCMS rooms are 65 units
 * wide, as drawn, and "CWH/RDU/012-00" on one line needs about 80 at a legible
 * size; every other shape printed it under 5 units). It prints the ID on TWO
 * lines, broken after its last slash (`idLines`, `splitCode`), which is what
 * lets it print at nearly twice the size in the same room.
 *
 * It is drawn at the OTHER cards' type sizes (it was 60 x 55 with a 9.5-unit
 * ID, the size that fitted those rooms as drawn). A card is scaled DOWN to its
 * room, never up, so at that size it could not grow when the rooms did: QC 3's
 * north row is drawn larger since the operator's "rooms are very small and
 * those data was showing very small", and there it now prints the ID at 13
 * units where the one-line `tall` card prints 8. In a room as small as before
 * it prints what it did. It is tried LAST, and only when `tall` / `compact`
 * still leave a heading under `LEGIBLE_LOC_FONT` — otherwise its two-line ID
 * would take over rooms those serve (Microbiology's LAF rooms).
 *
 * `wrap` is how long a Location may be before it takes two lines and `line`
 * the height each extra line adds; `val2Y` is the second reading's baseline on
 * a stacked card; `idPitch` the second ID line's drop.
 */
export const CARD_SHAPES = {
  std: { w: 196, h: 104, band: 26, idY: 19, idFont: 15.5, idLines: 1, idPitch: 0, locY: 46, locFont: 14, line: CARD_LINE, valY: 78, val2Y: 0, valFont: 20, capY: 95, wrap: 20, captions: true, stack: false },
  wide: { w: 280, h: 76, band: 24, idY: 17, idFont: 15.5, idLines: 1, idPitch: 0, locY: 43, locFont: 14, line: CARD_LINE, valY: 68, val2Y: 0, valFont: 20, capY: 0, wrap: 30, captions: false, stack: false },
  tall: { w: 124, h: 102, band: 24, idY: 17, idFont: 14, idLines: 1, idPitch: 0, locY: 42, locFont: 14, line: CARD_LINE, valY: 69, val2Y: 93, valFont: 20, capY: 0, wrap: 14, captions: false, stack: true },
  compact: { w: 170, h: 62, band: 20, idY: 14.5, idFont: 13, idLines: 1, idPitch: 0, locY: 35, locFont: 13, line: CARD_LINE, valY: 54.5, val2Y: 0, valFont: 17, capY: 0, wrap: 26, captions: false, stack: false },
  mini: { w: 120, h: 112, band: 44, idY: 18.5, idFont: 19, idLines: 2, idPitch: 20, locY: 60.5, locFont: 15, line: 17, valY: 82, val2Y: 104, valFont: 19, capY: 0, wrap: 12, captions: false, stack: true },
} as const;
export type CardShape = keyof typeof CARD_SHAPES;
/** A reading's pill, in units of the reading's font: how far it starts above
 *  the baseline, and how tall it is. Two stacked pills need `val2Y - valY` to
 *  be more than the height — every stacked shape's is. */
export const PILL_ABOVE = 0.84;
export const PILL_HEIGHT = 1.1;
/** The design's shapes, tried first; the small-room shapes, tried only when
 *  those print a heading under `LEGIBLE_LOC_FONT`; and the narrow-room shape,
 *  tried only when the small-room ones still do. */
export const DESIGN_SHAPES = ['std', 'wide'] as const satisfies readonly CardShape[];
export const SMALL_ROOM_SHAPES = ['tall', 'compact'] as const satisfies readonly CardShape[];
export const NARROW_ROOM_SHAPES = ['mini'] as const satisfies readonly CardShape[];

/**
 * An instrument ID on `lines` lines: one, or two broken AFTER its last slash
 * ("CWH/RDU/" over "012-00"). An ID with no slash to break at stays on one.
 */
export function splitCode(code: string, lines: number): string[] {
  const at = code.lastIndexOf('/');
  if (lines < 2 || at <= 0 || at >= code.length - 1) return [code];
  return [code.slice(0, at + 1), code.slice(at + 1)];
}
/** Under this many units a Location is hard to read on a wall display. The
 *  smallest Location on the QC floor prints at 9.1. */
export const LEGIBLE_LOC_FONT = 9;

/** A card's base size and Location lines for a given shape and Location text. */
export function cardSpec(shape: CardShape, location: string) {
  const c = CARD_SHAPES[shape];
  const lines = splitLabel(location, c.wrap);
  const extra = (lines.length - 1) * c.line;
  return { ...c, lines, extra, h: c.h + extra };
}

/** The Location font a card of `spec` prints at scale `k`. */
export function locationFont(spec: ReturnType<typeof cardSpec>, k: number): number {
  const longest = Math.max(1, ...spec.lines.map((l) => l.length));
  return Math.min(spec.locFont * k, (spec.w * k - 10) / (longest * 0.6));
}

/** The instrument-ID font a card of `spec` prints `code` at, scale `k`: the
 *  shape's size, or less when the card is too narrow for its longest ID line. */
export function codeFont(spec: ReturnType<typeof cardSpec>, k: number, code: string): number {
  const longest = Math.max(1, ...splitCode(code, spec.idLines).map((l) => l.length));
  return Math.min(spec.idFont * k, (spec.w * k - 10) / (longest * 0.64));
}

/**
 * Which shape a one-instrument room's card takes, and where it goes: the
 * shape whose SMALLER heading — the Location, or the instrument ID when
 * `code` is given — prints largest. The portrait card wins a tie (it is the
 * design; the others are fallbacks), and the small-room shapes are not even
 * tried while a design shape is legible. Null when no shape fits clear of the
 * obstacles — the caller falls back to the tile grid's box.
 *
 * The ID counts because a room can be too NARROW for it while the Location
 * still fits: QC 3's LCMS ROOM-II printed "LCMS Room-II" at 5.8 on the tall
 * card and on the mini card alike, and the ID at 4.7 against 8.3.
 *
 * `inner` is the room's LARGEST inscribed rectangle. In an L-shaped room that
 * can be the arm a card fits worst (Module-E's API DISPENSING: the tall narrow
 * bay is 2 % larger than the room proper, and the card went into the bay at
 * half the size). `others` gives the room's other inscribed rectangles; they
 * are tried, the same way, ONLY when the largest cannot hold a legible card —
 * so a room whose card is legible where it is never moves.
 */
export function chooseCard(
  inner: PixelBox,
  obstacles: PixelBox[],
  location: string,
  code?: string,
  others?: () => PixelBox[],
): (NonNullable<ReturnType<typeof placeCard>> & { shape: CardShape }) | null {
  let best: (NonNullable<ReturnType<typeof placeCard>> & { shape: CardShape }) | null = null;
  let bestFont = -1;
  const tryShapes = (box: PixelBox, shapes: readonly CardShape[]) => {
    for (const shape of shapes) {
      const spec = cardSpec(shape, location);
      const placed = placeCard(box, obstacles, spec.w, spec.h);
      if (!placed) continue;
      const loc = locationFont(spec, placed.k);
      const font = code ? Math.min(loc, codeFont(spec, placed.k, code)) : loc;
      if (font > bestFont + 0.25) { bestFont = font; best = { ...placed, shape }; }
    }
  };
  const tryBox = (box: PixelBox) => {
    tryShapes(box, DESIGN_SHAPES);
    if (bestFont < LEGIBLE_LOC_FONT) tryShapes(box, SMALL_ROOM_SHAPES);
    if (bestFont < LEGIBLE_LOC_FONT) tryShapes(box, NARROW_ROOM_SHAPES);
  };
  tryBox(inner);
  if (bestFont < LEGIBLE_LOC_FONT && others) {
    for (const box of others()) {
      if (bestFont >= LEGIBLE_LOC_FONT) break;
      tryBox(box);
    }
  }
  return best;
}

/** The card's Location text for a row: its own Location attribute, else the room's name. */
const cardLocation = (row: { locationAttribute?: string | null }, room: { label: string | null }) =>
  row.locationAttribute?.trim() || room.label || '';

/**
 * One object so a dark wall-display palette is a value swap rather than a
 * rewrite. The dark values are deliberately NOT authored yet — a scheme guessed
 * at without seeing it on the target display is wasted work.
 *
 * Chip colours are NOT in here: they are semantic and must not vary with the
 * surface, or a themed site ends up with a purple "out of spec".
 */
const PALETTE = {
  paper: '#ffffff',
  /** The plate the building sits on, so the plan reads as a drawing, not a float. */
  ground: '#f8fafc',
  wall: '#1f2937',
  /** Doors read as openings, and match the operator's reference drawing. */
  door: '#0ea5e9',
  /** A door as the plant's drawings show it (2026-10-01): dark leaf, orange swing. */
  doorLeaf: '#4b5563',
  doorSwing: '#f97316',
  ink: '#111827',
  inkSoft: '#374151',
  /** Room label — subordinate to the code by size AND colour. */
  labelInk: '#475569',
  /** Corridor centre-line. */
  centreLine: '#94a3b8',
  /** Alarm halo. Same red as the OUT_OF_SPEC chip, deliberately. */
  alarm: '#dc2626',
  tile: '#ffffff',
  tileBorder: '#cbd5e1',
  /* Annotation marks. Warm for equipment, green for plant, and NEITHER is a
     status colour: the semantic reds and ambers live in CHIP and nowhere near
     these, so a hatched block can never be misread as an alarm. */
  equipFill: '#fdf0e3',
  equipInk: '#d97757',
  hvacFill: '#eaf5ec',
  hvacInk: '#3f8f5c',
  airflow: '#2f9e5e',
} as const;


/**
 * ZONE COLOUR — hue encodes cleanroom GRADE, saturation encodes STATUS.
 *
 * GMP floor plans are already colour-coded by classification, so this borrows
 * the subject's own vernacular instead of inventing a palette. The rule that
 * keeps the two readings from fighting: zone colour is LOW CHROMA and appears
 * in exactly three places — the room fill, the room code, and the grade tab.
 * Status colour is saturated and appears only in the chips and the alarm halo.
 * Walls, doors and the building outline are never zone-coloured: the zone
 * already speaks three times, and a fourth is what tips a dense floor into
 * noise.
 *
 * An unknown or absent grade falls back to `NONE`, which is exactly how the
 * drawing looked before grades existed — an absent classification is honest, a
 * guessed one is not.
 */
const NO_ZONE = { fill: PALETTE.paper, ink: PALETTE.wall } as const;

const ZONE: Record<RoomGrade, { fill: string; ink: string }> = {
  A: { fill: '#eef0ff', ink: '#4338ca' },
  B: { fill: '#e8f1fe', ink: '#1d4ed8' },
  C: { fill: '#e9f7f1', ink: '#047857' },
  D: { fill: '#fef5e7', ink: '#b45309' },
  CIRCULATION: { fill: '#eff2f7', ink: '#475569' },
  UTILITY: { fill: '#f4f4f5', ink: '#52525b' },
};

/** The API sends free text; anything not in the vocabulary draws unclassified. */
function zoneOf(grade: string | null): { fill: string; ink: string } {
  return grade && grade in ZONE ? ZONE[grade as RoomGrade] : NO_ZONE;
}

/**
 * The alarm halo pulses so a breach finds the eye from across the room — this
 * drawing's job is to be read from a monitoring wall. Motion is a real
 * accessibility cost, so `prefers-reduced-motion` drops to the static stroke;
 * the halo itself never goes away, because it is the thing carrying the alarm.
 */
const HALO_CSS = `
/* Hover feedback that does not repaint the zone: darkening keeps the hue, and
   works on a white unclassified room where a tint would be invisible. */
.fp-room-fill { transition: filter 120ms ease; }
.fp-room-fill:hover { filter: brightness(0.955); }
.fp-alarm-halo { opacity: 0.9; animation: fpAlarmPulse 2s ease-in-out infinite; }
@keyframes fpAlarmPulse { 0%, 100% { opacity: 0.9 } 50% { opacity: 0.35 } }
@media (prefers-reduced-motion: reduce) {
  .fp-alarm-halo { animation: none; opacity: 0.9; }
}
`;

interface RoomView {
  room: FloorplanRoomShape;
  rows: OverviewRow[];
  status: InstrumentStatus;
}

export function FloorplanView({ functionalLocationId, directOnly }: { functionalLocationId?: string; directOnly?: boolean } = {}) {
  const sensorWords = useSensorWords();
  const navigate = useNavigate();
  const { plans, isLoading: plansLoading } = useFloorplans();
  // Scoped server-side. When a functional location is selected the rows are only
  // that location's instruments, so the rooms drawn below narrow with it.
  const { rows } = useTelemetryOverview({ functionalLocationId, directOnly });

  const [planId, setPlanId] = useState<string>('');

  const plan = plans.find((p) => p.id === planId) ?? plans[0] ?? null;

  const byRoom = useMemo(() => {
    const map = new Map<string, OverviewRow[]>();
    for (const r of rows) {
      if (!r.room) continue;
      const list = map.get(r.room.id);
      if (list) list.push(r);
      else map.set(r.room.id, [r]);
    }
    return map;
  }, [rows]);

  const roomViews: RoomView[] = useMemo(() => {
    if (!plan) return [];
    const all = plan.rooms.map((room) => {
      const roomRows = byRoom.get(room.id) ?? [];
      return { room, rows: roomRows, status: worstStatus(roomRows.map((r) => r.status)) };
    });
    // Unscoped: draw the whole floor, empty rooms included — that is the plan.
    // Scoped to a functional location: draw ONLY rooms holding one of its
    // instruments, otherwise selecting "Module-E" still renders the entire
    // building and the filter appears to have done nothing.
    //
    // SINCE 2026-10-01 (QC Layout-2, "match with the image"): a plan that shows
    // ANY of the selection's instruments is that floor, so it is drawn WHOLE —
    // its corridors, offices and empty rooms are the building the readings sit
    // in, and dropping them left windows floating in space. Readings are still
    // only the selection's (the rows are scoped server-side). A plan holding
    // none of them still draws nothing, and says so below.
    return roomsToDraw(all, !!functionalLocationId);
  }, [plan, byRoom, functionalLocationId]);

  // There is NO "not placed on any plan" tray here any more (operator,
  // 2026-09-22: "in graphical view dont show not placed on any panel section").
  // It listed every instrument in the selection with no room, under the plan,
  // so nothing could be silently absent from the graphical view. Consequence,
  // stated once: an instrument with no room now appears ONLY in the Tabular
  // view (its Room column) and on the Instruments page; the drawn floor shows
  // the rooms and nothing else. Place it in a room (Config -> Layout Designer) to
  // see it here.

  /**
   * FULL SCREEN (operator, 2026-09-22: "the layout should complete visible in
   * full screen"). The view leaves its panel for a fixed overlay over the whole
   * viewport and, being contained (see the root below), the WHOLE plan is then
   * visible at once at the largest size the screen allows. Escape leaves it —
   * a fixed overlay with no keyboard way out is a trap — and so does the same
   * button. The Data Report widget's pattern (`history-widget.tsx`).
   */
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // The box the full-screen drawing has to fill, in CSS px — see `fillHeight`.
  // The overlay is fixed to the viewport, so it changes size only with the window.
  const fullBoxRef = useRef<HTMLDivElement | null>(null);
  const [fullBox, setFullBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    if (!fullscreen) { setFullBox(null); return; }
    const measure = () => {
      const r = fullBoxRef.current?.getBoundingClientRect();
      setFullBox(r && r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : null);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [fullscreen, plan?.id]);

  // The room-detail panel is no longer opened from here (2026-10-01): a room
  // opens its instrument's TREND page instead (see the room's onClick).

  if (!plansLoading && plans.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
        <p className="text-sm font-medium text-slate-700">No floor layout yet.</p>
        <p className="mt-1 text-xs text-slate-500">
          Draw one on{' '}
          <Link to="/config/floorplans" className="font-medium underline" style={{ color: 'var(--theme-primary)' }}>
            Configuration → Layout Designer
          </Link>
          {' '}to see rooms here.
        </p>
      </div>
    );
  }

  // The part of the canvas actually drawn on — see `planExtent`.
  const structure = plan?.annotations ?? null;
  // The frame takes in the columns and windows set into the outer walls — a
  // plan is drawn whole whether or not a location is selected (see roomViews).
  // ...and an exterior door that swings OUT of the building: its leaf and arc
  // stand outside every room, and a frame fitted to the rooms would cut them.
  const extentAt = (h: number) => {
    if (!plan) return { x: 0, y: 0, w: 1, h: 1 };
    const outSwings = roomViews.flatMap(({ room }) => {
      const out = (room.doors ?? []).filter((d) => d.swing === 'out');
      if (!out.length) return [];
      return polygonDoorPlacements(roomOutline(room, VB_W, h), out).map(swingSquare)
        .map((b) => ({ x: b.x / VB_W, y: b.y / h, w: b.w / VB_W, h: b.h / h }));
    });
    return planExtent(roomViews.map((r) => r.room), 0.01, [...(structure?.columns ?? []), ...(structure?.windows ?? []), ...outSwings]);
  };
  const arch = plan?.annotations?.style === 'architectural';
  // In its panel a plan has the DRAWING's proportions. In FULL SCREEN a 2D
  // plan is drawn to the screen's — see `fillHeight`.
  //
  // ONLY the 2D style. Its cards and names are PLACED, by search, clear of
  // every door swing, so they find their place again in the re-proportioned
  // rooms. The standard style lays a fixed tile out per room: rendered at a
  // screen's proportions the generated Stability floor (0.77 wide to tall)
  // lost the instrument ID in several rooms, ran Locations across their
  // neighbours and swept door arcs over the readings. Those floors keep their
  // proportions in full screen, centred, until they are drawn in the 2D style.
  const naturalVbH = plan ? Math.round((VB_W * plan.imageHeight) / plan.imageWidth) : 700;
  const vbH = fullscreen && arch ? fillHeight(naturalVbH, extentAt, fullBox) : naturalVbH;
  const extent = extentAt(vbH);
  const vb = { x: extent.x * VB_W, y: extent.y * vbH, w: extent.w * VB_W, h: extent.h * vbH };

  // The legend goes UNDER every 2D plan but a portrait one (see the 2D branch
  // of the return).
  const legendUnder = arch && vb.w > vb.h * LEGEND_UNDER_RATIO;
  // The viewBox is 1000 units wide whatever the drawing's width, so on a wider
  // canvas a unit is a smaller piece of the building: Microbiology's 1406 px
  // against QC's 1069. Lines of a fixed unit weight would then be heavier on
  // the wider floor — its rooms are ~100 units across and 8-unit walls took a
  // twelfth of each. The 2D style's line weights are QC's, scaled so a wall is
  // the same thickness IN THE DRAWING on every plan; never heavier than QC's.
  const lineK = arch && plan ? Math.min(1, ARCH_REF_CANVAS_W / plan.imageWidth) : 1;

  // Each room's outline, the openings cut from its walls and the box its
  // readings lay out in — computed ONCE and read by every layer below (the 2D
  // style draws walls, cards and doors in their own passes, over all rooms).
  const columnBoxes = (plan?.annotations?.columns ?? []).map((c) => ({ x: c.x * VB_W, y: c.y * vbH, w: c.w * VB_W, h: c.h * vbH }));
  // Fixed plant the drawing outlines (an autoclave in a wall, a cross-over
  // bench) — drawn in the 2D style only.
  const equipmentBoxes = arch
    ? (plan?.annotations?.equipment ?? []).map((c) => ({ x: c.x * VB_W, y: c.y * vbH, w: c.w * VB_W, h: c.h * vbH }))
    : [];
  // What a card or a room's name must stay clear of in the 2D style: every
  // door swing on the plan (a neighbour's door can swing in), the columns and
  // the outlined plant.
  const planObstacles = arch
    ? [...roomViews.flatMap((o) => polygonDoorPlacements(roomOutline(o.room, VB_W, vbH), o.room.doors ?? []).map(swingSquare)), ...columnBoxes, ...equipmentBoxes]
    : [];
  const geoms = new Map(roomViews.map(({ room, rows: roomRows }) => {
    // A corridor is ONE space that the schema stores as several
    // rectangles (a room is a rectangle; an L is two). The seam
    // between two adjoining CIRCULATION rooms is therefore not a
    // wall, and is cut out like a door — without a leaf, since
    // nothing is there. Operator, 2026-09-21: "in layout image
    // corridor single line, not divided into separately". Only the
    // rooms actually DRAWN count as neighbours: in a scoped view a
    // hidden piece would otherwise open a wall onto nothing.
    // Two rooms are one space when both are circulation, OR when
    // one is a continuation piece of the other — an L-shaped lab
    // stored as `INCUBATOR-01` + `INCUBATOR-01 (2)` (Microbiology,
    // 2026-09-21) has no wall between its halves either.
    // The outline (a polygon since 2026-09-22; a rectangle is its
    // four-corner case) and everything cut out of its walls: its own
    // doors, the seams it shares with the rooms it is one space with,
    // and the OPENING links the designer drew.
    const outline = roomOutline(room, VB_W, vbH);
    const doorOpenings = (room.doors ?? []).flatMap((d) => {
      const o = doorToEdgeOpening(d, room.points ?? null);
      return o ? [o] : [];
    });
    const openings = [
      ...polygonSharedOpenings(
        outline,
        roomViews
          .filter((o) => o.room.id !== room.id && sameSpace(room, o.room))
          .map((o) => roomOutline(o.room, VB_W, vbH)),
      ),
      ...roomOpenings(room, plan?.links ?? [], roomViews, VB_W, vbH),
      ...neighbourDoorOpenings(room, roomViews, VB_W, vbH),
    ];
    // The readings tiles lay out in the largest rectangle INSIDE the
    // outline, so an L-shaped room never hangs a tile outside a wall.
    // For a rectangle that IS the box, and nothing moves.
    // ...and stepped clear of a door swing that would sit on the tile's
    // text (QC Layout-2's DISSOLUTION ROOM-II printed its ID on its door).
    // In the 2D style the text is the whole CARD, so the band is the card's.
    const doors = polygonDoorPlacements(outline, room.doors ?? []);
    // ...and clear of the structural columns standing in it.
    const tileBox = roomRows.length > 0
      ? avoidObstacles(
        avoidDoorSwings(
          largestInscribedRect(outline),
          doors,
          arch ? CARD_H + 12 : TILE_HEADER_H + FULL_CODE_GAP + 2 * MAX_TILE_FONT * CHIP_HEIGHT_FACTOR + CHIP_GAP,
        ),
        columnBoxes,
      )
      : largestInscribedRect(outline);
    // A continuation piece (`CWH-I/217 (2)`) whose first piece is
    // on the plan prints no code and no name of its own — with the
    // seam gone, a second label inside the same space is the
    // "divided" reading the seam gave.
    const continuationOf = continuationBase(room.code);
    const isContinuation = continuationOf !== null
      && roomViews.some((o) => o.room.id !== room.id && o.room.code.toUpperCase() === continuationOf);
    // The 2D style places a room's ONE card by search (see `placeCard`),
    // clear of every swing on the plan (a neighbour's door can swing in) and of
    // the columns; a room with several instruments keeps the tile grid.
    // The shape is whichever prints the Location largest — see `chooseCard`.
    const card = arch && roomRows.length === 1
      ? chooseCard(largestInscribedRect(outline), planObstacles, cardLocation(roomRows[0], room), roomRows[0].code,
        // The room's other arms, tried only when the largest holds no legible card.
        () => inscribedRects(outline).slice(1, 6))
      : null;
    return [room.id, {
      outline, doorOpenings, openings, tileBox, isContinuation, card,
      outlinePoints: outline.map((pt) => `${pt.x},${pt.y}`).join(' '),
      // Doors, plus an OPENING link's leaf on the from-room's edge.
      doorPlacements: polygonDoorPlacements(outline, [
        ...(room.doors ?? []),
        ...(plan?.links ?? [])
          .filter((l) => l.kind === 'OPENING' && l.fromRoomId === room.id && l.door && l.fromEdge != null && l.offset != null && l.width != null)
          .map((l) => ({ edge: l.fromEdge!, offset: l.offset!, width: l.width!, kind: l.door! })),
      ]),
    }] as const;
  }));

  const floorSvg = plan ? (
          <svg
            viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
            className="h-full w-full"
            preserveAspectRatio="xMidYMin meet"
            role="img"
            aria-label={`${plan.name}: ${roomViews.length} rooms with current temperature and humidity`}
          >
            <style>{HALO_CSS}</style>

            {/* Building outline on its plate. The ground is a shade off white so
                the building reads as a drawing laid on something, and so the
                gaps between rooms are visibly OUTSIDE them. The ink is still the
                information. */}
            {/* The 2D style: a plain white plate (the grid went with the
                "vivid status" look — the colour is on the rooms, never behind
                them), and the gradients its floors and card bands are filled
                with. Each runs top to bottom of the shape it fills. */}
            {arch ? (
              <>
                <defs>
                  {TONE_ORDER.map((t) => (
                    <linearGradient key={`w-${t}`} id={`fp-wash-${t}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor={ARCH.wash[t]} /><stop offset="1" stopColor={ARCH.washTo[t]} />
                    </linearGradient>
                  ))}
                  {TONE_ORDER.map((t) => (
                    <linearGradient key={`b-${t}`} id={`fp-band-${t}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor={ARCH.bandFrom[t]} /><stop offset="1" stopColor={CHIP[t].bg} />
                    </linearGradient>
                  ))}
                  <linearGradient id="fp-wash-empty" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor={ARCH.emptyWash} /><stop offset="1" stopColor={ARCH.emptyWashTo} />
                  </linearGradient>
                </defs>
                <rect x={vb.x} y={vb.y} width={vb.w} height={vb.h} fill={ARCH.ground} />
              </>
            ) : (
              <rect x={vb.x} y={vb.y} width={vb.w} height={vb.h} fill={PALETTE.ground} stroke={PALETTE.wall} strokeWidth={3} />
            )}

            {roomViews.map(({ room, rows: roomRows, status }) => {
              const x = room.x * VB_W;
              const y = room.y * vbH;
              const w = room.w * VB_W;
              const h = room.h * vbH;
              const zone = zoneOf(room.grade);
              // A ROOM PRINTS NOTHING OF ITS OWN (operator, 2026-09-22: "in rooms
              // show Instrument ID, Location and Values dont show any other
              // things"). Until then the room printed its code, its name and,
              // on a traced plan, the drawing's ceiling height and dimensions
              // (`captionHeader` costed those lines against the tiles). All of
              // that is gone; the tile grid starts at the room's top edge, and
              // each tile prints the instrument ID, its Location attribute and
              // the two readings. Consequence, stated once: a room with no
              // instrument is an unlabelled box, and the traced plans' room
              // numbers and names no longer appear on the floor (they are still
              // stored and still on the Config -> Floorplans editor).
              const headerH = 0;
              const gradeMeta = room.grade && room.grade in ROOM_GRADE_META
                ? ROOM_GRADE_META[room.grade as RoomGrade]
                : null;

              const { outline, doorOpenings, openings, tileBox, outlinePoints, isContinuation, doorPlacements } = geoms.get(room.id)!;
              const tone = arch ? roomTone(roomRows, sensorWords) : null;

              return (
                <g
                  key={room.id}
                  // A room with NO instrument is not a button (2026-10-01,
                  // operator: "which ever dont have instrument ids those rooms
                  // should be unclickable"): no click, no pointer, no tab stop —
                  // its detail page would only ever say "no instruments".
                  // A room WITH one opens its instrument's TREND page (same day:
                  // "when user click on room redirect to that instrument trends
                  // page") — the first instrument when a room holds several;
                  // each tile opens its own.
                  {...(roomRows.length > 0
                    ? {
                      onClick: () => navigate(`/instruments/${roomRows[0].instrumentId}/trend`),
                      style: { cursor: 'pointer' },
                      role: 'button',
                      tabIndex: 0,
                      onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/instruments/${roomRows[0].instrumentId}/trend`); },
                    }
                    : { role: 'group' })}
                  aria-label={`${room.code}${room.label ? ` ${room.label}` : ''}${
                    // Zone colour is never the only carrier of the grade.
                    gradeMeta ? `, grade ${gradeMeta.label}` : ''
                  }, ${statusClasses(status).label}, ${
                    roomRows.length
                  } instrument${roomRows.length === 1 ? '' : 's'}${
                    room.doors && room.doors.length > 0
                      ? `, ${room.doors.length} door${room.doors.length === 1 ? '' : 's'}`
                      : ''
                  }`}
                >
                  {/* Fill only, and the ONE place zone colour is allowed to
                      cover area. The walls are separate segments below, because
                      a stroked rect cannot have a door cut out of it. */}
                  {/* `meta.fill` is the colour the DRAUGHTSMAN used, and it wins
                      on a traced plan. The two statements do not conflict: the
                      drawing's colour says what a room is FOR, the zone tint says
                      how it is classified, and since the grade legend and tab were
                      both removed the tint is decoration anyway. On a generated
                      plan `meta` is null and this is the zone tint exactly as
                      before. */}
                  <polygon
                    points={outlinePoints}
                    fill={arch
                      ? (tone ? `url(#fp-wash-${tone})` : room.grade === 'CIRCULATION' ? ARCH.corridor : 'url(#fp-wash-empty)')
                      : room.meta?.fill ?? zone.fill}
                    data-tone={tone ?? undefined}
                    // The hover darkening says "clickable" — only where it is.
                    className={roomRows.length > 0 ? 'fp-room-fill' : undefined}
                  />

                  {/* Corridor centre-line. Runs the room's long axis and makes
                      the corridors read as one connected circulation system
                      rather than as leftover space between rooms. */}
                  {/* Only on a RECTANGLE: a polygon corridor (QC Layout-2's one
                      corridor wraps three blocks) would have its box's centre
                      line run straight through the rooms it goes round. */}
                  {!arch && room.grade === 'CIRCULATION' && (!room.points || room.points.length === 4) && (
                    w >= h ? (
                      <line
                        x1={x + 6} y1={y + h / 2} x2={x + w - 6} y2={y + h / 2}
                        stroke={PALETTE.centreLine} strokeWidth={1} strokeDasharray="6 5"
                      />
                    ) : (
                      <line
                        x1={x + w / 2} y1={y + 6} x2={x + w / 2} y2={y + h - 6}
                        stroke={PALETTE.centreLine} strokeWidth={1} strokeDasharray="6 5"
                      />
                    )
                  )}

                  {!arch && polygonWalls(outline, [...doorOpenings, ...openings]).map((s, i) => (
                    <line
                      key={`w${i}`}
                      x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                      stroke={PALETTE.wall} strokeWidth={2.5} strokeLinecap="butt"
                    />
                  ))}

                  {/* Alarm halo. It NEVER repaints the fill: the fill is the
                      grade, and an alarm that recoloured it would make grade and
                      status argue over the same pixels. Skipped on a box too
                      small to inset without the stroke crossing itself. */}
                  {/* Not in the 2D style: there the room's red wash and its red
                      card carry the alarm, and the band showed through every
                      door gap in the double wall as a loose red sliver. */}
                  {!arch && status === 'OUT_OF_SPEC' && w > 12 && h > 12 && (
                    // A stroke clipped to the outline: only its inner half shows,
                    // which is an inset band on ANY outline without inset maths.
                    <>
                      <clipPath id={`fp-halo-${room.id}`}><polygon points={outlinePoints} /></clipPath>
                      <polygon
                        className="fp-alarm-halo"
                        points={outlinePoints}
                        fill="none" stroke={PALETTE.alarm} strokeWidth={8}
                        clipPath={`url(#fp-halo-${room.id})`}
                        pointerEvents="none"
                      />
                    </>
                  )}

                  {/* No room code, grade tab or caption here — see the note at
                      `headerH` above. The zone TINT stays as decoration.

                      A room with NO instrument prints its LOCATION — the room's
                      name, falling back to its code — and nothing else
                      (operator, 2026-09-22: "which doesnt have instrument ids
                      for rooms there show Location"). It is the same text an
                      instrument's Location attribute carries for the room it
                      sits in, so the floor reads one vocabulary. A continuation
                      piece of a corridor prints nothing; its base piece does.
                      Sized to the room: never wider than the box, never taller
                      than a third of it. */}
                  {!arch && roomRows.length === 0 && !isContinuation && (room.label || room.code) && (() => {
                    const text = (room.label || room.code).trim();
                    const fontSize = Math.max(6, Math.min(
                      TILE_LOCATION_FONT + 1.5,
                      (tileBox.w - 6) / (Math.max(1, text.length) * 0.55),
                      tileBox.h / 3,
                    ));
                    // The middle of the largest rectangle INSIDE the room, not the
                    // centroid: a corridor that wraps three blocks has its
                    // centroid inside another room (2026-10-01, QC Layout-2).
                    const c = { x: tileBox.x + tileBox.w / 2, y: tileBox.y + tileBox.h / 2 };
                    return (
                      <text
                        x={c.x} y={c.y + fontSize * 0.35} textAnchor="middle"
                        fontSize={fontSize} fill={PALETTE.labelInk}
                        pointerEvents="none"
                      >
                        {text}
                      </text>
                    );
                  })()}

                  {!arch && (() => {
                    const layout = tileLayout(tileBox, roomRows.length, headerH);
                    if (layout.visible === 0) return null;

                    return roomRows.slice(0, layout.visible).map((row, i) => {
                      const col = i % layout.cols;
                      const rowIx = Math.floor(i / layout.cols);
                      // From the INSCRIBED box, not the room's bounding box: on
                      // an L-shaped room the two differ, and a tile placed from
                      // the bounding box sat half outside its wall (2026-10-01).
                      const tx = tileBox.x + col * layout.tile.w;
                      const ty = layout.bodyTop + rowIx * layout.tile.h;
                      const tcx = tx + layout.tile.w / 2;

                      const tempV = row.temperature?.value ?? null;
                      const rhV = row.humidity?.value ?? null;
                      const lim = row.limits;
                      const tempBad = outOfSpec(tempV, lim?.tempMin, lim?.tempMax);
                      const rhBad = outOfSpec(rhV, lim?.rhMin, lim?.rhMax);
                      // The chips and their tones: see `tileValues` for the rule.
                      const values = tileValues(row, sensorWords);
                      // The code is SMALL and FIXED (TILE_CODE_FONT), never the
                      // reading font, and shrinks further to fit a narrow tile
                      // rather than overrunning it: the readings are what a
                      // control room reads first, the identity is a caption.
                      const codeFontSize = Math.min(
                        TILE_CODE_FONT,
                        Math.max(7, (layout.tile.w - 6) / (Math.max(1, row.code.length) * 0.66)),
                      );
                      // The instrument's own `Location` ATTRIBUTE (the dashboard
                      // table's Location column) — never the room's code or name.
                      const location = row.locationAttribute?.trim() || null;
                      const locationFontSize = location
                        ? Math.min(TILE_LOCATION_FONT, Math.max(6.5, (layout.tile.w - 6) / (location.length * 0.6)))
                        : 0;

                      return (
                        <g
                          key={row.instrumentId}
                          onClick={(e) => { e.stopPropagation(); navigate(`/instruments/${row.instrumentId}/trend`); }}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              navigate(`/instruments/${row.instrumentId}/trend`);
                            }
                          }}
                          aria-label={`${row.code}${
                            tempV !== null ? `, ${formatDecimals(tempV, row.decimals.temperature)} degrees${tempBad ? ' out of limit' : ''}` : ''
                          }${rhV !== null ? `, ${formatDecimals(rhV, row.decimals.humidity)} percent humidity${rhBad ? ' out of limit' : ''}` : ''}`}
                        >
                          <rect
                            x={tx + 1.5} y={ty + 1} width={layout.tile.w - 3} height={layout.tile.h - 2}
                            rx={3} fill={PALETTE.tile}
                            // A lone tile draws no border (2026-10-01): it fills
                            // the room's inner rectangle, and on an L-shaped room
                            // its edge read as a wall the drawing does not have.
                            // The border is what separates SEVERAL tiles.
                            stroke={layout.visible > 1 ? PALETTE.tileBorder : 'none'} strokeWidth={0.8}
                          />
                          {layout.step === 'FULL' && (
                            <text
                              x={tcx} y={ty + CODE_LINE_H - 2} textAnchor="middle"
                              fontSize={codeFontSize} fontWeight={700}
                              letterSpacing="0.04em" fill={PALETTE.ink}
                            >
                              {row.code}
                            </text>
                          )}
                          {layout.step === 'FULL' && location && (
                            <text
                              x={tcx} y={ty + CODE_LINE_H + LOCATION_LINE_H - 3} textAnchor="middle"
                              fontSize={locationFontSize} fontWeight={700} fill={PALETTE.labelInk}
                            >
                              {location}
                            </text>
                          )}
                          {values.map((v, vi) => {
                            const paint = CHIP[v.st];
                            // The value with its unit, nothing else (operator,
                            // 2026-09-22, "just show value with units").
                            const label = v.text;
                            // The chip is as wide as its text, capped at the
                            // tile (operator, 2026-09-22: "dont cover entire room
                            // width for room values, just card background should
                            // come till the value only"). It spanned the tile for
                            // a few hours that day. 0.6em per glyph + 4 of padding
                            // is the SAME estimate `fillFont` sizes the font by.
                            const cw = Math.min(layout.tile.w - 6, label.length * layout.fontSize * 0.6 + 4);
                            const chipH = layout.fontSize * CHIP_HEIGHT_FACTOR;
                            const cyTop =
                              ty + (layout.step === 'FULL' ? TILE_HEADER_H + FULL_CODE_GAP : VALUES_TOP_GAP)
                              + vi * (chipH + CHIP_GAP);
                            if (cyTop + chipH > ty + layout.tile.h) return null;
                            return (
                              <g key={vi}>
                                <rect x={tcx - cw / 2} y={cyTop} width={cw} height={chipH} rx={2} fill={paint.bg} />
                                <text
                                  x={tcx} y={cyTop + chipH * 0.75} textAnchor="middle"
                                  fontSize={layout.fontSize * 0.8} fontWeight={700} fill="#ffffff"
                                  style={{ fontVariantNumeric: 'tabular-nums' }}
                                >
                                  {label}
                                </text>
                              </g>
                            );
                          })}
                        </g>
                      );
                    });
                  })()}

                  {!arch && (() => {
                    const layout = tileLayout(tileBox, roomRows.length, headerH);
                    if (layout.hidden <= 0) return null;
                    const i = layout.visible;
                    const col = layout.cols > 0 ? i % layout.cols : 0;
                    const rowIx = layout.cols > 0 ? Math.floor(i / layout.cols) : 0;
                    return (
                      <text
                        x={tileBox.x + col * layout.tile.w + layout.tile.w / 2}
                        y={layout.bodyTop + rowIx * layout.tile.h + layout.fontSize + 2}
                        textAnchor="middle" fontSize={layout.fontSize * 0.85}
                        fontWeight={700} fill={PALETTE.inkSoft}
                      >
                        +{layout.hidden}
                      </text>
                    );
                  })()}

                  {/* Doors LAST in the room (2026-10-01): a reading tile is opaque and,
                      drawn after them, it hid every arc inside an instrument room.
                      Leaf + swing arc in the door blue, which reads as an
                      opening and matches the operator's reference drawing. A door
                      carries no reading — nothing in this install senses one — so
                      it is never given STATUS colour, and it is never given ZONE
                      colour either: the zone already speaks through fill, code and
                      tab. */}
                  {!arch && doorPlacements.map((d, i) => (
                    <g key={`d${i}`}>
                      {/* Drawn as the plant's drawings draw a door (2026-10-01,
                          "doors not matched with image"): a dark leaf standing
                          open and a SOLID orange swing — not the dashed blue it
                          was. Still never a status colour. */}
                      <line
                        x1={d.leaf.x1} y1={d.leaf.y1} x2={d.leaf.x2} y2={d.leaf.y2}
                        stroke={PALETTE.doorLeaf} strokeWidth={1.6}
                      />
                      <path d={d.arc} fill="none" stroke={PALETTE.doorSwing} strokeWidth={1.4} />
                      {/* No IN / OUT word (operator, 2026-09-22: nothing but
                          ID, Location and values in a room). The kind still
                          shapes the leaf and rides in the room's aria-label. */}
                    </g>
                  ))}

                </g>
              );
            })}

            {arch && (
              <g data-testid="fp-arch">
                {/* WALLS — a dark line with a light core, the drawing's double
                    wall. Drawn over ALL the floors, so a neighbour's fill can
                    never cover half of a wall drawn before it. */}
                <g pointerEvents="none">
                  {roomViews.flatMap(({ room }) => {
                    const g = geoms.get(room.id)!;
                    return polygonWalls(g.outline, [...g.doorOpenings, ...g.openings]).map((w, i) => (
                      <line key={`wo-${room.id}-${i}`} x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2}
                        stroke={ARCH.wallOuter} strokeWidth={8 * lineK} strokeLinecap="square" />
                    ));
                  })}
                  {roomViews.flatMap(({ room }) => {
                    const g = geoms.get(room.id)!;
                    return polygonWalls(g.outline, [...g.doorOpenings, ...g.openings]).map((w, i) => (
                      <line key={`wi-${room.id}-${i}`} x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2}
                        stroke={ARCH.wallInner} strokeWidth={2.5 * lineK} strokeLinecap="square" />
                    ));
                  })}
                </g>

                {/* A room with no instrument: its name, letter-spaced, and its
                    number under it; a continuation piece prints nothing. The
                    name sits in the room's middle unless a door swing or a
                    column is there — then at the nearest clear spot
                    (`placeRoomName`; Microbiology's four change rooms are
                    small enough that a door swept through every name). */}
                <g pointerEvents="none">
                  {roomViews.map(({ room, rows: roomRows }) => {
                    const g = geoms.get(room.id)!;
                    if (roomRows.length > 0 || g.isContinuation) return null;
                    const name = (room.label || room.code).trim();
                    const { cx, cy, fs, vertical, lines } = placeRoomName(g.tileBox, planObstacles, name, !!room.label);
                    const below = (lines.length - 1) * NAME_LINE * fs;
                    return (
                      // A tall narrow room's name runs UP it, as on the drawing;
                      // a long name in a small room wraps (`lines`).
                      <g key={`n-${room.id}`} data-vertical={vertical || undefined} transform={vertical ? `rotate(-90 ${cx} ${cy})` : undefined}>
                        {lines.map((line, li) => (
                          <text key={li} x={cx} y={cy + li * NAME_LINE * fs} textAnchor="middle" fontSize={fs} fontWeight={600} fill={ARCH.roomName} letterSpacing="0.08em">{line}</text>
                        ))}
                        {room.label && (
                          <text x={cx} y={cy + below + fs * 1.15} textAnchor="middle" fontSize={fs * 0.72} fill={ARCH.roomCode}>{room.code}</text>
                        )}
                      </g>
                    );
                  })}
                </g>

                {/* CARDS — one per instrument, laid out in the room's tile box
                    (inscribed, clear of door swings), centred in its tile and
                    scaled down to fit, never up. */}
                <defs>
                  <filter id="fp-card-shadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="0" dy="2.5" stdDeviation="3" floodColor="#0f172a" floodOpacity="0.22" />
                  </filter>
                </defs>
                {roomViews.flatMap(({ room, rows: roomRows }) => {
                  const g = geoms.get(room.id)!;
                  const box = { x: g.tileBox.x + 6, y: g.tileBox.y + 6, w: g.tileBox.w - 12, h: g.tileBox.h - 12 };
                  const layout = tileLayout(box, roomRows.length, 0);
                  return roomRows.slice(0, Math.max(1, layout.visible)).map((row, i) => {
                    const col = layout.cols > 0 ? i % layout.cols : 0;
                    const rowIx = layout.cols > 0 ? Math.floor(i / layout.cols) : 0;
                    const tileW = layout.cols > 0 ? layout.tile.w : box.w;
                    const tileH = layout.cols > 0 ? layout.tile.h : box.h;
                    const placed = roomRows.length === 1 ? g.card : null;
                    const spec = cardSpec(placed?.shape ?? 'std', cardLocation(row, room));
                    const locLines = spec.lines;
                    const k = placed ? placed.k : Math.min(1, (tileW - 6) / spec.w, (tileH - 6) / spec.h);
                    const cw = spec.w * k, ch = spec.h * k;
                    // Everything under the Location moves down by the second line.
                    const dy = spec.extra * k;
                    const x0 = placed ? placed.x : box.x + col * tileW + (tileW - cw) / 2;
                    const y0 = placed ? placed.y : (layout.cols > 0 ? layout.bodyTop : box.y) + rowIx * tileH + (tileH - ch) / 2;
                    const tone = cardTone(row, sensorWords);
                    const band = CHIP[tone].bg;        // the card's border; its header is the tone's gradient
                    const [t, h] = tileValues(row, sensorWords);
                    const locFont = locationFont(spec, k);
                    const idLines = splitCode(row.code, spec.idLines);
                    const go = () => navigate(`/instruments/${row.instrumentId}/trend`);
                    const tempV = row.temperature?.value ?? null;
                    const rhV = row.humidity?.value ?? null;
                    return (
                      <g
                        key={`c-${row.instrumentId}`}
                        data-testid="fp-card"
                        data-tone={tone}
                        data-shape={placed?.shape ?? 'std'}
                        onClick={(e) => { e.stopPropagation(); go(); }}
                        role="button"
                        tabIndex={0}
                        style={{ cursor: 'pointer' }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); go(); } }}
                        aria-label={`${row.code}${
                          tempV !== null ? `, ${formatDecimals(tempV, row.decimals.temperature)} degrees${t.bad ? ' out of limit' : ''}` : ''
                        }${rhV !== null ? `, ${formatDecimals(rhV, row.decimals.humidity)} percent humidity${h.bad ? ' out of limit' : ''}` : ''}`}
                      >
                        <rect x={x0} y={y0} width={cw} height={ch} rx={9 * k} fill="#ffffff" stroke={band} strokeWidth={2} filter="url(#fp-card-shadow)" />
                        <path
                          d={`M${x0},${y0 + spec.band * k} V${y0 + 9 * k} Q${x0},${y0} ${x0 + 9 * k},${y0} H${x0 + cw - 9 * k} Q${x0 + cw},${y0} ${x0 + cw},${y0 + 9 * k} V${y0 + spec.band * k} Z`}
                          fill={`url(#fp-band-${tone})`}
                        />
                        {/* The ID: one line, or two on the `mini` card. */}
                        {idLines.map((line, li) => (
                          <text key={`id${li}`} x={x0 + cw / 2} y={y0 + spec.idY * k + li * spec.idPitch * k} textAnchor="middle" fontSize={codeFont(spec, k, row.code)} fontWeight={800} fill="#ffffff">{line}</text>
                        ))}
                        {locLines[0] && locLines.map((line, li) => (
                          <text key={li} x={x0 + cw / 2} y={y0 + spec.locY * k + li * spec.line * k} textAnchor="middle" fontSize={locFont} fontWeight={700} fill="#334155">{line}</text>
                        ))}
                        {/* The two readings, each in its PILL (see `readingPill`):
                            side by side, or one above the other on the narrow
                            cards. The text is centred in its pill and shrinks
                            to it — `Error` or `100.0 %RH` must not run out. */}
                        {([
                          { v: t, q: 'temperature' as const, caption: 'TEMP', baseline: spec.valY, left: true },
                          { v: h, q: 'humidity' as const, caption: 'HUMIDITY', baseline: spec.stack ? spec.val2Y : spec.valY, left: false },
                        ]).map(({ v, q, caption, baseline, left }) => {
                          const gap = 3 * k, pad = 8 * k;
                          const pw = spec.stack ? cw - 2 * pad : (cw - 2 * pad - 2 * gap) / 2;
                          const px = spec.stack ? x0 + pad : left ? x0 + pad : x0 + cw / 2 + gap;
                          const by = y0 + baseline * k + dy;
                          const fs = Math.min(spec.valFont * k, (pw - 4 * k) / (Math.max(1, v.text.length) * 0.6));
                          const pill = readingPill(v.st, q);
                          return (
                            <g key={q} data-testid="fp-reading" data-quantity={q} data-solid={pill.solid || undefined}>
                              <rect x={px} y={by - PILL_ABOVE * spec.valFont * k} width={pw} height={PILL_HEIGHT * spec.valFont * k} rx={5 * k} fill={pill.bg} />
                              <text x={px + pw / 2} y={by} textAnchor="middle" fontSize={fs} fontWeight={700} fill={pill.ink} style={{ fontVariantNumeric: 'tabular-nums' }}>{v.text}</text>
                              {spec.captions && (
                                <text x={px + pw / 2} y={y0 + spec.capY * k + dy} textAnchor="middle" fontSize={8.5 * k} fill={ARCH.roomCode} letterSpacing="0.06em">{caption}</text>
                              )}
                            </g>
                          );
                        })}
                      </g>
                    );
                  });
                })}

                {/* DOORS last: the leaf and a dashed swing, the drawing's door.
                    Never a status colour. */}
                <g pointerEvents="none">
                  {roomViews.flatMap(({ room }) => geoms.get(room.id)!.doorPlacements.map((d, i) => (
                    <g key={`d-${room.id}-${i}`} data-testid="fp-arch-door">
                      <path d={d.arc} fill="none" stroke={ARCH.doorSwing} strokeWidth={1.3} strokeDasharray="4 3" />
                      <line x1={d.leaf.x1} y1={d.leaf.y1} x2={d.leaf.x2} y2={d.leaf.y2} stroke={ARCH.doorLeaf} strokeWidth={2.5 * lineK} />
                    </g>
                  )))}
                </g>
              </g>
            )}

            {/* CONNECTOR links (Layout Designer, 2026-09-22): a dashed line
                between the centres of two rooms that do not touch, in the door
                blue because it is an opening in spirit, never a status colour.
                Drawn after the rooms so it rides over both fills; no pointer
                events so it cannot swallow a click meant for a room. */}
            {(plan?.links ?? []).filter((l) => l.kind === 'CONNECTOR').map((l) => {
              const a = roomViews.find((v) => v.room.id === l.fromRoomId)?.room;
              const b = roomViews.find((v) => v.room.id === l.toRoomId)?.room;
              if (!a || !b) return null;
              const ca = centroid(roomOutline(a, VB_W, vbH)), cb = centroid(roomOutline(b, VB_W, vbH));
              return (
                <g key={l.id} pointerEvents="none">
                  <line x1={ca.x} y1={ca.y} x2={cb.x} y2={cb.y} stroke={PALETTE.door} strokeWidth={1.4} strokeDasharray="6 4" />
                  {l.label && (
                    <text x={(ca.x + cb.x) / 2} y={(ca.y + cb.y) / 2 - 3} textAnchor="middle" fontSize={8} fill={PALETTE.door}>
                      {l.label}
                    </text>
                  )}
                </g>
              );
            })}

            {/* The drawing's annotation layer (equipment, HVAC, water points,
                airflow, free text) is NOT drawn here since 2026-09-22
                (operator: "other symbols remove those"). It is still stored and
                still served by the API; the dashboard shows rooms, doors, links
                and readings, nothing else.

                EXCEPT the building's STRUCTURE (2026-10-01, QC Layout-2:
                "show columns and windows"): columns, windows and partition
                stubs, drawn as the drawing draws them — hatched orange squares,
                blue-framed lights, wall-weight lines. Part of the building, not
                a status: none of it ever takes a status colour, and none of it
                takes a click. A plan without them (every other plan) draws
                nothing here.

                AND, in the 2D style only, the fixed plant the drawing OUTLINES
                (2026-10-01, Microbiology, operator: "rooms dooars and room
                lines are some places not matches with image"): the pass-through
                autoclave standing in a wall and the change room's cross-over
                bench are lines on that drawing, and a plan without them did
                not match it. A thin outlined box with the drawing's caption —
                opaque, so the wall the autoclave stands in stops at it, as it
                does on the drawing. Not a symbol with a legend, never a status
                colour; the standard style still draws none of it. */}
            {structure && (structure.columns?.length || structure.windows?.length || structure.walls?.length || equipmentBoxes.length) ? (
              <g pointerEvents="none" data-testid="fp-structure">
                <defs>
                  <pattern id="fp-column-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="4" height="4" fill={arch ? ARCH.columnFill : '#f97316'} />
                    <line x1="0" y1="0" x2="0" y2="4" stroke={arch ? ARCH.columnInk : '#c2410c'} strokeWidth="1.4" />
                  </pattern>
                </defs>
                {equipmentBoxes.map((b, i) => (
                  <rect key={`eq${i}`} data-structure="equipment" x={b.x} y={b.y} width={b.w} height={b.h}
                    fill="#ffffff" stroke={ARCH.wallOuter} strokeWidth={1.5} />
                ))}
                {arch && (structure.labels ?? []).map((l, i) => (
                  <text key={`lbl${i}`} x={l.x * VB_W} y={l.y * vbH} textAnchor="middle" fontSize={6.5} fill={ARCH.roomName} letterSpacing="0.04em">{l.text}</text>
                ))}
                {(structure.walls ?? []).map((l, i) => (
                  <line key={`sw${i}`} x1={l.x1 * VB_W} y1={l.y1 * vbH} x2={l.x2 * VB_W} y2={l.y2 * vbH}
                    stroke={arch ? ARCH.wallOuter : PALETTE.wall} strokeWidth={arch ? 8 * lineK : 2.5} strokeLinecap="butt" />
                ))}
                {/* ...and in the 2D style a stub is a WALL: the same light core. */}
                {arch && (structure.walls ?? []).map((l, i) => (
                  <line key={`swi${i}`} data-structure="stub-core" x1={l.x1 * VB_W} y1={l.y1 * vbH} x2={l.x2 * VB_W} y2={l.y2 * vbH}
                    stroke={ARCH.wallInner} strokeWidth={2.5 * lineK} strokeLinecap="butt" />
                ))}
                {(structure.windows ?? []).map((b, i) => {
                  const x = b.x * VB_W, y = b.y * vbH, w = b.w * VB_W, h = b.h * vbH;
                  return (
                    <g key={`win${i}`}>
                      <rect data-structure="window" x={x} y={y} width={w} height={h}
                        fill={arch ? ARCH.windowFill : '#dbeafe'} stroke={arch ? ARCH.windowInk : '#1d4ed8'} strokeWidth={arch ? 1.5 : 1.2} />
                      {/* The glazing line along the window's long side. */}
                      {arch && (h > w
                        ? <line x1={x + w / 2} y1={y} x2={x + w / 2} y2={y + h} stroke={ARCH.windowInk} strokeWidth={1} />
                        : <line x1={x} y1={y + h / 2} x2={x + w} y2={y + h / 2} stroke={ARCH.windowInk} strokeWidth={1} />)}
                    </g>
                  );
                })}
                {(structure.columns ?? []).map((b, i) => (
                  <rect key={`col${i}`} data-structure="column" x={b.x * VB_W} y={b.y * vbH} width={b.w * VB_W} height={b.h * vbH}
                    fill="url(#fp-column-hatch)" stroke={arch ? ARCH.wallOuter : '#0891b2'} strokeWidth={arch ? 2 : 1.2} />
                ))}
              </g>
            ) : null}
          </svg>
  ) : null;

  // FULL SCREEN — the trend widget's pattern (operator, 2026-09-22: "i need
  // like how full screen option there in trend widget like that i need for
  // layout"): a fixed full-viewport overlay with the widget's own title bar
  // and the toggle in the same place, the drawing filling the rest, Escape to
  // leave. No plan switcher and no legends in it ("dont show any option").
  //
  // RENDERED THROUGH A PORTAL, and that is the whole difference from the first
  // cut, which the operator reported as "not given properly": this view lives
  // in a react-grid-layout item, which is positioned with a CSS TRANSFORM, and
  // `position: fixed` inside a transformed ancestor is fixed to THAT ancestor,
  // not the viewport — the overlay opened inside the panel's own box. The
  // trend and Data Report widgets never met this because their pages have no
  // transformed ancestor. `document.body` has none.
  if (fullscreen && plan) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex flex-col bg-white" data-testid="floorplan-view" data-fullscreen="true">
        <div
          className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
          style={{ background: 'linear-gradient(135deg, var(--theme-sidebar-bg), var(--theme-primary-dark))' }}
        >
          <h3 className="text-sm font-bold tracking-wide text-white">{plan.name}</h3>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setFullscreen(false)}
            aria-pressed
            aria-label="Exit full screen — floor plan"
            title="Normal screen (Esc)"
            className="text-white/80 hover:bg-white/15 hover:text-white"
          >
            <Minimize2 className="mr-1 h-4 w-4" aria-hidden="true" /> Normal screen
          </Button>
        </div>
        <div className="min-h-0 flex-1 p-3">
          <div ref={fullBoxRef} className="h-full w-full" data-testid="fp-full-box">{floorSvg}</div>
        </div>
      </div>,
      document.body,
    );
  }

  return (
    // A flex column filling the panel, so the drawing below can take WHAT IS
    // LEFT and no more (operator, 2026-09-22: "decrease the space in rooms,
    // layout rooms taking so much large"). Until then the SVG was `w-full
    // h-auto`: it spanned the panel's width and the plan's aspect ratio set its
    // height, so a portrait plan (QC is 1000x1360) ran to ~1,500px inside an
    // 880px panel and scrolled, every room drawn far bigger than the screen.
    // Now the plan is CONTAINED in the panel; to see it bigger, make the panel
    // bigger (Arrange), which is the one panel where dragging taller does
    // something — see `AUTO_HEIGHT_PANELS`.
    <div className="flex h-full flex-col gap-4" data-testid="floorplan-view">
      {/* Dark title bar: current plan on the left, the others as links on the
          right — the reference drawing's chrome. A <select> hid which other plans
          existed behind a click; these are visible at a glance. */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-t-2xl px-4 py-2.5"
        style={{ background: 'linear-gradient(135deg, var(--theme-sidebar-bg), var(--theme-primary-dark))' }}
      >
        <h3 className="text-sm font-bold tracking-wide text-white">{plan?.name ?? 'Floor plan'}</h3>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setFullscreen(true)}
            aria-label="Full screen — floor plan"
            title="Full screen"
            className="text-white/80 hover:bg-white/15 hover:text-white"
          >
            <Maximize2 className="h-4 w-4" aria-hidden="true" />
          </Button>
          {plans.filter((p) => p.id !== plan?.id).map((p) => (
            <Button
              variant="ghost"
              size="sm"
              key={p.id}
              type="button"
              onClick={() => setPlanId(p.id)}
              // This bar is a dark gradient, so ghost's slate ink is invisible
              // on it. The variant is still right — no fill, no border — it just
              // has to be the inverse ink here.
              className="text-white/80 hover:bg-white/15 hover:text-white"
            >
              {p.name}
            </Button>
          ))}
        </div>
      </div>

      {/* Scoped, but none of this location's instruments sit in a room on this
          plan. Drawing the building with no rooms would read as "the plan is
          broken"; naming the actual fix is more useful than an empty rectangle. */}
      {plan && functionalLocationId && plan.rooms.length > 0 && roomViews.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
          <p className="text-sm font-medium text-slate-700">
            No instruments in this functional location are placed on {plan.name}.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Place them on{' '}
            <Link to="/config/floorplans" className="font-medium underline" style={{ color: 'var(--theme-primary)' }}>
              Configuration → Layout Designer
            </Link>
            , or switch to the Tabular view, which does not need geometry.
          </p>
        </div>
      ) : plan && plan.rooms.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
          <p className="text-sm font-medium text-slate-700">{plan.name} has no rooms drawn yet.</p>
          <p className="mt-1 text-xs text-slate-500">
            Draw them on{' '}
            <Link to="/config/floorplans" className="font-medium underline" style={{ color: 'var(--theme-primary)' }}>
              Configuration → Layout Designer
            </Link>.
          </p>
        </div>
      ) : plan && arch ? (
        // The 2D style's side panel (operator chose "Legend + summary + north
        // arrow"): the drawing takes what is left of the panel's width.
        //
        // UNDER the drawing for a LANDSCAPE plan (2026-10-01, Microbiology,
        // operator: "width is small,rooms and text are slightly no space and
        // look is not good"). A plan that wide is sized by the panel's WIDTH,
        // and the 224px panel beside it cost a fifth of that while the space
        // under the drawing stood empty: the same legend as a strip gives the
        // drawing the whole width — every room and every word on it a fifth
        // larger. A portrait plan (QC) is sized by HEIGHT and keeps the side.
        //
        // And under a plan that is about SQUARE too (QC 3, same day, operator:
        // "increase widgth and give legend on below the layout"). In a panel
        // wider than the plan that is a trade, not a gain: such a plan is
        // sized by the panel's HEIGHT, and the strip takes about 45px of it.
        // The operator asked for it; a taller panel, or Full screen, is what
        // makes that plan larger.
        <div className={legendUnder ? 'flex min-h-0 flex-1 flex-col gap-2' : 'flex min-h-0 flex-1 gap-3'}>
          <div className={`min-h-0 min-w-0 flex-1 overflow-hidden rounded-b-2xl border border-slate-300 bg-white shadow-soft ${legendUnder ? 'p-1.5' : 'p-3'}`}>
            {floorSvg}
          </div>
          <ArchSidePanel summary={archSummary(roomViews.flatMap((v) => v.rows), sensorWords)} strip={legendUnder} />
        </div>
      ) : plan && (
        <div className="min-h-0 flex-1 overflow-hidden rounded-b-2xl border border-slate-300 bg-white p-3 shadow-soft">
          {floorSvg}
        </div>
      )}

      {/* Status legend. The room-grade legend was removed 2026-08-24 at the
          operator's request. Since 2026-09-22 a chip carries no glyph, so this
          bar is the ONE place the colours are named — do not remove it. */}
      {!arch && <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200/70 px-4 py-3">
        <span className="text-xs font-semibold text-slate-700">Reading colour:</span>
        {LEGEND.map(({ tone, label, sample }) => (
          <span key={tone} className="flex items-center gap-1.5 text-xs text-slate-600">
            <span
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[0.625rem] font-bold text-white"
              style={{ backgroundColor: CHIP[tone].bg }}
            >
              {sample}
            </span>
            {label}
          </span>
        ))}
      </div>}
    </div>
  );
}

/**
 * The 2D style's side panel: what each mark means, how many instruments are
 * in each state, and the plan's orientation. The counts are the server's
 * statuses bucketed (`archSummary`), one bucket per instrument, so they sum.
 *
 * The arrow is PLAN north — the top of the drawing. The source drawing
 * (`Layouts/CWH/QC Layout-2.png`) marks no true north, and an unqualified "N"
 * would assert an orientation nobody recorded; the caption says so.
 */
function ArchSidePanel({ summary, strip = false }: { summary: ReturnType<typeof archSummary>; strip?: boolean }) {
  const states: { tone: ChipTone; label: string }[] = [
    { tone: 'OK', label: statusClasses('OK').label },
    { tone: 'OUT_OF_SPEC', label: statusClasses('OUT_OF_SPEC').label },
    { tone: 'ERROR', label: 'Sensor error' },
    { tone: 'STALE', label: statusClasses('STALE').label },
  ];
  const counts: { label: string; value: number; color: string }[] = [
    { label: 'Instruments', value: summary.total, color: '#0f172a' },
    { label: statusClasses('OK').label, value: summary.ok, color: CHIP.OK.bg },
    { label: statusClasses('OUT_OF_SPEC').label, value: summary.outOfLimit, color: CHIP.OUT_OF_SPEC.bg },
    { label: 'Sensor error', value: summary.fault, color: CHIP.ERROR.bg },
    { label: 'Offline / no data', value: summary.other, color: CHIP.STALE.bg },
  ];
  // Under a LANDSCAPE plan the same content is one STRIP: beside it, the panel
  // took a fifth of the width from a drawing whose width is what limits its
  // size (see `legendUnder` in FloorplanView).
  const item = strip ? 'flex items-center gap-1.5' : 'flex items-center gap-2.5';
  return (
    <aside
      className={strip
        ? 'flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1.5 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-xs shadow-soft'
        : 'flex w-56 shrink-0 flex-col gap-4 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-soft'}
      data-testid="fp-arch-panel"
      data-layout={strip ? 'strip' : 'side'}
      aria-label="Floor plan legend and summary"
    >
      <section className={strip ? 'flex flex-wrap items-center gap-x-3 gap-y-1' : undefined}>
        <h4 className={strip ? 'text-[0.6875rem] font-bold tracking-wider text-slate-900' : 'mb-2 text-xs font-bold tracking-wider text-slate-900'}>LEGEND</h4>
        <ul className={strip ? 'flex flex-wrap items-center gap-x-3.5 gap-y-1 text-slate-700' : 'space-y-2 text-slate-700'}>
          {states.map(({ tone, label }) => (
            <li key={tone} className={item}>
              <span className="h-4 w-6 rounded" style={{ background: `linear-gradient(${ARCH.wash[tone]}, ${ARCH.washTo[tone]})`, border: `2px solid ${CHIP[tone].bg}` }} aria-hidden="true" />
              {label}
            </li>
          ))}
          <li className={item}>
            <span className="h-4 w-6 rounded border-2 border-slate-300" style={{ background: `linear-gradient(${ARCH.emptyWash}, ${ARCH.emptyWashTo})` }} aria-hidden="true" />
            No instrument
          </li>
          {/* The two pill tints carry a meaning — which reading is which — so
              they are named here like every other colour on the plan. */}
          {(['temperature', 'humidity'] as const).map((q) => (
            <li key={q} className={item}>
              <span className="h-4 w-6 rounded" style={{ background: ARCH.pill[q].bg, border: `1px solid ${ARCH.pill[q].ink}` }} aria-hidden="true" />
              {q === 'temperature' ? 'Temperature' : 'Humidity'}
            </li>
          ))}
          <li className={item}>
            <svg width="24" height="10" aria-hidden="true"><line x1="0" y1="5" x2="24" y2="5" stroke={ARCH.wallOuter} strokeWidth="7" /><line x1="0" y1="5" x2="24" y2="5" stroke={ARCH.wallInner} strokeWidth="2" /></svg>
            Wall
          </li>
          <li className={item}>
            <svg width="24" height="20" aria-hidden="true"><path d="M3 18 A16 16 0 0 0 19 2" fill="none" stroke={ARCH.doorSwing} strokeDasharray="3 2" /><line x1="3" y1="18" x2="3" y2="2" stroke={ARCH.doorLeaf} strokeWidth="2.5" /></svg>
            Door and swing
          </li>
          <li className={item}>
            <svg width="24" height="16" aria-hidden="true">
              <defs><pattern id="fp-legend-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill={ARCH.columnFill} /><line x1="0" y1="0" x2="0" y2="4" stroke={ARCH.columnInk} strokeWidth="1.4" /></pattern></defs>
              <rect x="1" y="1" width="22" height="14" fill="url(#fp-legend-hatch)" stroke={ARCH.wallOuter} strokeWidth="1.5" />
            </svg>
            Structural column
          </li>
          <li className={item}>
            <svg width="24" height="10" aria-hidden="true"><rect x="1" y="1" width="22" height="8" fill={ARCH.windowFill} stroke={ARCH.windowInk} /><line x1="1" y1="5" x2="23" y2="5" stroke={ARCH.windowInk} /></svg>
            Window
          </li>
        </ul>
      </section>
      <section className={strip ? 'flex flex-wrap items-center gap-x-3 gap-y-1' : undefined}>
        <h4 className={strip ? 'text-[0.6875rem] font-bold tracking-wider text-slate-900' : 'mb-2 text-xs font-bold tracking-wider text-slate-900'}>SUMMARY</h4>
        <dl className={strip ? 'flex flex-wrap items-baseline gap-x-3.5 gap-y-1' : 'space-y-1.5'}>
          {counts.map(({ label, value, color }) => (
            <div key={label} className={strip ? 'flex items-baseline gap-1.5' : 'flex items-baseline justify-between'}>
              <dt className="text-slate-600">{label}</dt>
              <dd className={strip ? 'text-sm font-bold tabular-nums' : 'text-base font-bold tabular-nums'} style={{ color }}>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section
        className={strip ? 'ml-auto flex items-center gap-1.5' : 'mt-auto flex flex-col items-center gap-1 text-center'}
        title={strip ? 'Plan north. True north is not marked on the drawing.' : undefined}
      >
        <svg width={strip ? 26 : 64} height={strip ? 26 : 64} viewBox="-32 -32 64 64" role="img" aria-label="Plan north: the top of the drawing">
          <circle r="30" fill="#ffffff" stroke="#cbd5e1" strokeWidth={strip ? 2.5 : 1} />
          <path d="M0 -22 L9 9 L0 3 L-9 9 Z" fill="#0f172a" />
          <text y="23" textAnchor="middle" fontSize="11" fontWeight="700" fill="#0f172a">N</text>
        </svg>
        {/* The strip says it in two words and keeps the sentence as a tooltip. */}
        <p className="text-[0.6875rem] leading-tight text-slate-500">{strip ? 'Plan north' : 'Plan north. True north is not marked on the drawing.'}</p>
      </section>
    </aside>
  );
}
