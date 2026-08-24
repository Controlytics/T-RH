# DigiLog — Frontend Guide

> **2026-08-24 — re-synced to live code (drift sweep).** This entire document
> previously described the removed filter/AHU/cleaning-cycle/RFID domain and a
> Capacitor tablet app (offline queue, RFID bridge) — none of it exists in this
> fork; see root `CLAUDE.md` "Filter domain — REMOVED" and the equally stale
> `OFFLINE_SYNC_ARCHITECTURE.md`. Rewritten below from `apps/web/src/main.tsx`,
> `routes/`, `hooks/`, and `lib/` directly. Note for whoever next touches root
> `CLAUDE.md`: its System Stats line ("26 custom hooks, 30 lib modules") is
> also stale — live counts are **17 hooks, 17 lib modules** (`ls
> apps/web/src/hooks/*.ts` / `apps/web/src/lib/*.ts`), and its route count of
> 48 is off by one — live is **49** (`grep -cE "<Route" apps/web/src/main.tsx`).
> Not fixed here since `CLAUDE.md` isn't one of this pass's four files.

## Overview

React 19 SPA built with Vite 6, styled with Tailwind CSS 4. The built `apps/web/dist/` bundle is served directly by the Fastify API in the standard local-Windows dev setup. No component library — all UI built with Tailwind utility classes. There is no Capacitor build, no mobile app, and no RFID hardware integration in this fork (verified — no `capacitor` dependency anywhere, no `apps/android`, no `routes/mobile/`).

**Entry point:** `apps/web/src/main.tsx`
**Dev server:** `npx vite --host` (port 5175/5176)
**Build:** `npx vite build` → `apps/web/dist/`

## All Routes (49 — verified `grep -cE "<Route" apps/web/src/main.tsx` 2026-08-24)

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
| `/home` | HomePage | Module flow / navigation overview |
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

### Configuration (24 pages — verified `ls apps/web/src/routes/config/*.tsx` 2026-08-24)

| Path | Page | Permission / Notes |
|---|---|---|
| `/config` | ConfigIndexPage | CONFIG_READ — registry-discovered cards |
| `/config/password-policy` | PasswordPolicyPage | CONFIG_READ |
| `/config/instrument-attributes` | InstrumentAttributesConfigPage | SUPER_ADMIN — attribute keys the New Instrument form asks for |
| `/config/floorplans` | FloorplansConfigPage | SUPER_ADMIN — plan/room placement editor |
| `/config/alarm-rules` | AlarmRulesConfigPage | ALARM_RULE_READ |
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

## Components

### Layout Components

| Component | File | Purpose |
|---|---|---|
| `AppLayout` | `layout/app-layout.tsx` | Main wrapper: sidebar + header + page outlet |
| `Sidebar` | `layout/sidebar.tsx` | Navigation, driven by `PERMISSION_TREE` via `sidebar-visibility.ts`, collapsible (12 sidebar items per root `CLAUDE.md`, not the "26-item" figure previously here) |
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
| `PwaReloadPrompt` | `pwa-reload-prompt.tsx` | Prompts a refresh when `vite-plugin-pwa` detects a new service-worker build — asset-caching for update UX, not an offline-data feature (see `OFFLINE_SYNC_ARCHITECTURE.md`, a deletion candidate for describing a different, non-existent offline subsystem) |

## Utility Libraries (17 modules — verified `ls apps/web/src/lib/*.ts` 2026-08-24)

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
Capacitor tablet app. See `OFFLINE_SYNC_ARCHITECTURE.md` (flagged as a
deletion candidate in this same sweep) for the full picture of what was
removed. The only offline-adjacent code in this app is the PWA service-worker
update prompt (`components/pwa-reload-prompt.tsx`, `vite-plugin-pwa`), which
caches static assets for update UX and does nothing with application data.

## Key Patterns

1. **SWR for all reads** — auto-revalidation, dedup, error retry
2. **apiClient for all writes** — post/put/delete with token attachment
3. **Lazy loading** — heavy pages code-split via `React.lazy()`
4. **Permission gating** — `<RequireRole>` for routes, `useCan()` for buttons, `isSuperAdmin` bypass
5. **Re-authentication** — `useReauth()` + `ReauthDialog`, **47** reauth actions defined in `packages/shared/src/types/reauth-actions.ts` (the "81 sensitive actions" figure previously here belonged to the removed filter/PM/RFID domain)
6. **Toast notifications** — success/error feedback (never `alert()`)
7. **Light theme only** — bg-white cards, bg-slate-50 sections, no dark mode
8. **Responsive** — sidebar collapses to hamburger on mobile, reduced padding
