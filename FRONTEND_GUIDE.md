# DigiLog — Frontend Guide

## Overview

React 19 SPA built with Vite 6, styled with Tailwind CSS 4. The built `apps/web/dist/` bundle is served directly by the Fastify API on port 3000 in the standard local-Windows install (Phase 4 of the windows-friendly-rewrite retired the bundled Nginx config; a reverse proxy is now optional / customer-choice). The same bundle is also packaged into the Capacitor APK for tablets. No component library — all UI built with Tailwind utility classes.

**Entry point:** `apps/web/src/main.tsx`
**Dev server:** `npx vite --host` (port 5175)
**Build:** `npx vite build` → `apps/web/dist/`

## All Routes (85+ pages)

### Public Routes (no authentication)

| Path | Page | Description |
|---|---|---|
| `/login` | LoginPage | Username/password login with force-login option |
| `/forgot-password` | ForgotPasswordPage | Submit password reset request |
| `/change-password` | ChangePasswordPage | Forced password change on first login |
| `/contact-admin` | ContactAdminPage | Display admin contact info |

### Dashboard & Profile

| Path | Page | Permission |
|---|---|---|
| `/` | DashboardPage | Any authenticated user |
| `/profile` | ProfilePage | Any authenticated user |

### User Management

| Path | Page | Permission |
|---|---|---|
| `/users` | UserListPage | USER_READ |
| `/users/create` | CreateUserPage | USER_CREATE |
| `/users/:id` | EditUserPage | USER_UPDATE |
| `/users/reset-requests` | ResetRequestsPage | USER_RESET_PASSWORD |

### Entity Management (lazy-loaded)

| Path | Page | Permission |
|---|---|---|
| `/assets` | AssetsPage | ASSET_VIEW |
| `/assets/templates` | AssetTemplatesPage | ASSET_VIEW |

### Filter Management (lazy-loaded)

| Path | Page | Permission |
|---|---|---|
| `/filter-list` | FilterListPage | ASSET_READ |
| `/filters` | FilterOperationsPage | FILTER_OPERATE |
| `/filters/:id/trace` | FilterTraceabilityPage | EVENT_READ |
| `/filter-retirements` | RetirementListPage | ASSET_READ |
| `/filter-replacements` | ReplacementListPage | ASSET_READ |

### Cleaning Profiles (lazy-loaded)

| Path | Page | Permission |
|---|---|---|
| `/filter-cleaning-profiles` | CleaningProfileListPage | FCP_READ |
| `/filter-cleaning-profiles/:id/edit` | CleaningProfileEditorPage | FCP_UPDATE |

### Checklists (lazy-loaded)

| Path | Page | Permission |
|---|---|---|
| `/checklists` | ChecklistProfileListPage | FCP_READ |
| `/checklists/:id` | ChecklistProfileDetailPage | FCP_READ |

### Cleaning Cycles (lazy-loaded)

| Path | Page | Permission |
|---|---|---|
| `/cleaning-cycles` | CleaningCycleHistoryPage | CYCLE_READ |
| `/cleaning-cycles/:id` | CleaningCycleTimelinePage | CYCLE_READ |

### PM Schedules (lazy-loaded)

| Path | Page | Permission |
|---|---|---|
| `/pm-schedules` | PmScheduleListPage | PM_READ |
| `/pm-schedules/:entityId` | PmScheduleDetailPage | PM_READ |
| `/my-tasks` | MyTasksPage | PM_EXECUTE |

### Equipment & AHU (lazy-loaded)

| Path | Page | Permission |
|---|---|---|
| `/ahus/:id` | AhuDashboardPage | ASSET_VIEW |

### Reports (lazy-loaded)

| Path | Page | Permission |
|---|---|---|
| `/report-reviews` | ReportReviewsPage | REPORT_REVIEW_SUBMIT / REPORT_REVIEW / REPORT_APPROVE |
| `/filter-lifecycle-report` | FilterLifecycleReportPage | CYCLE_READ |

> The `/report-templates` designer + `/reports` generate/sign/view routes were removed
> 2026-06-08 (frontend) and the backing modules 2026-07-04. Client-side PDF export for the
> cleaning-record + filter-lifecycle pages lives on those pages via `lib/pdf-report.ts`
> (see the Libs table), not a dedicated route.

### Rule Chains — REMOVED 2026-05-17

> The `/rule-chains` + `/rule-chains/:id` routes (RuleChainsPage / RuleChainEditorPage), the `RULE_CHAIN_*` permissions, the rule-chain + alarm subsystems, and `reactflow` / `@monaco-editor/react` were all deleted in the rule-chain + alarm tear-out. The cleaning-profile pipeline editor now uses a custom canvas.

### Notifications

| Path | Page | Permission |
|---|---|---|
| `/notifications` | NotificationsPage | NOTIFICATION_VIEW |

> The `/alarms` route (AlarmDashboardPage, `ALARM_VIEW`) was removed 2026-05-17 with the alarm subsystem.

### Audit & System

| Path | Page | Permission |
|---|---|---|
| `/audit` | AuditTrailPage | AUDIT_READ |
| `/system-health` | SystemHealthPage (lazy) | SUPER_ADMIN/ADMIN |
| `/debug/traces` | DebugTracesPage | READ_DEBUG_TRACE |

### Approvals

| Path | Page | Permission |
|---|---|---|
| `/approvals` | ApprovalsPage (lazy) | BLOCK_CHANGE_APPROVE |
| `/admin-requests` | AdminRequestsPage (lazy) | USER_CREATE |

### Organization Management

> **Removed 2026-04-30 (MT removal):** `/organizations` and `/organizations/:id` routes were deleted along with the `Organization` model, `ORG_VIEW` / `ORG_MANAGE` permissions, and the `routes/tenant/` page folder. DigiLog is single-tenant.

### Catch-all 404 redirect

`apps/web/src/main.tsx` ends with `<Route path="*" element={<Navigate to="/" replace />} />`. Any URL that doesn't match a registered route (e.g. an old `/organizations` bookmark, a typo, a deep link to a deleted page) redirects to the dashboard instead of rendering blank. Added 2026-04-30 in the post-MT-removal hardening pass.

### Configuration (34 pages — verified by `ls apps/web/src/routes/config/*.tsx`)

| Path | Page | Permission / Notes |
|---|---|---|
| `/config` | ConfigIndexPage | CONFIG_READ — registry-discovered cards |
| `/config/access-matrix` | AccessMatrixPage | SUPER_ADMIN — per-module role allowlist |
| `/config/action-reauth` | ActionReauthPage | SUPER_ADMIN |
| `/config/ahu-filter-set-config` | AhuFilterSetConfigPage | SUPER_ADMIN — `/my-tasks` per-AHU mode (BOTH/SET_A/SET_B/DISABLED) |
| `/config/audit-templates` | AuditTemplatesPage | SUPER_ADMIN — templates that hide UUIDs in audit UI |
| `/config/backup` | BackupRestorePage | CONFIG_UPDATE — dynamic 64-table export |
| `/config/branding` | BrandingConfigPage | SUPER_ADMIN — 10 color themes + logo |
| `/config/cleaning-profile-assignment` | CleaningProfileAssignmentPage | CONFIG_UPDATE — block→profile binding |
| `/config/dashboard-cards` | DashboardCardsPage | CONFIG_UPDATE |
| `/config/datetime` | DateTimeConfigPage | CONFIG_READ |
| `/config/dynamic/:moduleKey` | DynamicConfigPage | CONFIG_READ |
| `/config/equipment-groups` | EquipmentGroupsConfigPage | EG_VIEW |
| `/config/field-ids` | FieldIdsPage | SUPER_ADMIN |
| `/config/filter-cleaning-reasons` | FilterCleaningReasonsPage | CONFIG_UPDATE |
| `/config/filter-data-management` | FilterDataManagementPage | **SUPER_ADMIN — escape hatch with NO audit trail** |
| `/config/help` | HelpAdminPage | HELP_MANAGE |
| `/config/ldap` | LdapConfigPage | SUPER_ADMIN |
| `/config/notification-rules` | NotificationRulesPage | CONFIG_UPDATE |
| `/config/notification-settings` | NotificationSettingsPage | CONFIG_UPDATE — email/SMS/Telegram/Slack |
| `/config/pagination` | PaginationConfigPage | CONFIG_READ |
| `/config/password-policy` | PasswordPolicyPage | SUPER_ADMIN |
| `/config/report-config` | ReportConfigPage | SUPER_ADMIN — report page titles / labels / signatories |
| `/config/retention` | RetentionPage | RETENTION_VIEW |
| `/config/role-access` | RoleAccessPage | ROLE_MANAGE |
| `/config/tablet-access` | TabletAccessConfigPage | SUPER_ADMIN — role × feature matrix; controls `/m` access |
| `/config/template-kinds` | TemplateKindsConfigPage | CONFIG_UPDATE — admin-editable Template Kinds lookup (BLOCK/AREA/AHU/FILTER/EQUIPMENT/OTHER seeded as system; admins can add PUMP/VALVE/etc.). System rows show 🔒 badge and Delete is hidden. Step 1 of architectural refactor. |
| `/config/uns` | UnsConfigPage | UNS_VIEW |
| `/config/user-id` | UserIdConfigPage | SUPER_ADMIN — username format rules |

### Mobile (lazy-loaded, standalone layout)

| Path | Page | Description |
|---|---|---|
| `/m/login` | MobileLoginPage (`mobile-login.tsx`) | Tablet login with show/hide password + lockout-progress UI |
| `/m/forgot-password` | MobileForgotPasswordPage (`mobile-forgot-password.tsx`) | Tablet password reset request |
| `/m` | MobileWrapper (`mobile-wrapper.tsx`) | Home: Filter Cleaning, My Tasks, Approvals, Status, Logout — features gated by `/api/config/tablet-access/my-features` |
| `/m` (cleaning view) | MobileOperationsPage (`mobile-operations.tsx`) | Per-stage scan + batch queue + checklist + DRY_IN countdown panel; same component used as cleaning operations across desktop and tablet |

## Custom Hooks (14)

### Authentication & Session

| Hook | File | Purpose |
|---|---|---|
| `useAuth()` | `use-auth.ts` | Login, logout, token refresh, user data, permissions |
| `useSession()` | `use-session.ts` | Idle timeout tracking, warning dialog countdown |
| `useSingleTab()` | `use-single-tab.ts` | One tab per user enforcement via heartbeat |
| `useReauth()` | `use-reauth.ts` | Password re-entry dialog for sensitive operations |

### UI & Configuration

| Hook | File | Purpose |
|---|---|---|
| `useBranding()` | `use-branding.ts` | Fetch branding config, apply theme colors |
| `useToast()` | `use-toast.ts` | Success/error/warning notification toasts |
| `useRoleColors()` | `use-role-colors.ts` | Color mapping per user role |
| `useFieldLabels()` | `use-field-labels.ts` | Dynamic field name labels from config |
| `useDatetimeFormat()` | `use-datetime-format.ts` | Locale-aware date/time formatting |
| `usePaginationConfig()` | `use-pagination-config.ts` | Page size options from config |

### Business Logic

| Hook | File | Purpose |
|---|---|---|
| `useReportConfig()` | `use-report-config.ts` | Report layout settings (header, footer) |
| `useOffline()` | `use-offline.ts` | Offline operation queue, sync status |
| `useEntityWebsocket()` | `use-entity-websocket.ts` | Real-time WebSocket data subscription |
| `useRfidGuard()` | `use-rfid-guard.ts` | Block RFID keyboard input in non-RFID fields |

## Components

### Layout Components

| Component | File | Purpose |
|---|---|---|
| `AppLayout` | `layout/app-layout.tsx` | Main wrapper: sidebar + header + page outlet |
| `Sidebar` | `layout/sidebar.tsx` | 26-item navigation, permission-filtered, collapsible |
| `Header` | `layout/header.tsx` | Top bar: menu toggle, profile, logout |

### Auth & Guard Components

| Component | File | Purpose |
|---|---|---|
| `RequireRole` | `require-role.tsx` | Permission gate — wraps routes |
| `ReauthDialog` | `reauth-dialog.tsx` | Password re-entry modal for sensitive actions |
| `ErrorBoundary` | `error-boundary.tsx` | Global error catch |
| `RouteErrorBoundary` | `route-error-boundary.tsx` | Per-route error catch |

### UI Primitives (Tailwind-based)

| Component | File | Description |
|---|---|---|
| `Button` | `ui/button.tsx` | Primary, outline, ghost variants |
| `Input` | `ui/input.tsx` | Text, password, number inputs |
| `Select` | `ui/select.tsx` | Dropdown selector |
| `Dialog` | `ui/dialog.tsx` | Modal dialog (header, title, footer) |
| `Card` | `ui/card.tsx` | Card container |
| `Table` | `ui/table.tsx` | Data table with th/tr/td |
| `Badge` | `ui/badge.tsx` | Status badges (success, error, warning) |
| `Toast` | `ui/toast.tsx` | Notification toast (5s auto-dismiss) |
| `HelpButton` | `ui/help-button.tsx` | Tooltip help |
| `CodeSnippet` | `ui/code-snippet.tsx` | Formatted code display |
| `ConnectivityIndicator` | `ui/connectivity-indicator.tsx` | Online/offline status |
| `ErrorPopup` | `ui/error-popup.tsx` | Error notification dialog |

### Feature Components

| Component | File | Purpose |
|---|---|---|
| `ReportPageWrapper` | `report-page-wrapper.tsx` | Wraps report tables with header/footer |
| `ToastProvider` | `toast-provider.tsx` | SWR error toast registration |

## Utility Libraries (15 modules)

| File | Purpose |
|---|---|
| `lib/api-client.ts` | HTTP client (get/post/put/delete), auto-attach token, 401 redirect, reauth methods, maps `err.details` to `connectionInfo` |
| `lib/swr-config.ts` | SWR defaults (5s dedup, 2 retries, no focus revalidation) |
| `lib/themes.ts` | 10 color presets, `applyTheme()` sets CSS vars on `:root` |
| `lib/theme-styles.ts` | Tailwind theme utility-class wrappers (`.text-theme-primary`, `.bg-theme-gradient`, etc.) — codemod target replacing inline `style={{ color: 'var(--theme-primary)' }}` |
| `lib/cn.ts` | Class name merger (clsx-like) |
| `lib/password-utils.ts` | Password strength validation |
| `lib/url-utils.ts` | URL parsing, safe redirect checking |
| `lib/filter-constants.ts` | Filter stage type constants |
| `lib/pdf-report.ts` | jspdf + jspdf-autotable client-side report rendering |
| `lib/format-by-least-count.ts` | Least-count number formatting — integer LC → `25`, 0.1 → `25.0`, 0.01 → `25.00`. Applied everywhere instrument readings render. |
| `lib/connectivity.ts` | **Single source of truth for "are we online?"** — fans out 3 signals: Capacitor Network plugin (OS-level on tablet) + `navigator.onLine` + `/api/health` probe every 15s + on `visibilitychange`. Replaces unreliable `navigator.onLine` alone. |
| `lib/rfid-bridge.ts` | **React-side wrapper for the native `RfidPlugin` (Capacitor)** — when the RFID reader is in SDK / answer mode, the OS does not inject keystrokes; the native side opens USB via `Reader_Usb.jar` and emits a `tag` event per scan. Exposes `subscribeRfidTags()`. No-op on non-Capacitor platforms. |
| `lib/offline-store.ts` | IndexedDB offline cache — 3 stores: `operations` (queued ops), `cache` (TTL-keyed snapshots), `filters` (filter snapshots) |
| `lib/offline-sync-service.ts` | Centralized sync of 9 data types on login: filter instances, templates, cleaning reasons, identifiers, profile pipelines, equipment groups + instruments, approved block changes, branding, field IDs |
| `lib/sync-engine.ts` | Offline sync engine — FIFO, skip-on-conflict, auto-sync on reconnect, idempotency-key-aware, JWT refresh during replay, emits `interrupted` event on network drop |

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
9. Idle timeout (configurable, default 15 min) → warning → auto-logout
10. Single-tab enforcement: heartbeat every 1s, 3s timeout detection
```

## Permission System

```typescript
// Route-level guard
<RequireRole permissions={[PERMISSIONS.USER_READ]}>
  <UserListPage />
</RequireRole>

// Page-level check
const { user } = useAuth();
const isSuperAdmin = user?.role === 'SUPER_ADMIN';
const canEdit = isSuperAdmin || (user?.permissions ?? []).includes('USER_UPDATE');

// SUPER_ADMIN bypasses ALL permission checks
```

## Theming System

```
10 Presets: ocean, forest, sunset, mint, rose, slate, indigo, amber, emerald, violet

Each preset defines:
  --theme-primary, --theme-secondary, --theme-accent
  --theme-gradient-from, --theme-gradient-to
  --theme-focus-ring

Applied via: useBranding() → applyTheme() → CSS custom properties on :root

Used on: sidebar gradient, buttons, dialog headers, links, badges, focus rings
```

## Offline Architecture

```
Online Mode:
  API calls → apiClient.post/put/delete → server response

Offline Mode:
  API calls → executeOrQueue() hook
    → If online → direct API call
    → If offline → IndexedDB queue + "pending" indicator

Reconnect:
  sync-engine.ts detects connectivity
    → Replays queued operations (FIFO order)
    → Skips conflicting operations
    → Shows "synced" indicator

Cached Data (IndexedDB):
  - Filter instances (for offline lookup)
  - Cleaning profile templates
  - Cleaning reasons
  - Identifier → filter map (for offline RFID)
```

## Key Patterns

1. **SWR for all reads** — auto-revalidation, dedup, error retry
2. **apiClient for all writes** — post/put/delete with token attachment
3. **Lazy loading** — heavy pages code-split via `React.lazy()`
4. **Permission gating** — `<RequireRole>` wrapper + `isSuperAdmin` bypass
5. **Re-authentication** — `useReauth()` + `ReauthDialog` for 81 sensitive actions
6. **Toast notifications** — success/error feedback (never `alert()`)
7. **Light theme only** — bg-white cards, bg-slate-50 sections, no dark mode
8. **Responsive** — sidebar collapses to hamburger on mobile, reduced padding
