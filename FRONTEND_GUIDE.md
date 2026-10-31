# DigiLog — Frontend Guide

> **2026-08-24 — re-synced to live code (drift sweep).** This entire document
> previously described the removed filter/AHU/cleaning-cycle/RFID domain and a
> Capacitor tablet app (offline queue, RFID bridge) — none of it exists in this
> fork; see root `CLAUDE.md` "Filter domain — REMOVED" and the equally stale
> `docs/archive/OFFLINE_SYNC_ARCHITECTURE.md`. Rewritten below from `apps/web/src/main.tsx`,
> `routes/`, `hooks/`, and `lib/` directly. Root `CLAUDE.md` System Stats is
> the live inventory and is re-derived whenever a count moves; as of
> 2026-10-31 it reads **26** hooks, **24** lib modules and **56** routes (routes 53 → 54 on
> 2026-10-24, 54 → 56 on 2026-10-29 with `/dashboards` and `/dashboards/:id`; lib 22 → 24 on
> 2026-10-31 with `lib/refusal.ts` and `lib/polling.ts`, dashboard builder phase 2)
> (`ls apps/web/src/hooks/ | wc -l`, `ls apps/web/src/lib/ | wc -l`,
> `grep -cE "<Route" apps/web/src/main.tsx`). The paragraph that stood here
> until then quoted three earlier generations of those numbers as "stale" and
> was itself the stale one.

## Overview

React 19 SPA built with Vite 6, styled with Tailwind CSS 4. The built `apps/web/dist/` bundle is served directly by the Fastify API in the standard local-Windows dev setup. No component library — all UI built with Tailwind utility classes. There is no Capacitor build, no mobile app, and no RFID hardware integration in this fork (verified — no `capacitor` dependency anywhere, no `apps/android`, no `routes/mobile/`).

**Entry point:** `apps/web/src/main.tsx`
**Dev server:** `npx vite --host` (port 5175/5176)
**Build:** `npx vite build` → `apps/web/dist/`

## All Routes (56 — verified `grep -cE "<Route" apps/web/src/main.tsx` 2026-10-29; 54 → 56 that day: `/dashboards`, `/dashboards/:id`; 53 → 54 on 2026-10-24: `/config/attribute-access`; 52 → 53 on 2026-09-08: `/settings`; 50 → 52 on 2026-09-07: `/data-report`, `/reports`)

The previous "85+ pages" figure and every table below it described `/assets`,
`/filters`, `/filter-cleaning-profiles`, `/checklists`, `/cleaning-cycles`,
`/pm-schedules`, `/my-tasks`, `/ahus/:id`, `/report-reviews`,
`/filter-lifecycle-report`, `/approvals`, `/organizations`, and the entire
`/m/*` mobile section — none of these routes, or the page components behind
them, exist in `main.tsx` or `routes/` today.

### Public Routes (no authentication)

| Path | Page | Description |
|---|---|---|
| `/login` | LoginPage | Username/password login with force-login option |
| `/forgot-password` | ForgotPasswordPage | Submit password reset request |
| `/change-password` | ChangePasswordPage | Forced password change on first login |
| `/contact-admin` | ContactAdminPage | Display admin contact info |

### Dashboard & Profile

| Path | Page | Notes |
|---|---|---|
| `/` | DashboardPage | Instrument dashboard — floorplan view, telemetry table, room detail |
| `/dashboards` | DashboardsPage | Built dashboards a SUPER_ADMIN creates and assigns (`DASHBOARD_VIEW`; the list shows only what is assigned to the viewer) — 2026-10-29 |
| `/dashboards/:id` | DashboardPage (`routes/dashboards/dashboard-page.tsx`) | One built dashboard: header window + widgets; Edit / Settings / Assign for a SUPER_ADMIN; 404 = "not available to you" — 2026-10-29 |
| `/profile` | ProfilePage | Any authenticated user |

### User Management

| Path | Page | Permission |
|---|---|---|
| `/users` | UserListPage | USER_READ (and other USER_* actions gate in-page) |
| `/users/create` | CreateUserPage | USER_CREATE |
| `/users/reset-requests` | ResetRequestsPage | USER_RESET_PASSWORD |
| `/users/:id` | EditUserPage | USER_READ |

### Instrument Monitoring

| Path | Page | Permission |
|---|---|---|
| `/functional-locations` | FunctionalLocationsPage | FUNCTIONAL_LOCATION_READ |
| `/functional-locations/:id` | FunctionalLocationDetailPage | FUNCTIONAL_LOCATION_READ |
| `/alarms` | AlarmsPage | ALARM_READ |
| `/instruments` | InstrumentProfileListPage | INSTRUMENT_READ |
| `/instruments/profiles/:profileId` | InstrumentListPage | INSTRUMENT_READ |
| `/instruments/new` | InstrumentCreatePage | INSTRUMENT_CREATE |
| `/instruments/bulk` | InstrumentBulkCreatePage | INSTRUMENT_CREATE |
| `/instruments/:id` | InstrumentDetailPage | INSTRUMENT_READ |
| `/instruments/:id/trend` | InstrumentTrend | INSTRUMENT_READ |
| `/data-report` | DataReportPage | INSTRUMENT_READ — the Instrument History widget's own page (2026-09-07) |
| `/reports` | ReportsPage | REPORT_REVIEW_READ — report requests awaiting approval, my requests, approved reports (2026-09-07) |
| `/settings` | SettingsPage | INSTRUMENT_READ — one instrument picker (server-scoped) and a square widget of its Instrument ID, Building, Area and every attribute; `settings.edit` adds an Edit button opening the Attributes panel (2026-09-08) |

### Notifications & Admin Requests

| Path | Page | Permission |
|---|---|---|
| `/notifications` | NotificationsPage | NOTIFICATION_VIEW / NOTIFICATION_MANAGE |
| `/admin-requests` | AdminRequestsPage (lazy) | ADMIN_REQUEST_APPROVE / ADMIN_REQUEST_REJECT |

### Audit & System

| Path | Page | Permission |
|---|---|---|
| `/audit` | AuditTrailPage (lazy) | AUDIT_READ |
| `/system-health` | SystemHealthPage (lazy) | SUPER_ADMIN / ADMIN |
| `/debug/traces` | DebugTracesPage (lazy) | READ_DEBUG_TRACE |

### Catch-all 404 redirect

`apps/web/src/main.tsx` ends with `<Route path="*" element={<Navigate to="/" replace />} />`. Any URL that doesn't match a registered route redirects to the dashboard instead of rendering blank.

### Configuration (25 pages — verified `ls apps/web/src/routes/config/*.tsx | wc -l` 2026-08-27)

| Path | Page | Permission / Notes |
|---|---|---|
| `/config` | ConfigIndexPage | CONFIG_READ — registry-discovered cards |
| `/config/password-policy` | PasswordPolicyPage | CONFIG_READ |
| `/config/instrument-attributes` | InstrumentAttributesConfigPage | SUPER_ADMIN — attribute keys the New Instrument form asks for, per profile, plus each key's display name (2026-09-16; the map is read by every user via `/api/config/attribute-labels/current`) and, since 2026-09-21, a Show in Settings toggle per key and one for the Instrument ID — which fields the Settings page draws, stored on the same row as `settingsHidden` |
| `/config/floorplans` | FloorplansConfigPage | SUPER_ADMIN — plan/room placement editor |
| `/config/alarm-webhooks` | AlarmWebhooksConfigPage | ALARM_RULE_READ |
| `/config/report-page-titles` | ReportPageTitlesPage (lazy) | CONFIG_READ |
| `/config/ldap` | LdapConfigPage (lazy) | CONFIG_READ |
| `/config/datetime` | DatetimeConfigPage | CONFIG_READ |
| `/config/backup` | BackupRestorePage | CONFIG_READ |
| `/config/appearance` | AppearanceConfigPage (lazy) | SUPER_ADMIN |
| `/config/roles` | RoleAccessPage | ROLE_MANAGE — includes Instrument Scope + Attribute Access panels |
| `/config/display-settings` | DisplaySettingsPage (lazy) | SUPER_ADMIN |
| `/config/user-id` | UserIdConfigPage | CONFIG_READ |
| `/config/access-matrix` | AccessMatrixPage | SUPER_ADMIN |
| `/config/action-reauth` | ActionReauthPage | SUPER_ADMIN |
| `/config/email-settings` | EmailSettingsPage (lazy) | SUPER_ADMIN |
| `/config/sms-settings` | SmsSettingsPage (lazy) | SUPER_ADMIN |
| `/config/notification-rules` | NotificationRulesPage (lazy) | SUPER_ADMIN |
| `/config/notification-logs` | NotificationLogsPage (lazy) | SUPER_ADMIN |
| `/config/help` | HelpArticlesPage (lazy) | SUPER_ADMIN |
| `/config/dynamic/:moduleKey` | DynamicConfigPage | CONFIG_READ — renders any config def with no dedicated page |

(`role-assignments.tsx` was deleted 2026-08-19 as dead code — see root `CLAUDE.md` Config history. The previous version of this guide listed 34 config pages including `/config/ahu-filter-set-config`, `/config/cleaning-profile-assignment`, `/config/equipment-groups`, `/config/filter-cleaning-reasons`, `/config/filter-data-management`, `/config/report-config`, `/config/retention`, `/config/tablet-access`, `/config/template-kinds`, `/config/uns` — none of these exist; they were the removed filter/AHU/tenant config surfaces.)

There is no mobile/tablet section — `routes/mobile/`, `/m`, `/m/login` etc. do not exist in this fork.

## Custom Hooks (17 — verified `ls apps/web/src/hooks/*.ts` 2026-08-24)

The previous "14 hooks" table named `use-report-config.ts`, `use-offline.ts`,
`use-entity-websocket.ts`, `use-rfid-guard.ts` — none of those exist. Actual
inventory:

### Authentication & Session

| Hook | File | Purpose |
|---|---|---|
| `useAuth()` | `use-auth.ts` | Login, logout, token refresh, user data, permissions |
| `useSession()` | `use-session.ts` | Idle timeout tracking, warning dialog countdown |
| `useSingleTab()` | `use-single-tab.ts` | One tab / one active session per user, `checkExistingUserSession()` used on login |
| `useReauth()` | `use-reauth.ts` | Password re-entry dialog for sensitive operations |
| `useSuperAdminLock()` | `use-super-admin-lock.ts` | Guards the last-SUPER_ADMIN lock rule |
| `useCan()` | `use-can.ts` | Gates a button/section on a `PERMISSION_TREE` node's `gate` |

### UI & Configuration

| Hook | File | Purpose |
|---|---|---|
| `useBranding()` | `use-branding.ts` | Fetch branding config, apply theme colors |
| `useToast()` | `use-toast.ts` | Success/error/warning notification toasts |
| `useRoleColors()` | `use-role-colors.ts` | Color mapping per user role |
| `useFieldLabels()` | `use-field-labels.ts` | Dynamic field name labels from config |
| `useDatetimeFormat()` | `use-datetime-format.ts` | Locale-aware date/time formatting |
| `usePaginationConfig()` | `use-pagination-config.ts` | Page size options from config |
| `useDragScroll()` | `use-drag-scroll.ts` | Click-and-drag horizontal scroll (e.g. wide tables) |

### Reports & Exports

| Hook | File | Purpose |
|---|---|---|
| `useReportLabels()` | `use-report-labels.ts` | Configurable report field labels |
| `useReportPageTitles()` | `use-report-page-titles.ts` | Configurable report page titles |
| `useExportOptions()` | `use-export-options.ts` | Which columns/formats a report export offers |
| `useExportLimit()` | `use-export-limit.ts` | Row-count cap enforcement on exports |
| `useAttributeLabels()` | `use-attribute-labels.ts` | `labelFor(key)`: the administered display name of an attribute key, else the key (2026-09-16); `settingsHidden` / `isHiddenInSettings(key)`: the Settings page's hidden set from the same response, nothing hidden until it arrives (2026-09-21) |

## Components

### Layout Components

| Component | File | Purpose |
|---|---|---|
| `AppLayout` | `layout/app-layout.tsx` | Main wrapper: sidebar + header + page outlet |
| `Sidebar` | `layout/sidebar.tsx` | Navigation, driven by `PERMISSION_TREE` via `sidebar-visibility.ts`, collapsible (15 sidebar items per root `CLAUDE.md` — 14 → 15 on 2026-10-29 with `dashboards`; 13 → 14 → 15 → 14 between 2026-09-07 and 2026-09-19 (`reports`, `settings`, `home` removed); 12 → 13 on 2026-09-07 with `data-report`; not the "26-item" figure previously here) |
| `Header` | `layout/header.tsx` | Top bar: menu toggle, profile, logout |

### Auth & Guard Components

| Component | File | Purpose |
|---|---|---|
| `RequireRole` | `require-role.tsx` | Permission gate — wraps routes |
| `ReauthDialog` | `reauth-dialog.tsx` | Password re-entry modal for sensitive actions |
| `ErrorBoundary` | `error-boundary.tsx` | Global error catch |
| `RouteErrorBoundary` | `route-error-boundary.tsx` | Per-route error catch |

### UI Primitives (`components/ui/`, Tailwind-based)

| Component | File | Description |
|---|---|---|
| `Button` | `ui/button.tsx` | Primary, outline, ghost variants |
| `Input` | `ui/input.tsx` | Text, password, number inputs |
| `Select` | `ui/select.tsx` | Dropdown selector |
| `SearchableSelect` | `ui/searchable-select.tsx` | Filterable dropdown |
| `Dialog` | `ui/dialog.tsx` | Modal dialog (header, title, footer) |
| `ConfirmDialog` | `ui/confirm-dialog.tsx` | Yes/No confirmation modal |
| `MessageDialog` | `ui/message-dialog.tsx` | Single-message modal |
| `Card` | `ui/card.tsx` | Card container |
| `Table` | `ui/table.tsx` | Data table with th/tr/td |
| `Pagination` | `ui/pagination.tsx` | Page-size + page-number controls |
| `Badge` | `ui/badge.tsx` | Status badges (success, error, warning) |
| `Toast` | `ui/toast.tsx` | Notification toast |
| `ErrorPopup` | `ui/error-popup.tsx` | Error notification dialog |

(`HelpButton`, `CodeSnippet`, `ConnectivityIndicator` from the previous version of this table do not exist.)

### Feature Components

| Component | File | Purpose |
|---|---|---|
| `ReportPageWrapper` | `report-page-wrapper.tsx` | Wraps report tables with header/footer |
| `ToastProvider` | `toast-provider.tsx` | SWR error toast registration |
| `ExportMenu` | `ExportMenu.tsx` | Export-format picker for report/list pages |
| `ReportDownloadDialog` | `report-download-dialog.tsx` | Report download confirmation |
| `SendForReviewButton` | `SendForReviewButton.tsx` | Send-for-review action |
| `SuperAdminApiAccess` | `super-admin-api-access.tsx` | Super-admin API token/access panel |
| `PwaReloadPrompt` | `pwa-reload-prompt.tsx` | Prompts a refresh when `vite-plugin-pwa` detects a new service-worker build — asset-caching for update UX, not an offline-data feature (see `docs/archive/OFFLINE_SYNC_ARCHITECTURE.md`, a deletion candidate for describing a different, non-existent offline subsystem) |

## Utility Libraries (19 modules — re-derived `ls apps/web/src/lib/*.ts` 2026-09-03)

17 -> 19: `lib/document-identity.ts` was added 2026-09-03 with the configurable
browser tab, and `lib/background-style.ts` had been MISSING from this table since
it landed on 2026-08-27 — the count was already one short before this change.

The previous "15 modules" list named `lib/filter-constants.ts`,
`lib/format-by-least-count.ts`, `lib/connectivity.ts`, `lib/rfid-bridge.ts`,
`lib/offline-store.ts`, `lib/offline-sync-service.ts`, `lib/sync-engine.ts` —
none exist (Capacitor/RFID/offline-queue infrastructure, all part of the
removed mobile app). Actual inventory:

| File | Purpose |
|---|---|
| `lib/api-client.ts` | HTTP client (get/post/put/delete), auto-attach token, 401 redirect, reauth methods |
| `lib/api-base.ts` | Resolves the API base URL |
| `lib/swr-config.ts` | SWR defaults |
| `lib/themes.ts` | 10 color presets (Ocean/Sapphire/Emerald/Amethyst/Sunset/Slate/Ruby/Forest/Midnight/Coral), `applyTheme()` sets CSS vars on `:root` |
| `lib/theme-styles.ts` | Tailwind theme utility-class wrappers |
| `lib/cn.ts` | Class name merger (clsx-like) |
| `lib/password-utils.ts` | Password strength validation |
| `lib/url-utils.ts` | URL parsing, safe redirect checking |
| `lib/pdf-report.ts` | Client-side PDF report rendering |
| `lib/excel-export.ts` | Client-side Excel export |
| `lib/export-surfaces.ts` | Registry of which pages/data support export |
| `lib/report-export-log.ts` | Audit-logs report export/download actions |
| `lib/report-labels.ts` | Report label resolution |
| `lib/report-review.ts` | Report review/approval workflow client logic |
| `lib/resolve-bulk-targets.ts` | Resolves bulk-action target sets |
| `lib/server-contact.ts` | Admin contact info display |
| `lib/timing-constants.ts` | Shared timeout/interval constants |
| `lib/background-style.ts` | Builds the app background layer from the branding config |
| `lib/document-identity.ts` | Applies the administered browser-tab title and favicon to the document |

## Authentication Flow

```
1. User enters credentials on /login
2. POST /api/auth/login { username, password, force? }
3. If session conflict → show "force login" option
4. Token stored in sessionStorage (+ localStorage backup)
5. If forcePasswordChange → redirect to /change-password
6. Fetch /api/auth/me → get user profile + permissions
7. Navigate to returnUrl or / (dashboard)
8. Token auto-refreshes every 30 minutes
9. Idle timeout (configurable) → warning → auto-logout
10. Single-tab enforcement via `useSingleTab()` — a duplicate tab is offered a "force login" / claim-active-tab choice rather than a raw heartbeat race
```

(`JWT_EXPIRES_IN` is `1h` in `apps/api/.env.example` — verify against the live
`.env` before relying on the "30 minutes" refresh figure above, which was not
independently re-verified in this sweep.)

## Permission System

```typescript
// Route-level guard
<RequireRole permissions={[PERMISSIONS.USER_READ]}>
  <UserListPage />
</RequireRole>

// Button-level gating (current pattern, ~19 pages — per root CLAUDE.md)
const canEdit = useCan('users.edit'); // gates on the PERMISSION_TREE node's `gate`

// Older inline pattern, retained only for non-button logic
const { user } = useAuth();
const isSuperAdmin = user?.role === 'SUPER_ADMIN';
const canDoX = isSuperAdmin || (user?.permissions ?? []).includes('SOME_PERMISSION');

// SUPER_ADMIN bypasses ALL frontend permission checks
```

`packages/shared/src/types/permission-tree.ts` (`PERMISSION_TREE`) is the
single source of truth for sidebar visibility, button gating, and reauth
mapping — see root `CLAUDE.md` "Sidebar RBAC redesign".

## Theming System

```
10 Presets (verified apps/web/src/lib/themes.ts 2026-08-24):
  Ocean, Sapphire, Emerald, Amethyst, Sunset, Slate, Ruby, Forest, Midnight, Coral

Each preset defines:
  --theme-primary, --theme-secondary, --theme-accent
  --theme-gradient-from, --theme-gradient-to
  --theme-focus-ring

Applied via: useBranding() → applyTheme() → CSS custom properties on :root

Used on: sidebar gradient, buttons, dialog headers, links, badges, focus rings
```

(The previous preset list here — "ocean, forest, sunset, mint, rose, slate,
indigo, amber, emerald, violet" — had 5 names that don't exist in
`themes.ts` and was missing Sapphire, Amethyst, Ruby, Midnight, Coral.)

## Offline Architecture — REMOVED

There is no client-side offline queue, IndexedDB cache, or sync engine in this
fork's web app. The previous version of this section described `executeOrQueue()`,
`sync-engine.ts`, and an IndexedDB cache of filter instances / cleaning
profiles / cleaning reasons — none of that exists; it belonged to the removed
Capacitor tablet app. See `docs/archive/OFFLINE_SYNC_ARCHITECTURE.md` (flagged as a
deletion candidate in this same sweep) for the full picture of what was
removed. The only offline-adjacent code in this app is the PWA service-worker
update prompt (`components/pwa-reload-prompt.tsx`, `vite-plugin-pwa`), which
caches static assets for update UX and does nothing with application data.

## Key Patterns

1. **SWR for all reads** — auto-revalidation, dedup, error retry
2. **apiClient for all writes** — post/put/delete with token attachment
3. **Lazy loading** — heavy pages code-split via `React.lazy()`
4. **Permission gating** — `<RequireRole>` for routes, `useCan()` for buttons, `isSuperAdmin` bypass
5. **Re-authentication** — `useReauth()` + `ReauthDialog`, **50** reauth actions defined in `packages/shared/src/types/reauth-actions.ts` (48 → 50 on 2026-09-07, report review) (the "81 sensitive actions" figure previously here belonged to the removed filter/PM/RFID domain)
6. **Toast notifications** — success/error feedback (never `alert()`)
7. **Light theme only** — bg-white cards, bg-slate-50 sections, no dark mode
8. **Responsive** — sidebar collapses to hamburger on mobile, reduced padding
