# compliance-core Web (T&RH-Monitoring) — CLAUDE.md

> This file was headed "DigiLog Web" and described port 5175 and a `:3000` backend
> until 2026-10-05 (audit WEB-16). Those are the SIBLING DigiLog checkout's; root
> `CLAUDE.md` corrected them on 2026-08-24 and this file was never re-synced.

## Overview
React 19 SPA built with Vite 6 (`"vite": "^6.1.0"` in `apps/web/package.json`). In dev it runs on the Vite dev server on
**port 5176** — and only if `WEB_PORT=5176` is set: `vite.config.ts` defaults to 5175 and proxies
`/api` to `https://localhost:3000`, the sibling DigiLog backend, so a bare `npx vite` here serves an
app reading the WRONG database. `start-app.bat` sets both. Production-style builds output to
`apps/web/dist/`.

## Build & Deploy
```bash
# Local Development (Windows) — or just start-app.bat, which sets both variables
cd apps/web && WEB_PORT=5176 API_PROXY_TARGET=https://localhost:3001 npx vite --host

# Build (consumed by the Fastify static-serve at :3001 — PORT in apps/api/.env)
cd apps/web && npx vite build          # Outputs to apps/web/dist/
```

> ⚠️ **Correction (2026-08-24): the APK/Capacitor commands that used to be here are fiction.**
> `apps/android/` does not exist in this fork — verified `ls apps/` 2026-08-24 (only `api`, `web`).
> There is no Capacitor build, no APK, and no `cap`/`gradlew` step. Root `CLAUDE.md` confirms: no
> mobile app here. If you need APK build history, it's in `apps/web/DECISIONS.md` / `CHANGELOG.md`
> as a removed feature, not a live command.

## Testing
```bash
cd apps/web && npm test                # Run vitest once (CI-style, exit 0/1)
cd apps/web && npm run test:watch      # Re-run on file change

# Or run a single suite directly:
cd apps/web && npx vitest run src/routes/version-history/__tests__/diff.test.ts
```

- Runner: vitest 3.x with `environment: 'jsdom'` and `@vitejs/plugin-react`.
- Config: `apps/web/vitest.config.ts` (intentionally separate from
  `vite.config.ts` — the dev/build config reads HTTPS certs at module load
  and registers VitePWA, neither of which belongs in a unit-test runner).
- Setup: `apps/web/src/test-setup.ts` registers `@testing-library/jest-dom`
  matchers for component tests that arrive later.
- Workspace: `vitest.workspace.ts` at the repo root includes the web project,
  so `npm run test` from root picks it up alongside api / shared / integration.
- First suite (B7.1, 2026-05-02): `routes/version-history/__tests__/diff.test.ts`
  covers the `diffSnapshots()` engine in `routes/version-history/index.tsx` —
  8 cases across scalar / keyed-array / meta-filter / no-change branches across
  the three shown EntityKinds (cleaning-profile / checklist-profile /
  equipment-group). The `filter-profile` tab + its set-style diff branch were
  removed 2026-06-29 (no user-facing Filter Profiles page existed).

## Key Paths
- Source: `apps/web/src/`
- Entry: `apps/web/src/main.tsx`
- Routes: `apps/web/src/routes/` (**59 `<Route>` definitions** in `main.tsx`, re-derived `grep -cE "<Route"` 2026-11-05: 57 → 59 on 2026-11-04, `/rule-chains` and `/rule-chains/:id`; 56 → 57 on 2026-11-02, `/config/report-templates` (this line read 56 until then); 54 → 56, 2026-10-29: `/dashboards`, `/dashboards/:id`; 53 → 54, 2026-10-24: `/config/attribute-access`; re-derived `grep -cE "<Route"` 2026-09-16 — unchanged that day (a `/config/attribute-labels` route lived for a few hours and was folded into the Instrument Attributes page); 52 → 53 on 2026-09-08 with `/settings`; 51 → 52 on 2026-09-07 with `/reports` (the report review workflow) after 50 → 51 with `/data-report`; it had gone 51 → 50 on 2026-08-31 with `/config/alarm-rules` and THIS line was never re-synced, so the number here was right by coincidence for a week. Earlier: 50 -> 51 on 2026-08-29: `/config/export-options`, which had a config def declaring customPagePath and a card on the Configuration dashboard but NO registered route — the card fell through to the dashboard, so the page had never been reachable. Earlier, verified 2026-08-27 — 49 → 50: new `/config/alarm-webhooks` page (target form with a placeholder picker rendered from `ALARM_WEBHOOK_VARIABLES`, a scope picker reusing the functional-location tree widget, Send test, and a status-filterable delivery log). Earlier, 2026-08-24, 48 → 49: new `/instruments/:id/trend` page (gradient identity strip, one period/interval row, two BAND GAUGES, full-width limit-lined charts, raw paged time-series + alarms side by side). The latest-value cards it launched with were replaced by `band-gauge.tsx` on 2026-08-24 — a bare number cannot answer "how close to the limit is it?", which is the page's whole question. **Restyled 2026-08-31 to an operator reference image, and the number leads again — but the band did NOT go away: the horizontal track became the ARC around the quantity icon (swept to the reading's place between its bounds, red on a breach) and the two bounds are named in a three-cell panel under it. See "The trend latest-value card" below.** `/config/role-assignments` removed 2026-08-19 as dead code (its 7 config defs went in the Phase 0 strip and `system_config` held 0 rows for them), 49 → 48; the previous "23 folders / ~84 pages / 77 Routes" was stale before 2026-08-11 and the shortfall has NOT been reconciled. 2026-08-13 added `/functional-locations`; 2026-08-14 added `/alarms` and `/config/alarm-rules`; 2026-08-16 added `/functional-locations/:id`)
- Hooks: `apps/web/src/hooks/` (**26** entries incl. `__tests__`, `ls apps/web/src/hooks/ | wc -l` 2026-10-05 — 25 → 26 that day with `use-row-keys.ts`, stable React keys for editable rows with no id of their own (audit WEB-14); 23 → 25 on 2026-10-01 with `use-report-downloads.ts` (the ONE reader of the per-type report download policy) and `use-offset-keys.ts` (which keys get the + / - offset input); this line was not re-synced that day. Earlier 22 → 23 on 2026-09-16 with `use-attribute-labels.ts`, the ONE browser reader of Configuration → Attribute Display Names: `labelFor(key)` returns the administered name or the KEY, never a literal; consumed by the New Instrument form, the Attributes panel, the Settings widget and the Attribute Access picker; since 2026-09-21 it also returns `settingsHidden` / `isHiddenInSettings(key)` — the Settings page's hidden set, from the SAME response, nothing hidden until it arrives. Earlier list: auth, branding, datetime, pagination, reauth, session, single-tab, toast, field-labels)
- Components: `apps/web/src/components/` (layout, UI primitives, dialogs)
- API Client: `apps/web/src/lib/api-client.ts`

## Feature sections — MOVED to `docs/web-feature-notes.md` (2026-11-05)

The per-feature sections that filled this file were moved VERBATIM, byte for byte and in their original order, to
[`docs/web-feature-notes.md`](../../docs/web-feature-notes.md) on 2026-11-05, because this file had passed the
150k-character load limit (154,657 bytes) — the way root `CLAUDE.md` was split on 2026-10-07. **Before changing a
screen below, read its section there**: most record an operator decision or a trap that is not visible in the code.
A "see … below" in the sections kept here now points into that file. Add NEW web feature notes there, not here; keep
this file to project-wide rules (Overview, Build & Deploy, Testing, Key Paths, the signature-password, toggle, UI v3
and design-system traps, Architecture, Auth Flow, Theme) and the history sections at its end.

Topics (in that file's order): Instrument dashboard (2026-08-11) · Built dashboard widgets (2026-10-28) — `routes/dashboard/widgets/` · The trend page's extra keys, per profile (2026-10-29) · Widget reports and report templates (2026-11-02; page reports joined them 2026-11-03) · Rule Chains — `routes/rule-chains/` (2026-11-04 .. 2026-11-05) · Built dashboards — `routes/dashboards/` (2026-10-29, dashboard builder phase 1) · Instrument detail — the Details card (trimmed 2026-09-16) · Functional Locations pages (restyled 2026-09-17) · The report review workflow (2026-09-07) · The Data Report page and the Instrument History widget (2026-09-05; own page since 2026-09-07) · The trend page's Time Series (Raw Readings) card (2026-09-01) · Layout Designer (2026-09-22) — `routes/config/layout-designer/` · The 2D ARCHITECTURAL style (2026-10-01) — "CWH — QC", "CWH — QC Microbiology", "CWH — QC 3" · The QC floor plan is TRACED, and carries an annotation layer (2026-08-31) · Alarms page (rebuilt 2026-08-31) · The trend CHART cards (restyled 2026-08-31) · The trend latest-value card (restyled 2026-08-31) · Trend page widget labels are administered (2026-09-01) · A panel's controls sit in the CARD HEADER, beside the title (2026-09-01) · Dashboard panel height FOLLOWS THE CONTENT (2026-09-01)

## E-signature password fields — `autocomplete="off"` DOES NOT WORK

Every §11 password box must be `components/ui/signature-password-input.tsx`.
Never a bare `<input type="password">`, with or without `autoComplete="off"` —
**Chrome deliberately ignores that attribute on credential fields.** The Alarms
acknowledge dialog shipped one on 2026-08-31 and the browser filled the saved
password into it, which makes a §11.200 signature executable by whoever is at an
unlocked workstation. The field looks entirely normal while this happens.

Second symptom, which is how it was found: a `type="password"` input that is NOT
inside a `<form>` makes Chrome scan the whole document for a username field and
fill an unrelated text box. It typed the logged-in username into the Alarms
search box. That looks like a bug in the search box and is not.

Four measures, each defeating a different heuristic — do not drop any one:
mount as `type="text"` and switch to `password` a tick later (the one that
actually stops the fill); `autoComplete="one-time-code"`; a `name` generated per
MOUNT; `secureField`. Pinned by `components/ui/__tests__/signature-password-input.test.tsx`,
which asserts all four separately and has been mutation-checked.

## Boolean config settings are TOGGLES, not checkboxes (2026-08-31)

`dynamic-config.tsx` renders `type: 'boolean'` with `components/ui/toggle.tsx`.
That covers EVERY dynamic config page — one control style everywhere, which is
the point rather than a side effect.

The distinction is about when a change takes effect: a **checkbox** states an
intention a Save button later commits, a **toggle** reads as something you have
just done. Use `Toggle` for a setting that turns a behaviour on or off; keep
`Checkbox` for selecting items from a list or a set of options submitted
together — which the same page still does for dynamic option sets.

`Toggle` is built on a real `<input type="checkbox">` with `role="switch"`, drawn
over with `peer-*` styles, for the same reason `Checkbox` is: keyboard operation,
form participation and screen-reader semantics come from the platform rather than
from a re-implementation that always misses one of them.

**Green for on, red for off** (operator, 2026-08-31), from `--status-ok-dot` /
`--status-danger-dot`. `Toggle` is the ONE control here that deliberately does
NOT follow `--theme-primary`: it reports a STATE, and a state colour that changes
with the site palette stops meaning anything. The word "On"/"Off" sits beside it
in the same colour — status colour never travels alone, and red/green is the pair
a colour-blind reader is most likely to lose. **Consequence to know:** a setting
merely switched off now reads RED on every config page, which is right for
"alarms are not being raised" and stronger than "require an uppercase letter" 
deserves. Change off to `--status-idle-*` if that becomes a problem.

## UI v3 — one visual language on every screen (Batch 1 landed 2026-09-21)

Spec: `docs/superpowers/specs/2026-09-21-ui-design-system-v3-design.md`; plan
`docs/superpowers/plans/2026-09-21-ui-v3-batch-1-foundation-shell-auth.md`.
Operator: "update all the screens ui more professionally"; chose a new design
system in the language of their mockups (`Alarms.png`, `screen-2.png`,
`cc-dashboard.png`).

- **Tokens** (in `@theme`): `--text-figure`, `--text-figure-lg`,
  `--surface-tint-1/2`, `--band-gradient` — every one derived from the
  `--theme-*` variables, so all ten presets work. **The band's ends are the
  preset's gradient mixed 78% with black, not the raw colours**: body-size
  white text on the raw band failed WCAG AA on five of ten presets.
  `npm run check:contrast` (`scripts/contrast-check.mjs`) holds the same
  0.78 and proves white-on-band and ink-on-tint for every preset — keep the
  two numbers in step.
- **SINCE 2026-10-01 `grid` and `size="lg"` are the DEFAULTS** — every table
  in the app is the Audit Trail's (operator). Hand-built tables carry
  `.tbl-grid` themselves. The zebra / hover are on the `<tr>`, not the `<td>`:
  a cell background hid every row tint (selected, pending). Do not move them
  back onto the cell.
- **`Table grid` / `size="lg"` (2026-09-25)**: `grid` puts `.tbl-grid`
  (`app.css` — a line around every cell, a zebra; the same rules as the
  dashboard alarms panel's `.alarm-grid`) on the table, `size="lg"` is 15px
  base type. The Audit Trail uses both (operator: "table format … table
  lines shoud be visibl"); every other caller passes nothing and is
  unchanged.
- **Primitives** in `components/ui/`: `PageHero` (the band every screen
  starts with; the screen's toolbar goes INSIDE it as `children`), `StatCard`
  (ONE figure; no sparkline — nothing stores that history), the rebuilt
  `Table` (`TableHeader band`, `TableGroupRow`, `TableHead sortable` with
  `aria-sort`, `TableRow accent`, `TableEmpty`, `TableFooter` — the eight
  existing callers render with the new band and nothing else), `FormSection`
  (gradient plate, field grid, no description), `DialogBanner` (moved here;
  `tone="danger"` for a destructive act; the functional-locations file
  re-exports it), `Toolbar` (search with a distinct `name`, filters, trailing).
- **Shell**: the sidebar's active item is a white pill with theme ink and a
  right-hand dot (`data-active`). **Auth**: `routes/auth/auth-shell.tsx`
  frames login, forgot-password, change-password and contact-admin;
  `__tests__/auth-pages-render.test.tsx` mounts all four — the first tests
  those pages have had.
- **Test gotcha**: `\bbg-white\b` also matches `hover:bg-white/10` (`/` is a
  word boundary); assert a class token with `(^|\s)bg-white(\s|$)`. And jsdom
  has no `matchMedia` — the sidebar test stubs it.
- **`PageHero` does NOT clip its content, and its toolbar is `relative z-10`
  with no backdrop filter (2026-10-03, operator: "instrument selection
  dropdown was not showing values properly in dropdown").** The root's
  `overflow-hidden` (for the two circles) clipped every popup opened from a
  toolbar inside the band — the Settings picker's list, the Export menu on
  Alarms and Audit — to the band's bottom padding; the circles are now
  clipped by their own `page-hero-decoration` wrapper. And the toolbar's
  `backdrop-blur-sm` was a stacking context that trapped a popup's `z-50`
  under the next card on the page. Both pinned in `page-hero.test.tsx` as
  class tokens; the picture was checked in headless Chrome with the built
  stylesheet, which is how both were found — one at a time, the second only
  visible once the first was fixed.
- **`cn()` is tailwind-merge, and an UNTYPED arbitrary `bg-[…]` is read as
  a background COLOUR** (2026-10-03). `Select`'s chevron position
  `bg-[right_0.6rem_center]` made it drop the `bg-white` before it, so every
  native Select in the app was transparent — invisible on white cards, dark
  on the hero band. Write `bg-[position:…]` / `bg-[length:…]` (hinted), and
  when a primitive's class looks absent on screen, read the MERGED class
  string off the DOM before reading the source. `select.test.tsx` reads it.
- Batches 2–4 rebuild the screens on these; see the spec §4. Status colours,
  PDFs, fetch keys and gates are untouched throughout.

**Batch 2 landed the same day — the monitoring screens.** Alarms
(`PageHero` with the export icon as its action; the four stat cards re-skinned
on the `--status-*` tokens with a top rail, still filter buttons; the alarm
table banner is `--band-gradient`, its sticky action cell the band's END
colour), Instruments list (`PageHero`, `Toolbar` with a named search, the
shared `Table` — its first render test, `list-page.test.tsx`), Instrument
detail (`PageHero` headed by the code; the chips are its `meta`), Instrument
trend (`PageHero` replaced `trend-header.tsx`, which is DELETED; the crumbs
ride in the band and the strip's own "Back to instrument" link went — the
crumb's instrument link is that hop), Data Report, Settings (the picker rides
INSIDE the band as `children`; the widget's own band is `--band-gradient`),
Functional Locations index and detail (their private hero markup, `Figure`
and `Stat` went; `PageHero testId` keeps `fl-hero` / `fl-detail-hero`, and
`HeroTile.testId` keeps `fl-figure-*` / `fl-stat-*`). **Two deliberate
exceptions:** the DASHBOARD is untouched — its hero and title were removed at
the operator's instruction on 2026-08-29 and its readings table already
carries the coloured column groups of `screen-2.png` (its ENTRY CARDS and
ground were coloured on 2026-09-25 at the operator's request — see the
Instrument dashboard section; the table and panels still stand); and `PageHero` gained
`meta`, `testId` and per-tile `testId` for these pages. Three banner
assertions (`alarms-page`, `alarms-widget`, `selection-alarms`) now check
`var(--band-gradient)` / `var(--theme-gradient-to` instead of
`--theme-primary` — the same intent (site theme, no hex), the token that is
actually there.

**Batch 3 landed the same day — people and records.** Users list
(`PageHero` with Password Reset Requests and Create User inside; the four
counts are `StatCard`s in `user-stats-bar.tsx`, same props), Users create /
reset requests (`PageHero`, Back inside it; the reset history on the shared
`Table`), Users edit (`PageHero` headed by the person, initials as the icon,
status / directory badges and username as `meta`), Admin Requests (`PageHero`
with a `Toolbar` search INSIDE it — named `admin-request-search`; the four
filter cards on the status tokens; the table on the shared `Table`),
Notifications (`PageHero`, Mark All as Read inside), Audit Trail (`PageHero`
with the record total as its one tile and the export as its action; the
"21 CFR Part 11 Compliant Activity Log" line went — the sidebar's compliance
line says it), Reports (`PageHero`; the table on the shared band), Profile
(the identity card's cover is `--band-gradient`). **New render tests:**
`users/__tests__/pages-render.test.tsx` (all four Users pages),
`notifications/__tests__/page-render.test.tsx`, `audit/__tests__/page-render.test.tsx`.
**Test gotcha, and it cost two minutes of a hung vitest:** an `swr` mock that
returns a FRESH object per call makes any effect keyed on `data` re-run
forever without throwing. Return module-level constants (see the Users test's
`RESPONSES`). And the real `usePaginationDefaults` returns `options`, not
`pageSizeOptions` — the shared `Pagination` calls `.includes` on it.

**Batch 4 landed the same day — configuration and system — and closes UI v3:
the design system is now on every screen.** Twenty-one pages (the
Configuration index, every page under `routes/config/` incl. the dynamic
config page, Roles & Access and Help, System Health, Debug traces) open with
`PageHero`; the six that held the header beside sibling controls carry them
as `actions`; Help and Roles & Access lost their own emerald / violet
gradients and their back-arrow links (the crumb is that hop). Eight raw
tables (`access-matrix`, `action-reauth`, `alarm-webhooks` ×2,
`export-options`, `help`, `notification-rules`, `notification-logs`,
`debug`) were rewritten onto the shared `Table` by a tokenising transformer
(row and cell attributes preserved; `className` dropped from
table/thead/tbody/th; header rows' grey classes stripped after). **There is
ONE `FormSection` now**: `components/ui/form-section.tsx`;
`form-field.tsx` re-exports it (it accepts and ignores the old
`description`), so the dynamic config page's groups wear the gradient plate
with no page edit. The Configuration index's medallions are the band
gradient — the nineteen per-card gradients (`card.gradient`, still in the
data, unused) went for the reason the old PageHeader comment gave.
`config/__tests__/pages-hero.test.tsx` mounts the index, Password Policy,
Date/Time, System Health and Debug. **Deliberately untouched across all four
batches:** the dashboard (see Batch 2). **The four card-based forms followed
the same day** (operator: "do those four forms also"): Backup (both forms),
Floorplans (the plan editor — its select and Upload button ride in the plate
as `actions` — and the room form), Pagination, and Instrument Attributes (the
key list; its `{kept} keys` count is the plate's action; the profile picker
above it stays a plain `Card`). Each is a labelled `region` now, which is
what `pages-hero.test.tsx` and `instrument-attributes.test.tsx` assert. All
use `columns={1}`: their bodies are stacked controls, not field pairs.

## Design system (Stage 1 `7ed8329`, Stage 2 2026-08-28)

Tokens live in `src/app.css` `@theme`; primitives in `src/components/ui/`.

- **The type is Inter, self-hosted** (`@fontsource-variable/inter`). **Do NOT
  reintroduce a CDN font `<link>` in `index.html`** — this runs on a factory
  network that may have no internet route, and a webfont fetched at runtime
  falls back to a system face on exactly the machines that matter. That was a
  real shipped bug: Inter was bundled but `body` read `--font-body`, which named
  Sora from Google Fonts, so Inter rendered nowhere. `--font-display` and
  `--font-body` are now the same family, separated by tracking and weight.
- **Radius: two values.** `--radius-control` (6px) and `--radius-card` (10px).
  `--radius-sm/md/lg/xl` are **aliases** onto those — they are not a second
  vocabulary and must not be deleted, because Tailwind generates
  `rounded-lg`/`rounded-xl` from them and ~700 call sites use those utilities.
  `rounded-2xl` is left alone: it is the dashboard panel cards.
- **`.ctl` / `.ctl-sm` / `.ctl-check` / `.ctl-radio`** (`app.css`) are for the raw
  `<input>`/`<select>`/`<textarea>` that have not migrated to the primitives.
  Prefer `Input`/`Select`/`Checkbox` in new code.
- **`.tbl`** styles the raw tables' header band, separator, hover and rhythm, and
  deliberately sets no alignment, font size or cell colour.
- **⚠ THESE LIVE IN `@layer components`, AND MUST STAY THERE.** Tailwind v4 emits
  utilities into `@layer utilities`, and in the CSS cascade an **unlayered rule
  beats every layered rule at any specificity**. While these classes sat outside
  a layer they silently outranked every Tailwind class on the same element — the
  `.tbl` zebra was erasing the `bg-amber-50/20` tint Admin Requests puts on a
  PENDING row, and wrapping the selectors in `:where()` did NOT fix it, because
  specificity was never what decided it. If you add a shared class here, put it
  in the layer, or a call site will not be able to override it.
- **Elevation is `--elev-1/2/3`.** Don't reach for `shadow-lg` etc.
- Status colour never travels alone — always colour + glyph + word.

## Architecture
- React Router v6 with AppLayout wrapper for auth + session management
- **Sidebar collapse** state is in `localStorage` (`compliance-core.sidebarCollapsed`),
  read through a try/catch — a browser blocking site data throws on access, and an
  exception there takes the whole shell down. The auth token deliberately stays in
  `sessionStorage`; do not conflate the two.
- The sidebar item list is **flat on purpose**. `config.sidebarItems` is an
  operator-ordered array (Config → Roles & Access → Sidebar), so adding section
  headings would silently override an arrangement someone chose.
- SWR for data fetching with auto-revalidation
- **Roles & Access → Permissions marks a HELD toggle (2026-11-03).** `roles-components/held-toggles.ts` runs the shared `rebuildRolePermissions` + `privilegeTogglesFromPermissions` (the server's own rule, never a copy) on the tab's toggles, the role's stored sidebar items and its stored permissions (`permissionsHeld`, sent by the GET to ROLE_MANAGE only). A toggle OFF but held renders checked and disabled with "Held by …", which also names a permission granted outside the tab. Rules: `docs/feature-notes.md`, under "Roles & Access → PERMISSIONS shows what the role HOLDS".
- **`react-grid-layout` was ADDED 2026-08-28** — the first UI dependency taken on
  here in a long time, and a deliberate reversal of the habit recorded below. It
  powers the draggable/resizable dashboard; drag, resize, collision and
  responsive reflow are weeks of fiddly work and a half-working drag is worse
  than none. **Written against the 2.x API, not the v1 one every example shows:**
  v2 replaced `isDraggable`/`isResizable`/`draggableCancel` with
  `dragConfig`/`resizeConfig`, dropped `WidthProvider` for `useContainerWidth`,
  and requires an explicit `width`. A `legacy` entry point keeps the v1 shape;
  `routes/dashboard/panel-grid.tsx` does NOT use it. Both its CSS and
  `react-resizable`'s must be imported or the resize corner is invisible.
  **Only the `lg` arrangement is stored, so dragging and resizing are enabled ONLY at `lg`**
  (ruling R9, 2026-10-29 — `interactive = canArrange && editing && breakpoint === 'lg'`, the
  breakpoint being the library's own `getBreakpointFromWidth(BREAKPOINTS, width)`; `lg` is a
  container WIDER than 1200 px). Below it edit mode shows "Widen the window (or collapse the
  sidebar) to move and resize cards — the arrangement is saved in the 12-column layout." `md` (a
  1240 px window with the sidebar open) has the SAME 12 columns (F-I5), so it draws the stored
  arrangement; a 6-column `md` staircased it. Pinned by `__tests__/panel-grid-breakpoint.test.tsx`. Optional `resetLabel` /
  `saveLabel` name the edit row's buttons (a built dashboard: "Discard changes" / "Save").
- Cleaning-profile pipeline editor uses a custom hand-rolled canvas (the
  `reactflow` + `@monaco-editor/react` deps were removed 2026-05-30 — 0 imports
  remained after the 2026-05-17 rule-chain tear-out) — history: that editor is gone, and
  `@xyflow/react` 12.12.0 (reactflow's successor) came back 2026-11-04 for the Rule Chains editor
- Tailwind CSS (no component library) — unified light theme throughout
- Lazy-loaded heavy pages (assets, UNS, checklists, filter management, etc.)
- Permission-based route guards via `<RequireRole permissions={[PERMISSIONS.*]}>`

## Auth Flow
- Token stored in sessionStorage (not localStorage — for shared workstation security)
- **`/` lands by RULE (2026-10-05, audit WEB-4):** `routes/dashboard/landing.ts`
  `landingRoute(perms, role)` — the dashboard for SUPER_ADMIN or `DASHBOARD_VIEW`,
  else the first sidebar page the role can see (the sidebar's own
  `isSidebarItemVisible`), else `/profile`. `landing-page.tsx` renders the
  dashboard or a `<Navigate>`; a redirect, never Access Denied, because `/` is
  the first screen after every login. `/users` guards on `USER_READ` alone
  (WEB-5). The Super Admin API-access password boxes are
  `SignaturePasswordInput` (WEB-1); the chart x-axis uses `useDatetimeFormat`
  (WEB-2).
- **Every login lands on `/` (the dashboard) — there is NO return-URL (2026-10-03,
  operator: "after every login user should come to dashboard page only dont
  redirect to other pages").** The layout and the API client's 401 handler send
  an unauthenticated visitor to a bare `/login`; the login page's signed-in
  redirect and `useAuth().login` go to `/` whatever the query string says. The
  `?returnUrl=` that lived here sent the NEXT user on a shared workstation to
  the page the PREVIOUS one left — Access Denied for a role without it. Pinned
  by `routes/auth/__tests__/login-lands-on-dashboard.test.tsx`, whose hook
  case sets `window.location` too (the old code read it, not the router).
- 30-minute JWT refresh cycle
- Session timeout warning dialog
- Single-tab enforcement per user (BroadcastChannel)
- Force login (`force: true`) to terminate existing sessions

## Key Features
- **24** files in `routes/config/` (23 → 24 on 2026-11-02: `report-templates.tsx`, Configuration → Report Templates; 22 → 23 on 2026-10-24: `attribute-access.tsx`, Configuration → Attribute Edit Access; re-derived `ls apps/web/src/routes/config/*.tsx | wc -l` 2026-10-05: 23 → 22 that day — `alarm-rule-dialog.tsx`, dead since the 2026-08-31 alarm-rules removal, deleted (audit WEB-8); 22 → 23 on 2026-10-01: `report-settings.tsx`, Report Approvers + Report Downloads on one page — this line was not re-synced that day. Earlier 23 → 22 on 2026-09-22: `floorplans.tsx` DELETED, replaced by the `layout-designer/` FOLDER at the same route — `ls *.tsx` counts files; re-derived `ls apps/web/src/routes/config/*.tsx | wc -l`. Earlier, 2026-09-16 — unchanged: the `attribute-labels` def's Display name column lives ON `instrument-attributes.tsx` (a separate `attribute-labels.tsx` existed for a few hours that day and was folded in at the operator's direction). That page now saves THREE things (2026-09-21 added the third: the Settings page's hidden set — a Show in Settings toggle per row and one for the Instrument ID, written on the SAME `attribute-labels` row as `settingsHidden` and merged by `mergeSettingsHidden`, pure, exported; a toggle alone is dirty and never rewrites the profile). Before that, TWO: the profile's keys (only when they changed) and the global display-name map (WHOLE, merged by the exported pure `mergeLabels`, through the generic dynamic PUT because that PUT replaces the row), then revalidates `/api/config/attribute-labels/current` so open panels re-label. Earlier re-derived 2026-09-01; 24 -> 23 on 2026-08-31 with the alarm-rules removal — this line was never re-synced then, and the two inventory lines in root CLAUDE.md carried the same stale 24 until 2026-09-01. `trend-widgets.def.ts`, added that day, adds NO file here: it renders through the dynamic config page. Earlier 25 -> 24 on 2026-08-28: `dashboard-cards.tsx` deleted — panel assignment moved to a Panels tab on `role-access.tsx`, stored on `role_configs`/`user_configs` rather than in `system_config`, and gained a per-USER layer. Config -> Appearance lost its second tab with it.) Earlier: **25** files (re-verified `ls apps/web/src/routes/config/*.tsx | wc -l` 2026-08-27 — `alarm-webhooks.tsx` added 2026-08-27, 24 → 25. It has **no config def of its own**: alarm webhooks are a CRUD module with their own tables, not a `system_config` row, so the def count stays at 25 and this page is not driven by the dynamic config page. Its `/config` card is **SUPER_ADMIN-only** — `index.tsx` reads `const visibleSuperAdminCards = isSuperAdmin ? superAdminCards : []` (the delegation allow-list went 2026-08-19) and the card is in `superAdminCards`, so a non-SUPER_ADMIN NEVER sees it and no Configuration Access grant will surface it; `/config/alarm-webhooks` is still reachable by URL, where `RequireRole permissions={[ALARM_RULE_READ]}` admits them. Same as Alarm Rules, which is in the same array. **This line said "default-deny … until `alarm-webhooks` is granted under Configuration Access" until 2026-08-27; that was FALSE.** Earlier: re-verified `ls` 2026-08-19 — `role-assignments.tsx` removed as dead code, 25 → 24; `alarm-limits.def.ts`, added 2026-08-17 for the instrument-limit alarm work, is an auto-discovered def rendered by the dynamic config page, so it adds no file here. Earlier verified `ls` 2026-08-14; the "34" was inherited from DigiLog and was never true here). Most config surfaces are auto-discovered defs rendered by the dynamic page; `alarm-rules.tsx` (2026-08-14) is a real CRUD page, like `floorplans.tsx`
- Entity tree with drag-and-drop hierarchy
- Cleaning-profile pipeline editor (STAGE / CHECKLIST nodes on a custom canvas)
- Notification system (email/SMS/Telegram/Slack)
- Debug trace page for pipeline visibility
- **Home / Module Guide — REMOVED 2026-09-19** (operator: "remove home feature
  from side bar from entire application"). `/home`, `routes/home/` (FlowChart,
  module-flows, viewer-access, types, tests), the `home` entry in `SIDEBAR_ITEMS`
  and `allNavItems`, and its only data source `GET /api/roles/access-matrix` are
  gone. It had been the ONE sidebar item with no `PERMISSION_TREE` group;
  `sidebar-visibility.test.ts` now locks that every item has one. Every page's
  root breadcrumb reads `Dashboard` (it always pointed at `/`). History:
  `CHANGELOG.md` 2026-07-06 / 2026-07-13 entries and
  `docs/superpowers/specs/2026-07-06-home-module-guide-design.md`.

## Theme
- Unified light theme: bg-white cards, bg-slate-50 sections, border-slate-200
- Gradient dialog headers are acceptable
- No dark theme anywhere in the application

## Frontend Pages

> ⚠️ **Stale — re-verified 2026-08-24, this list is a 2026-05-17 snapshot.** `assets`,
> `checklists`, `cleaning-cycles`, `filter-management`, `mobile`, `pm-schedules`, `tenant` do not
> exist under `apps/web/src/routes/` any more (Phase 0 strip). The live top-level folders are:
> `admin-requests, alarms, audit, auth, config, dashboard, debug, functional-locations, home,
> instruments, notifications, profile, system-health, users` (verified `ls
> apps/web/src/routes/` 2026-08-24 — 14 folders, not the list below).

admin-requests, assets (dialogs/tabs/hooks), audit, auth, checklists, cleaning-cycles (history/timeline), config (branding/notification-rules/notification-settings/roles), debug, filter-management (operations/profiles/status/scan/traceability/AHU-dashboard/cleaning-profile-editor/retirement/replacement/bulk-upload/equipment), mobile, notifications, pm-schedules, profile, system-health, tenant, users (alarms + rule-chains route folders removed 2026-05-17 — both are back: `alarms/` since 2026-08-14, a new `rule-chains/` since 2026-11-04)

## Phase 2 Pages

> ⚠️ **This entire section (Phase 2 Pages, and Phase 3/parts of Phase 4 below) describes pages
> that no longer exist** — the filter/checklist/PM/RFID domain was removed in the 2026-07-18 Phase 0
> strip. Verified `ls apps/web/src/routes/` 2026-08-24: none of `filter-management`, `cleaning-cycles`,
> `checklists`, `pm-schedules` exist. Kept as history.
- `routes/filter-management/filter-operations.tsx` — Main operations page (8 stages, scan, checklist dialog, reason selection)
- `routes/filter-management/cleaning-profile-editor.tsx` — Visual pipeline editor (canvas, drag, wire, properties panel)
- `routes/filter-management/cleaning-profile-list.tsx` — Profile list with status badges
- `routes/filter-management/filter-profile-list.tsx` — Filter profile management
- `routes/filter-management/ahu-dashboard.tsx` — AHU filter set view with equipment groups
- `routes/filter-management/filter-traceability.tsx` — Per-filter history with full event timeline
- `routes/filter-management/filter-status.tsx` — Filter status overview
- `routes/filter-management/filter-scan.tsx` — QR/barcode scan for filter identification
- `routes/filter-management/retirement.tsx` — Filter retirement workflow
- `routes/filter-management/replacement.tsx` — Filter replacement workflow
- `routes/filter-management/bulk-upload.tsx` — CSV bulk import for filters
- `routes/filter-management/equipment.tsx` — Equipment group management
- `routes/cleaning-cycles/history.tsx` — Expandable cycle history
- `routes/cleaning-cycles/timeline.tsx` — Cycle event timeline with performer names
- `routes/checklists/list.tsx` — Checklist profile list
- `routes/checklists/detail.tsx` — Checklist detail with questions
- `routes/pm-schedules/` — PM schedule pages with monthly entries
- `routes/config/filter-lifecycle.tsx` — Lifecycle state config
- `routes/config/filter-cleaning-reasons.tsx` — Cleaning reasons config

### Phase 2 Patterns
- All routes wrapped in `<RequireRole permissions={[PERMISSIONS.ASSET_READ]}>` or more specific permissions
- SWR for data fetching with refresh intervals
- Toast notifications for success/error (not alert())
- Checklist dialog: no skip, no backdrop dismiss, mandatory submission
- Pipeline editor uses a custom canvas with node types (START, END, STAGE, CHECKLIST)
- Stage types: WASH_IN, WASH_OUT, DRY_IN, DRY_OUT, STORAGE_IN, STORAGE_OUT

---

## Phase 3 Update (2026-04-07)

> ⚠️ **Removed — `rfid_scan_app/` does not exist** (verified `ls rfid_scan_app` 2026-08-24: no such
> file). No mobile app, RFID, or offline sync exists in this fork. Kept as history.

**RFID & Offline Operations:**
- RFID Scanner Android app (`rfid_scan_app/`) for KC-series UHF readers
- RFID keyboard guard prevents UKB tag input leaking into random fields
- Offline cleaning operations via IndexedDB queue + sync engine
- Cached identifier→filter map for offline RFID lookup
- "Data Synced" indicator in mobile header
- One identifier per entity (backend-enforced)
- Responsive layout with collapsible sidebar
- Error popups replace inline banners
- User creation auto-assigns org for admins
- `/api/roles/active` public endpoint for contact-admin page

See `CHANGELOG.md` for full details.

---

## Phase 4 Update (2026-04-14)

> ⚠️ **Themes and Granular Permissions below are current in spirit (still 10 presets, verified
> `grep -c "name:" apps/web/src/lib/themes.ts` 2026-08-24); the per-page examples naming
> filter-list/checklists/cleaning-profiles are stale — those pages are gone. Report Configuration
> below is mostly stale too**: `routes/config/report-config.tsx`, `report-labels.tsx`, and
> `report-signatories.tsx` do not exist (verified `ls apps/web/src/routes/config/` 2026-08-24 — only
> `report-page-titles.tsx` survives, matching root `CLAUDE.md`'s note that it replaced
> `report-settings.def.ts`). `report-page-wrapper.tsx` still exists and is still used (by
> `routes/audit/index.tsx`), but its other listed consumers (Filter Traceability, Quality
> Notifications, RFID Track Record) are gone with their pages.

**Configurable Color Themes:**
- 10 presets in `lib/themes.ts`, applied via CSS custom properties
- Theme selector on Branding page, `use-branding` hook applies on load
- ~~Replaced hardcoded cyan/teal with CSS vars on: filter-list, PM schedules, dashboard, approvals, checklists, cleaning profiles~~ (those pages are gone; the CSS-var theming mechanism itself is still live on remaining pages)

**Granular Permissions:**
- SUPER_ADMIN bypasses all frontend permission checks
- 7 pages have `isSuperAdmin || perms.includes()` pattern
- Feature toggles: Filters Page Controls, Checklist/Cleaning Profile/Equipment Group/PM Page Controls

**Report Configuration** — one page (`routes/config/report-config.tsx`, `/config/report-config`) combining three tabs, each an independent editor with its own config key + Save (consolidated 2026-06-29, replacing three standalone pages; "Report Settings" was removed earlier the same day):
- **Identity** tab (`routes/config/report-page-titles.tsx`, key `report-page-titles`) — company + application name shown in every report header + footer; `hooks/use-report-page-titles.ts` resolves override → Branding. The former configurable common labels were removed; the chrome uses fixed defaults (`By:` / `records` / `Page X of Y`).
- **Labels** tab (`routes/config/report-labels.tsx`, key `report-labels`) — per-report title / subtitle / column headers (view + PDF).
- **Signatories** tab (`routes/config/report-signatories.tsx`, key `report-signatories`) — per-report × role signature label.
- `components/report-page-wrapper.tsx` — shared on-screen report chrome (header always shown; footer suppressible via `hideFooter` / `hideFooterStats`). Applied to: Audit Trail, Filter Traceability, Quality Notifications, RFID Track Record (RFID hides the footer).
- Report-page default page size comes from Pagination Settings (`usePaginationDefaults().defaultLimit`).

**Reauth Fixes:**
- Added `useReauth` + `ReauthDialog` to checklists (list + detail) and cleaning profiles (list + editor)
- Reauth dialog: password autofill prevention, focus management on close
