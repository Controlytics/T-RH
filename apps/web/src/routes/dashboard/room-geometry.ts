/**
 * The floor drawing's maths, as pure functions.
 *
 * Extracted from `floorplan-view.tsx` because the SVG it produces cannot be
 * meaningfully asserted in jsdom, but every number going into it can — and the
 * numbers are where this breaks. Nothing here touches React or the DOM.
 *
 * Design: docs/superpowers/specs/2026-08-24-scada-floorplan-view-design.md
 */

import {
  rectanglePoints, polygonEdges, signedArea, doorEdge, sharedEdges,
  type Polygon, type EdgeOpening,
} from '@digilog/shared';

export type DoorWall = 'top' | 'right' | 'bottom' | 'left';
export type DoorKind = 'ENTRY' | 'EXIT' | 'PASSAGE';

/**
 * Mirrors the API shape (`floorplans/validation.ts`). `offset` and `width` are
 * fractions of the WALL's length, not of the plan — that is what keeps a door
 * attached to its room when the room moves or is resized.
 *
 * A door drawn before 2026-09-22 names its `wall`; a door on a polygon room
 * (Layout Designer) names its `edge`. `doorToEdgeOpening` is the ONE place the
 * two are reconciled — including the direction flip below.
 */
export interface RoomDoor {
  wall?: DoorWall;
  edge?: number;
  offset: number;
  width: number;
  kind: DoorKind;
  /** Which end of the opening the leaf hangs on, along the EDGE's direction:
   *  'start' (default — every door before 2026-10-01), 'end', or 'none' (an
   *  opening with no leaf). */
  hinge?: 'start' | 'end' | 'none';
}

/** A room's box in viewBox units — already multiplied out of normalized space. */
export interface PixelBox { x: number; y: number; w: number; h: number }

export interface Segment { x1: number; y1: number; x2: number; y2: number }

export interface DoorPlacement {
  /** The polygon edge the door sits on (0..3 for a rectangle). */
  edge: number;
  /** The wall name, for a door that was stored by wall. */
  wall?: DoorWall;
  kind: DoorKind;
  /** The opening itself, along the wall. */
  start: Segment;
  /** The end of the opening the leaf is hinged at. */
  hinge: { x: number; y: number };
  /** The leaf, drawn open into the room. */
  leaf: Segment;
  /** The swing arc, as an SVG path `d`. */
  arc: string;
}

/**
 * Kills the float noise that `offset + width` produces (0.4 + 0.2 is
 * 0.6000000000000001 in JS) before it reaches a pixel coordinate. The rooms
 * are drawn in viewBox units far coarser than 1e-9, so this loses nothing
 * visually while keeping equal openings actually equal.
 */
function clean(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

/**
 * A door as an opening on a polygon edge.
 *
 * DIRECTION FLIP, and why it is here and nowhere else: a wall-named door's
 * `offset` runs left→right along the bottom wall and top→bottom along the left
 * wall (the way the old `wallLine` traversed them), but polygon edges 2 and 3
 * of a rectangle run right→left and bottom→top (the outline is clockwise). A
 * stored bottom-wall door at offset 0.4 must still draw 0.4 from the LEFT, so
 * its fraction is mirrored onto the edge. A door stored by `edge` is already in
 * edge terms and passes through. Null = an edge the room does not have.
 */
export function doorToEdgeOpening(door: RoomDoor, points: Polygon | null): EdgeOpening | null {
  const edge = doorEdge(door, points);
  if (edge < 0) return null;
  const reversed = door.edge === undefined && (door.wall === 'bottom' || door.wall === 'left');
  const offset = reversed ? clean(1 - door.offset - door.width) : door.offset;
  return { edge, offset, width: door.width };
}

function pointOn(points: Polygon, i: number, t: number): { x: number; y: number } {
  const e = polygonEdges(points)[i];
  return { x: clean(e.x1 + (e.x2 - e.x1) * t), y: clean(e.y1 + (e.y2 - e.y1) * t) };
}

/** Unit vector INTO the room from edge i, and the edge's length. */
function edgeInward(points: Polygon, i: number): { x: number; y: number; length: number } {
  const e = polygonEdges(points)[i];
  const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1) || 1;
  const dx = (e.x2 - e.x1) / len, dy = (e.y2 - e.y1) / len;
  // Clockwise on screen (signed area > 0 with y down): inside is to the RIGHT
  // of the edge direction, i.e. the direction rotated a quarter turn clockwise.
  return signedArea(points) > 0 ? { x: -dy, y: dx, length: len } : { x: dy, y: -dx, length: len };
}

/**
 * Every edge of the outline, each cut into the pieces its openings leave.
 *
 * A stroked `<polygon>` cannot have a hole in it, and overpainting a gap with
 * the background colour breaks the moment the room is hovered or the palette
 * changes. A gap has to be an ABSENCE of wall.
 */
export function polygonWalls(points: Polygon, openings: EdgeOpening[]): Segment[] {
  const out: Segment[] = [];
  points.forEach((_, i) => {
    const onEdge = openings
      .filter((o) => o.edge === i)
      .map((o) => ({ start: o.offset, end: clean(o.offset + o.width) }))
      .sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const o of onEdge) {
      if (o.start > cursor) {
        const a = pointOn(points, i, cursor), b = pointOn(points, i, o.start);
        out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
      cursor = Math.max(cursor, o.end);
    }
    // The remainder past the last opening. Skipped when an opening reaches the
    // corner, so no zero-length stub is emitted.
    if (cursor < 1) {
      const a = pointOn(points, i, cursor), b = pointOn(points, i, 1);
      out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  });
  return out;
}

/**
 * Each door as plan notation: the opening, a leaf hinged at its start, and the
 * quarter-circle it sweeps. Always drawn INTO the room — a leaf swinging out
 * would overlap the neighbouring room and read as that room's door.
 */
export function polygonDoorPlacements(points: Polygon, doors: RoomDoor[] | null | undefined): DoorPlacement[] {
  const sweep = signedArea(points) > 0 ? 1 : 0;
  return (doors ?? []).flatMap((door) => {
    const o = doorToEdgeOpening(door, points);
    if (!o) return [];
    // An opening with no leaf: the wall is cut (by the caller), nothing swings.
    if (door.hinge === 'none') return [];
    const inward = edgeInward(points, o.edge);
    const a = pointOn(points, o.edge, o.offset);
    const b = pointOn(points, o.edge, clean(o.offset + o.width));
    // Hung at the END: the leaf stands at the far end and the swing runs back
    // the other way round, so the sweep flag flips with it.
    const atEnd = door.hinge === 'end';
    const hinge = atEnd ? b : a;
    const far = atEnd ? a : b;
    const span = o.width * inward.length;
    const leafEnd = { x: clean(hinge.x + inward.x * span), y: clean(hinge.y + inward.y * span) };
    // The swing is a quarter circle CENTRED ON THE HINGE. The flag below was
    // inverted until 2026-10-01 — every door on every plan drew its arc
    // centred on the far inner corner, bulging toward the hinge (found by
    // computing each rendered arc's centre against the QC Layout-2 drawing).
    const turn = atEnd ? sweep : 1 - sweep;
    return [{
      edge: o.edge,
      wall: door.wall,
      kind: door.kind,
      start: { x1: hinge.x, y1: hinge.y, x2: far.x, y2: far.y },
      hinge,
      leaf: { x1: hinge.x, y1: hinge.y, x2: leafEnd.x, y2: leafEnd.y },
      arc: `M ${leafEnd.x} ${leafEnd.y} A ${span} ${span} 0 0 ${turn} ${far.x} ${far.y}`,
    }];
  });
}

/**
 * Where this outline's edges coincide with a neighbour's, as openings on MY
 * edges. The caller decides WHICH neighbours qualify (the view passes the other
 * circulation rooms and the pieces of one code); this only does the geometry.
 * `tol` is in the caller's units — 0.5 for a 1000-unit viewBox.
 */
export function polygonSharedOpenings(points: Polygon, neighbours: Polygon[], tol = 0.5): EdgeOpening[] {
  return neighbours.flatMap((n) =>
    sharedEdges(points, n, tol).map((s) => ({ edge: s.aEdge, offset: s.start, width: clean(s.end - s.start) })));
}

/**
 * An opening in a wall that is NOT a door: the stretch where this room and a
 * neighbour are one continuous space. Same fractions-of-the-wall shape as a
 * door so `wallSegments` can cut it out the same way; never given a leaf or
 * an arc, because there is nothing there to swing.
 */
export type WallOpening = { wall?: DoorWall; edge?: number; offset: number; width: number };

// ── Rectangle wrappers: the old signatures, over the polygon path ────────────
// A rectangle is `rectanglePoints(box)`; a wall name is an edge 0..3 with the
// direction flip `doorToEdgeOpening` applies. Kept so every rectangle caller
// (and its tests) is byte-for-byte the four-corner case of the polygon path.

const WALL_NAMES: DoorWall[] = ['top', 'right', 'bottom', 'left'];

export function wallSegments(box: PixelBox, doors: WallOpening[] | null | undefined): Segment[] {
  const poly = rectanglePoints(box);
  const openings = (doors ?? []).flatMap((d) => {
    const o = doorToEdgeOpening({ ...d, kind: 'PASSAGE' }, null);
    return o ? [o] : [];
  });
  return polygonWalls(poly, openings);
}

export function doorPlacements(box: PixelBox, doors: RoomDoor[] | null | undefined): DoorPlacement[] {
  return polygonDoorPlacements(rectanglePoints(box), doors);
}

export function sharedOpenings(box: PixelBox, neighbours: PixelBox[], tol = 0.5): WallOpening[] {
  return polygonSharedOpenings(rectanglePoints(box), neighbours.map(rectanglePoints), tol).map((o) => {
    // Back to wall terms, mirroring edges 2 and 3 the way doorToEdgeOpening does.
    const reversed = o.edge === 2 || o.edge === 3;
    return { wall: WALL_NAMES[o.edge], offset: reversed ? clean(1 - o.offset - o.width) : o.offset, width: o.width };
  });
}

export type DegradeStep = 'FULL' | 'VALUES_ONLY' | 'OVERFLOW' | 'COMPACT' | 'CODE_ONLY';

export interface TileLayout {
  step: DegradeStep;
  visible: number;
  hidden: number;
  cols: number;
  rows: number;
  tile: { w: number; h: number };
  fontSize: number;
  bodyTop: number;
}

/** Below these, a tile cannot hold legible text at all. viewBox units. */
const MIN_TILE_W = 46;
/** A tile showing values but no instrument code needs less height. */
const VALUES_TILE_H = 18;
/** Room for the code strip along the room's top edge. */
const HEADER_H = 14;

/**
 * The renderer (`floorplan-view.tsx`) draws each chip at `fontSize *
 * CHIP_HEIGHT_FACTOR` tall, stacked `CHIP_GAP` apart, starting `TILE_HEADER_H +
 * FULL_CODE_GAP` down when the ID + Location strip precedes them (FULL) or a flat
 * `VALUES_TOP_GAP` down when it doesn't (VALUES_ONLY / OVERFLOW). It drops any
 * chip whose bottom would exceed the tile — so a layout step is only really
 * FULL or VALUES_ONLY if the tile it hands back is tall enough for BOTH
 * chips, not just the one that happens to fit. EXPORTED, and the renderer and
 * the tests IMPORT them (2026-09-22): until then each of the three hand-copied
 * the literals, and a module that promises a tile the renderer then quietly
 * clips is exactly what a copy that drifted would produce.
 *
 * The CODE LINE IS A FIXED HEIGHT, not the reading font (operator, 2026-09-22:
 * "decrease instrument id font size, text looking so large"). The first cut
 * of the fill-the-tile font printed the code at 0.85 of the reading font, so a
 * 26-unit reading came with a 22-unit code: the identity shouting over the
 * measurement. The code prints at TILE_CODE_FONT (or smaller, to fit its
 * tile's width) inside a CODE_LINE_H strip, and the readings take the rest.
 */
export const CHIP_HEIGHT_FACTOR = 1.3;
export const CHIP_GAP = 1.5;
export const FULL_CODE_GAP = 3;
export const VALUES_TOP_GAP = 2;
// 2026-10-01 (operator: "increase location name font size and instrument id
// font size"): 10 -> 14, and the Location line 8.5 -> 12 below. Each still
// shrinks to fit a narrow tile, and the readings are sized from what is left.
export const CODE_LINE_H = 17;
export const TILE_CODE_FONT = 14;
/**
 * The LOCATION line under the ID (operator, 2026-09-22: "in rooms show
 * Instrument ID, Location and Values dont show any other things"). The tile's
 * strip is now two lines — ID, then the instrument's `Location` attribute —
 * and the readings start under both; `TILE_HEADER_H` is that strip.
 */
export const LOCATION_LINE_H = 15;
export const TILE_LOCATION_FONT = 12;
export const TILE_HEADER_H = CODE_LINE_H + LOCATION_LINE_H;

/**
 * THE FONT FILLS THE TILE (operator, 2026-09-22: "in layouts show instruments
 * live temperature and humidity values ..."). Every placed instrument already
 * had a tile, but the readings printed at 12 units inside rooms 100-500 wide,
 * so on a wall display the floor read as empty boxes with a smudge in each.
 * The step chosen above is the font at which the tile FITS; `fillFont` then
 * grows it until the tile is full, bounded three ways:
 *
 *   - HEIGHT: both chips and the gap above them must still fit, the SAME
 *     equation `twoChipsHeight` states, solved for the font; the chip-fit test
 *     in `room-geometry.test.ts` holds at the grown size exactly as it did at
 *     the base size, or a FULL tile would clip its humidity chip again.
 *   - WIDTH: the renderer prints a chip label at CHIP_GLYPH_EM per glyph plus
 *     CHIP_TEXT_PAD, and the longest label is nine glyphs ("100.0 %RH" — the
 *     value with its unit, no status glyph since 2026-09-22), which must fit
 *     inside the tile less CHIP_SIDE_INSET. A tile 63 wide (Module-F's
 *     narrowest) stays width-bound.
 *   - MAX_TILE_FONT: above this a reading stops being a label and becomes a
 *     poster that dwarfs the room it is in. 26 for the first hours of
 *     2026-09-22; the operator's "decrease values font sizes" brought it to
 *     16 — a third larger than the 12 the readings printed at before that day.
 *
 * Never SMALLER than the base: the step already proved the base fits.
 */
export const MAX_TILE_FONT = 16;
const CHIP_GLYPH_EM = 0.6;
const CHIP_LABEL_GLYPHS = 9;
const CHIP_SIDE_INSET = 6;
const CHIP_TEXT_PAD = 4;

function fillFont(base: number, tileW: number, tileH: number, codeLine: boolean): number {
  // twoChipsHeight(f, topGap) = topGap + 2*factor*f + gap, solved for f; the
  // top gap is the fixed code strip in FULL and a flat inset otherwise.
  const topGap = codeLine ? TILE_HEADER_H + FULL_CODE_GAP : VALUES_TOP_GAP;
  const byHeight = (tileH - topGap - CHIP_GAP) / (2 * CHIP_HEIGHT_FACTOR);
  const byWidth = (tileW - CHIP_SIDE_INSET - CHIP_TEXT_PAD) / (CHIP_LABEL_GLYPHS * CHIP_GLYPH_EM);
  // Floor to half a unit so the height bound holds after floating-point rounding.
  const grown = Math.floor(Math.min(MAX_TILE_FONT, byHeight, byWidth) * 2) / 2;
  return Math.max(base, grown);
}

/** The tile height needed to show two stacked chips, given the top offset before the first one. */
function twoChipsHeight(fontSize: number, topGap: number): number {
  const chipH = fontSize * CHIP_HEIGHT_FACTOR;
  return topGap + 2 * chipH + CHIP_GAP;
}

/**
 * How many instrument tiles fit, and what has to be given up when they do not.
 *
 * Text degrades in FIXED, ORDERED steps rather than shrinking continuously:
 * overlapping text is worse than absent text, and a font that keeps shrinking
 * produces a floor where half the rooms are unreadable but none of them look
 * broken. The step is chosen from measured size, never guessed.
 */
/** One caption line, and the room name that sits above them. */
const CAPTION_LINE_H = 9.5;
const NAME_LINE_H = 11;

/**
 * How much header a TRACED room may reserve for its captions — and whether it
 * gets them at all.
 *
 * A traced room wants to print four lines where a generated one prints one: the
 * code, the room name, `FCH: 2.7m` and its floor dimensions. That space comes
 * out of the tile grid, so on a short room the captions and the readings are in
 * direct competition.
 *
 * **The readings win, always.** A transcribed ceiling height is reference
 * material; a temperature is why the screen exists, and a room that hid its
 * reading behind a dimension line would be a monitoring screen that had stopped
 * monitoring. So the captions are costed first: if reserving their space would
 * show fewer instruments than not reserving it, they are dropped and the room
 * falls back to exactly what a generated room shows.
 *
 * This replaced a fixed `h >= 78` threshold in the view. That threshold happened
 * to hold for all twelve instrument rooms on the QC plan, but it encoded no
 * reason — resize one room, or add one with two instruments, and it would have
 * started hiding readings with nothing to catch it.
 */
export function captionHeader(
  box: PixelBox,
  count: number,
  opts: { name: boolean; lines: number },
): { headerH: number; captions: boolean } {
  const plain = { headerH: HEADER_H, captions: false };
  if (opts.lines <= 0) return plain;
  const wanted = HEADER_H + (opts.name ? NAME_LINE_H : 0) + opts.lines * CAPTION_LINE_H;
  // A room with nothing in it has no readings to lose.
  if (count <= 0) return { headerH: wanted, captions: true };
  if (wanted >= box.h) return plain;
  return tileLayout(box, count, wanted).visible >= tileLayout(box, count).visible
    ? { headerH: wanted, captions: true }
    : plain;
}

/**
 * @param headerH how much vertical space the room's own captions need before
 *   the tiles start. Defaults to one line for the code. A TRACED room also
 *   prints its name, its ceiling height and its floor dimensions, and those
 *   lines have to be reserved HERE rather than guessed at by the view — the
 *   tile grid is sized from the leftover, so a view that drew four caption
 *   lines into a 14px header would lay the first row of readings on top of
 *   them.
 */
export function tileLayout(box: PixelBox, count: number, headerH: number = HEADER_H): TileLayout {
  const bodyTop = box.y + headerH;
  const bodyH = box.h - headerH;
  const empty: TileLayout = {
    step: 'CODE_ONLY', visible: 0, hidden: Math.max(0, count), cols: 0, rows: 0,
    tile: { w: 0, h: 0 }, fontSize: 8, bodyTop,
  };

  if (count <= 0) return { ...empty, hidden: 0 };
  // Not enough body left for even a values-only tile: the room can carry its
  // code and nothing else.
  if (box.w < MIN_TILE_W || bodyH < VALUES_TILE_H) return empty;

  const rawCols = Math.max(1, Math.floor(box.w / MIN_TILE_W));
  // Never spread instruments across more columns than there are instruments —
  // one instrument in a wide room gets one wide tile, not a narrow tile in a
  // grid with empty columns beside it.
  const cols = Math.max(1, Math.min(rawCols, count));
  const tileW = box.w / cols;

  const fullFontSize = Math.max(8, Math.min(12, tileW / 4.5));
  const fullRequiredH = twoChipsHeight(fullFontSize, TILE_HEADER_H + FULL_CODE_GAP);
  const fullRows = Math.max(0, Math.floor(bodyH / fullRequiredH));
  const fullCapacity = cols * fullRows;

  if (fullRows >= 1 && fullCapacity >= count) {
    const rows = Math.ceil(count / cols);
    const tileH = bodyH / rows;
    return {
      step: 'FULL', visible: count, hidden: 0,
      cols, rows,
      tile: { w: tileW, h: tileH },
      fontSize: fillFont(fullFontSize, tileW, tileH, true),
      bodyTop,
    };
  }

  // Drop the instrument code line: values are what a control room reads first,
  // and the tile is still clickable through to the instrument.
  const valuesFontSize = Math.max(8, Math.min(11, tileW / 5));
  const valuesRequiredH = twoChipsHeight(valuesFontSize, VALUES_TOP_GAP);
  const valueRows = Math.max(0, Math.floor(bodyH / valuesRequiredH));
  const valueCapacity = cols * valueRows;

  if (valueRows >= 1 && valueCapacity >= count) {
    const rows = Math.ceil(count / cols);
    const tileH = bodyH / rows;
    return {
      step: 'VALUES_ONLY', visible: count, hidden: 0,
      cols, rows,
      tile: { w: tileW, h: tileH },
      fontSize: fillFont(valuesFontSize, tileW, tileH, false),
      bodyTop,
    };
  }

  if (valueRows >= 1 && valueCapacity >= 2) {
    // One slot goes to the "+K" marker, so the count it reports is honest.
    const visible = valueCapacity - 1;
    return {
      step: 'OVERFLOW', visible, hidden: count - visible,
      cols, rows: valueRows,
      tile: { w: tileW, h: bodyH / valueRows },
      fontSize: valuesFontSize,
      bodyTop,
    };
  }

  if (valueRows >= 1) {
    // One reading block for the room, as the view drew before tiles existed.
    return {
      step: 'COMPACT', visible: 1, hidden: count - 1,
      cols: 1, rows: 1,
      tile: { w: box.w, h: bodyH },
      fontSize: Math.max(8, Math.min(11, box.w / 6)),
      bodyTop,
    };
  }

  return empty;
}
