# SCADA-style graphical floor view — design

**Date:** 2026-08-24
**Status:** approved, not yet implemented
**Surface:** Dashboard → Graphical view (`apps/web/src/routes/dashboard/floorplan-view.tsx`)
and the placement editor (`apps/web/src/routes/config/floorplans.tsx`).

## 1. Problem

The drawn floor reads as a plan, not as a control-room view. Two gaps:

1. **No doors.** Rooms are closed rectangles, so the drawing does not resemble
   the building an operator walks through, and circulation is unreadable.
2. **The room box hides instruments.** It shows the room code, the room label,
   and two value chips taken from `rows[0]` — the FIRST instrument in the room,
   judged against that instrument's limits and shown at that instrument's
   precision. The instrument's own ID is never printed, and **a room holding two
   probes silently omits the second one**, including when the omitted one is the
   breaching one. That is a correctness defect, not only a cosmetic one.

## 2. Scope

In scope: persisted door geometry with an editor to draw it; per-instrument
tiles inside each room box; a palette indirection so a dark wall-display mode is
a later swap rather than a rewrite.

Out of scope, deliberately:

- **The dark palette itself.** Built light-first; the toggle lands in a
  follow-up once the operator has seen it on the target display. Guessing at a
  dark scheme unseen is wasted work.
- **Live door state.** Nothing in this install senses a door. Doors are static
  geometry and must never be drawn as though they carry a reading.
- **Rendering the uploaded plan image.** Unchanged: the image stays a tracing
  guide in the editor only, for the reasons already recorded in
  `floorplan-view.tsx`.

## 3. Data model

A `doors` JSONB column on `floorplan_rooms`, nullable. `NULL` = no doors drawn
yet, which is the honest state of every existing row.

```ts
interface RoomDoor {
  wall: 'top' | 'right' | 'bottom' | 'left';
  /** Start of the opening along that wall, as a fraction of the wall's length. */
  offset: number;   // 0..1
  /** Span of the opening, as a fraction of the wall's length. */
  width: number;    // 0..1, > 0
  kind: 'ENTRY' | 'EXIT' | 'PASSAGE';
}
```

`offset` and `width` are normalized against the WALL, exactly as `x/y/w/h` are
normalized against the plan. A door therefore holds its position at any zoom and
survives the plan being re-exported at a different DPI.

### Why JSONB and not a `FloorplanRoomDoor` table

A door belongs to exactly one room, is always read with that room, and is never
queried, filtered, sorted or joined on independently. A table would add a model
(34 → 35), two enums (13 → 15), a second write per room save, cascade rules, and
a documentation sweep across every count in `CLAUDE.md` — buying only
independent queryability, which nothing in this feature needs.

The repository already stores exactly this shape of data as JSONB
(`role_configs.instrument_scope`, `role_configs.attribute_access`). Rooms are
already saved wholesale through `PUT /:id/rooms/:roomId`, so the whole-document
replace semantics of a JSON column match how the surface already behaves.

**Counts are unchanged by this design:** 34 models, 13 enums, 42 permissions,
46 reauth actions, 23 API modules, 25 config defs, 48 routes. Doors are a column
on an existing model, saved through an existing route, under an existing
permission.

### Migration

Hand-written SQL, NOT generated:

```sql
ALTER TABLE floorplan_rooms ADD COLUMN doors JSONB;
```

`prisma migrate diff` on this repository emits a DROP of the partitioned
telemetry history table; its output must not be used verbatim. The migration is
applied to **both** `compliance_core_db` and `compliance_core_db_test` — one
applied to only one database makes every instrument-touching e2e return 500.

`prisma generate` fails with EPERM while `tsx watch` holds the client DLL; stop
the API before regenerating.

## 4. Validation

Extends `apps/api/src/modules/floorplans/validation.ts`, which is a pure
function so the rules stay unit-testable and every rejection names its field.

| Rule | Why |
|---|---|
| `wall` is one of the four sides | typo in a hand-posted payload |
| `width > 0` | a zero-span door is a slip while dragging, never an intent |
| `offset + width <= 1` | the door would run past the wall's corner |
| no two doors on one wall overlap | two openings drawn on top of each other are not representable |
| at most 6 doors per room | a runaway loop in a client, not a real room |

A door list is replaced wholesale with the room, matching the existing PUT
semantics. `doors: null` and `doors: []` both mean "no doors".

## 5. Rendering

### 5.1 Walls become segments

A stroked `<rect>` cannot have a hole cut in it. The room's `<rect>` therefore
keeps its FILL only, and the four walls are emitted as separate line segments,
each split around the doors that sit on it.

This is the substantive reason for the change in approach: overpainting a door
gap with background colour breaks the moment the room is hovered (the fill
changes) or the palette changes, and would silently regress when the dark mode
lands. A gap must be an absence of wall, not paint over one.

### 5.2 Doors

Each door draws as: the wall gap, a leaf line hinged at one end of the opening,
and a quarter-circle swing arc inside the room — standard plan notation. Kind is
marked at the opening by an arrow pointing INTO the room for `ENTRY`, out of it
for `EXIT`, and nothing for `PASSAGE`.

Doors are drawn in wall ink only. **They carry no status colour.** Colouring
them would put non-semantic colour next to the value chips, competing with the
one signal the drawing exists to carry.

### 5.3 Instrument tiles

The room code moves to a header strip on the room's top edge; the body holds one
tile per instrument, laid out as a grid. Each tile shows the instrument **code**
on its first line, then that instrument's temperature and humidity chips.

Each tile uses its OWN row's `limits`, `limitSource` and `decimals`, all of
which `GET /api/instruments/telemetry-overview` already returns per row. Nothing
is re-derived in the browser — the alarm evaluator reads the same resolved
values, and a second derivation is how a drawing comes to contradict the alarm
printed beside it.

Chip colour remains per READING, not per room: a green temperature can sit
beside a red humidity in the same tile. Chip colours stay semantic and fixed
across palettes — a site themed purple must never render a purple "out of spec".

### 5.4 Degrade steps

Text degrades in fixed, ordered steps as the box shrinks, because overlapping
text is worse than absent text:

1. full tiles (code + both chips)
2. tiles with values, code dropped
3. the `N` tiles that fit, plus a `+K` tile
4. today's single compact chip block
5. room code alone

The step is chosen from the box's measured size in viewBox units, not guessed.

### 5.5 Interaction

Clicking a tile opens `/instruments/:id` and stops propagation; clicking
anywhere else in the room still opens the room detail. Keyboard behaviour and
the existing `aria-label` are preserved, with the room's label extended to name
its doors.

### 5.6 Palette indirection

`WALL`, `INK`, `INK_SOFT` and the paper fill collapse into one `PALETTE`
object, so the later dark-canvas toggle is a value swap. The dark values are NOT
authored in this pass.

## 6. Editor

In `Config → Floorplans`, with a room selected, a **Doors** panel appears beside
the existing code / label / limit fields.

- Clicking a wall of the selected room drops a door there. The click projects
  onto the nearest wall and snaps to it — a door floating in mid-air is not
  creatable.
- Dragging along that wall sets the door's width.
- Each door lists with an Entry / Exit / Passage selector and a delete button.

Doors are sent in the SAME `PUT /:id/rooms/:roomId` body the room already saves
with. They therefore inherit the existing `UPDATE_FLOORPLAN_ROOM` reauth prompt
and audit entry, with no new permission and no new reauth action.

The audit `beforeValue` / `afterValue` gain a door summary. Without it, moving a
door writes an audit entry that says "room updated" and names nothing that
changed — unacceptable on a §11 surface.

## 7. Testing

`apps/web/src/routes/dashboard/room-geometry.ts` (new) holds the drawing maths
as pure functions — `wallSegments(room, doors)` and `tileLayout(box, count)` —
extracted from the TSX. The SVG itself cannot be meaningfully asserted in jsdom,
but the segment splitting and the degrade steps can, and those are where this
will actually break.

- `floorplans/__tests__/validation.test.ts` — every rule in §4.
- `dashboard/__tests__/room-geometry.test.ts` — wall splitting (including doors
  at a wall's start and end, and two adjacent doors), and each degrade step.
- **Vitest here does not typecheck.** `npx tsc -p apps/api/tsconfig.json` and a
  `vite build` are run explicitly; green tests are not evidence that it compiles.
- **Playwright cannot get past login against the mkcert setup on this machine.**
  The visual check belongs to the operator. Implementation must not claim the
  drawing has been seen.

## 8. Touch points

| # | File | Change |
|---|---|---|
| 1 | `apps/api/prisma/schema.prisma` | `doors Json?` on `FloorplanRoom` |
| 2 | new migration | hand-written `ADD COLUMN doors JSONB`, both databases |
| 3 | `apps/api/src/modules/floorplans/validation.ts` | door schema + §4 rules |
| 4 | `apps/api/src/modules/floorplans/routes.ts` | `roomSelect`, swagger `roomProps`, POST/PUT body, audit values |
| 5 | `apps/api/src/modules/floorplans/__tests__/validation.test.ts` | the new rules |
| 6 | `apps/web/src/routes/dashboard/use-telemetry.ts` | `doors` on `FloorplanRoomShape` |
| 7 | `apps/web/src/routes/dashboard/room-geometry.ts` (new) + test | wall splitting, tile layout |
| 8 | `apps/web/src/routes/dashboard/floorplan-view.tsx` | segmented walls, doors, tiles, `PALETTE` |
| 9 | `apps/web/src/routes/config/floorplans.tsx` | door placement mode, panel, save body |
| 10 | docs | `CHANGELOG.md`, `CLAUDE.md` floorplan section, `docs/recreation/`, `tasks/todo.md` |

`apps/web/src/routes/dashboard/room-detail.tsx` needs no change — verified, it
renders no geometry.

## 9. Risks

- **Doors are decoration, not telemetry.** Nothing in this install senses a
  door, so the drawing can never show open/closed or an airlock breach. If door
  STATE on the dashboard is the underlying goal, that is a separate feature
  requiring hardware this install does not have.
- **Crowded rooms.** A room with many instruments falls to the `+K` step
  quickly on a small box. The degrade order is a judgement call and will likely
  need tuning once the operator sees a real floor.
- **The migration must reach both databases.** Missing the test database is a
  known, previously-hit failure mode here.
