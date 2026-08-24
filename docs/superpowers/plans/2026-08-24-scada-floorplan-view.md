# SCADA-style Graphical Floor View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the dashboard's graphical view drawn entry/exit doors and one live tile per instrument inside each room box.

**Architecture:** Doors are a nullable `doors` JSONB column on `floorplan_rooms`, validated by the existing pure `validateRoomPayload` and saved through the existing `PUT /:id/rooms/:roomId` (so no new permission, reauth action or audit action). The drawing maths moves out of the TSX into a new pure module `room-geometry.ts` so wall splitting and text degradation are unit-testable; `floorplan-view.tsx` then renders walls as segments (a stroked `<rect>` cannot have a hole cut in it) and fills each room with per-instrument tiles.

**Tech Stack:** Fastify + Prisma + Postgres 18 (API), React + Vite + SWR + inline SVG (web), zod (validation), vitest (tests).

**Spec:** `docs/superpowers/specs/2026-08-24-scada-floorplan-view-design.md`

## Global Constraints

- **Windows box, PowerShell.** `&&` is not a PowerShell chain operator; use `;` or separate calls. The Bash tool is also available and takes POSIX syntax.
- **The API and web dev servers are the operator's.** Do not start, stop or restart them without asking — except where a step explicitly says the API must be stopped for `prisma generate` (it EPERMs while `tsx watch` holds the client DLL).
- **Two databases.** Every migration is applied to BOTH `compliance_core_db` and `compliance_core_db_test`. A migration applied to only one makes every instrument-touching e2e return 500.
- **Migrations are hand-authored.** `prisma migrate diff` in this repo emits destructive statements (DROP of the partitioned `instrument_telemetry_history`, a NOT NULL drop on the §11 hash-chain `audit_trail.chain_position`, a DROP/CREATE of an unchanged `instrument_credentials` FK). Never use its output verbatim.
- **Writing a SQL NULL into a Json column requires `Prisma.DbNull`.** `Prisma.JsonNull` stores the JSON literal `null` and is wrong.
- **Vitest here does not typecheck.** Green tests are not evidence the code compiles. Typechecking is a separate explicit command.
- **Playwright cannot get past login against this machine's mkcert setup.** No task may claim the drawing has been visually verified. The visual check is handed to the operator in Task 7.
- **Light theme only** (`bg-white`, `bg-slate-50`, `border-slate-200`). The dark palette is explicitly out of scope; only the palette *indirection* is built.
- **Chip colours are semantic and fixed** — `OUT_OF_SPEC #dc2626`, `STALE`/`PARTIAL` `#d97706`, `NO_DATA #64748b`, `OK #15803d`. Never substitute theme colours.
- **Status is never colour alone.** Every coloured chip keeps its glyph, and the legend keeps the pairing.
- **Counts must not move:** 34 models, 13 enums, 42 permissions, 46 reauth actions, 23 API modules, 25 config defs, 48 routes. If a step would change one of these, stop — the design has been misread.
- **No new file in `packages/shared`.** The web side mirrors the room shape by hand today (`FloorplanRoomShape` in `use-telemetry.ts`); doors follow that existing pattern rather than introducing a shared-package build dependency.

---

### Task 1: Door validation rules (API, pure)

**Files:**
- Modify: `apps/api/src/modules/floorplans/validation.ts`
- Test: `apps/api/src/modules/floorplans/__tests__/validation.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export type RoomDoor = { wall: 'top' | 'right' | 'bottom' | 'left'; offset: number; width: number; kind: 'ENTRY' | 'EXIT' | 'PASSAGE' }`, and `RoomInput` gains `doors?: RoomDoor[] | null`. `validateRoomPayload(input: unknown)` keeps its existing `{ ok: true; data: RoomInput } | { ok: false; error: string }` return.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/modules/floorplans/__tests__/validation.test.ts`:

```ts
const door = { wall: 'top' as const, offset: 0.2, width: 0.1, kind: 'ENTRY' as const };

describe('validateRoomPayload — doors', () => {
  it('accepts a room with no doors key at all — every existing room', () => {
    expect(validateRoomPayload(base).ok).toBe(true);
  });

  it('accepts an explicit null and an empty list', () => {
    expect(validateRoomPayload({ ...base, doors: null }).ok).toBe(true);
    expect(validateRoomPayload({ ...base, doors: [] }).ok).toBe(true);
  });

  it('accepts one door on each wall', () => {
    const doors = (['top', 'right', 'bottom', 'left'] as const).map((wall) => ({ ...door, wall }));
    expect(validateRoomPayload({ ...base, doors }).ok).toBe(true);
  });

  it('accepts a door flush against the far corner of its wall', () => {
    expect(validateRoomPayload({ ...base, doors: [{ ...door, offset: 0.8, width: 0.2 }] }).ok).toBe(true);
  });

  it('rejects an unknown wall', () => {
    const r = validateRoomPayload({ ...base, doors: [{ ...door, wall: 'ceiling' }] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/wall/i);
  });

  it('rejects an unknown kind', () => {
    const r = validateRoomPayload({ ...base, doors: [{ ...door, kind: 'AIRLOCK' }] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/kind/i);
  });

  it('rejects a zero-width door — a slip while dragging, never an intent', () => {
    expect(validateRoomPayload({ ...base, doors: [{ ...door, width: 0 }] }).ok).toBe(false);
  });

  it('rejects a negative offset', () => {
    expect(validateRoomPayload({ ...base, doors: [{ ...door, offset: -0.01 }] }).ok).toBe(false);
  });

  it('rejects a door running past the end of its wall', () => {
    const r = validateRoomPayload({ ...base, doors: [{ ...door, offset: 0.9, width: 0.2 }] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/past the end of the top wall/i);
  });

  it('rejects two doors overlapping on the same wall', () => {
    const doors = [
      { ...door, offset: 0.2, width: 0.2 },
      { ...door, offset: 0.3, width: 0.2 },
    ];
    const r = validateRoomPayload({ ...base, doors });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/overlap/i);
  });

  it('accepts two doors that merely touch end to start', () => {
    const doors = [
      { ...door, offset: 0.2, width: 0.2 },
      { ...door, offset: 0.4, width: 0.2 },
    ];
    expect(validateRoomPayload({ ...base, doors }).ok).toBe(true);
  });

  it('accepts overlapping offsets when the doors are on DIFFERENT walls', () => {
    const doors = [
      { ...door, wall: 'top' as const, offset: 0.2, width: 0.2 },
      { ...door, wall: 'left' as const, offset: 0.3, width: 0.2 },
    ];
    expect(validateRoomPayload({ ...base, doors }).ok).toBe(true);
  });

  it('rejects more than six doors — a runaway client, not a real room', () => {
    const doors = Array.from({ length: 7 }, (_, i) => ({ ...door, offset: i * 0.1, width: 0.05 }));
    expect(validateRoomPayload({ ...base, doors }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/api/src/modules/floorplans/__tests__/validation.test.ts`
Expected: the new `doors` describe block FAILS. Note that "rejects an unknown wall" may currently *pass by accident* (zod strips unknown keys, so the room without doors validates fine) — the ones that must fail are "rejects a door running past the end of its wall", "rejects two doors overlapping on the same wall" and "rejects more than six doors", because nothing enforces them yet.

- [ ] **Step 3: Add the schema**

In `apps/api/src/modules/floorplans/validation.ts`, after the `normalized` / `temperature` / `humidity` consts and before `roomSchema`:

```ts
/**
 * A door is normalized against its WALL, not against the plan: `offset` is where
 * the opening starts along that wall as a fraction of the wall's length, and
 * `width` is how much of the wall it takes. Normalizing against the wall (rather
 * than storing plan coordinates) is what keeps a door attached to its room when
 * the room is moved or resized in the editor.
 *
 * Doors are static geometry. NOTHING in this install senses a door, so a door
 * must never be drawn as though it carries a reading.
 */
const doorSchema = z.object({
  wall: z.enum(['top', 'right', 'bottom', 'left']),
  offset: normalized,
  width: normalized.refine((v) => v > 0, { message: 'must be greater than 0' }),
  kind: z.enum(['ENTRY', 'EXIT', 'PASSAGE']),
});

export type RoomDoor = z.infer<typeof doorSchema>;

/** The four walls, in the order the editor lists them. */
export const DOOR_WALLS = ['top', 'right', 'bottom', 'left'] as const;
```

Then add to the `roomSchema` object, after `rhMax`:

```ts
  // Six is a ceiling on a runaway client, not a judgement about architecture.
  doors: z.array(doorSchema).max(6).nullable().optional(),
```

- [ ] **Step 4: Add the cross-field rules**

In `validateRoomPayload`, immediately before the closing `return { ok: true, data: d };`:

```ts
  // A door must FINISH on its wall, for the same reason a room must finish
  // inside the plan: normalized coordinates make "starts in bounds" too weak.
  const doors = d.doors ?? [];
  for (let i = 0; i < doors.length; i++) {
    const door = doors[i];
    if (door.offset + door.width > 1) {
      return {
        ok: false,
        error: `doors.${i}: the door runs past the end of the ${door.wall} wall (offset + width must be at most 1).`,
      };
    }
  }

  // Two openings drawn on top of each other are not representable — one wall
  // cannot have two doors in the same place — so this is a drag that went wrong.
  for (const wall of DOOR_WALLS) {
    const onWall = doors.filter((door) => door.wall === wall).sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < onWall.length; i++) {
      const prev = onWall[i - 1];
      if (onWall[i].offset < prev.offset + prev.width) {
        return { ok: false, error: `doors: two doors overlap on the ${wall} wall.` };
      }
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run apps/api/src/modules/floorplans/__tests__/validation.test.ts`
Expected: PASS, including every pre-existing geometry and limit test.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -p apps/api/tsconfig.json --noEmit`
Expected: no errors. (Vitest does not typecheck; this is the only thing that proves it compiles.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/floorplans/validation.ts apps/api/src/modules/floorplans/__tests__/validation.test.ts
git commit -m "feat(floorplans): validate room door geometry"
```

---

### Task 2: Persist doors (schema, migration, routes, audit)

**Files:**
- Modify: `apps/api/prisma/schema.prisma:985-1015` (`model FloorplanRoom`)
- Create: `apps/api/prisma/migrations/20260824100000_floorplan_room_doors/migration.sql`
- Modify: `apps/api/src/modules/floorplans/routes.ts` (`roomSelect` ~line 33, `roomProps` ~line 39, POST handler ~line 250, PUT handler ~line 300)

**Interfaces:**
- Consumes: `RoomDoor` and the extended `RoomInput` from Task 1.
- Produces: `GET /api/floorplans` and `GET /api/floorplans/:id` now return `doors` on every room (`RoomDoor[] | null`); `POST /:id/rooms` and `PUT /:id/rooms/:roomId` accept it.

- [ ] **Step 1: Add the column to the schema**

In `apps/api/prisma/schema.prisma`, inside `model FloorplanRoom`, after the `rhMax` line:

```prisma
  /// Doors as drawn on the plan: an array of
  /// `{ wall, offset, width, kind }`, each normalized against ITS WALL so the
  /// door stays attached when the room is moved or resized. NULL = nobody has
  /// drawn doors for this room yet, which is the honest state of every row that
  /// predates the column. Validated in floorplans/validation.ts, never by a
  /// CHECK constraint, so a bad payload names its offending field.
  ///
  /// Static geometry only. Nothing in this install senses a door.
  doors Json?
```

- [ ] **Step 2: Hand-write the migration**

Create `apps/api/prisma/migrations/20260824100000_floorplan_room_doors/migration.sql`:

```sql
-- Doors drawn on a room's walls, for the graphical floor view.
--
-- HAND-AUTHORED. `prisma migrate diff` in this repo emits three DESTRUCTIVE
-- statements that must be stripped every time and are stripped here:
--   * DROP TABLE "instrument_telemetry_history" — partitioned, so Prisma's
--     datamodel cannot see it and reads it as stray. It holds live rows.
--   * ALTER "audit_trail" ALTER "chain_position" DROP NOT NULL — the 21 CFR §11
--     hash-chain position, backed by a manual sequence out of band.
--   * DROP/CREATE of an unchanged "instrument_credentials" foreign key.
-- Read the header of 20260811120000_instrument_floorplans before authoring the
-- next one.
--
-- Nullable with NO default: NULL means "no doors drawn yet", which is exactly
-- what every existing room is. A default of '[]' would claim someone had looked
-- at the room and decided it has no doors.
ALTER TABLE "floorplan_rooms" ADD COLUMN "doors" JSONB;
```

- [ ] **Step 3: Apply to BOTH databases**

Ask the operator to stop the API first (`prisma generate` EPERMs while `tsx watch` holds the client DLL), then:

```bash
cd apps/api
DATABASE_URL="postgresql://<user>:<pass>@localhost:5432/compliance_core_db" npx prisma migrate deploy
DATABASE_URL="postgresql://<user>:<pass>@localhost:5432/compliance_core_db_test" npx prisma migrate deploy
npx prisma generate
```

Take the real credentials from `apps/api/.env` — do not invent them, and do not rely on the repo-root `.env`, which has historically pointed at the sibling DigiLog checkout. Pass `DATABASE_URL` explicitly on every call.

- [ ] **Step 4: Verify both databases actually have the column**

```bash
psql "postgresql://<user>:<pass>@localhost:5432/compliance_core_db"      -c "\d floorplan_rooms" | grep doors
psql "postgresql://<user>:<pass>@localhost:5432/compliance_core_db_test" -c "\d floorplan_rooms" | grep doors
```

Expected: a `doors | jsonb` line from BOTH. If only one prints it, stop and fix that before continuing — this is the known failure mode that 500s every instrument e2e.

Then run the drift guard: `npm run db:verify-migrations` (needs `-ExecutionPolicy Bypass` if PowerShell blocks it). Expected: PASS.

- [ ] **Step 5: Expose doors on reads**

In `apps/api/src/modules/floorplans/routes.ts`, extend `roomSelect`:

```ts
const roomSelect = {
  id: true, code: true, label: true,
  x: true, y: true, w: true, h: true,
  tempMin: true, tempMax: true, rhMin: true, rhMax: true,
  doors: true,
} as const;
```

and `roomProps` — **this one matters more than it looks**: Fastify serializes responses against this schema and silently DROPS any property not declared, so an undeclared `doors` would arrive at the browser as `undefined` with no error anywhere:

```ts
const roomProps = {
  id: { type: 'string' },
  code: { type: 'string' },
  label: { type: 'string', nullable: true },
  x: { type: 'number' }, y: { type: 'number' },
  w: { type: 'number' }, h: { type: 'number' },
  tempMin: { type: 'number', nullable: true },
  tempMax: { type: 'number', nullable: true },
  rhMin: { type: 'number', nullable: true },
  rhMax: { type: 'number', nullable: true },
  doors: {
    type: 'array',
    nullable: true,
    items: {
      type: 'object',
      properties: {
        wall: { type: 'string' },
        offset: { type: 'number' },
        width: { type: 'number' },
        kind: { type: 'string' },
      },
    },
  },
} as const;
```

- [ ] **Step 6: Write doors on create and update**

Add the `Prisma` import at the top of `routes.ts`:

```ts
import { Prisma } from '@prisma/client';
```

Add a helper next to `IDENTITY_FIELDS`:

```ts
/**
 * `doors` is a Json column, so a SQL NULL needs Prisma.DbNull —
 * Prisma.JsonNull would store the JSON literal `null`, which reads back as a
 * value rather than an absence.
 */
function doorsForWrite(doors: RoomDoor[] | null | undefined) {
  return doors == null ? Prisma.DbNull : doors;
}

/** Readable in an audit entry. A raw JSON blob is not something an inspector can diff. */
function doorSummary(doors: unknown): string[] {
  if (!Array.isArray(doors)) return [];
  return doors.map((d) => {
    const door = d as RoomDoor;
    return `${door.kind} on ${door.wall} @ ${door.offset}`;
  });
}
```

and import the type: `import { validateRoomPayload, floorplanSchema, floorplanUpdateSchema, type RoomDoor } from './validation.js';`

In the POST handler, replace the `prisma.floorplanRoom.create` call's data spread:

```ts
      const { doors, ...roomData } = result.data;
      const room = await prisma.floorplanRoom.create({
        data: {
          ...roomData,
          doors: doorsForWrite(doors),
          floorplanId: id,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      });
```

and add to that handler's `afterValue`, after `limits`:

```ts
          doors: doorSummary(room.doors),
```

In the PUT handler, likewise:

```ts
      const { doors, ...roomData } = result.data;
      const after = await prisma.floorplanRoom.update({
        where: { id: roomId },
        data: { ...roomData, doors: doorsForWrite(doors), updatedBy: ctx.userId },
      });
```

and add `doors: doorSummary(before.doors),` to `beforeValue` and `doors: doorSummary(after.doors),` to `afterValue`. Without both, moving a door writes an audit entry reading "Room updated" that names nothing that changed — unacceptable on a §11 surface.

- [ ] **Step 7: Typecheck and run the API unit tests**

Run: `npx tsc -p apps/api/tsconfig.json --noEmit`
Run: `npx vitest run apps/api/src/modules/floorplans`
Expected: no type errors; all tests PASS.

- [ ] **Step 8: Prove it round-trips against the real API**

Ask the operator to start the API if it is not running, then:

```bash
curl -sk --ssl-revoke-best-effort https://localhost:3000/api/floorplans \
  -H "Authorization: Bearer <token>" | python -m json.tool | grep -A 6 doors
```

Expected: every room object carries a `doors` key (`null` for existing rooms). An exit 60 from curl on Windows is Schannel's revocation check, not a broken chain — `--ssl-revoke-best-effort` is already there for it.

- [ ] **Step 9: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260824100000_floorplan_room_doors apps/api/src/modules/floorplans/routes.ts
git commit -m "feat(floorplans): persist room doors on floorplan_rooms"
```

---

### Task 3: Wall splitting (pure geometry module)

**Files:**
- Create: `apps/web/src/routes/dashboard/room-geometry.ts`
- Test: `apps/web/src/routes/dashboard/__tests__/room-geometry.test.ts`

**Interfaces:**
- Consumes: the `RoomDoor` shape from Task 1, re-declared here (the web side mirrors API shapes by hand — see Global Constraints).
- Produces:

```ts
export type DoorWall = 'top' | 'right' | 'bottom' | 'left';
export type DoorKind = 'ENTRY' | 'EXIT' | 'PASSAGE';
export interface RoomDoor { wall: DoorWall; offset: number; width: number; kind: DoorKind }
export interface PixelBox { x: number; y: number; w: number; h: number }
export interface Segment { x1: number; y1: number; x2: number; y2: number }
export interface DoorPlacement { wall: DoorWall; kind: DoorKind; start: Segment; hinge: { x: number; y: number }; leaf: Segment; arc: string }
export function wallSegments(box: PixelBox, doors: RoomDoor[] | null | undefined): Segment[]
export function doorPlacements(box: PixelBox, doors: RoomDoor[] | null | undefined): DoorPlacement[]
```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/routes/dashboard/__tests__/room-geometry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { wallSegments, doorPlacements, type RoomDoor } from '../room-geometry';

/** A 100x100 box at the origin — every expected number below is readable by hand. */
const box = { x: 0, y: 0, w: 100, h: 100 };

describe('wallSegments', () => {
  it('returns four whole walls when there are no doors', () => {
    expect(wallSegments(box, null)).toHaveLength(4);
    expect(wallSegments(box, [])).toHaveLength(4);
  });

  it('closes the rectangle when there are no doors', () => {
    const segs = wallSegments(box, []);
    const total = segs.reduce((sum, s) => sum + Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1), 0);
    expect(total).toBe(400);
  });

  it('splits one wall into two segments around a door in the middle', () => {
    const doors: RoomDoor[] = [{ wall: 'top', offset: 0.4, width: 0.2, kind: 'ENTRY' }];
    const segs = wallSegments(box, doors);
    expect(segs).toHaveLength(5); // 3 whole walls + 2 pieces of the top
    const top = segs.filter((s) => s.y1 === 0 && s.y2 === 0);
    expect(top).toHaveLength(2);
    expect(top[0]).toEqual({ x1: 0, y1: 0, x2: 40, y2: 0 });
    expect(top[1]).toEqual({ x1: 60, y1: 0, x2: 100, y2: 0 });
  });

  it('emits no zero-length stub when a door starts at the wall corner', () => {
    const doors: RoomDoor[] = [{ wall: 'top', offset: 0, width: 0.2, kind: 'ENTRY' }];
    const segs = wallSegments(box, doors);
    expect(segs).toHaveLength(4); // 3 whole walls + the single remaining piece
    expect(segs.every((s) => s.x1 !== s.x2 || s.y1 !== s.y2)).toBe(true);
  });

  it('emits no zero-length stub when a door ends at the far corner', () => {
    const doors: RoomDoor[] = [{ wall: 'left', offset: 0.8, width: 0.2, kind: 'EXIT' }];
    const segs = wallSegments(box, doors);
    expect(segs).toHaveLength(4);
    expect(segs.every((s) => s.x1 !== s.x2 || s.y1 !== s.y2)).toBe(true);
  });

  it('handles two doors on one wall, in either input order', () => {
    const a: RoomDoor = { wall: 'bottom', offset: 0.1, width: 0.1, kind: 'ENTRY' };
    const b: RoomDoor = { wall: 'bottom', offset: 0.6, width: 0.1, kind: 'EXIT' };
    expect(wallSegments(box, [a, b])).toHaveLength(6); // 3 whole + 3 pieces
    expect(wallSegments(box, [b, a])).toEqual(wallSegments(box, [a, b]));
  });

  it('removes the wall entirely when a door spans all of it', () => {
    const doors: RoomDoor[] = [{ wall: 'right', offset: 0, width: 1, kind: 'PASSAGE' }];
    expect(wallSegments(box, doors)).toHaveLength(3);
  });

  it('respects the box origin', () => {
    const segs = wallSegments({ x: 10, y: 20, w: 50, h: 40 }, []);
    const xs = segs.flatMap((s) => [s.x1, s.x2]);
    const ys = segs.flatMap((s) => [s.y1, s.y2]);
    expect(Math.min(...xs)).toBe(10);
    expect(Math.max(...xs)).toBe(60);
    expect(Math.min(...ys)).toBe(20);
    expect(Math.max(...ys)).toBe(60);
  });
});

describe('doorPlacements', () => {
  it('returns nothing for no doors', () => {
    expect(doorPlacements(box, null)).toEqual([]);
  });

  it('hinges a top-wall door on the opening and swings the leaf INTO the room', () => {
    const [d] = doorPlacements(box, [{ wall: 'top', offset: 0.4, width: 0.2, kind: 'ENTRY' }]);
    expect(d.hinge).toEqual({ x: 40, y: 0 });
    // The leaf ends inside the room, i.e. below the top wall.
    expect(d.leaf.y2).toBeGreaterThan(0);
    expect(d.arc.startsWith('M')).toBe(true);
  });

  it('swings a bottom-wall door into the room too — upward', () => {
    const [d] = doorPlacements(box, [{ wall: 'bottom', offset: 0.4, width: 0.2, kind: 'EXIT' }]);
    expect(d.hinge.y).toBe(100);
    expect(d.leaf.y2).toBeLessThan(100);
  });

  it('carries the kind through untouched', () => {
    const placements = doorPlacements(box, [
      { wall: 'top', offset: 0.1, width: 0.1, kind: 'ENTRY' },
      { wall: 'left', offset: 0.1, width: 0.1, kind: 'PASSAGE' },
    ]);
    expect(placements.map((p) => p.kind)).toEqual(['ENTRY', 'PASSAGE']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/src/routes/dashboard/__tests__/room-geometry.test.ts`
Expected: FAIL — "Failed to resolve import '../room-geometry'".

- [ ] **Step 3: Write the module**

Create `apps/web/src/routes/dashboard/room-geometry.ts`:

```ts
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

function pointAt(box: PixelBox, wall: DoorWall, t: number): { x: number; y: number } {
  const { from, to } = wallLine(box, wall);
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/web/src/routes/dashboard/__tests__/room-geometry.test.ts`
Expected: PASS. If the arc sweep flag renders the arc bulging the wrong way, fix the flag — do not adjust the test to match the bug.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/dashboard/room-geometry.ts apps/web/src/routes/dashboard/__tests__/room-geometry.test.ts
git commit -m "feat(dashboard): wall splitting and door placement geometry"
```

---

### Task 4: Tile layout and degrade steps (pure)

**Files:**
- Modify: `apps/web/src/routes/dashboard/room-geometry.ts`
- Test: `apps/web/src/routes/dashboard/__tests__/room-geometry.test.ts`

**Interfaces:**
- Consumes: `PixelBox` from Task 3.
- Produces:

```ts
export type DegradeStep = 'FULL' | 'VALUES_ONLY' | 'OVERFLOW' | 'COMPACT' | 'CODE_ONLY';
export interface TileLayout {
  step: DegradeStep;
  /** How many instrument tiles are actually drawn. */
  visible: number;
  /** Instruments not drawn; > 0 only on OVERFLOW. */
  hidden: number;
  cols: number;
  rows: number;
  tile: { w: number; h: number };
  /** Font size for tile text, in viewBox units. */
  fontSize: number;
  /** Top of the tile grid, below the room's header strip. */
  bodyTop: number;
}
export function tileLayout(box: PixelBox, count: number): TileLayout
```

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/routes/dashboard/__tests__/room-geometry.test.ts`:

```ts
import { tileLayout } from '../room-geometry';

describe('tileLayout — degrade steps', () => {
  const big = { x: 0, y: 0, w: 300, h: 200 };
  const tiny = { x: 0, y: 0, w: 26, h: 18 };

  it('draws full tiles when there is room', () => {
    const l = tileLayout(big, 2);
    expect(l.step).toBe('FULL');
    expect(l.visible).toBe(2);
    expect(l.hidden).toBe(0);
  });

  it('never reports more visible tiles than there are instruments', () => {
    expect(tileLayout(big, 1).visible).toBe(1);
    expect(tileLayout(big, 0).visible).toBe(0);
  });

  it('falls to CODE_ONLY in a box too small for any tile', () => {
    expect(tileLayout(tiny, 3).step).toBe('CODE_ONLY');
    expect(tileLayout(tiny, 3).visible).toBe(0);
  });

  it('overflows rather than overlapping when the instruments do not fit', () => {
    const l = tileLayout({ x: 0, y: 0, w: 120, h: 70 }, 12);
    expect(l.step).toBe('OVERFLOW');
    expect(l.visible + l.hidden).toBe(12);
    expect(l.hidden).toBeGreaterThan(0);
    // The +K marker occupies a slot, so a tile is given up to make space for it.
    expect(l.visible).toBeLessThan(l.cols * l.rows);
  });

  it('keeps every tile inside the box', () => {
    const l = tileLayout(big, 4);
    expect(l.cols * l.tile.w).toBeLessThanOrEqual(big.w);
    expect(l.bodyTop + l.rows * l.tile.h).toBeLessThanOrEqual(big.y + big.h);
  });

  it('leaves the header strip clear for the room code', () => {
    const l = tileLayout(big, 2);
    expect(l.bodyTop).toBeGreaterThan(big.y);
  });

  it('is monotonic — a smaller box never degrades to a richer step', () => {
    const order: Record<string, number> = { FULL: 0, VALUES_ONLY: 1, OVERFLOW: 2, COMPACT: 3, CODE_ONLY: 4 };
    const wide = tileLayout({ x: 0, y: 0, w: 300, h: 200 }, 3);
    const narrow = tileLayout({ x: 0, y: 0, w: 90, h: 60 }, 3);
    expect(order[narrow.step]).toBeGreaterThanOrEqual(order[wide.step]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/src/routes/dashboard/__tests__/room-geometry.test.ts`
Expected: FAIL — `tileLayout` is not exported.

- [ ] **Step 3: Implement the layout**

Append to `apps/web/src/routes/dashboard/room-geometry.ts`:

```ts
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
const MIN_TILE_H = 26;
/** A tile showing values but no instrument code needs less height. */
const VALUES_TILE_H = 18;
/** Room for the code strip along the room's top edge. */
const HEADER_H = 14;

/**
 * How many instrument tiles fit, and what has to be given up when they do not.
 *
 * Text degrades in FIXED, ORDERED steps rather than shrinking continuously:
 * overlapping text is worse than absent text, and a font that keeps shrinking
 * produces a floor where half the rooms are unreadable but none of them look
 * broken. The step is chosen from measured size, never guessed.
 */
export function tileLayout(box: PixelBox, count: number): TileLayout {
  const bodyTop = box.y + HEADER_H;
  const bodyH = box.h - HEADER_H;
  const empty: TileLayout = {
    step: 'CODE_ONLY', visible: 0, hidden: Math.max(0, count), cols: 0, rows: 0,
    tile: { w: 0, h: 0 }, fontSize: 8, bodyTop,
  };

  if (count <= 0) return { ...empty, hidden: 0 };
  // Not enough body left for even a values-only tile: the room can carry its
  // code and nothing else.
  if (box.w < MIN_TILE_W || bodyH < VALUES_TILE_H) return empty;

  const fullCols = Math.max(1, Math.floor(box.w / MIN_TILE_W));
  const fullRows = Math.max(0, Math.floor(bodyH / MIN_TILE_H));
  const fullCapacity = fullCols * fullRows;

  if (fullRows >= 1 && fullCapacity >= count) {
    return {
      step: 'FULL', visible: count, hidden: 0,
      cols: fullCols, rows: Math.ceil(count / fullCols),
      tile: { w: box.w / fullCols, h: Math.min(MIN_TILE_H * 1.6, bodyH / Math.ceil(count / fullCols)) },
      fontSize: Math.max(8, Math.min(12, box.w / fullCols / 4.5)),
      bodyTop,
    };
  }

  // Drop the instrument code line: values are what a control room reads first,
  // and the tile is still clickable through to the instrument.
  const valueRows = Math.max(0, Math.floor(bodyH / VALUES_TILE_H));
  const valueCapacity = fullCols * valueRows;

  if (valueRows >= 1 && valueCapacity >= count) {
    return {
      step: 'VALUES_ONLY', visible: count, hidden: 0,
      cols: fullCols, rows: Math.ceil(count / fullCols),
      tile: { w: box.w / fullCols, h: Math.min(VALUES_TILE_H * 1.4, bodyH / Math.ceil(count / fullCols)) },
      fontSize: Math.max(8, Math.min(11, box.w / fullCols / 5)),
      bodyTop,
    };
  }

  if (valueRows >= 1 && valueCapacity >= 2) {
    // One slot goes to the "+K" marker, so the count it reports is honest.
    const visible = valueCapacity - 1;
    return {
      step: 'OVERFLOW', visible, hidden: count - visible,
      cols: fullCols, rows: valueRows,
      tile: { w: box.w / fullCols, h: bodyH / valueRows },
      fontSize: Math.max(8, Math.min(11, box.w / fullCols / 5)),
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/web/src/routes/dashboard/__tests__/room-geometry.test.ts`
Expected: PASS, including the Task 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/dashboard/room-geometry.ts apps/web/src/routes/dashboard/__tests__/room-geometry.test.ts
git commit -m "feat(dashboard): instrument tile layout with fixed degrade steps"
```

---

### Task 5: Render doors and per-instrument tiles

**Files:**
- Modify: `apps/web/src/routes/dashboard/use-telemetry.ts:137-144` (`FloorplanRoomShape`)
- Modify: `apps/web/src/routes/dashboard/floorplan-view.tsx` (whole render body)

**Interfaces:**
- Consumes: `wallSegments`, `doorPlacements`, `tileLayout`, `RoomDoor` from Tasks 3–4; `doors` on the API response from Task 2.
- Produces: no exports beyond the existing `FloorplanView` component.

- [ ] **Step 1: Carry doors through the data layer**

In `apps/web/src/routes/dashboard/use-telemetry.ts`, extend the interface and import the type:

```ts
import type { RoomDoor } from './room-geometry';

export interface FloorplanRoomShape {
  id: string;
  code: string;
  label: string | null;
  x: number; y: number; w: number; h: number;
  tempMin: number | null; tempMax: number | null;
  rhMin: number | null; rhMax: number | null;
  /** Drawn openings. NULL for every room drawn before doors existed. */
  doors: RoomDoor[] | null;
}
```

- [ ] **Step 2: Replace the two colour constants with a palette**

In `floorplan-view.tsx`, replace the `WALL` / `INK` / `INK_SOFT` consts with:

```ts
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
  wall: '#1f2937',
  ink: '#111827',
  inkSoft: '#374151',
  tile: '#f8fafc',
  tileBorder: '#cbd5e1',
} as const;
```

Update every existing `WALL` / `INK` / `INK_SOFT` reference to `PALETTE.wall` / `PALETTE.ink` / `PALETTE.inkSoft`.

- [ ] **Step 3: Draw walls as segments, with doors**

Inside the `roomViews.map(...)`, replace the single `<rect>` (fill + stroke + hover) with a fill-only rect plus segments. Import at the top:

```ts
import { wallSegments, doorPlacements, tileLayout } from './room-geometry';
```

and in the room `<g>`:

```tsx
                  {/* Fill only. The walls are separate segments below, because a
                      stroked rect cannot have a door cut out of it. */}
                  <rect
                    x={x} y={y} width={w} height={h}
                    fill={PALETTE.paper}
                    className="transition-colors hover:fill-slate-100"
                  />

                  {wallSegments({ x, y, w, h }, room.doors).map((s, i) => (
                    <line
                      key={`w${i}`}
                      x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                      stroke={PALETTE.wall} strokeWidth={2.5} strokeLinecap="butt"
                    />
                  ))}

                  {/* Doors: leaf + swing arc, in wall ink only. A door carries no
                      reading — nothing in this install senses one — so giving it
                      status colour would compete with the chips for no meaning. */}
                  {doorPlacements({ x, y, w, h }, room.doors).map((d, i) => (
                    <g key={`d${i}`}>
                      <line
                        x1={d.leaf.x1} y1={d.leaf.y1} x2={d.leaf.x2} y2={d.leaf.y2}
                        stroke={PALETTE.wall} strokeWidth={1.6}
                      />
                      <path d={d.arc} fill="none" stroke={PALETTE.inkSoft} strokeWidth={1} strokeDasharray="3 2" />
                      {d.kind !== 'PASSAGE' && (
                        <text
                          x={(d.start.x1 + d.start.x2) / 2}
                          y={(d.start.y1 + d.start.y2) / 2 - 2}
                          textAnchor="middle" fontSize={7} fontWeight={700} fill={PALETTE.inkSoft}
                        >
                          {d.kind === 'ENTRY' ? 'IN' : 'OUT'}
                        </text>
                      )}
                    </g>
                  ))}
```

- [ ] **Step 4: Replace the single chip block with per-instrument tiles**

Still inside the room `<g>`, after the room code header text, replace the existing `showChips` block. Each tile reads its OWN row's limits, decimals and status — the current code reads `rows[0]` for all of them, which is why a second instrument in a room is invisible today:

```tsx
                  {(() => {
                    const layout = tileLayout({ x, y, w, h }, roomRows.length);
                    if (layout.visible === 0) return null;

                    return roomRows.slice(0, layout.visible).map((row, i) => {
                      const col = i % layout.cols;
                      const rowIx = Math.floor(i / layout.cols);
                      const tx = x + col * layout.tile.w;
                      const ty = layout.bodyTop + rowIx * layout.tile.h;
                      const tcx = tx + layout.tile.w / 2;

                      const tempV = row.temperature?.value ?? null;
                      const rhV = row.humidity?.value ?? null;
                      const lim = row.limits;
                      const tempBad = outOfSpec(tempV, lim?.tempMin, lim?.tempMax);
                      const rhBad = outOfSpec(rhV, lim?.rhMin, lim?.rhMax);
                      const chipFor = (bad: boolean): InstrumentStatus =>
                        bad ? 'OUT_OF_SPEC' : row.status === 'OUT_OF_SPEC' ? 'OK' : row.status;

                      const values: { text: string; st: InstrumentStatus }[] = [];
                      if (tempV !== null) {
                        values.push({
                          text: `${formatDecimals(tempV, row.decimals.temperature)}°`,
                          st: chipFor(tempBad),
                        });
                      }
                      if (rhV !== null) {
                        values.push({
                          text: `${formatDecimals(rhV, row.decimals.humidity)}%`,
                          st: chipFor(rhBad),
                        });
                      }

                      return (
                        <g
                          key={row.instrumentId}
                          onClick={(e) => { e.stopPropagation(); navigate(`/instruments/${row.instrumentId}`); }}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              navigate(`/instruments/${row.instrumentId}`);
                            }
                          }}
                          aria-label={`${row.code}${
                            tempV !== null ? `, ${formatDecimals(tempV, row.decimals.temperature)} degrees${tempBad ? ' out of spec' : ''}` : ''
                          }${rhV !== null ? `, ${formatDecimals(rhV, row.decimals.humidity)} percent humidity${rhBad ? ' out of spec' : ''}` : ''}`}
                        >
                          <rect
                            x={tx + 1.5} y={ty + 1} width={layout.tile.w - 3} height={layout.tile.h - 2}
                            rx={2} fill={PALETTE.tile} stroke={PALETTE.tileBorder} strokeWidth={0.8}
                          />
                          {layout.step === 'FULL' && (
                            <text
                              x={tcx} y={ty + layout.fontSize + 1} textAnchor="middle"
                              fontSize={layout.fontSize * 0.85} fontWeight={700} fill={PALETTE.ink}
                            >
                              {row.code}
                            </text>
                          )}
                          {values.map((v, vi) => {
                            const paint = CHIP[v.st];
                            const label = paint.glyph ? `${paint.glyph} ${v.text}` : v.text;
                            const cw = Math.min(layout.tile.w - 6, label.length * layout.fontSize * 0.6 + 4);
                            const chipH = layout.fontSize * 1.3;
                            const cyTop =
                              ty + (layout.step === 'FULL' ? layout.fontSize + 3 : 2) + vi * (chipH + 1.5);
                            if (cyTop + chipH > ty + layout.tile.h) return null;
                            return (
                              <g key={v.text}>
                                <rect x={tcx - cw / 2} y={cyTop} width={cw} height={chipH} rx={2} fill={paint.bg} />
                                <text
                                  x={tcx} y={cyTop + chipH * 0.75} textAnchor="middle"
                                  fontSize={layout.fontSize * 0.8} fontWeight={700} fill="#ffffff"
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
```

Add the `+K` marker after that block, so hidden instruments are never silently dropped:

```tsx
                  {(() => {
                    const layout = tileLayout({ x, y, w, h }, roomRows.length);
                    if (layout.hidden <= 0) return null;
                    const i = layout.visible;
                    const col = layout.cols > 0 ? i % layout.cols : 0;
                    const rowIx = layout.cols > 0 ? Math.floor(i / layout.cols) : 0;
                    return (
                      <text
                        x={x + col * layout.tile.w + layout.tile.w / 2}
                        y={layout.bodyTop + rowIx * layout.tile.h + layout.fontSize + 2}
                        textAnchor="middle" fontSize={layout.fontSize * 0.85}
                        fontWeight={700} fill={PALETTE.inkSoft}
                      >
                        +{layout.hidden}
                      </text>
                    );
                  })()}
```

Import the navigator at the top of the file: `import { Link, useNavigate } from 'react-router-dom';` and add `const navigate = useNavigate();` inside `FloorplanView`.

- [ ] **Step 5: Move the room code into a header strip and name the doors**

Replace the existing room-code `<text>` positioning so it sits at `y + 10` (inside the header the layout reserves), keep the `showLabel` line only when `tileLayout(...).step === 'CODE_ONLY'` (otherwise the tiles need the space), and extend the room `<g>`'s `aria-label` with a door phrase:

```tsx
                  aria-label={`${room.code}${room.label ? ` ${room.label}` : ''}, ${statusClasses(status).label}, ${
                    roomRows.length
                  } instrument${roomRows.length === 1 ? '' : 's'}${
                    room.doors && room.doors.length > 0
                      ? `, ${room.doors.length} door${room.doors.length === 1 ? '' : 's'}`
                      : ''
                  }`}
```

The per-instrument readings now live on each tile's own `aria-label`, so they are dropped from the room's — repeating them would read every value twice to a screen reader.

- [ ] **Step 6: Typecheck and build**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Run: `cd apps/web; npx vite build`
Expected: no type errors, build succeeds. Remove any now-unused import (`TELEMETRY_DECIMALS_FALLBACK` may become unused if no code path still needs the fallback — delete it rather than leaving a dead import).

- [ ] **Step 7: Run the whole web test suite**

Run: `npx vitest run apps/web/src`
Expected: PASS. Nothing existing asserts against this SVG, so a failure here means something unrelated broke — investigate rather than skipping.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/routes/dashboard/use-telemetry.ts apps/web/src/routes/dashboard/floorplan-view.tsx
git commit -m "feat(dashboard): draw doors and per-instrument tiles on the floor view"
```

---

### Task 6: Draw doors in the placement editor

**Files:**
- Modify: `apps/web/src/routes/config/floorplans.tsx` (`Room` interface ~line 26, form state ~line 139, the selected-room overlay ~line 446, `saveRoom` ~line 281)

**Interfaces:**
- Consumes: `RoomDoor`, `DoorWall`, `DoorKind` from Task 3; the extended PUT body from Task 2.
- Produces: nothing beyond the page component.

- [ ] **Step 1: Carry doors on the editor's room type and form**

```ts
import type { RoomDoor, DoorWall, DoorKind } from '@/routes/dashboard/room-geometry';
```

Add `doors: RoomDoor[] | null;` to the editor's `Room` interface, add `doors: [] as RoomDoor[],` to the `form` initial state and to the reset in the deselect branch, and set it when a room is selected:

```ts
      doors: selectedRoom.doors ?? [],
```

- [ ] **Step 2: Add wall hit-strips to the selected room**

Inside the selected room's `<div>` in the canvas overlay, render four strips that only exist while that room is selected. A click anywhere on a strip drops a default 12%-wide door centred on the click, snapped to that wall — a door floating in mid-air is not creatable because the only way to make one is to hit a wall:

```tsx
                    {isSelected && (['top', 'right', 'bottom', 'left'] as DoorWall[]).map((wall) => {
                      const vertical = wall === 'left' || wall === 'right';
                      return (
                        <span
                          key={wall}
                          title={`Add a door on the ${wall} wall`}
                          onPointerDown={(e) => {
                            // Stop the room's own move-drag: placing a door must
                            // not also nudge the room out from under the pointer.
                            e.stopPropagation();
                            const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                            const t = vertical
                              ? (e.clientY - rect.top) / rect.height
                              : (e.clientX - rect.left) / rect.width;
                            addDoor(wall, t);
                          }}
                          className="absolute bg-sky-500/0 hover:bg-sky-500/40"
                          style={
                            vertical
                              ? { top: 0, bottom: 0, width: 8, [wall]: -4, cursor: 'copy' }
                              : { left: 0, right: 0, height: 8, [wall]: -4, cursor: 'copy' }
                          }
                        />
                      );
                    })}
```

and the handler beside `saveRoom`:

```ts
  const DOOR_WIDTH = 0.12;

  /** Place a door centred on the click, clamped so it finishes on its wall. */
  const addDoor = (wall: DoorWall, t: number) => {
    if (form.doors.length >= 6) {
      toast.error('Too many doors', 'A room can carry at most six doors.');
      return;
    }
    const offset = Math.min(Math.max(t - DOOR_WIDTH / 2, 0), 1 - DOOR_WIDTH);
    const next: RoomDoor = { wall, offset, width: DOOR_WIDTH, kind: 'ENTRY' };
    // The server rejects overlaps; refusing here means the operator finds out on
    // the click rather than on the save, with the room already half-edited.
    const clash = form.doors.some(
      (d) => d.wall === wall && offset < d.offset + d.width && d.offset < offset + DOOR_WIDTH,
    );
    if (clash) {
      toast.error('Doors overlap', 'There is already a door here. Move or delete it first.');
      return;
    }
    setForm((f) => ({ ...f, doors: [...f.doors, next] }));
  };
```

- [ ] **Step 3: Render each placed door on the canvas**

Inside the same selected-room div, draw the doors already on the form so the operator sees what they placed:

```tsx
                    {isSelected && form.doors.map((d, i) => {
                      const vertical = d.wall === 'left' || d.wall === 'right';
                      return (
                        <span
                          key={`${d.wall}-${i}`}
                          className="absolute bg-sky-600"
                          style={
                            vertical
                              ? { [d.wall]: -2, top: `${d.offset * 100}%`, height: `${d.width * 100}%`, width: 4 }
                              : { [d.wall]: -2, left: `${d.offset * 100}%`, width: `${d.width * 100}%`, height: 4 }
                          }
                        />
                      );
                    })}
```

- [ ] **Step 4: Add the Doors panel to the room form**

In the room editor card, after the limit inputs:

```tsx
              <div className="sm:col-span-2">
                <p className="mb-1 text-xs font-semibold text-slate-700">Doors</p>
                {form.doors.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    Click a wall of the selected room to place a door.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {form.doors.map((d, i) => (
                      <li key={`${d.wall}-${i}`} className="flex items-center gap-2 text-xs text-slate-600">
                        <span className="w-14 font-medium capitalize">{d.wall}</span>
                        <select
                          value={d.kind}
                          onChange={(e) => {
                            const kind = e.target.value as DoorKind;
                            setForm((f) => ({
                              ...f,
                              doors: f.doors.map((door, ix) => (ix === i ? { ...door, kind } : door)),
                            }));
                          }}
                          className="rounded border border-slate-200 px-1.5 py-1"
                        >
                          <option value="ENTRY">Entry</option>
                          <option value="EXIT">Exit</option>
                          <option value="PASSAGE">Passage</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => setForm((f) => ({ ...f, doors: f.doors.filter((_, ix) => ix !== i) }))}
                          className="text-red-600 hover:underline"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
```

- [ ] **Step 5: Send doors with the room**

In `saveRoom`, add to `body`:

```ts
      doors: form.doors.length > 0 ? form.doors : null,
```

No other change: this rides the existing `UPDATE_FLOORPLAN_ROOM` reauth and the existing audit entry.

- [ ] **Step 6: Typecheck and build**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Run: `cd apps/web; npx vite build`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/config/floorplans.tsx
git commit -m "feat(floorplans): place doors on room walls in the plan editor"
```

---

### Task 7: Verification sweep and documentation

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md` (floorplan section), `tasks/todo.md`
- Modify: `docs/recreation/` (the floorplan inventory entry)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing executable.

- [ ] **Step 1: Run every suite and typecheck, and record the actual output**

```bash
npx tsc -p apps/api/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
npx vitest run apps/api/src/modules/floorplans
npx vitest run apps/web/src/routes/dashboard
cd apps/web; npx vite build
```

Every one must pass. If any fails, fix the cause — do not comment out an assertion or loosen a test to get green.

- [ ] **Step 2: Re-derive the counts that the docs claim**

```bash
grep -cE "^model " apps/api/prisma/schema.prisma
grep -cE "^enum "  apps/api/prisma/schema.prisma
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts
grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts
grep -cE "<Route" apps/web/src/main.tsx
```

Expected: **34, 13, 42, 46, 48** — unchanged. If any moved, the design has been misread; stop and say so rather than editing the docs to match.

- [ ] **Step 3: Hand the visual check to the operator**

Post, verbatim in substance:

> Doors and per-instrument tiles are in. I have NOT seen the drawing — Playwright cannot get past login against the mkcert cert on this machine, so the visual check is yours. Please look at Dashboard → Graphical and confirm: (1) doors appear as gaps with a swing arc, (2) every instrument in a room has its own tile with its ID and values, (3) a crowded room shows "+K" rather than overlapping text, (4) clicking a tile opens that instrument and clicking elsewhere in the room opens the room, and (5) nothing unstyled or misaligned. Check the browser console for errors while you are there.

Wait for their answer before marking the plan complete.

- [ ] **Step 4: Update the documentation**

- `CHANGELOG.md`: an entry dated 2026-08-24 describing the `doors` column, the migration applied to both databases, and the per-instrument tiles — including that the tiles FIX a defect where a room's second instrument was never shown.
- `CLAUDE.md`: extend the floorplan/instrument-dashboard bullets with the doors column and the tile behaviour. State explicitly that no count moved.
- `docs/recreation/`: update the floorplan inventory entry with the new column and the new `room-geometry.ts` module.
- `tasks/todo.md`: an audit-log entry for this work.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md CLAUDE.md docs/recreation tasks/todo.md
git commit -m "docs: record floorplan room doors and per-instrument tiles"
```

---

## Deferred (explicitly NOT in this plan)

- **The dark wall-display palette.** Only the `PALETTE` indirection is built. The dark values wait until the operator has seen the light version on the target display.
- **Live door state.** Nothing senses a door in this install; doors are static geometry.
- **Dragging a placed door to resize it.** Doors are placed at a fixed 12% width and removed/re-placed to move. If the operator finds that clumsy in Task 7's check, resizing is a follow-up.
