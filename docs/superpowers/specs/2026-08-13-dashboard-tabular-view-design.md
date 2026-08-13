# Dashboard Tabular View — room-condition overview

**Date:** 2026-08-13
**Branch:** `data-injection`
**Reference:** `Tabular View.png` (repo root) — the operator's "Production Overview / Tabular View" screen

## Goal

Rework the Dashboard's existing Table view to the layout of the reference table: a
two-row grouped header where each measurement splits into **Actual** and **Set
Point**, a solid status cell, and a trend link per row.

**Content is provisional.** The operator's instruction was: *"i need table view
like that, i will say what should come in that table in next update."* So this
delivers the LAYOUT, populated with the data that already exists. The column set
is declared in one list (`COLUMN_GROUPS` at the top of `telemetry-table.tsx`) so
redefining the columns is an edit there, not a rewrite of the markup.

Placement: the Dashboard's existing `Table view | Graphical view` toggle. Not Home
— the operator's first message said Home, then corrected to the Dashboard's
existing tabular view.

## What the reference asks for, and what this system has

**Amended 2026-08-13 after seeing it:** the first column is **Instrument ID**, not
Room Name; the **DP group was removed**; and the STATUS cell is **Online / Offline**
only. The limit-breach signal moved into the value cells (red, bold) — an
instrument can read ONLINE while its temperature cell is red, because the probe is
healthy and the room is not. Table colours follow the app theme rather than the
reference's hardcoded dark grey.

| Reference column | Source here | Status |
|---|---|---|
| ROOM NAME | `FloorplanRoom.code` + `label` | exists |
| TEMP. (°C) — ACTUAL | telemetry via `/api/instruments/telemetry-overview` | exists |
| TEMP. (°C) — SET POINT | `FloorplanRoom.tempMin/tempMax` | exists, newly exposed |
| RH (%) — ACTUAL | same overview endpoint | exists |
| RH (%) — SET POINT | `FloorplanRoom.rhMin/rhMax` | exists, newly exposed |
| DP (mmWc) — ACTUAL / SET POINT | **nothing** | REMOVED on request |
| STATUS | `reporting` → Online / Offline | exists |
| MIMIC / TREND | instrument link + trend glyph | exists |

**DP has no source and the column was removed.** There is no differential-pressure
field in the schema and no AHU concept in this fork, so the column only ever showed
`NA` and the operator dropped it. Re-adding it means adding the data first, not
adding a column.

## Decisions

**Rows are instruments, and INSTRUMENT ID leads.** A room-per-row table hides every
unplaced instrument, and "this probe is not assigned to a room" is exactly the gap
this screen should surface.

**The room stays as a sub-line beneath the ID, deliberately.** The SET POINT columns
come FROM the room; without it, a spec of `18.0 - 25.0` has no visible source, and
an unplaced instrument looks identical to one whose room simply has no
specification. Unplaced rows read `not placed`.

**Set points use the reference's vocabulary**, derived from the room bounds:

- max only → `NMT 25.0` (Not More Than)
- min only → `NLT 18.0` (Not Less Than)
- both → `18.0 - 25.0`
- neither, or no room → `NA`

All four bounds NULL is legitimate — a corridor has no specification — so `NA` is
a real answer, not an error state.

**Colours follow the app theme**, not the reference's hardcoded dark grey. Header
bands use `--theme-primary-dark` — the 700-level tone in every preset, which keeps
white 11px header text above 4.5:1. `--theme-primary` is deliberately NOT used
behind white text: several presets measure near 3.7:1 there, which fails at that
size. Rows are white / slate-50, so the table matches the rest of the application
and the PDF export.

**Status is ONLINE / OFFLINE**, solid-filled like the reference's green `ON`, driven
by `reporting`. Offline sorts first so the rows needing attention surface in one
click, and the header line counts them.

**⚠ The limit-breach signal moved to the value cells.** Dropping the five-state
status removed the only place OUT_OF_SPEC was displayed, so a reading outside its
room's limits now renders red and bold in its own cell. An instrument can
legitimately read ONLINE with a red temperature cell — the probe is healthy, the
room is not. That styling is load-bearing, not decoration; the file header says so
because it does not look load-bearing.

## Backend change

`OverviewRow` gains `limits` (`tempMin/tempMax/rhMin/rhMax`, nullable). The query
**already loads these** to compute `status` and discarded them before responding,
so this costs nothing and saves the client a second request plus a client-side
join it could get wrong.

**Fastify strips any property absent from the response schema**, so `limits` is
declared in the `/telemetry-overview` 200 schema as well as on the type. A field
added to the type alone would silently never reach the browser — that trap is
noted in a comment at the schema.

## Testing

`formatSetPoint` is pure and unit-tested (8 cases): range, NMT, NLT, NA for null
and for undefined, decimal places, **zero as a real bound** (a 0 °C cold-room
minimum must not be dropped by a falsy check), and NaN/Infinity rejected rather
than printed.

The rest of the table can only be judged by looking at it. Playwright cannot get
past login in this environment, so the rendered result goes to the operator
unseen, and that is stated rather than implied.

## Out of scope

- Building DP for real, now that the column is gone (needs a telemetry key, per-room `dpMin/dpMax`, a migration
  — and `prisma migrate diff` in this repo emits destructive statements that must
  be stripped by hand).
- The reference's blue title bar, round icon buttons and HOME / WAREHOUSE / MORE
  LOCATIONS row: this app already has that navigation in the sidebar, and adding a
  second one would put two competing navigations on one screen.
- Home / the Module Guide: untouched.
- The final column set, which the operator is defining separately.
