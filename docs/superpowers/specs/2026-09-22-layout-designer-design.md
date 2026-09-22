# Layout Designer — design

**Date:** 2026-09-22
**Status:** approved in conversation, awaiting written review
**Replaces:** Configuration → Floorplans (`apps/web/src/routes/config/floorplans.tsx`)

## 1. What the operator asked for

> "in configurations give one configuration prepare layouts. like starts with
> empty one, draw shapes room redesigns and room to room linking, or empty space
> in between rooms like corridor and entire how design system needed for
> layouts do that system in one new configuration"

Decisions taken in the conversation, each a multiple-choice answer:

| Question | Answer |
|---|---|
| Room shapes | **Free polygons** (corner by corner), not rectangles or composed rectangles |
| Relation to the existing Floorplans page | **Replace it** — one editor on one set of rules |
| "Room to room linking" | **Both**: an opening in a shared wall, and a drawn connector between rooms that do not touch |
| Corridors and empty space | **A corridor is a drawn space of its own** (a polygon graded CIRCULATION); undrawn space is outside |
| Data approach | **A: polygon points beside the existing box**, not a rewrite of every reader |

## 2. What exists today, and what this keeps

`Floorplan` (name, image path + size, annotations) and `FloorplanRoom` (code,
label, `x y w h` in plan units 0..1, limits, `doors`, `grade`, `meta`) with
instrument membership by `Instrument.roomId`. The current editor draws
rectangles by drag over an uploaded image, moves and resizes them from the
bottom-right corner, places up to six doors on the four walls, and edits code,
name, grade, limits and instruments in a form. The dashboard
(`routes/dashboard/floorplan-view.tsx` over `room-geometry.ts`) draws walls,
doors, the zone tint, the alarm halo and the readings tiles from the box, and
joins adjoining CIRCULATION pieces with no wall between (`sharedOpenings`,
`sameSpace`).

Everything above keeps working unchanged. Rooms without points are rectangles
exactly as now; the tracing scripts (`draw-cwh-floorplan.ts`, the three traced
layouts) keep writing rectangles; the dashboard's rectangle path is the
four-corner case of the polygon path.

## 3. Data model

### 3.1 `floorplan_rooms.points` — the polygon

- New column `points JSONB NULL`: an array of `{x, y}` corners in plan units
  (0..1), in drawing order, the closing edge implied. Rules, enforced by the
  API's zod and by the designer before sending:
  - at least 3 corners, at most 64;
  - every corner inside the canvas (0..1 inclusive);
  - no two consecutive corners identical, no self-intersection
    (`isSimplePolygon` in `@digilog/shared`);
  - area above a minimum (`0.005 × 0.005` of the plan) — a slip, not a room.
- **`x y w h` remain and become the bounding box.** When a room is saved WITH
  points, the server computes the box from them and ignores any box sent. When
  saved WITHOUT points (the rectangle case, and every existing caller), the
  box is the geometry, as today. `points` is never populated for a rectangle
  by the server; the designer writes points only when a corner is edited or a
  room is drawn corner by corner.
- Written with `Prisma.DbNull` for a rectangle, never `JsonNull` (the `meta`
  precedent).
- Every reader that needs only a box — the tile layout, room history,
  telemetry overview, the trace scripts — is untouched by construction.

### 3.2 Doors — by edge, not by wall

- `doors[]` entries gain `edge` (0-based index into `points`, the edge from
  corner `i` to corner `i+1`, the last edge closing to corner 0). `offset` and
  `width` stay fractions of that edge's length. `kind` unchanged.
- A rectangle's four wall names map to edges: `top = 0`, `right = 1`,
  `bottom = 2`, `left = 3`, the order the rectangle's implied corners are
  enumerated (top-left, top-right, bottom-right, bottom-left). `doorEdge(door,
  points | null)` in `@digilog/shared` is the ONE converter; both the API and
  the dashboard read doors through it. Existing rows are never rewritten.
- The API accepts `wall` (rectangle rooms) or `edge` (polygon rooms); a door
  naming an edge that does not exist on the room is a 400 by field. The
  six-door ceiling stays.

### 3.3 `floorplan_room_links` — the new table (model `FloorplanRoomLink`)

| column | type | notes |
|---|---|---|
| `id` | uuid | |
| `floorplan_id` | uuid → floorplans, cascade | both rooms must be on this plan |
| `from_room_id` | uuid → floorplan_rooms, cascade | |
| `to_room_id` | uuid → floorplan_rooms, cascade | ≠ from |
| `kind` | text, validated `OPENING` \| `CONNECTOR` | a validated string, NOT a Postgres enum (the `grade` precedent) |
| `from_edge` | int, nullable | OPENING only: the edge of `from_room` the two share |
| `offset` | float, nullable | OPENING only: fraction along that edge |
| `width` | float, nullable | OPENING only: fraction of that edge, > 0 |
| `door` | text, nullable | OPENING only: `ENTRY` \| `EXIT` \| `PASSAGE` for a door leaf, NULL for a bare gap |
| `label` | text(60), nullable | CONNECTOR only |
| `created_at`, `updated_at`, `created_by`, `updated_by` | as the room table | |

- Several openings between two rooms are allowed (a long shared wall). A
  CONNECTOR between the same two rooms is allowed once per direction-agnostic
  pair; the API refuses a duplicate with 409.
- An OPENING is validated against geometry: the named edge of `from_room` must
  coincide (within the shared tolerance `sharedEdge()` uses, 0.5 plan units of
  1000) with an edge of `to_room`, or the request is a 400 `NOT_ADJACENT`.
  Nothing is stored that the dashboard could not draw.
- Cascade on room delete; cascade on plan delete.

### 3.4 `floorplans` — image optional, canvas size

- `image_path` becomes nullable. `image_width` / `image_height` keep their
  names and columns but now mean the CANVAS size; for a plan created from an
  image they equal the image's pixels as today, for a blank plan they hold the
  chosen preset (landscape 4:3 → 1600×1200, portrait 3:4 → 1200×1600, square
  → 1200×1200). The dashboard already derives its viewBox aspect from them and
  changes nothing.

### 3.5 Migration

One hand-authored migration, `20260922120000_floorplan_polygons_links`:
`ALTER TABLE floorplan_rooms ADD COLUMN points JSONB`; `ALTER TABLE floorplans
ALTER COLUMN image_path DROP NOT NULL`; `CREATE TABLE floorplan_room_links …`
with the two FKs and an index on `floorplan_id`. Applied to
`compliance_core_db` AND `compliance_core_db_test`; the `DROP TABLE
instrument_telemetry_history` Prisma emits is stripped as always; drift guard
must PASS.

**Counts that move:** models 36 → 37. Enums 13 (unchanged). Audit actions
103 → 106, templates 97 → 100 (`FLOORPLAN_LINK_CREATED` / `_UPDATED` /
`_DELETED`, Configuration category, with substitutions in
`audit-helpers.ts` — the two-edit rule). No permission, reauth action, config
def, sidebar item or route count change (the page replaces one at the same
path).

## 4. Shared geometry — `packages/shared/src/types/floorplan-geometry.ts`

One module, pure, unit-tested, used by the API (validation) and the web (the
designer and the dashboard). Nothing geometric may be re-implemented on either
side.

- `Point`, `Polygon` types; `rectanglePoints(box)` (the four implied corners
  of a rectangle, in the fixed order of §3.2).
- `boundingBox(points)`.
- `isSimplePolygon(points)` — segment-intersection test, adjacent edges
  excluded; `polygonArea` (shoelace, absolute).
- `polygonEdges(points)` → `Segment[]` in edge-index order.
- `sharedEdge(a, b, tol)` → the coincident stretch (as `{aEdge, bEdge, start,
  end}` fractions along `a`'s edge) or null. Generalises today's
  `sharedOpenings` on boxes.
- `largestInscribedRect(points)` → the biggest axis-aligned rectangle inside
  the polygon (grid search over the corner coordinates' x and y sets; exact
  for rectilinear polygons, a good approximation otherwise). The readings
  tiles lay out inside it.
- `doorEdge(door, points | null)` — §3.2.
- `centroid(points)` — connector endpoints.

`room-geometry.ts` on the web keeps its tile layout and door placement
functions but takes a `Polygon` where it took a `PixelBox`; the box overloads
become `rectanglePoints(box)` calls. `wallSegments` becomes
`polygonWalls(points, openings)`.

## 5. API

Module `floorplans` (no new module). Registered in `app.ts` AND
`src/e2e/test-helper.ts` (already is).

- `POST /:id/rooms`, `PUT /:id/rooms/:roomId` — `roomSchema` gains
  `points: polygonSchema.nullable().optional()`; when present the server
  derives `x y w h` (§3.1) and validates doors by edge (§3.2). `PUT` with
  `points: null` clears the polygon and keeps the box — an explicit act, as
  the `doors` omission rule already is: an OMITTED `points` leaves the column
  unchanged.
- `GET /` and `GET /:id` — rooms carry `points`; plans carry `links[]`.
  **Both declared in the response schemas, inner keys individually**, and the
  e2e asserts them over `app.inject` (the Fastify strip rule, seven times
  bitten).
- `POST /:id/links`, `PUT /:id/links/:linkId`, `DELETE /:id/links/:linkId` —
  `CONFIG_UPDATE`, `enforceReauth('UPDATE_FLOORPLAN_ROOM')`, audited with the
  three new actions (before/after JSON, the two room codes in the sentence).
  Geometry check for OPENING (§3.3); 404 for a room off this plan.
- `POST /` (plan) — `imagePath` optional; `imageWidth`/`imageHeight` required
  as the canvas size.
- `POST /api/uploads/floorplan` unchanged (the tracing image).

## 6. The designer — `apps/web/src/routes/config/layout-designer/`

Replaces `routes/config/floorplans.tsx` at `/config/floorplans` (route path
kept so bookmarks and the Configuration card keep working; the card is
renamed **Layout Designer**). `RequireRole roles={['SUPER_ADMIN']}` as today.
Folder, not one file: `index.tsx` (page), `canvas.tsx` (SVG surface and
pointer handling), `tools.ts` (pure tool state machine), `snapping.ts`
(pure), `properties-panel.tsx`, `links.tsx`, `__tests__/`.

### 6.1 Layout
Left toolbar (tools, undo/redo, grid toggle), canvas in the middle (SVG,
viewBox `1000 × 1000·H/W`, dotted grid every 2 % of the plan, optional
tracing image at 35 % opacity beneath), right properties panel. Plan bar
above: plan picker, **New plan** (name + size preset, or from an image),
**Upload tracing image**, delete plan.

### 6.2 Tools (`tools.ts` is a pure reducer; the canvas dispatches pointer
events into it)
- **Select** — click a room, door, link or corner; drag a room to move it
  (all corners translate; refused at the canvas edge).
- **Draw room** — click places a corner; Enter or a click on the first corner
  closes (≥ 3 corners); Escape discards. Shift constrains the next edge to
  horizontal/vertical. Snap targets, in priority: another room's corner
  (within 1 % of the plan), a point on another room's edge, the grid. A
  closed polygon that is not simple or too small is refused in place with the
  reason and stays open for correction.
- **Draw corridor** — Draw room with `grade` preset to CIRCULATION and the
  code prefilled `CORRIDOR-<n>`.
- **Corners** (on the selected room) — drag a corner (snapping as above);
  double-click an edge inserts a corner at that point; Delete on a selected
  corner removes it (refused below 3).
- **Door** — click an edge of the selected room; a door of default width
  appears centred on the click, kind ENTRY; the panel edits kind; drag slides
  it along the edge. Six per room, no overlap — today's rules.
- **Link** — click room A, then room B. If `sharedEdge(A, B)` is non-null
  the tool creates an OPENING centred on the shared stretch with default
  width, which the panel can turn into a door or slide; otherwise a
  CONNECTOR with an optional label. Escape cancels after the first click.
- **Delete** — the selected room (confirm when it holds instruments or
  links; the server cascades links), door or link.
- **Undo / redo** — over the in-progress, unsaved drawing state only
  (corners of an open polygon, an unsaved drag). Nothing saved is undone
  silently: a saved change is a §11 record and is reversed by another edit.

### 6.3 Properties panel
For the selected room: code, name, grade, temperature and humidity limits,
instruments (the existing picker and `PUT /:id/rooms/:roomId/instruments`).
For a door: kind. For a link: kind is fixed; opening width and door kind, or
connector label. The current editor's form rules stay (code required, blank
limit stores NULL).

### 6.4 Saving
Same rule as the current editor: a geometry change is saved on release
(`PUT …/rooms/:roomId` with `points`, re-authentication dialog as today), a
new room on close (the panel asks the code first, then `POST`), a link on
creation, properties on **Save**. Every save is a separate audited request;
nothing batches.

### 6.5 Existing plans in the designer
Open as four-corner rooms via `rectanglePoints(box)`; `points` is written
only when a corner is edited. The designer offers **Merge pieces** on a
selection of two adjoining CIRCULATION rooms or two pieces of one code: it
computes the union outline (rectilinear union of the two rectangles) into one
room, deletes the other, and moves its instruments — three audited requests,
confirmed first.

## 7. The dashboard

`floorplan-view.tsx`:
- A room's outline is `points ?? rectanglePoints(box)`; walls are
  `polygonWalls(points, openings)` with the room's doors (by `doorEdge`) and
  the OPENINGs from `plan.links` cut out; the tint is a `<polygon>`; the alarm
  halo is the outline inset by 4 units (`insetPolygon`, shared).
- `sharedOpenings` / `sameSpace` stay for CIRCULATION pieces without an
  explicit link, so today's corridors keep drawing as one space.
- CONNECTOR links draw as a dashed line from centroid to centroid in the door
  blue, label at the midpoint, `pointerEvents="none"`.
- The readings tiles lay out in `largestInscribedRect(points)` instead of the
  box; for a rectangle that IS the box, so nothing moves on today's plans.
- `RoomDetail`, the room history and the telemetry overview are untouched.

## 8. Testing

- **Shared** (`floorplan-geometry.test.ts`): bounding box; `isSimplePolygon`
  on a square, an L, a bow-tie (false), a degenerate repeat; `sharedEdge` on
  touching, overlapping, gapped and offset pairs; `largestInscribedRect` on a
  rectangle (itself), an L (the larger arm) and a T; `doorEdge` for all four
  wall names. Mutation-checked: invert the intersection test, drop the
  tolerance, return the bounding box from the inscribed search.
- **API e2e** (`floorplan-polygons.e2e.test.ts`): points accepted and box
  derived; bow-tie 400; corner outside 400; `points: null` clears, omission
  keeps; door on a missing edge 400; links create/update/delete with audit
  rows; OPENING on non-adjacent rooms 400 `NOT_ADJACENT`; duplicate CONNECTOR
  409; cascade on room delete; `points` and `links` present in `GET /` and
  `GET /:id` over `app.inject`, inner keys asserted. Mutation-checked by
  deleting the schema lines.
- **Web**: `tools.test.ts` (the reducer: draw, close, refuse, corner edit,
  snapping choices); `snapping.test.ts`; a render test of the designer that
  draws a triangle corner by corner and reads the `POST` payload;
  `room-geometry.test.ts` extended for polygon walls with an opening and a
  door; `floorplan-continuation.test.ts` unchanged.
- The existing `floorplans.e2e.test.ts`, `floorplan-annotations.e2e.test.ts`,
  `qc-layout.test.ts`, `traced-layouts.test.ts` and the dashboard tests stay
  green unchanged — the proof that rectangles are untouched.
- Every test file run individually by exit code; the commit gated on it.

## 9. Not in this build

Curved walls; rotating a room; measurement or dimension labels; printing or
exporting the plan; automatic corridor detection between rooms; an image
imported as vectors. Each is its own request.

## 10. Docs and counts to update with the code

`CHANGELOG.md`; root `CLAUDE.md` System Stats (models, audit actions and
templates) and the floorplan bullets; `apps/api/CLAUDE.md` (models, migration,
module note); `apps/web/CLAUDE.md` and root `CLAUDE.md` (the config PAGE count moves
23 → 22: `ls routes/config/*.tsx` counts files, `floorplans.tsx` goes and
`layout-designer/` is a folder; the `<Route` count does not move — same
path); `packages/shared/CLAUDE.md`;
`docs/recreation/06-api/endpoints.md` (three link routes); memory
(`instrument-dashboard-floorplans`).
