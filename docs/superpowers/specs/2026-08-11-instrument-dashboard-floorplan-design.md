# Instrument dashboard — table view, floorplan view, live time-series

**Date:** 2026-08-11
**Branch:** `data-injection`
**Supersedes:** the four `* Temperature Limit` / `* Humidity Limit` attribute keys
established in `2026-08-08-per-profile-instrument-attributes-design.md` (see §3)

## 1. The problem

Instruments report temperature and humidity into `instrument_telemetry_latest`
and `instrument_telemetry_history`, and there is nowhere to look at it. The
Instruments page lists devices and one detail page shows one device's readings.
Nothing answers the two questions an operator actually has:

- *What is every room reading right now, and is any of it out of spec?*
- *What has this room been doing for the last hour?*

The dashboard (`apps/web/src/routes/dashboard.tsx`) is three static stat cards
counting users, audit rows and notifications.

This adds two dashboard views over the existing telemetry:

- **Table** — every instrument with its current temperature and RH.
- **Graphical** — the site's floorplan with instrument-bearing rooms drawn on
  it, coloured by spec compliance; clicking a room drills into that room's
  instruments and their live time-series.

## 2. What already exists (do not rebuild)

Verified against the tree at the time of writing:

| Thing | Where | Note |
|---|---|---|
| Latest reading per (instrument, key) | `instrument_telemetry_latest` | Prisma model |
| Full history | `instrument_telemetry_history` | Monthly RANGE partitions; raw SQL only (Prisma cannot express `PARTITION BY`) |
| Partition rollover | `apps/api/src/workers/telemetry-partition.worker.ts` | Creates future partitions; no cliff |
| Read helpers | `instruments/telemetry.repository.ts` — `getLatest()`, `getHistory({instrumentId,key,from,to,limit,offset})` | `getHistory` already supports `from`/`to` |
| Per-instrument endpoint | `GET /api/instruments/:id/telemetry?key=&limit=` | Latest + history, capped 500 |
| "Is it reporting?" | `Instrument.expectedIntervalSec`, falling back to `instrument-activity` config `activeWindowMinutes` | Reuse; do not invent a second staleness rule |
| Per-role dashboard card visibility | `config/static-routes/dashboard-cards.routes.ts` + `routes/config/dashboard-cards.tsx` | New views slot in here |
| File upload | `apps/api/src/modules/uploads/` | Plan images go through it |
| Permissions | `INSTRUMENT_READ`, `CONFIG_READ`, `CONFIG_UPDATE` | Sufficient; **no new permission constants** |

**There is no push channel.** Pub/sub, the in-process event bus and
`@fastify/websocket` were all removed from this repo. "Live" in this spec means
**polling on an interval**, and the UI must not imply otherwise.

**Telemetry keys are free-form.** Ingest stores whatever key the device sends.
Live data here uses `temperature` and `humidity`; the e2e suite exercises `temp`
and `rh`. §5 handles this.

## 3. Limits move to the room (a reversal)

`2026-08-08-per-profile-instrument-attributes-design.md` put spec limits on the
instrument, as four free-text attribute keys on the Default profile:
`Low Temperature Limit`, `High Temperature Limit`, `Low Humidity Limit`,
`High Humidity Limit`.

**Those four keys are retired.** Limits become numeric columns on the room.

Reasoning:

1. A cleanroom's specification belongs to the room, not to whichever probe is
   currently bolted to its wall. Under the attribute model, replacing a probe
   silently discards the room's spec, and two probes in one room can carry two
   different specs with nothing flagging the contradiction.
2. `instrument_attributes.value` is `String` — sanitised free text with no
   numeric constraint. `"25 C"`, `"2 2"` and `""` all store cleanly and all
   silently disable limit checking. A limit that fails open is worse than no
   limit.
3. Keeping both would be the third duplication of the same fact in this schema
   (`Block` / `Area` / `Location` already exist both as `Instrument` columns and
   as attribute keys). Two answers to "what is the limit here" is a support
   burden that never ends.

**Not retired:** `Low/High Temperature Range` and `Low/High Humidity Range`.
Those describe the *device's* measurement capability, which genuinely is a
per-instrument fact and is not what colours a room. `Slave ID`, `Block`, `Area`
and `Location` are untouched.

**Migration is trivial, and runs last.** The live database holds exactly one
`instrument_attributes` row matching a retired key (`Low Temperature Limit`).
Retirement is step 5 in §10 — deliberately after rooms exist, so there is
somewhere for a value to go. The migration copies any parseable numeric value
into the room of the instrument that carries it, writes an audit row for each,
and leaves unparseable values and unplaced instruments' values in place for
manual review rather than discarding them. The four keys are then stripped from
every profile's `attributeKeys`.

**The existing `instrument_attributes` rows are deleted, each with its own audit
row** naming the key and the removed value. Keeping them would leave
`attributes-panel.tsx` rendering "High Temperature Limit: 25" on the instrument
detail page forever — which is precisely the second source of truth this section
exists to eliminate — and hiding them instead would need a suppression list,
i.e. a fourth mechanism. Deletion is audited per the `InstrumentAttribute`
model's own contract ("each change is audited individually, naming the key and
both values"), so the value survives in the audit trail even where it could not
be migrated.

**Collision rule.** Where two instruments in one room carry different values for
the same retired key, the room's limit is left **unset** and both values are
reported in the migration output for manual resolution. Silently picking one
would invent a specification nobody wrote. This cannot occur on this install
(one matching row exists) but the migration ships to customer installs.

**Verified data-only.** A grep across `packages/` and `apps/` finds no code
reference to any of the four key strings — they are not in
`INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT`, not in `instrument-attributes.def.ts`, and
not in any frozen-snapshot test. Retirement touches data and the migration
only.

## 4. Data model

Two new models plus one nullable column:

```prisma
model Floorplan {
  id          String   @id @default(uuid())
  name        String   @unique          // "CWH — 3rd Floor"
  imagePath   String   @map("image_path")
  imageWidth  Int      @map("image_width")
  imageHeight Int      @map("image_height")
  isActive    Boolean  @default(true) @map("is_active")
  sortOrder   Int      @default(0) @map("sort_order")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  createdBy   String?  @map("created_by")
  updatedBy   String?  @map("updated_by")

  rooms FloorplanRoom[]

  @@map("floorplans")
}

model FloorplanRoom {
  id          String  @id @default(uuid())
  floorplanId String  @map("floorplan_id")
  code        String                     // "CWH-I/142"
  label       String?                    // "WET LAB"

  // Normalized 0..1 against the plan image, NOT pixels — see below.
  x Float
  y Float
  w Float
  h Float

  // Nullable = that bound is not checked. All four null = no limit checking,
  // which is a legitimate state for a corridor or an office.
  tempMin Float? @map("temp_min")
  tempMax Float? @map("temp_max")
  rhMin   Float? @map("rh_min")
  rhMax   Float? @map("rh_max")

  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  createdBy String?  @map("created_by")
  updatedBy String?  @map("updated_by")

  floorplan   Floorplan    @relation(fields: [floorplanId], references: [id], onDelete: Cascade)
  instruments Instrument[]

  @@unique([floorplanId, code])
  @@index([floorplanId])
  @@map("floorplan_rooms")
}
```

On `Instrument`:

```prisma
  roomId String?        @map("room_id")
  room   FloorplanRoom? @relation(fields: [roomId], references: [id], onDelete: SetNull)

  @@index([roomId])
```

Three choices worth stating:

- **Coordinates are normalized 0..1, not pixels.** The hotspots then hold at any
  zoom and any screen size, and survive re-exporting the drawing at a different
  DPI. Pixel coordinates would need re-authoring every time the source image
  changes.
- **`roomId` is a foreign key, not the existing free-text `location`.** The
  descriptive `block` / `area` / `location` columns are left exactly as they
  are. Room membership becomes a reference that a typo or a trailing space
  cannot break. There is nothing to migrate: 2 of 15 instruments currently have
  any `location` value at all, so the placement editor is how instruments get
  placed, and `location` is not read by anything in this feature.
- **`roomId` is nullable and `onDelete: SetNull`.** An unplaced instrument is a
  normal state, and deleting a room must not delete instruments. The graphical
  view renders unplaced instruments in an explicit tray (§6) so they are never
  silently invisible.

**Migration** is hand-authored per `apps/api/CLAUDE.md` ("Database Migrations —
READ BEFORE ANY SCHEMA CHANGE"): `prisma migrate diff` to draft,
review, hand-author into `prisma/migrations/<UTC>_instrument_floorplans/`, then
`npm run db:verify-migrations` must PASS before commit.

## 5. Resolving "temperature" and "humidity"

A new config definition, `telemetry-keys.def.ts`, maps a semantic slot to an
ordered list of accepted telemetry keys:

```
temperature:  temperature, temp, t
humidity:     humidity, rh, hum
```

For a given instrument, the first alias present in its latest readings wins.
Without this, an instrument from a vendor that says `temp` renders blank cells on
both views and nothing explains why. The lists are ordered so a device reporting
both `temperature` and `temp` resolves deterministically.

The def also carries display precision (decimal places) per slot, and the two
poll intervals used in §7 (overview refresh, chart refresh) so a site can slow
them down without a code change.

This is a new config def and therefore triggers the **12-touchpoint rule** in
`docs/CONTRIBUTING.md` — including registration in `config-discovery.ts` and a
card in `routes/config/index.tsx`. Config def count goes 22 → 23.

**Staleness** is not redefined here. A reading is current if the instrument is
Active by the existing rule (`expectedIntervalSec`, else the `instrument-activity`
config window) and stale otherwise.

## 6. Backend endpoints

### Prefix note

`/api/dashboards` (plural) is **already taken** by the existing widget-dashboard
module (`apps/api/src/modules/dashboards/routes.ts`, 494 lines). Mounting a
second, unrelated `/api/dashboard` (singular) beside it would be a trap for the
next reader. These endpoints therefore live with the resources they read:
telemetry under `/api/instruments`, room history under `/api/floorplans`. The
existing `dashboards` module is not touched.

### `GET /api/instruments/telemetry-overview`

Gate: `INSTRUMENT_READ`. Sits beside the existing `/:id/telemetry` route and
matches ahead of `/:id` the same way `/eligible-children` already does. One row
per instrument:

```
{ instrumentId, code, name, isActive,
  room: { id, code, label, floorplanId } | null,
  temperature: { key, value, ts } | null,
  humidity:    { key, value, ts } | null,
  reporting: boolean,                     // per §5 staleness rule
  status: InstrumentStatus }
```

**`InstrumentStatus`**, in strict precedence order — the first condition that
holds wins, and this same order defines "worst" wherever statuses are compared:

| Rank | Status | Condition |
|---|---|---|
| 1 | `OUT_OF_SPEC` | A resolved value breaches a limit its room sets |
| 2 | `STALE` | Not reporting per the §5 staleness rule |
| 3 | `NO_DATA` | No reading at all for either slot |
| 4 | `PARTIAL` | Reporting, in spec, but one slot has no reading while its room sets a limit for that slot |
| 5 | `OK` | Reporting, both required slots present, all within limits |

`OUT_OF_SPEC` deliberately outranks `STALE`: a probe last seen four hours ago
reading 27 °C in a 25 °C room is a breach that happens to also be stale, and
showing it amber would understate it. The staleness is still visible — the row
and the room box both show the reading age regardless of status.

`PARTIAL` exists because a room with both temperature and RH limits whose probe
reports only temperature is a real and common state, and it is neither `OK` nor
a breach.

One query joining `instruments` × `instrument_telemetry_latest` ×
`floorplan_rooms`. It feeds **both** views — the table renders rows directly, the
floorplan aggregates them by room. Building two endpoints for one dataset would
guarantee the two views eventually disagree.

Optional `?floorplanId=` narrows to one plan.

### `GET /api/floorplans/:planId/rooms/:roomId/history?window=15m|1h|6h|24h|7d`

Gate: `INSTRUMENT_READ`. Every instrument in the room × both slots, in one call.
A 3-instrument room would otherwise poll 6 endpoints every few seconds.

Server-side bucketing: windows above ~6h return per-bucket averages
(`date_trunc` / width_bucket over `ts`) rather than raw rows, capped at ~500
points per series. Raw rows for a 7-day window would be tens of thousands of
points that no chart can draw and no browser should receive.

### `GET|POST|PUT|DELETE /api/floorplans` and `/api/floorplans/:id/rooms[/:roomId]`

Reads gate on `CONFIG_READ`, writes on `CONFIG_UPDATE`, writes require reauth.

**Writes are audited.** A room's temperature limits are a quality record —
who changed the spec, from what, to what, must be answerable. This is the
opposite of telemetry itself, which stays deliberately unaudited as process data
(the existing spec D5 decision in `telemetry.repository.ts`). Do not add
`auditLog()` to the telemetry path; do add it to every floorplan and room write.

Room writes validate: `x`, `y`, `w`, `h` within 0..1 and `x+w <= 1`, `y+h <= 1`;
`tempMin < tempMax` and `rhMin < rhMax` where both are present; `code` unique
within the plan.

### `GET /api/instruments/:id/telemetry` — existing, extended

Additive only: expose the `from` / `to` query parameters that `getHistory()`
already accepts but the route does not surface. Used by the single-instrument
chart. No behaviour change for existing callers.

## 7. Frontend

`apps/web/src/routes/dashboard.tsx` (252 lines) becomes a folder. Splitting it is
part of the work, not incidental — three views in one file would put it past
1000 lines.

```
routes/dashboard/
  index.tsx              existing stat cards + Table | Graphical toggle
  telemetry-table.tsx    the table view
  floorplan-view.tsx     plan picker, image, hotspot overlay, unplaced tray
  room-detail.tsx        one room: instruments + live charts
  time-series-chart.tsx  hand-rolled SVG line chart
  use-telemetry.ts       SWR hooks for both endpoints
routes/config/
  floorplans.tsx         the placement editor
```

### Table view

Columns: Instrument ID (code), Name, Room, Temperature, Humidity, Last reading,
Status. Sortable; filterable by plan, room and status. Out-of-spec values are
flagged in the row. Instruments with no room show "Not placed".

### Graphical view

**REVISED 2026-08-11, after seeing it.** The first version showed the uploaded
plan image with transparent hotspots over it. On screen that reads as a scan
with rectangles stuck on top — the rooms are invisible until you hover, and the
drawing's own ink competes with the status colours it is supposed to carry.

The dashboard now **draws** the layout: each room is a real shape with walls, its
code and label, its current readings, and a status colour filling it. **The plan
image is not shown on the dashboard at all.** It appears only in the editor, as a
faded tracing guide underneath the shapes being drawn.

Nothing behind the view changed. Rooms already store `x/y/w/h` as proportions,
which is exactly what a drawn layout needs, so limits, placement, telemetry,
history and the audit trail are all untouched. This is a renderer swap.

Rejected alongside it: **2.5D isometric** (still dependency-free, but labels and
readings are harder to place and comparing two rooms' values is slower than a
flat plan) and **true 3D** (needs three.js in a repo that has deliberately
removed every rendering dependency it ever had; only worth it if walking the
building is the actual goal, which it is not — the goal is reading numbers).

Plan picker → drawn floor at the plan's aspect ratio → one shape per room at its
normalized coordinates. Each shows room code, label, current temperature and RH,
and takes its colour from the room's aggregate status — the worst status among
its instruments by the §6 precedence table:

| Room status | Colour |
|---|---|
| `OUT_OF_SPEC` | red |
| `STALE` | amber |
| `NO_DATA` (or no instruments placed) | grey |
| `PARTIAL` | amber |
| `OK` | green |

Below the plan, a **"Not placed on any plan"** tray lists instruments with
`roomId = null` alongside their readings. Instruments must never be silently
absent from the dashboard because nobody placed them.

Clicking a room opens the room detail.

### Room detail

The clicked room's region of the plan, its instruments listed with ID and current
temperature/RH against the room's limits, and a live time-series chart per
instrument with a window selector (15m / 1h / 6h / 24h / 7d).

### Placement editor (`config/floorplans.tsx`)

Upload a plan image and name it. Then, on the plan: drag a box, give it a room
code and label, set its four limits, and tick which instruments live in it.
Boxes are draggable and resizable afterwards. An instrument may belong to at most
one room; ticking it in a second room moves it and says so.

The CWH 3rd-floor drawing (`CWH 3RD floor Pantry-DP.pdf`) is rendered to PNG once
and uploaded through this editor as the first plan. The PDF is not parsed and no
room geometry is extracted from it — the rooms that matter are the ones with
instruments in them, and they are placed by hand.

### Polling, not push

`use-telemetry.ts` uses SWR `refreshInterval`: 5s for the overview, 10s for
charts. Both read from the config in §5 so a site can slow them down. The UI
labels this honestly ("updated 3s ago"), never "real-time" or "live stream".

### Charts: hand-rolled SVG, no new dependency

This repo has deliberately removed every chart and canvas library it has ever
carried (`chartjs-node-canvas`, `reactflow`, `@monaco-editor/react`) and
hand-rolls its canvases. `time-series-chart.tsx` is an SVG line chart with axes,
a limit band, and hover readout — a few hundred lines, no dependency, styled with
the existing theme CSS variables.

### Role visibility

Both views register in the existing `dashboard-cards` config
(`telemetry_table`, `telemetry_floorplan`) so they are hidden per role by the
same mechanism as every other dashboard card. No parallel visibility mechanism.

## 8. Testing

- **API e2e** — overview endpoint shape and status computation across the four
  states; room history bucketing at each window; floorplan and room CRUD
  including the coordinate and limit validation; audit rows written on every
  floorplan/room write and **not** written on telemetry reads; `roomId` set null
  when its room is deleted.
- **Migration** — `npm run db:verify-migrations` PASSes; the limit-attribute
  migration copies a parseable value and leaves an unparseable one in place.
- **Web unit** — status/colour derivation from a reading plus limits (the pure
  function, table-driven); alias resolution picking the first present key;
  chart scale and bucket maths.
- **Browser** — the operator tests in the browser. §9 covers having something to
  see.

Per `apps/api/CLAUDE.md`: run the API suite single-fork
(`cd apps/api && npm test`), and provision a unique SUPER_ADMIN inside any new
e2e file rather than sharing `admin`.

## 9. There is almost nothing to look at yet

Live database at the time of writing: **15 instruments, 2 with any location, 32
rows in `instrument_telemetry_history`**, keys `temperature` / `humidity` on a
handful of devices.

The plan therefore includes a small publisher script that registers a few
instruments against the CWH rooms and publishes plausible temperature/RH through
the existing EMQX ingest path — including values that breach limits, so the
colour coding can be seen doing its job. Without it we would be shipping three
views neither of us has watched populate.

The script is a dev tool under `scripts/`, writes only through the normal ingest
endpoint, and is never wired into the app.

## 10. Sequencing

1. **Config def + overview endpoint + table view.** Delivers something visible
   immediately and proves the key-alias resolution against real devices.
2. **Time-series chart + single-instrument history.** Reuses the extended
   existing endpoint.
3. **Floorplan schema + placement editor.**
4. **Graphical view + room detail.**
5. **Limit-attribute retirement + migration.**

Steps 1–2 carry the risk that matters (does the data resolve, does polling feel
right). The floorplan geometry is the largest unknown and is last, so if it is
renegotiated the rest still stands.

## 11. Out of scope

- **Alerts on limit breach.** The `notification-rules` module could drive this
  later; it is not part of this work.
- **Differential pressure.** The source drawing is a *DP zoning* layout, and DP
  is a natural third slot. Not built here — this spec covers temperature and RH
  as asked. The §5 slot mapping is shaped so DP can be added without rework.
- **Historic playback** of the floorplan (scrubbing the plan back through time).
- **Automatic room extraction** from the PDF. Considered and rejected: matching
  ~150 free-floating labels to enclosing polygons is a real geometry problem, and
  the label data is already visibly dirty (`CWH-I/142` and `CWH-I/217` each
  appear twice in the source).
- **Any change to ingest.** Nothing in this feature touches how readings arrive.

## 12. Documentation touchpoints

Per the Documentation Sync Rule, verify each count with a live `grep`/`ls` at the
time of the change:

- Root `CLAUDE.md` — Prisma model count (+2), config def count (22 → 23), web
  route count, API endpoint list.
- `apps/api/CLAUDE.md` — model count, config def count, new module.
- `apps/web/CLAUDE.md` — route count, dashboard folder, new config page.
- `CHANGELOG.md` — always.
- `tasks/todo.md` — audit-log entry.
- `2026-08-08-per-profile-instrument-attributes-design.md` — note the §3
  reversal of the four limit keys.

The §3 retirement itself has **no code touchpoints** — verified by grep across
`packages/` and `apps/`, no source file names any of the four key strings. It is
a migration plus the audited deletion of the matching `instrument_attributes`
rows.
