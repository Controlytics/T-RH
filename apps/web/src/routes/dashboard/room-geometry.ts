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
export function wallSegments(box: PixelBox, doors: RoomDoor[] | null | undefined): Segment[] {
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
