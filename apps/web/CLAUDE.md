# DigiLog Web — CLAUDE.md

## Overview
React 19 SPA built with Vite 6. In dev it runs on the Vite dev server (port 5175). For production-style builds it outputs to `apps/web/dist/`, which is also what Capacitor copies into the Android APK.

## Build & Deploy
```bash
# Local Development (Windows)
cd apps/web && npx vite --host         # Dev server on port 5175

# Build (consumed by the Fastify static-serve at :3000)
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
- Routes: `apps/web/src/routes/` (**51 `<Route>` definitions** in `main.tsx`, verified `grep -cE "<Route"` 2026-08-29. 50 -> 51 on 2026-08-29: `/config/export-options`, which had a config def declaring customPagePath and a card on the Configuration dashboard but NO registered route — the card fell through to the dashboard, so the page had never been reachable. Earlier, verified 2026-08-27 — 49 → 50: new `/config/alarm-webhooks` page (target form with a placeholder picker rendered from `ALARM_WEBHOOK_VARIABLES`, a scope picker reusing the functional-location tree widget, Send test, and a status-filterable delivery log). Earlier, 2026-08-24, 48 → 49: new `/instruments/:id/trend` page (gradient identity strip, one period/interval row, two BAND GAUGES, full-width limit-lined charts, raw paged time-series + alarms side by side). The latest-value cards it launched with were replaced by `band-gauge.tsx` on 2026-08-24 — a bare number cannot answer "how close to the limit is it?", which is the page's whole question. `/config/role-assignments` removed 2026-08-19 as dead code (its 7 config defs went in the Phase 0 strip and `system_config` held 0 rows for them), 49 → 48; the previous "23 folders / ~84 pages / 77 Routes" was stale before 2026-08-11 and the shortfall has NOT been reconciled. 2026-08-13 added `/functional-locations`; 2026-08-14 added `/alarms` and `/config/alarm-rules`; 2026-08-16 added `/functional-locations/:id`)
- Hooks: `apps/web/src/hooks/` (auth, branding, datetime, pagination, reauth, session, single-tab, toast, field-labels)
- Components: `apps/web/src/components/` (layout, UI primitives, dialogs)
- API Client: `apps/web/src/lib/api-client.ts`

## Instrument dashboard (2026-08-11)

`routes/dashboard.tsx` became `routes/dashboard/` — `index.tsx` (stat cards +
Table|Graphical toggle), `telemetry-table.tsx`, `floorplan-view.tsx`,
`room-detail.tsx`, `time-series-chart.tsx`, `status.ts`, `use-telemetry.ts`.
Plus `routes/config/floorplans.tsx`, the placement editor.

**The graphical view DRAWS the floor as SVG and never renders the uploaded plan
image.** The first cut showed the image with transparent hotspots over it and
read as a scan with rectangles stuck on top. The image now appears only in the
editor, faded, as a tracing guide. Rooms store proportional `x/y/w/h`, so the
drawn layout is resolution-independent.

**"Live" is polling.** There is no browser-facing WebSocket or SSE channel here
(the `@fastify/websocket` registration is INBOUND device ingest), so every live
surface is an SWR `refreshInterval` and the UI says "updates every Ns".

The chart is hand-rolled SVG — no dependency, consistent with this app having
dropped `chartjs-node-canvas`, `reactflow` and `@monaco-editor/react`. Series
colours come from a fixed validated categorical order; status colour never
carries meaning alone (always a glyph + word).

**Chart colours live in `app.css` as `--chart-*` custom properties (2026-08-27),
and every consumer must read them WITH a literal fallback** —
`var(--chart-series-1, #2a78d6)`, never a bare `var()`. The PDF export
(`routes/instruments/chart-image.ts`) mounts `TimeSeriesChart` off-screen and
serialises its live SVG into a STANDALONE document with **no stylesheet
attached**, so the custom property is undefined there and only the fallback
resolves. The consequence, stated plainly because it is easy to rediscover the
hard way: **the exported chart can never follow a future theme.** It will always
print the fallback literals. That is an accepted limitation, not an oversight —
the indirection exists so a future dark theme need not touch chart code, and a
signed §11 record printing a black or invisible line would be far worse than one
printing yesterday's palette. The reasoning is also written beside the variables
themselves in `app.css`.

**Trend chart interaction (2026-08-27) — zoom REFETCHES, it does not magnify.**
`routes/dashboard/chart-zoom.ts` turns a drag selection into a time range; the
page sets a custom range and requests it fresh, so zooming into a sampled
30-day view reveals the true raw readings for the narrower window. `SampledNote`
("Showing N of M readings") takes `shown` from the RAW reading count, not from
the post-bucketing point count. Rendering the picture and the numbers from two
different populations is the defect these two rules exist to prevent.

`apiClient.postFormData()` is the ONE way to upload multipart — it reuses the
single definition of where the session token lives (`sessionStorage`). A
hand-rolled `fetch` reading `localStorage.getItem('access_token')` is why
profile photo upload silently 401'd until 2026-08-11.

## Alarms page (rebuilt 2026-08-31)

`routes/alarms/` is `index.tsx` + `alarm-stat-cards.tsx` + `alarm-filters.tsx` +
`acknowledge-dialog.tsx`, over the pure `alarm-display.ts`.

**Nothing on this page filters, counts, sorts or pages in the browser.** It used
to do all four over `GET /api/alarms?limit=500`, which made the four state boxes
count the newest 500 alarms while reading as plant-wide totals. `filterByQuadrant()`
and `quadrantCounts()` were DELETED and a comment stands where they were —
reintroducing a client-side count is the obvious "improvement" and it will be wrong
again the moment this installation passes one page of alarms.

- The four cards and the Status dropdown read and write ONE value, so they cannot
  claim different things about what is shown.
- `counts` and `total` come from the same response as the rows.
- **There is deliberately no sparkline and no "from yesterday"**, though the
  supplied mock had both: nothing in this system stores alarm-state history.
- **Cleared-Unacknowledged is AMBER, never neutral** — the overnight excursion
  nobody answered for is the one row that must not look finished. `QUADRANT_TONE`
  in `alarm-display.ts` is the single source for that, read by the card, the row's
  left accent and the status pill.
- The status pill takes the four-state tone. It was keyed off `severity` until
  2026-08-31, so on an installation where every alarm is CRITICAL every pill on
  the page rendered red.
- The dark table banner is `color-mix(... var(--theme-primary) ...)`, not a
  hardcoded indigo, so it follows all ten colour presets.
- Sortable headers offer only the columns the SERVER can order on — sorting one
  page of a paged result would rearrange twelve rows and call it a sort of five
  hundred.
- The date range is sent as an INSTANT (`localInputToIso`): `datetime-local` gives
  zoneless text, and sending it raw would let the API resolve it in its own zone.

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
- Cleaning-profile pipeline editor uses a custom hand-rolled canvas (the
  `reactflow` + `@monaco-editor/react` deps were removed 2026-05-30 — 0 imports
  remained after the 2026-05-17 rule-chain tear-out)
- Tailwind CSS (no component library) — unified light theme throughout
- Lazy-loaded heavy pages (assets, UNS, checklists, filter management, etc.)
- Permission-based route guards via `<RequireRole permissions={[PERMISSIONS.*]}>`

## Auth Flow
- Token stored in sessionStorage (not localStorage — for shared workstation security)
- Auto-redirect to `/` (dashboard) after login, or returnUrl from query param
- 30-minute JWT refresh cycle
- Session timeout warning dialog
- Single-tab enforcement per user (BroadcastChannel)
- Force login (`force: true`) to terminate existing sessions

## Key Features
- **24** files in `routes/config/` (25 -> 24 on 2026-08-28: `dashboard-cards.tsx` deleted — panel assignment moved to a Panels tab on `role-access.tsx`, stored on `role_configs`/`user_configs` rather than in `system_config`, and gained a per-USER layer. Config -> Appearance lost its second tab with it.) Earlier: **25** files (re-verified `ls apps/web/src/routes/config/*.tsx | wc -l` 2026-08-27 — `alarm-webhooks.tsx` added 2026-08-27, 24 → 25. It has **no config def of its own**: alarm webhooks are a CRUD module with their own tables, not a `system_config` row, so the def count stays at 25 and this page is not driven by the dynamic config page. Its `/config` card is **SUPER_ADMIN-only** — `index.tsx` reads `const visibleSuperAdminCards = isSuperAdmin ? superAdminCards : []` (the delegation allow-list went 2026-08-19) and the card is in `superAdminCards`, so a non-SUPER_ADMIN NEVER sees it and no Configuration Access grant will surface it; `/config/alarm-webhooks` is still reachable by URL, where `RequireRole permissions={[ALARM_RULE_READ]}` admits them. Same as Alarm Rules, which is in the same array. **This line said "default-deny … until `alarm-webhooks` is granted under Configuration Access" until 2026-08-27; that was FALSE.** Earlier: re-verified `ls` 2026-08-19 — `role-assignments.tsx` removed as dead code, 25 → 24; `alarm-limits.def.ts`, added 2026-08-17 for the instrument-limit alarm work, is an auto-discovered def rendered by the dynamic config page, so it adds no file here. Earlier verified `ls` 2026-08-14; the "34" was inherited from DigiLog and was never true here). Most config surfaces are auto-discovered defs rendered by the dynamic page; `alarm-rules.tsx` (2026-08-14) is a real CRUD page, like `floorplans.tsx`
- Entity tree with drag-and-drop hierarchy
- Cleaning-profile pipeline editor (STAGE / CHECKLIST nodes on a custom canvas)
- Notification system (email/SMS/Telegram/Slack)
- Debug trace page for pipeline visibility
- Home / Module Guide (`/home`, `routes/home/`, 2026-07-06): a `home` sidebar
  item defined in `components/layout/sidebar.tsx`'s `allNavItems` AND registered
  in `packages/shared/src/types/sidebar-items.ts` (first entry). **2026-07-13:**
  Home was made a normal, Roles-&-Access-managed sidebar item — the previous
  `if (item.id === 'home') return true` force-show in `sidebar.tsx` was removed,
  so it now follows the same per-role/user `config.sidebarItems` governance as
  every other item (visible-to-all by permission since it has no `PERMISSION_TREE`
  group; toggleable per role on Config → Roles & Access → Sidebar; SUPER_ADMIN
  still bypasses). Existing role_configs were backfilled with `home` at the front
  so nothing regressed. NOT added to the Permissions/Feature-Privileges tab — it
  grants no capability, so visibility is governed on the Sidebar tab only.
  Renders per-module cards via `FlowChart.tsx` (no new deps) in one of **two
  layouts** chosen by each module's `layout` field in `module-flows.ts`
  (2026-07-13): `'sequence'` — a true ordered workflow (the 7 modules with
  review/approve `branch` steps: filter-operations, filter-replacements,
  pm-schedules, approvals, stage-approvals, report-reviews, admin-requests) —
  numbered cards joined by arrow connectors, branches drop below via a
  down-arrow, horizontal scroll + "Scroll for more" cue; `'actions'` (the
  default when omitted, all other modules) — INDEPENDENT capabilities
  (Create / Edit / Delete) as a wrapping grid of cards with **no arrows and no
  step numbers**, so the layout never implies a false order. A test guard
  (`module-flows.test.ts`) enforces that any module with a `branch` step is
  `layout: 'sequence'`. For each operation it
  shows the role(s) **configured live** to perform it, from
  `GET /api/roles/access-matrix` (active roles + permissions + per-role sidebar
  config; authenticated, not ROLE_MANAGE-gated). A role shows on a step only if
  it can see that module's sidebar item AND holds the step's gate; SUPER_ADMIN
  always. Custom roles appear automatically with their own colour. Each viewer
  sees only the modules their own role can access (mirrors their sidebar), via
  `routes/home/viewer-access.ts`. A **"My modules | All modules (audit)" toggle**
  switches to a full auditor view: every module + every role permitted by the
  backend gate, ignoring any role's sidebar (`ignoreSidebar` flag on
  `rolesForStep`/`rolesForGate`). The catalog (`module-flows.ts`) carries each
  step's real backend `gate` (traceable to routes/`PERMISSION_TREE`); the prior
  static `default-roles` map + drift-guard were retired for the live matrix.

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

admin-requests, assets (dialogs/tabs/hooks), audit, auth, checklists, cleaning-cycles (history/timeline), config (branding/notification-rules/notification-settings/roles), debug, filter-management (operations/profiles/status/scan/traceability/AHU-dashboard/cleaning-profile-editor/retirement/replacement/bulk-upload/equipment), mobile, notifications, pm-schedules, profile, system-health, tenant, users (alarms + rule-chains route folders removed 2026-05-17)

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
