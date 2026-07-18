# Frontend — Key Files

An annotated pointer to the files that a new contributor must know about. Everything else follows the conventions these establish.

## Bootstrap & global wiring

| File | Why it matters |
|---|---|
| `src/main.tsx` | The only router. Registers **76 `<Route>` definitions**. `<ErrorBoundary>` → `<ToastProvider>` → `<SWRConfig>` → `<BrowserRouter>`. Lazy-loads every heavy route. |
| `src/app.css` | Tailwind entry + theme utility classes (`.text-theme-primary`, `.bg-theme-gradient`, `.bg-theme-gradient-br`, etc.) — codemod target replacing inline `style={{ color: 'var(--theme-primary)' }}`. |
| `src/components/layout/app-layout.tsx` | Sidebar + header + outlet. Mounts `useRfidGuard()`, `use-branding`, `use-session`, single-tab check. |
| `src/components/layout/sidebar.tsx` | Permission-filtered sidebar. Reads `SIDEBAR_ITEMS` from `@digilog/shared` and filters by `SIDEBAR_PRIVILEGE_MAP`. Collapses to hamburger below `lg`. |
| `src/components/layout/header.tsx` | Notifications bell, unread count, connectivity/offline indicator, user menu. |
| `src/components/require-role.tsx` | Route gate. Reads `useAuth()`; super-admin bypass + any-of permissions + any-of roles. |
| `src/components/route-error-boundary.tsx` | Per-route error isolation so one page crashing doesn't take down the shell. |
| `src/components/reauth-dialog.tsx` | 21 CFR e-sig reauth popup. Wired via `use-reauth.ts`. |
| `src/components/report-page-wrapper.tsx` | Wraps printable pages (audit, cycles, traceability) with the configured header/footer/pagination. |
| `src/components/toast-provider.tsx` + `ui/toast.tsx` | Global toast. |
| `src/components/error-boundary.tsx` | Outer error boundary. |

## API client + data

| File | Why it matters |
|---|---|
| `src/lib/api-client.ts` | fetch wrapper. Adds `Authorization`, parses JSON, normalizes errors. **Line 58 maps `err.details ?? err.connectionInfo`** — required for the block-change-required popup to fire (backend sends 409 with structured `details`). Exposes `.status` on errors so SWR can suppress 403s. |
| `src/lib/swr-config.ts` | Default fetcher, revalidate-on-focus rules, dedup interval. |
| `src/lib/connectivity.ts` | Single source of truth for online state. Fans out three signals: Capacitor Network plugin (OS-level on tablet) + `navigator.onLine` + `/api/health` probe every 15 s + on `visibilitychange`. **Always import from here, never read `navigator.onLine` directly.** |
| `src/lib/rfid-bridge.ts` | React-side wrapper for the native Capacitor `RfidPlugin`. When the RFID reader is in SDK / answer mode, the OS does not inject keystrokes — the native side opens the USB device via `Reader_Usb.jar` and emits a `tag` event for each scan. Subscribe via `subscribeRfidTags()`. No-op on non-Capacitor platforms. |

## Auth + session

| File | Why it matters |
|---|---|
| `src/hooks/use-auth.ts` | Main auth hook. `login`, `logout`, `user`, `permissions`, `isSuperAdmin`. |
| `src/hooks/use-session.ts` | Session lifecycle — auto-logout on session expiry, refresh handling. |
| `src/hooks/use-reauth.ts` | Wraps mutating actions with the reauth-dialog flow when the action is in the reauth-required list. |
| `src/hooks/use-single-tab.ts` | Enforces one-tab-per-session via BroadcastChannel for auditability. |
| `src/routes/auth/login.tsx` | Desktop login. Handles lockout, policy enforcement. |
| `src/routes/auth/contact-admin.tsx` | Public page that lists active roles via `/api/roles/active`. |

## Offline + RFID

| File | Why it matters |
|---|---|
| `src/lib/offline-store.ts` | IndexedDB wrapper. 3 stores: `operations` (queued ops), `cache` (TTL-keyed snapshots — 24 h for filter-state, 7 d compaction), `filters` (filter snapshots with LRU eviction). |
| `src/lib/sync-engine.ts` | Auto-sync on reconnect, FIFO replay, idempotency-key-aware (`x-client-op-id`), JWT refresh during replay, emits `'interrupted'` event on network drop. Filter-state caches preserved on success. |
| `src/lib/offline-sync-service.ts` | Centralized 9-data-type login hydration (filter instances, templates, cleaning reasons, identifiers, profile pipelines, equipment groups + instruments, approved block changes, branding, field IDs). |
| `src/hooks/use-offline.ts` | Page-facing API: `online`, `pendingCount`, `syncing`, `executeOrQueue`. Health-check uses `apiClient` (CapacitorHttp under the hood) to tolerate self-signed certs. |
| `src/hooks/use-rfid-guard.ts` | Global keydown interceptor. Any keyboard burst that looks like an RFID read is blocked unless the target element has `data-rfid="true"`. Burst threshold 150 ms; first-keystroke seeded into buffer (commit `f9721af`). |
| `src/routes/mobile/mobile-wrapper.tsx` | Mobile home screen with stage cards (6 individual stage buttons) + My Tasks + Approvals + Status + Logout. Features gated by `/api/config/tablet-access/my-features`. |
| `src/routes/mobile/mobile-operations.tsx` | Per-stage scan + batch queue + checklist + DRY_IN countdown panel. Cleaning actions wrap `executeOrQueue`. Used both on tablet and (via routing) for desktop variants. P0.1 fix extracted `validateOfflineGate` helper so `handleSubmit` and `handleSubmitQueue` share validation. |
| `src/routes/mobile/mobile-login.tsx` | Tablet-specific login with cached-auth restore + show/hide password + lockout-progress UI. |
| `src/routes/mobile/mobile-forgot-password.tsx` | Tablet password reset request flow. |

## Theming & branding

| File | Why it matters |
|---|---|
| `src/lib/themes.ts` | 10 preset definitions (Ocean, Sapphire, Emerald, Amethyst, Sunset, Slate, Ruby, Forest, Midnight, Coral). |
| `src/lib/theme-styles.ts` | Helpers that produce class strings based on the active theme. |
| `src/hooks/use-branding.ts` | Applies theme CSS variables to `:root` on app boot. |
| `src/routes/config/branding.tsx` + `branding-components/` | Admin UI to change logo, company name, and theme preset. |

## Filter management (the core Phase-3/4 feature)

| File | Why it matters |
|---|---|
| `src/routes/filter-management/filter-operations.tsx` | Desktop + stage-URL variants share this component (1928 LOC — bloat audit P0.2 outstanding). The cycle state machine runs through here. Reauth, error popups, offline queue, DRY_IN two-step flow, block-change popup all wire in. |
| `src/routes/filter-management/filter-list.tsx` | Filter table + Block→Area→AHU→Filter hierarchy tree + RFID assign + bulk upload + Create/Edit/Delete dialogs (2433 LOC — bloat audit P0.2 outstanding). |
| `src/routes/checklist-form/*` | Standalone end-user checklist submission — intentionally outside AppLayout (renamed from `checklist/` in P1.4). |
| `src/routes/checklist-admin/*` | Admin CRUD for checklist templates (renamed from `checklists/` in P1.4). |
| `src/routes/cleaning-cycles/*` | History + timeline of cycles; reads DRY_IN dryerTemp from readings event. |
| `src/routes/config/filter-cleaning-reasons.tsx`, `equipment-groups.tsx`, `cleaning-profile-assignment.tsx`, `ahu-filter-set-config.tsx`, `audit-templates.tsx`, `access-matrix.tsx`, `tablet-access.tsx` | Filter-domain + governance config pages added in Phases 4-5. *(`alarm-columns.tsx` removed 2026-05-17 with the alarm tear-out.)* |
| `src/routes/pm-schedules/*` + `my-tasks/*` | PM schedule list + detail + per-user task views. PM QA approval workflow: PENDING/APPROVED/REJECTED with mandatory remarks; `getDueTasks` returns APPROVED only. |

## Admin / governance

| File | Why it matters |
|---|---|
| `src/routes/admin-requests/index.tsx` | Admin request creation + approver view. Approvals execute the action server-side (create/unlock/reset/modify); requester Employee ID required and audited. |
| `src/routes/approvals/index.tsx` | Approvals inbox (block-change + PM); remarks mandatory; mobile approvals view also has comment input. |
| `src/routes/config/backup.tsx` | Dynamic backup/restore UI — covers all 64 tables. |
| `src/routes/config/filter-data-management.tsx` | **SUPER_ADMIN-only data console with ZERO audit trail** — 9 tabs each mirroring its user-facing page (cycles, events, PM, audit, notifications, admin requests, block changes, retirements, replacements). Bypasses 21 CFR audit chain by design for emergency data fixes. *(The alarms tab was removed 2026-05-17 with the alarm tear-out.)* |
| `src/routes/config/access-matrix.tsx` | SUPER_ADMIN-only per-module role allowlist; modules without an entry default to visible (back-compat). |
| `src/routes/config/tablet-access.tsx` | Role × feature matrix gating tablet `/m` access; mobile-login enforces this. |
| `src/routes/tenant/*` | Super-admin org management. |

## Reports

| File | Why it matters |
|---|---|
| ~~`src/routes/reports/*`~~ | **Removed** — the reports list/generate/detail pages + `/api/reports/*` were torn out (FE 2026-06-08, backend 2026-07-04). Live report surface: `src/routes/report-reviews/`. |
| `src/routes/report-templates/*` | Template list + editor. |
| `src/lib/pdf-report.ts` | Client-side PDF helpers (mostly for preview — the authoritative PDFs are produced server-side via Puppeteer). |

## Config surface

`src/routes/config/` has **26 pages**, one per config module. The pattern:

1. Each page fetches a `*/current` endpoint with SWR.
2. Renders a form via react-hook-form + zod resolvers (schema usually comes from `@digilog/shared`).
3. Submits a `PUT` that includes **only that tab's fields** — the backend preserves the rest.
4. Uses `useReauth()` if the module is in the reauth-required list.

## Things that are deliberately NOT in a component library

The repo does **not** use shadcn/ui or Radix. UI primitives in `components/ui/` are hand-rolled. If you need a new primitive, add it there — do not install a library.
