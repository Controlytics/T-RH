# Layout Designer — 2D design model

**Date:** 2026-10-05
**Status:** approved in conversation ("go ahead with the 2d layout designer"); the operator took the recommended option of three
**Extends:** `docs/superpowers/specs/2026-09-22-layout-designer-design.md` (the designer) and the 2D ARCHITECTURAL style the five traced floors render in (root `CLAUDE.md`, "ONE QC plan … in the 2D ARCHITECTURAL style", "THE 2D STYLE'S LOOK IS VIVID STATUS")

## 1. What the operator asked for

> "layout designer feature is should able to create 2d design model"

Asked what that should mean, the operator chose, of three:

| Option | Chosen |
|---|---|
| **Full 2D authoring** — a plan has a style; the designer gains tools for the structure layer, door hinge / swing / double leaf, floor group and north; the dashboard renders it like the traced floors | **yes** |
| Style switch only | no |
| Full authoring + the traced floors become fully designer-owned | no |

## 2. What exists today, and what this keeps

**The 2D style is a RENDERING of data that already exists.** `floorplans.annotations`
(JSONB, nullable) carries `style: 'architectural'`, `columns[]`, `windows[]`,
`walls[]` (partition stubs), `equipment[]`, `labels[]`, `floor {group, label,
order}`, `north`, and the older `hvac` / `water` / `airflow`. Rooms carry
`points` (a polygon) and `doors[]` with `edge`, `offset`, `width`, `kind`,
`hinge` ('start' | 'end' | 'none') and `swing` ('in' | 'out'). The dashboard
(`routes/dashboard/floorplan-view.tsx`) switches on `annotations.style ===
'architectural'` and draws double walls, status-washed rooms, reading pills,
columns (hatched), windows (glazed), wall stubs, equipment outlines, labels, a
compass and a floor switch. The response schema (`planProps` in
`modules/floorplans/routes.ts`) declares every one of those keys.

**Who writes it today:** only the trace scripts (`draw-architectural-floor.ts`,
`draw-qc-layout-2.ts`), through Prisma. `floorplanSchema` /
`floorplanUpdateSchema` (`modules/floorplans/validation.ts`) have NO
`annotations` key, so `POST /api/floorplans` and `PUT /api/floorplans/:id`
cannot write it. The designer (`routes/config/layout-designer/`) draws polygon
rooms, places doors on edges, links rooms, and edits code / label / grade /
limits / membership; its `DesignerPlan` type has no `annotations`; its door
rows edit `kind` and remove, nothing else; its canvas (`canvas.tsx`, viewBox
1000 wide) draws rooms, doors, corners and links in the standard look.

Everything above keeps working. A plan with no `annotations.style` is the
standard style exactly as now. The five traced floors keep being drawn by their
scripts (option three was declined) — see §8.

## 3. Data model — nothing new

No model, enum, migration, permission, reauth action, sidebar item or route is
added. Three things are written through the API that were not before:

### 3.1 `floorplans.annotations` — now validated and writable

A zod `annotationsSchema` in `validation.ts`:

| Key | Shape | Rule |
|---|---|---|
| `style` | `'standard' \| 'architectural'` | absent = standard; the designer writes it explicitly |
| `columns`, `windows`, `equipment` | `{x, y, w, h}[]`, plan units 0..1 | `0 ≤ x,y`, `w,h > 0`, `x+w ≤ 1`, `y+h ≤ 1`; ≤ 500 each |
| `walls` | `{x1, y1, x2, y2}[]`, 0..1 | the two ends differ; ≤ 500 |
| `labels` | `{x, y, text}[]` | 0..1; `text` trimmed, 1..60 chars; ≤ 200 |
| `floor` | `{group, label, order} \| null` | strings trimmed 1..60; `order` integer 0..99 |
| `north` | number \| null | 0 ≤ north < 360 |
| `hvac`, `water`, `airflow` | passthrough | validated as arrays of objects only — the traced plans carry them and the designer never edits them |

Added to `floorplanSchema` as `annotations: annotationsSchema.optional()` (so
`floorplanUpdateSchema` inherits it). **Omitted = the column is left untouched;
given = replaced whole** — the `doors` rule of 2026-08-24, for the same reason:
a client that predates a key must not silently wipe it, and a partial merge
would let a stale client resurrect a deleted column.

### 3.2 Doors — `hinge` and `swing` written by the designer

The room PUT already validates them (`roomSchema`, since 2026-10-01). The
designer's door rows gain the controls; nothing moves on the server.

### 3.3 A double door is two doors

As the traces do (`vPair` / `hPair` in `architectural-layout.ts`): two
half-width doors on the same edge, `hinge: 'start'` on the first and `'end'` on
the second, abutting at the middle of the original opening. The designer offers
**Double leaf** as an action on a door row that replaces that door by the pair;
there is no "double" flag in the data.

## 4. Shared geometry — `packages/shared/src/types/floorplan-geometry.ts`

Two pure additions, used by the designer and tested there:

- `segmentOnEdge(a, b, polys)` — snaps a two-click segment to the nearest
  polygon edge when both ends lie within `SNAP_TOL` of the same edge (a window
  or a wall stub drawn along a wall lands ON the wall); otherwise returns the
  points unchanged (a free-standing stub across a room is allowed — Module-E's
  duct stubs are).
- `splitDoor(door, points)` — the double-leaf rule of §3.3: returns the two
  doors; pure, so the designer and a future script agree.

Everything else the tools need (`nearestEdgePoint`, `snapPoint`, `GRID`) is in
the designer's own `snapping.ts` already.

## 5. API

| Route | Change |
|---|---|
| `POST /api/floorplans` | accepts `annotations` (validated); a designer-created plan sends `{style: 'architectural'}` |
| `PUT /api/floorplans/:id` | accepts `annotations` (validated); the `FLOORPLAN_UPDATED` audit row's before / after gain `annotations` as a **summary** — `{style, columns, windows, walls, equipment, labels}` as COUNTS plus `floor` and `north` — not the coordinate arrays, which would be hundreds of numbers nobody can diff on a §11 record |
| `GET` plan reads | unchanged; `annotations` already declared |

Same `CONFIG_UPDATE` permission and `UPDATE_FLOORPLAN` re-auth as every plan
write. The room routes are unchanged.

## 6. The designer — `apps/web/src/routes/config/layout-designer/`

### 6.1 Plan panel (new)

With no room or link selected, the right-hand panel shows the PLAN:

- **Style** — Standard / 2D architectural. A NEW plan is created as 2D
  (`createPlan` sends `annotations: {style: 'architectural'}`); an existing
  plan keeps what it has until switched. Switching to Standard keeps the
  structure data (the dashboard just stops drawing it) — nothing is deleted by
  a style change.
- **Floor** — group, label, order (the Module-F floor switch). Blank group =
  not a multi-floor building.
- **North** — degrees clockwise from the top, blank = no compass.
- For a traced plan (§8) a one-line note: "This plan is drawn by a script;
  re-running it overwrites edits made here."

Saved as ONE `PUT /api/floorplans/:id {annotations}` carrying the plan's whole
annotations object (the structure arrays included), under the existing `run`
helper, so the re-auth dialog, toasts and revalidation are the same path every
other save takes.

### 6.2 Tools (`tools.ts` reducer; the canvas dispatches)

`Tool` gains `'column' | 'equipment' | 'window' | 'wall' | 'label'`. The
toolbar shows them in a second group, **only when the plan's style is 2D** —
in the standard style they would draw into data the dashboard does not show.

| Tool | Gesture | Stores |
|---|---|---|
| Column | drag a box (snapped to the grid) | `columns[]` entry |
| Equipment | drag a box | `equipment[]` entry (outlined on the dashboard) |
| Window | click, click (snapped by `segmentOnEdge`); the second click makes a thin box along the segment, `WINDOW_DEPTH` = 0.008 plan units, centred on the wall line | `windows[]` entry (a box, as the traces store) |
| Wall stub | click, click (snapped by `segmentOnEdge`) | `walls[]` entry |
| Label | click, then a text prompt in the panel | `labels[]` entry |

`DesignerState` gains `drag: {kind, from, to} | null` for the box tools and
reuses `drawing` (two points) for the segment tools. Escape cancels, as now.

### 6.3 Selection and editing

`Selection` gains `{kind: 'structure'; layer: 'columns' | 'windows' | 'walls'
| 'equipment' | 'labels'; index}`. A selected element is highlighted; drag
moves it (boxes and labels by their origin, segments by both ends); the panel
shows its numbers (x / y / w / h, or the two ends, or the text) editable in
place, and **Delete** (button or the Delete key, as rooms have). Every edit
goes through the same `PUT {annotations}` of §6.1 — the annotations object is
held in the page's state and saved whole on each change, like a room's doors.

### 6.4 Doors in 2D

The door row in the room panel gains **Hinge** (Start / End / None — "None"
is a leafless opening, the sliding doors and bays of the traces), **Swing**
(In / Out), **Width** (fraction of the edge, 0.02..0.5) and the **Double
leaf** action (§3.3). The controls show in both styles — a door's data is the
same in either — but the swing arc only draws in 2D.

### 6.5 Canvas preview

In the 2D style the designer canvas draws the structure layer the way the
dashboard does: thick wall strokes with a light core, hatched columns, glazed
windows, outlined equipment, labels in the room-name ink, door leaves with a
dashed swing arc (hinge and swing honoured). It does NOT draw readings, pills
or cards — that is the dashboard's job and needs telemetry. The drawing code
is the designer's own (`canvas.tsx`), kept deliberately small; the dashboard's
renderer is not imported into the config page (it pulls in telemetry types and
the card layout).

### 6.6 Existing plans

A standard plan opened in the designer shows the Plan panel with Style =
Standard and no structure tools. Switching it to 2D re-renders the canvas in
the 2D look and reveals the tools; its rooms and doors are already valid 2D
data (hinge defaults to 'start', swing to 'in').

## 7. The dashboard

No change. A designer-made 2D plan carries exactly the keys a traced plan
carries, and the dashboard reads them through the same code path. The render
test in §9 proves it.

## 8. The five traced floors

QC, QC Microbiology, QC 3, Module-E and Module-F stay drawn by
`draw-architectural-floor.ts` / `draw-qc-layout-2.ts`; their `*-layout.ts`
files remain the source of truth, and a re-run overwrites whatever the designer
changed on them. The designer does not refuse to edit them (the rooms have
always been editable there), it SAYS so on the Plan panel. Promoting them to
designer-owned plans was the declined third option and is not done here.

## 9. Testing

- **Shared** — `segmentOnEdge` (snaps when both ends sit on one edge; leaves a
  free segment alone; never snaps two ends to different edges) and
  `splitDoor` (two half-widths, mirrored hinges, same kind / swing, abutting).
- **API e2e** (`floorplan-annotations-write.e2e.test.ts`) — POST with
  `annotations` lands and reads back key by key over HTTP (Fastify strips an
  undeclared key silently — assert the inner keys); PUT replaces whole; PUT
  without `annotations` leaves it untouched (mutation-checked); every bound in
  §3.1 refused with a 400 naming the field; the audit row carries the summary,
  not the arrays; a style of `'wrong'` refused.
- **Designer page** (`designer-page.test.tsx` + new `structure-tools.test.tsx`)
  — one case per tool (column, equipment, window on a wall, free wall stub,
  label); select / move / delete an element; the Plan panel saves style /
  floor / north; the tools are hidden in the standard style; a new plan is
  created as 2D; the door row's hinge / swing / width / double leaf each PUT
  the room with the right doors.
- **Canvas render** — a 2D plan with one of each element renders the
  `fp-structure`-equivalent markup in the designer.
- **Dashboard render** — a plan built the way the designer builds one
  (annotations + polygon rooms + hinged doors) renders through
  `FloorplanView`'s 2D path with `fp-structure` and `fp-plant` present —
  proving §7 without the eye.
- Mutation checks: the "omitted annotations leaves the column" rule; the
  tools-hidden-in-standard rule; `splitDoor`'s mirrored hinges.

## 10. Not in this build

- No image tracing or import; the 2D model is drawn by hand.
- No HVAC / water / airflow authoring (the keys pass through for the traced
  plans; the operator has not asked for them).
- No room `meta` (fill / fch / dims) authoring.
- The traced floors are not migrated into the designer (§8).

## 11. Docs and counts to update with the code

Root `CLAUDE.md` (a Layout Designer 2D bullet under the Layout Designer
note; "No count moved"), `apps/web/CLAUDE.md` (designer section),
`packages/shared/CLAUDE.md` (two geometry functions), `CHANGELOG.md`. No
count moves: no model, enum, migration, permission, reauth action, def, page,
route, hook or lib module. Shared type files stay 33 (the functions join
`floorplan-geometry.ts`).
