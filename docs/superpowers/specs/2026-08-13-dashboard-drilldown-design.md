# Dashboard drill-down by Functional Location — design (Project B)

**Date:** 2026-08-13
**Branch:** `data-injection`
**Depends on:** Project A (`2026-08-13-functional-locations-design.md`), complete.

## Goal

Turn the dashboard into a ThingsBoard-style hierarchical view: entry cards, drill
from Block into its Areas, and the Tabular / Graphical views scoped to whatever is
selected. A functional-location dropdown at the top jumps straight to any location.

## Operator's words, and how each maps

| Asked for | Delivered |
|---|---|
| "in dashboard on top provide one filter showing multiple functional locations dropdown" | A location `<select>` in the page header, always visible, listing `All Instruments` + every Block and Area |
| "if user select one functional location then show that functional location linked instruments … in the tabular or graphical view" | Both views take an optional `functionalLocationId`; the API filters server-side |
| "in dashboard page, show only tabular view and graphical view" | Welcome hero, Quick Overview and Quick Actions are removed from the page |
| "when user click on dashboard first show the All Instruments, CWH Block, Alarms 3 cards" | Card grid: `All Instruments` + one card per Block, **driven by data** rather than hardcoded to CWH |
| "if user click on CWH Block, then Module-E, Module-F, Packing, Stability, WareHouse, Microbiology, QC, QC3" | Clicking a Block replaces the grid with cards for its Areas, plus a card for the Block's own directly-linked instruments |
| "like thingsboard dashboard types" | Three levels with breadcrumb navigation back up |

**The Alarms card is NOT included.** There is no alarm subsystem — it was removed
from this fork in Phase 6 — and the operator chose to build a real one as project C
rather than substitute an out-of-spec count. A card that cannot be backed by data is
worse than an absent card, so it arrives with C.

**Cards are data-driven, not hardcoded.** The operator named CWH and eight areas,
but those are their current locations, not a fixed menu. The grid renders whatever
the functional-location tree contains, so creating `Packing` on the Functional
Locations page makes a `Packing` card appear with no code change. Hardcoding the
eight names would have looked identical today and been wrong tomorrow.

## Navigation model

```
Level 0  [ All Instruments ]  [ CWH ]  [ Block C ]          ← Blocks from the tree
             │                    │
             │                    └─ Level 1  [ CWH — direct ] [ Module-E ] [ … ]
             │                                     │
             └──────────── Level 2 ────────────────┘
                      Tabular view | Graphical view, scoped
```

- **Level 0** — `All Instruments` plus one card per Block. Each card shows its
  instrument count (a Block's own **plus** its Areas', from `totalCount`).
- **Level 1** — a Block's Areas, plus a `— direct` card for instruments pinned to
  the Block itself. That card only appears when `ownCount > 0`; a Block with no
  direct instruments must not offer an empty view.
- **Level 2** — the two views, scoped to the selection, with a breadcrumb back.

Selection state lives in the URL (`?fl=<id>`), so a scoped view is linkable,
survives a refresh, and the browser Back button walks back up the tree. State in
`useState` alone would lose the selection on every reload.

## Scoping — server-side

`getTelemetryOverview` gains `functionalLocationId`. It resolves through
**`resolveLocationIds()`** from project A, so selecting a Block returns its own
instruments **plus all its Areas'** — the single most likely bug here is a Block
view that shows only the directly-pinned ones.

```ts
where: opts.functionalLocationId
  ? { functionalLocationId: { in: resolveLocationIds(opts.functionalLocationId, nodes) } }
  : opts.floorplanId ? { room: { floorplanId: opts.floorplanId } } : undefined
```

Filtering server-side rather than in the browser matters even though this is not
yet access control: the payload is the whole estate otherwise, and project D will
enforce visibility on this same query. A client-side filter would have to be
rewritten then.

**An unknown id resolves to `[]`**, which yields no rows rather than every row. A
stale bookmark must not silently widen to the whole estate.

## Graphical view under a location

Per project A's recorded decision: draw the **rooms of that location's
instruments**. Floorplans stay the source of geometry; functional locations stay the
logical grouping. `FloorplanView` takes the same optional `functionalLocationId`,
filters its room set to rooms containing at least one in-scope instrument, and shows
an honest empty state naming the fix ("no instruments in this location are placed on
a floorplan — place them in Configuration → Floorplans") rather than an empty
building.

## What is removed, and the consequence

The Welcome hero, **Quick Overview** (Total Users / Audit Trail / Notifications) and
**Quick Actions** leave the dashboard page.

**Consequence, stated rather than discovered later:** four keys in the
`dashboard-cards` config def — `total_users`, `audit_trail`, `notifications`,
`quick_actions` — become inert. They will still appear on the config page and toggle
nothing. Removing them is a follow-up (a config-def change with its own
12-touchpoint sweep), deliberately not bundled here so this change stays reviewable.
`telemetry_table` and `telemetry_floorplan` keep working and still gate the two
views.

## Files

**Modify**
- `apps/api/src/modules/instruments/telemetry-overview.ts` — accept and resolve `functionalLocationId`.
- `apps/api/src/modules/instruments/routes.ts` — querystring + pass-through.
- `apps/web/src/routes/dashboard/use-telemetry.ts` — `useTelemetryOverview(opts)`.
- `apps/web/src/routes/dashboard/index.tsx` — the drill-down; hero/overview/actions removed.
- `apps/web/src/routes/dashboard/telemetry-table.tsx` — accept `functionalLocationId`.
- `apps/web/src/routes/dashboard/floorplan-view.tsx` — accept and filter.

**Create**
- `apps/web/src/routes/dashboard/location-cards.tsx` — the card grid + breadcrumb.
- `apps/web/src/routes/dashboard/__tests__/location-nav.test.ts` — the pure navigation logic.

## Testing

The navigation shape is pure and therefore testable: given the tree and a selected
id, produce the cards to render and the breadcrumb. Cases: level 0 lists Blocks and
`All Instruments`; a Block lists its Areas; a Block with `ownCount > 0` gains the
`— direct` card and one with `ownCount === 0` does not; an Area lists no cards and
goes straight to the views; an unknown id falls back to level 0 rather than
rendering an empty page.

`useTelemetryOverview`'s URL construction is asserted too — a dropped query
parameter is invisible in the UI (it just shows more rows than it should) and is
exactly the failure a test catches cheaply.

## Out of scope

- **Alarms** (project C) and the Alarms card.
- **Role/user visibility** (project D) — this change deliberately puts the filter on
  the same server-side query D will enforce against.
- Removing the four inert `dashboard-cards` keys.
- Any change to the Functional Locations page itself.
