# Dashboard aggregate widgets — design

**Date:** 2026-08-28
**Status:** approved in chat, not yet implemented
**Scope:** Project B of two. Project A (panel assignment per role and per user) is
implemented and is what these widgets plug into — they arrive as two new keys in
its catalogue and need no change to it.

## The request

> "in dashboard if I want to assign only trend cards or only historian table or
> only alarm widget like that I need to be able to assign"

Project A made every panel that *existed* assignable. Those three named things did
not exist on the dashboard — trend charts, the historian table and the alarms
widget all live on the per-instrument trend page. This builds dashboard versions.

Operator decision, recorded: the dashboard versions show **whatever the viewer's
scope allows, aggregated**, following the existing `?fl=` drill-down.

## What exists today (verified against live code, 2026-08-28)

- `routes/dashboard/index.tsx` drills down through functional locations via `?fl=`
  and renders two panels: `telemetry_table` and `telemetry_floorplan`.
- An **Alarms count card** exists, but only at the top level (`selected === null`),
  and it is a navigation button to `/alarms`, not a widget. Its comment says a
  global count would be misleading deeper in the tree — which is exactly the gap
  this closes.
- `GET /api/alarms` filters by `state`, `acknowledged`, `instrumentId`, `limit`.
  **No location filter.** It is visibility-scoped via `scopedToVisible`.
- `floorplans/room-history.ts` already reads both metrics for every instrument in
  a room and buckets server-side (`WINDOW_SPEC`, ~480 points per window). It is
  the precedent this generalises.
- `TimeSeriesChart` takes `series` (lines) plus `min`/`max` for the in-limit band.
  It has **no** concept of a per-bucket envelope.
- `OverviewRow.temperature` / `.humidity` are `SlotValue { key, value, ts }` — the
  reading timestamp is already on the wire and the Readings table never shows it.

## Piece 1 — the trend card

### Endpoint

```
GET /api/instruments/telemetry-aggregate?functionalLocationId=&direct=&window=
```

`window` reuses `HISTORY_WINDOWS` (`15m|1h|6h|24h|7d`). Returns, per metric and
per bucket: `min`, `mean`, `max`, `instrumentCount`, `ts`.

Computed in SQL over `instrument_telemetry_history`, in one query per window,
with the caller's instrument-visibility filter merged into the instrument set —
the same way `getRoomHistory` now takes `visibility`. New module
`modules/instruments/telemetry-aggregate.ts`, beside the overview it complements.

Selection resolves through `resolveLocationIds()` so a Block covers its Areas,
exactly as the drill-down and every other location filter do. No fourth grouping
concept.

### Every point is DERIVED, and the card says so

A min/mean/max band is not a recording. This repo already refuses to let an
averaged trend look like stored data (`chart-interval-note.tsx`, and the
`lttb()` selection-not-averaging rule). The card carries the same class of
disclosure, on its face:

> Spread across N instruments — minimum, mean and maximum per interval. These are
> computed values, not stored readings.

The raw readings stay one click away on each instrument's own trend page, and the
card links there.

### Limit lines only when the selection agrees

Instruments in a selection can carry **different** limits — that is the whole
point of `limitsFor()` resolving per instrument, and this database already has
instruments whose own attributes override their room's.

**Limit lines are drawn only when every instrument in the selection resolves to
the same bound.** When they differ the lines are omitted and the card says
"instruments in this selection have different limits". Drawing the first
instrument's limits across a mixed selection would be a false claim about every
other instrument on the chart, and it is the easy thing to do by accident.

### The instrument count is load-bearing

`instrumentCount` per bucket ships and is shown. If instruments go offline the
band narrows — and a narrowing band reads as "conditions stabilised" when it
actually means "we are hearing from fewer sensors". A chart that cannot tell those
apart is worse than no chart.

### Chart support

`TimeSeriesChart` gains ONE optional prop:

```ts
envelope?: { points: { ts: string; lo: number; hi: number }[]; color: string };
```

Rendered as a filled path beneath the series, before the lines. Optional and
absent by default, so the trend page and the room chart are untouched — verified
by their existing tests staying green rather than by assertion.

Extending the shared chart rather than writing a second one: axes, scaling,
tooltips, fullscreen and the zoom interaction are already solved there, and a
parallel implementation would drift on the very details (`var(--chart-*)` with
literal fallbacks; a flat series' artificial range) that took work to get right.

## Piece 2 — the alarm list widget

`GET /api/alarms` gains a `functionalLocationId` query parameter, expanded via
`resolveLocationIds` and **ANDed with** the existing `scopedToVisible` filter —
never replacing it. A location filter that widened visibility would be the exact
inversion of what both filters are for.

The widget lists active alarms for the current drill-down: instrument code,
metric, value against its limit, raised at, and whether acknowledged. It links to
`/alarms` for the full page.

The existing count card is left alone as the top-level destination.

## Piece 3 — the Readings table gains a timestamp

**No new panel.** The operator's chosen historian shape — latest reading per
instrument — is what `telemetry_table` already renders. A second panel of that
shape would be a duplicate to keep in sync by hand, which is the failure Project A
just removed.

What is genuinely missing is *when*: `OverviewRow` carries `ts` per slot and the
table never shows it, so a value that stopped updating an hour ago looks exactly
like a live one. A new "As of" column shows the reading's age, with the absolute
timestamp on hover, formatted through `useDatetimeFormat` like every other date in
the product.

Where the two slots have different timestamps the column shows the **older** of
the two: the column answers "how stale might what I am looking at be", and the
freshest value cannot answer that.

## Panel catalogue

Two keys added to `@digilog/shared` `types/panels.ts`:

| Key | Page | Label |
|---|---|---|
| `dashboard_trend` | dashboard | Trend — spread across the selection |
| `dashboard_alarms` | dashboard | Active alarms in this selection |

The frozen-key test updates with them, and they go at the END of the dashboard
group — the order is asserted, and inserting into the middle would be a pointless
churn in a list whose order is contractual.

### New keys are OFF for restricted roles, deliberately

A role holding an explicit panel list does not get these until an admin ticks
them. Roles on `NULL` ("All panels") get them automatically.

This is the OPPOSITE of what the Project A migration did, and the difference is
the point: there, the trend panels were already visible to everyone, so carrying
only the dashboard keys would have *taken away* something people had. Here the
widgets are new, nobody has them yet, and defaulting new capability to "off until
granted" is the safe direction. **No migration** — the absence of a key in a
stored list already means "not shown".

## Counts this moves

- Prisma models **36**, enums **13** — unchanged. **No migration.**
- Permissions **42**, reauth actions **48**, audit actions **97** — unchanged. The
  new endpoint reuses `INSTRUMENT_READ`; the alarm filter is a parameter on an
  existing route.
- API modules **24** — unchanged (`telemetry-aggregate.ts` joins the existing
  `instruments` module).
- Config defs **25**, config pages **24**, `<Route>`s **50** — unchanged.
- Shared type files **18** — unchanged (two entries added to `panels.ts`).

## Testing

**Unit** — the aggregate module's pure half: bucket alignment; a bucket with one
instrument reporting is not silently treated as the whole selection; the
same-limits test that decides whether limit lines are drawn, including the case
where one instrument has no limits at all (which is "mixed", not "agrees").

**E2E** (`src/e2e/telemetry-aggregate.test.ts`), through the seeded OPERATOR over
HTTP, each restricted case with a positive control:
- an out-of-scope instrument contributes NOTHING to min/mean/max — asserted with a
  value extreme enough that its inclusion would be unmistakable;
- `functionalLocationId` for a Block covers its Areas;
- `instrumentCount` reflects only instruments that reported in that bucket;
- `GET /api/alarms?functionalLocationId=` narrows AND stays visibility-scoped —
  including the case where the location filter names a location the caller cannot
  see, which must return nothing rather than everything.

**Web** — the same-limits decision and the "as of" staleness formatting are pure
functions with unit tests. Rendering is checked by the operator in a browser;
Playwright cannot authenticate against this install's certificate.

## Explicitly out of scope

- Per-instrument lines on the dashboard trend card. The band is the answer for a
  selection; individual lines are what the per-instrument trend page is for.
- Any change to `instrument_scope`, panel assignment semantics, or the alarm
  evaluator.
- A period picker on the dashboard trend card beyond `HISTORY_WINDOWS`.
