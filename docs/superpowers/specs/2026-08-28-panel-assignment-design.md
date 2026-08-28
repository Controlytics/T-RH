# Panel assignment, per role and per user — design

**Date:** 2026-08-28
**Status:** approved in chat, not yet implemented
**Scope:** Project A of two. Project B (new dashboard trend / historian / alarm
widgets showing scope-aggregated data) is deliberately out of scope here and is
additive to this catalogue.

## The request

> "in dashboard I need card level assign option user wise or role wise — if I want
> to assign only trend cards or only historian table or only alarm widget like
> that I need to be able to assign"

## What exists today (verified against live code, 2026-08-28)

- **Per-ROLE dashboard cards already exist**: `system_config['dashboard-cards']`
  holding `{roles: {ROLE: [cardKey]}}`, served by
  `modules/config/static-routes/dashboard-cards.routes.ts`, edited at Config →
  Appearance → Dashboard Cards.
- **Four of its six keys are INERT.** `total_users`, `audit_trail`,
  `notifications` and `quick_actions` were removed from the dashboard when it was
  cut to "tabular view and graphical view" — the comment at
  `routes/dashboard/index.tsx:31` records the consequence and defers the cleanup.
  Only `telemetry_table` and `telemetry_floorplan` gate anything.
- **No per-user layer.**
- **The catalogue is duplicated**, frontend and backend, with a "Keep in sync"
  comment (`dashboard-cards.routes.ts:7`). Two hand-maintained copies of the same
  list is a drift waiting to happen.
- **The trend page has no governance at all.** Its panels — gauges, charts,
  summary strips, the raw readings table, the alarms widget — are always shown.
- The PUT writes the **whole config blob**, so two admins editing different roles
  overwrite each other silently.

The three things the operator named (trend charts, historian table, alarm widget)
are all on `/instruments/:id/trend`, not on the dashboard.

## Decision: store it like `instrument_scope`, not like `dashboard-cards`

A nullable `dashboard_cards JSONB` column on **both** `role_configs` and
`user_configs`, mirroring `instrument_scope` exactly.

Rejected alternatives, and why:

- **Extend the existing `system_config` key with a `users` map.** Cheapest — no
  migration — but it keeps two different governance patterns in one product,
  keeps the wholesale-blob clobber, and gives no clean way to distinguish
  "inherit" from "deliberately empty". That ambiguity is precisely what
  `instrument_scope` was built to avoid; repeating the mistake on a second
  surface would be a choice, not an oversight.
- **Fold panels into `PERMISSION_TREE` / sidebar items.** One mechanism for
  everything is attractive, but that tree is defined as a Sidebar → Page → Action
  catalogue and a panel is none of the three. Bending it makes the single source
  of truth less true.

The deciding argument is that "why does this user see nothing?" should have ONE
answer. Panels and instruments will be assigned on the same screen, in the same
shape, with the same semantics.

### Three states, and they must stay distinguishable

```
NULL       inherit (user -> role -> every panel)
[]         NO panels
[keys]     these panels
```

Identical to `instrument_scope`, and for the identical reason: a "is anything
selected" test collapses `[]` into inherit and turns a deny into a grant.

**This is a deliberate deviation from the `sidebarItems` precedent beside it.**
`config.service.getMyConfig` decides whether a user config wins by testing
`sidebarItems.length > 0`, so an empty user list falls through to the role. That
is already documented as the wrong direction to fail in
(`modules/instruments/visibility.ts:effectiveScope`). Panels follow scope, not
sidebar items. Do not "make it consistent" with the neighbour later.

### Nullable with NO default

Same as `instrument_scope` and `attributeAccess`: shipping this must not blank
any existing role's dashboard. A `DEFAULT '[]'` column would hide every panel
from everyone the moment the migration ran.

`Prisma.DbNull`, never `JsonNull` — a JSON `null` is a different stored value and
the contract rests on SQL NULL meaning inherit.

## The catalogue

ONE definition in `@digilog/shared` (`types/panels.ts`), imported by both the API
and the web app, ending the hand-synced copies. A frozen-snapshot test locks it
the way `PERMISSION_TREE` is locked.

| Page | Key | Panel |
|---|---|---|
| Dashboard | `telemetry_table` | Instrument Readings — Table |
| Dashboard | `telemetry_floorplan` | Instrument Readings — Floorplan |
| Trend | `trend_gauges` | The two band gauges |
| Trend | `trend_charts` | Temperature / humidity charts |
| Trend | `trend_summary` | The per-chart summary strips |
| Trend | `trend_historian_table` | "Time series (raw readings)" |
| Trend | `trend_alarms` | "Alarms in this period" |

Each entry carries `key`, `page`, `label`, `description`.

**Removed:** `total_users`, `audit_trail`, `notifications`, `quick_actions`. They
gate nothing. A switch that does nothing on a governance screen is worse than an
absent one — someone will turn one off believing they restricted something.

### Unknown keys are ignored, never treated as a wildcard

A stored key that is no longer in the catalogue contributes nothing, exactly as a
deleted functional location contributes nothing to an instrument scope. It must
never be read as "show everything".

## What hiding a panel does NOT do

**A hidden panel is a DISPLAY decision, not an access control.** Hiding the
historian table does not stop its data being fetched from
`GET /api/instruments/:id/telemetry` by anyone who can reach the API.
`instrument_scope` is what restricts data; this restricts clutter.

This sentence must appear on the editor screen itself, not only in this document.
An admin who hides the alarms widget believing they have withheld alarm data has
been misled by the UI, and that is the failure mode this feature can most easily
cause.

Consequence for the implementation: the panel list is applied in the **browser**,
and that is correct and deliberate here — it is a layout preference, not a policy
decision, so it does not fall under the "never reconstruct server-side decision
logic in the client" rule. What the client must NOT do is re-derive the
inherit/none/these resolution; the server resolves that once and ships the answer.

## Resolution

One pure function beside the catalogue, and one server-side resolver:

```
resolvePanels(userRole, roleCards, userCards) -> string[] | null   // null = all
```

- SUPER_ADMIN bypasses, exactly as with instrument scope, so an admin cannot lock
  themselves out of the screen that would let them fix it.
- The user's list REPLACES the role's — it can widen as well as narrow, matching
  `effectiveScope`. Consistency beats cleverness here; two surfaces on the same
  screen behaving differently would be worse than either rule alone.

Served on the existing `GET /api/config/my-config` payload as `panels`
(`modules/config/static-routes/roles.routes.ts:176` — verified 2026-08-28), so
the browser makes no extra request and never re-derives the resolution. That
route already merges role and user config for `sidebarItems`; `panels` is
resolved beside it but by the scope rule above, NOT by the `length > 0` rule that
route uses for sidebar items.

## API

```
GET /api/roles/panel-access                 — every role + every user override (ROLE_MANAGE)
PUT /api/roles/panel-access/role/:name      — set a role's panels (ROLE_MANAGE + reauth + audit)
PUT /api/roles/panel-access/user/:userId    — set one user's override (ROLE_MANAGE + reauth + audit)
```

Deliberately mirrors `/api/roles/instrument-scope/*`: same module, same
permission, same reauth action (`UPDATE_ROLE_CONFIG`), same audit action
(`CONFIG_CHANGED`) with `targetType` `role_config` / `user_config`. **No new
permission, no new reauth action, no new audit action.**

Written one role or one user at a time, which is what removes the existing
wholesale-blob clobber.

The §11 signature names the count and the state, e.g.
`Role "OPERATOR" dashboard panels set to 3 of 7` / `... set to NO panels` /
`... set to ALL panels`. Bounded: `signature_meaning` is VARCHAR(255) and
`auditLog` does not truncate.

## Admin surface

A new **Panels** tab on Config → Roles & Access, beside Instrument Scope, with
the same two sections (per role; per user, overriding their role) and the same
three-state radio + checklist. Panels are grouped by page under headings, so
"Dashboard" and "Trend page" read as separate groups.

The empty selection shows the same amber warning Instrument Scope uses, worded
for panels.

## Retiring the old surface

1. Migrate the existing `system_config['dashboard-cards'].roles` map into
   `role_configs.dashboard_cards`, dropping the four dead keys, in the migration
   itself. Roles absent from the map get NULL (inherit), not `[]`.
2. Delete `modules/config/static-routes/dashboard-cards.routes.ts`, its
   registration, `routes/config/dashboard-cards.tsx`, and its card on the
   Appearance page.
3. Delete the `system_config['dashboard-cards']` row **only after** the migration
   has copied it, and record the row count moved.

Per `docs/CONTRIBUTING.md`'s pre-deletion rule: read each file for unique
knowledge first. The `VALID_CARD_KEYS` set and `ALL_CARDS` labels are the
knowledge; both are carried into the shared catalogue.

## Counts this moves

- Prisma models: **unchanged at 36**. Enums: **unchanged at 13** — two nullable
  columns are not a model, and the panel keys are validated strings, the same
  precedent as `FloorplanRoom.grade`.
- Permissions **42**, reauth actions **48**, audit actions **97** — all
  unchanged, deliberately.
- Config defs **25 → 25**; config pages **25 → 24** (verified `ls
  apps/web/src/routes/config/*.tsx | wc -l` = 25 on 2026-08-28, and
  `dashboard-cards.tsx` is one of them; the new tab lives inside the existing
  `role-access.tsx`, which is already counted).
- `<Route>`s in `main.tsx`: **unchanged at 50** — a tab, not a route.
- Migration: `<UTC-timestamp>_panel_access`, hand-authored per
  `apps/api/CLAUDE.md`, drift guard must PASS, applied to
  `compliance_core_db` **and** `compliance_core_db_test`.

## Testing

**Unit** (`@digilog/shared` + resolver):
- `NULL` inherits; `[]` is NO panels and does not fall through to the role;
  `[keys]` wins; a user list replaces rather than intersects.
- SUPER_ADMIN always resolves to all panels whatever is stored.
- An unknown/retired key contributes nothing and is never a wildcard.
- Frozen-snapshot test on the catalogue.

**E2E** (`src/e2e/panel-access.test.ts`), over HTTP as the seeded OPERATOR
because SUPER_ADMIN bypasses:
- `my-config` returns the resolved panel list for a scoped role and for a user
  override, with a positive control for the unrestricted case.
- Each PUT writes SQL NULL (not JSON null) for "all panels", verified by raw
  query — the same assertion instrument scope carries.
- Both PUTs write an audit row naming the count.
- The migration's carried-over values match what `system_config` held.

**Web**: the panel-filtering helper is pure and unit-tested; the two pages'
rendering is checked by the operator in a browser, since Playwright cannot
authenticate against this install's certificate.

## Explicitly out of scope

- Project B: new dashboard trend / historian / alarm widgets. They become new
  catalogue keys with no rework here.
- Per-panel ordering or layout. Assignment only.
- Any change to `instrument_scope`, `attributeAccess`, or `sidebarItems`
  semantics.
