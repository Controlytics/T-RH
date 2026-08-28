# Customisable dashboard layout — design

**Date:** 2026-08-28
**Status:** awaiting review — NOT approved for implementation
**Scope:** Project C1 of two. C2 (the per-card edit dialog: bounded palette,
heading text, status colours locked) is deliberately out of scope here and slots
into the same edit mode afterwards.

## The request

> "in dashboards screens all cards and widgets should be drag and move or change
> place and width and height should be increase or decrease when dragging, and
> give edit options for each card"

Operator decisions already taken: `react-grid-layout`; a bounded palette with
status colours locked (C2); layout stored **per user with a role default as the
starting point**; layout first, styling second.

## What exists (verified 2026-08-28)

- `routes/dashboard/index.tsx` drills down through functional locations via `?fl=`.
- Four assignable panels: `telemetry_table`, `telemetry_floorplan`,
  `dashboard_trend`, `dashboard_alarms` — all gated by `usePanels()`.
- `telemetry_table` and `telemetry_floorplan` are currently **one region with a
  Table | Graphical toggle**, showing one at a time.
- The drill-down entry cards (one per Block/Area, plus the Alarms count card) are
  generated from the location tree and change with the level.
- No layout or drag-and-drop library. Web dependencies are lean by habit —
  `reactflow`, `monaco` and `chartjs` were each removed.
- `react-grid-layout@2.2.4` installs cleanly against React 19 (`--dry-run`: 8
  packages, no peer conflict).

## ⚠ Decision that needs the operator's confirmation at review

**The Table | Graphical toggle would be replaced by two independently placeable
cards.**

A grid where every panel is a movable item cannot also have two of those panels
sharing one slot behind a toggle. They are already two separate keys in the panel
catalogue, so splitting them is consistent — but it changes a screen in daily use:
instead of switching between the table and the floorplan, both can be on screen at
once, or either can be removed by dragging it away.

The alternative is keeping them as ONE grid item that still holds the toggle. That
preserves today's behaviour and costs nothing structurally, but then "each card is
movable" is not quite true of those two.

**This spec assumes the split.** If that is wrong, say so at review — it is a
small change now and an awkward one later.

## What is draggable, and what is not

**Draggable:** the four assignable panels. Each becomes one grid item.

**Not draggable:** the drill-down entry cards and the Alarms count card. They are
navigation, they are generated from whatever the location tree holds (creating a
location makes a card appear with no code change), and their number changes as you
move through the tree. A saved position for "the third Block card" is meaningless
the moment a Block is added. They keep their existing responsive grid above the
panel area.

Stated because "all cards should be draggable" is the request, and this is a
deliberate narrowing with a reason rather than an omission.

## Edit mode

Dragging is OFF by default. An **Arrange** button puts the dashboard into edit
mode; only then do drag handles and resize corners appear, and the grid shows a
faint guide.

Not a preference — a safety property. A dashboard someone can rearrange by
accidentally dragging a card while trying to scroll on a touchscreen is a
dashboard whose layout is never trusted again. Edit mode also gives C2 an obvious
home: the per-card edit affordance appears in the same mode.

Edit mode offers **Save**, **Cancel** (discards to the last saved state) and
**Reset to default** (drops the user's override so the role default — or the
built-in — applies again).

## Storage

Nullable `dashboard_layout` JSONB on **both** `user_configs` and `role_configs`,
mirroring where `dashboard_cards` lives so there is one place to look for
"everything about this user's dashboard".

```
user_configs.dashboard_layout   NULL = use the role default
role_configs.dashboard_layout   NULL = use the built-in default
```

**TWO states, not three, and deliberately unlike `dashboard_cards`.** Panel
assignment needs `NULL` / `[]` / `[keys]` because an empty list is a *deny* that
must not be read as inherit. A layout has no equivalent: an empty layout is not a
meaningful instruction, so an absent or empty value simply falls back. Do not copy
the three-state rule here, and do not "unify" them later — they answer different
questions.

### Shape

```ts
{ version: 1, items: { i: PanelKey; x: number; y: number; w: number; h: number }[] }
```

`version` is present so a future grid change can migrate rather than guess. An
unknown `i` (a retired panel key) is DROPPED on read, the same rule
`normalizePanels` follows: a stored key that no longer exists contributes nothing
and is never a wildcard.

### Interaction with panel assignment

Layout and assignment are separate concerns and must not blur:

- A layout entry for a panel the viewer may **not** see is ignored entirely. It is
  not rendered, and its space is not reserved — otherwise a hidden panel would
  leave a hole that discloses its existence.
- A panel the viewer **may** see with no layout entry is appended at the bottom at
  its default size, so a newly granted panel appears rather than silently
  vanishing.
- Assignment stays governance (audited, reauth-gated, admin-only). Layout is
  preference. **Hiding a panel is still not an access control** — nor is dragging
  one away.

## Auditing: the role default only

**A user's own layout is NOT audited.** It is a personal preference, and a §11
audit trail that fills with "moved a card 40px left" is a trail in which real
records become harder to find. This system's audit trail is immutable and
hash-chained; what goes into it should be worth keeping forever.

**A role's default layout IS audited** (`CONFIG_CHANGED`, `role_config`,
`ROLE_MANAGE` + `UPDATE_ROLE_CONFIG` reauth), because that is an administrator
acting on other people, which is the line this codebase already draws everywhere
else.

## API

```
PUT /api/config/my-dashboard-layout        — the caller's own layout (authenticated, NOT audited)
DELETE /api/config/my-dashboard-layout     — reset to the role default
PUT /api/roles/dashboard-layout/role/:name — a role's default (ROLE_MANAGE + reauth + audited)
```

The resolved layout rides on the existing `GET /api/config/my-config` beside
`panels`, so the dashboard makes no extra request and never re-derives the
user → role → built-in fallback in the browser.

## Responsive

`react-grid-layout`'s `ResponsiveGridLayout`, 12 columns at `lg`, 6 at `md`, 1 at
`sm`. **Only the `lg` layout is stored**; narrower breakpoints are derived by the
library. Storing three layouts would mean an operator arranging a phone view they
will never look at, and a "why did my desktop layout change" bug the first time
someone opened the dashboard on a tablet.

**Drag and resize are disabled below `md`.** Precise dragging on a phone is a way
to destroy a layout by accident, not a feature.

## Counts this moves

- **One new dependency:** `react-grid-layout` (+ `prop-types`, `fast-equals`;
  8 packages total). The first UI dependency added to this app in a long while,
  and a deliberate reversal of habit — recorded as such.
- **One migration**: two nullable JSONB columns. Models **36** and enums **13**
  unchanged — columns are not models.
- Permissions **42**, reauth actions **48**, audit actions **97** — unchanged.
  The role-default route reuses `ROLE_MANAGE` / `UPDATE_ROLE_CONFIG` /
  `CONFIG_CHANGED`.
- Config defs **25**, config pages **24**, `<Route>`s **50**, API modules **24** —
  unchanged.
- Shared type files **18 → 19** (`types/dashboard-layout.ts`: the shape, the
  built-in default, and the pure resolver).

## Testing

**Unit** (`@digilog/shared`): the fallback chain (user → role → built-in); a
retired panel key is dropped rather than rendered; a visible panel with no entry is
appended rather than lost; a hidden panel's entry is ignored and reserves no space;
a malformed stored value falls back to the default rather than blanking the
dashboard.

**E2E**: the layout round-trips through `my-config`; the per-user PUT writes **no**
audit row while the role PUT writes one; `DELETE` restores the role default; the
role route refuses without `ROLE_MANAGE`.

**Web**: the pure resolver and the "append missing panels" rule are unit-tested.
Drag behaviour itself is not unit-tested — it is the library's, and asserting that
`react-grid-layout` drags would be testing someone else's code. The operator checks
it in a browser; Playwright cannot authenticate against this install's certificate.

## Explicitly out of scope

- C2: the per-card edit dialog and colours.
- Dragging the drill-down entry cards or the Alarms count card.
- Per-breakpoint stored layouts.
- Adding, removing or duplicating cards from within the dashboard — which panels
  exist is governance, and it lives on the Panels tab.
