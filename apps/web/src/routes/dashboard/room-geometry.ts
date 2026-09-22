/**
 * The floor drawing's maths, as pure functions.
 *
 * Extracted from `floorplan-view.tsx` because the SVG it produces cannot be
 * meaningfully asserted in jsdom, but every number going into it can — and the
 * numbers are where this breaks. Nothing here touches React or the DOM.
 *
 * Design: docs/superpowers/specs/2026-08-24-scada-floorplan-view-design.md
 */

export type DoorWall = 'top' | 'right' | 'bottom' | 'left';
export type DoorKind = 'ENTRY' | 'EXIT' | 'PASSAGE';

/**
 * Mirrors the API shape (`floorplans/validation.ts`). `offset` and `width` are
 * fractions of the WALL's length, not of the plan — that is what keeps a door
 * attached to its room when the room moves or is resized.
 */
export interface RoomDoor {
  wall: DoorWall;
  offset: number;
  width: number;
  kind: DoorKind;
}

/** A room's box in viewBox units — already multiplied out of normalized space. */
export interface PixelBox { x: number; y: number; w: number; h: number }

export interface Segment { x1: number; y1: number; x2: number; y2: number }

export interface DoorPlacement {
  wall: DoorWall;
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

const WALLS: DoorWall[] = ['top', 'right', 'bottom', 'left'];

/**
 * Where a wall starts and ends, and which way "along" it runs. Every wall is
 * traversed from its own origin so a door's `offset` means the same thing on
 * all four — otherwise a door dragged along the bottom wall would travel the
 * opposite way to one dragged along the top.
 */
function wallLine(box: PixelBox, wall: DoorWall): { from: { x: number; y: number }; to: { x: number; y: number }; length: number; inward: { x: number; y: number } } {
  const { x, y, w, h } = box;
  switch (wall) {
    case 'top':
      return { from: { x, y }, to: { x: x + w, y }, length: w, inward: { x: 0, y: 1 } };
    case 'right':
      return { from: { x: x + w, y }, to: { x: x + w, y: y + h }, length: h, inward: { x: -1, y: 0 } };
    case 'bottom':
      return { from: { x, y: y + h }, to: { x: x + w, y: y + h }, length: w, inward: { x: 0, y: -1 } };
    case 'left':
      return { from: { x, y }, to: { x, y: y + h }, length: h, inward: { x: 1, y: 0 } };
  }
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

function pointAt(box: PixelBox, wall: DoorWall, t: number): { x: number; y: number } {
  const { from, to } = wallLine(box, wall);
  return { x: clean(from.x + (to.x - from.x) * t), y: clean(from.y + (to.y - from.y) * t) };
}

/**
 * The four walls, each cut into the pieces the doors leave behind.
 *
 * A stroked `<rect>` cannot have a hole in it, and overpainting a gap with the
 * background colour breaks the moment the room is hovered or the palette
 * changes. A gap has to be an ABSENCE of wall.
 */
export function wallSegments(box: PixelBox, doors: WallOpening[] | null | undefined): Segment[] {
  const all = doors ?? [];
  const out: Segment[] = [];

  for (const wall of WALLS) {
    const onWall = all
      .filter((d) => d.wall === wall)
      .map((d) => ({ start: d.offset, end: d.offset + d.width }))
      .sort((a, b) => a.start - b.start);

    let cursor = 0;
    for (const opening of onWall) {
      if (opening.start > cursor) {
        const a = pointAt(box, wall, cursor);
        const b = pointAt(box, wall, opening.start);
        out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
      cursor = Math.max(cursor, opening.end);
    }
    // The remainder past the last door. Skipped when a door reaches the corner,
    // so no zero-length stub is emitted — an invisible segment that still costs
    // a DOM node and shows up as a dot under a round line cap.
    if (cursor < 1) {
      const a = pointAt(box, wall, cursor);
      const b = pointAt(box, wall, 1);
      out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }

  return out;
}

/**
 * An opening in a wall that is NOT a door: the stretch where this room and a
 * neighbour are one continuous space. Same fractions-of-the-wall shape as a
 * door so `wallSegments` can cut it out the same way; never given a leaf or
 * an arc, because there is nothing there to swing.
 */
export type WallOpening = Pick<RoomDoor, 'wall' | 'offset' | 'width'>;

/**
 * Where this room's walls coincide with a neighbour's, as openings.
 *
 * A room is ONE rectangle in the schema, so an L-shaped corridor is stored as
 * two or three of them — and drawn naively, the seam between the pieces is a
 * wall the building does not have. The operator's words (2026-09-21): "in
 * layout image corridor single line, not divided into separately". The caller
 * decides WHICH neighbours qualify (the view passes the other circulation
 * rooms); this only does the geometry: for each wall, the overlap with the
 * neighbour's facing wall, when the two lie on the same line within `tol`
 * viewBox units. Rooms that only touch at a corner produce nothing — a point
 * is not an opening.
 */
export function sharedOpenings(box: PixelBox, neighbours: PixelBox[], tol = 0.5): WallOpening[] {
  const out: WallOpening[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= tol;
  for (const n of neighbours) {
    // Vertical seams: my right against their left, my left against their right.
    if (near(box.x + box.w, n.x) || near(box.x, n.x + n.w)) {
      const lo = Math.max(box.y, n.y), hi = Math.min(box.y + box.h, n.y + n.h);
      if (hi - lo > tol && box.h > 0) {
        out.push({
          wall: near(box.x + box.w, n.x) ? 'right' : 'left',
          offset: clean((lo - box.y) / box.h),
          width: clean((hi - lo) / box.h),
        });
      }
    }
    // Horizontal seams: my bottom against their top, my top against their bottom.
    if (near(box.y + box.h, n.y) || near(box.y, n.y + n.h)) {
      const lo = Math.max(box.x, n.x), hi = Math.min(box.x + box.w, n.x + n.w);
      if (hi - lo > tol && box.w > 0) {
        out.push({
          wall: near(box.y + box.h, n.y) ? 'bottom' : 'top',
          offset: clean((lo - box.x) / box.w),
          width: clean((hi - lo) / box.w),
        });
      }
    }
  }
  return out;
}

/**
 * Each door as plan notation: the opening, a leaf hinged at its start, and the
 * quarter-circle it sweeps. Always drawn INTO the room — a leaf swinging out
 * would overlap the neighbouring room and read as that room's door.
 */
export function doorPlacements(box: PixelBox, doors: RoomDoor[] | null | undefined): DoorPlacement[] {
  return (doors ?? []).map((door) => {
    const { length, inward } = wallLine(box, door.wall);
    const hinge = pointAt(box, door.wall, door.offset);
    const far = pointAt(box, door.wall, door.offset + door.width);
    const span = door.width * length;

    const leafEnd = { x: hinge.x + inward.x * span, y: hinge.y + inward.y * span };
    // Sweep from the open leaf back to the closed position at the far jamb.
    const arc = `M ${leafEnd.x} ${leafEnd.y} A ${span} ${span} 0 0 1 ${far.x} ${far.y}`;

    return {
      wall: door.wall,
      kind: door.kind,
      start: { x1: hinge.x, y1: hinge.y, x2: far.x, y2: far.y },
      hinge,
      leaf: { x1: hinge.x, y1: hinge.y, x2: leafEnd.x, y2: leafEnd.y },
      arc,
    };
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
 * CHIP_HEIGHT_FACTOR` tall, stacked `CHIP_GAP` apart, starting `CODE_LINE_H +
 * FULL_CODE_GAP` down when a code line precedes them (FULL) or a flat
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
export const CODE_LINE_H = 12;
export const TILE_CODE_FONT = 10;

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
  const topGap = codeLine ? CODE_LINE_H + FULL_CODE_GAP : VALUES_TOP_GAP;
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
  const fullRequiredH = twoChipsHeight(fullFontSize, CODE_LINE_H + FULL_CODE_GAP);
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
