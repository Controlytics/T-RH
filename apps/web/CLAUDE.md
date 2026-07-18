# DigiLog Web — CLAUDE.md

## Overview
React 19 SPA built with Vite 6. In dev it runs on the Vite dev server (port 5175). For production-style builds it outputs to `apps/web/dist/`, which is also what Capacitor copies into the Android APK.

## Build & Deploy
```bash
# Local Development (Windows)
cd apps/web && npx vite --host         # Dev server on port 5175

# Build (consumed by the Fastify static-serve at :3000 and by Capacitor for the APK)
cd apps/web && npx vite build          # Outputs to apps/web/dist/

# Update APK with the latest build
cd apps/android && npx cap copy android
cd apps/android/android && ./gradlew assembleDebug
```

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
- Routes: `apps/web/src/routes/` (23 route folders/files; ~84 pages; **77 `<Route>` definitions** in `main.tsx`)
- Hooks: `apps/web/src/hooks/` (auth, branding, datetime, pagination, reauth, session, single-tab, toast, field-labels)
- Components: `apps/web/src/components/` (layout, UI primitives, dialogs)
- API Client: `apps/web/src/lib/api-client.ts`

## Architecture
- React Router v6 with AppLayout wrapper for auth + session management
- SWR for data fetching with auto-revalidation
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
- 34 config pages (auto-discovered from registry)
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
admin-requests, assets (dialogs/tabs/hooks), audit, auth, checklists, cleaning-cycles (history/timeline), config (branding/notification-rules/notification-settings/roles), debug, filter-management (operations/profiles/status/scan/traceability/AHU-dashboard/cleaning-profile-editor/retirement/replacement/bulk-upload/equipment), mobile, notifications, pm-schedules, profile, system-health, tenant, users (alarms + rule-chains route folders removed 2026-05-17)

## Phase 2 Pages
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

**Configurable Color Themes:**
- 10 presets in `lib/themes.ts`, applied via CSS custom properties
- Theme selector on Branding page, `use-branding` hook applies on load
- Replaced hardcoded cyan/teal with CSS vars on: filter-list, PM schedules, dashboard, approvals, checklists, cleaning profiles

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
