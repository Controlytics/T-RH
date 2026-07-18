# Frontend — Quick Tour

**Location:** `apps/web/`
**Tech:** React 19 + Vite 6 + TailwindCSS 4 + SWR 2 + React Router 7 + react-hook-form + zod 4. Plus `@dnd-kit/*`, `recharts`, `signature_pad`, `qrcode.react`, `vite-plugin-pwa`. *(`reactflow` 11 + `@monaco-editor/react` were removed 2026-05-17 with the rule-chain tear-out; the cleaning-profile pipeline editor now uses a custom canvas.)*
**Entry:** `apps/web/src/main.tsx` (**76 `<Route>` definitions**)
**Dev:** `cd apps/web && npm run dev` → Vite on port 5173 (5175 on some configurations)
**Build:** `npm run build` (tsc -b + vite build) → output to `apps/web/dist/`. The bundle is served by the Fastify API at `:3000` (Phase 4 of the windows-friendly-rewrite retired the bundled Nginx config; a reverse proxy is now optional / customer-choice). Capacitor 8 also packages `dist/` into the Android APK.

## Directory map

```
apps/web/src/
├── main.tsx            Router, global providers (ErrorBoundary, ToastProvider, SWRConfig, BrowserRouter), 76 <Route> definitions
├── app.css             Tailwind entry + theme utility classes (.text-theme-primary, .bg-theme-gradient, etc.)
├── vite-env.d.ts       Vite ambient types
├── components/         (7 top-level + layout/ + ui/)
│   ├── layout/          app-layout, header, sidebar (26 items, hamburger <lg)
│   ├── ui/              badge, button, card, code-snippet, connectivity-indicator, dialog, error-popup, help-button, input, select, table, toast  (alarm-badge removed 2026-05-17 with the alarm tear-out)
│   ├── error-boundary.tsx, route-error-boundary.tsx
│   ├── reauth-dialog.tsx           21 CFR reauth
│   ├── report-page-wrapper.tsx     Consistent report header/footer/pagination driven by report settings
│   ├── require-role.tsx            Route permission + role gate (SUPER_ADMIN bypass)
│   └── toast-provider.tsx
├── hooks/              (27 hooks)
│   ├── use-auth.ts                  Current user + login/logout + permissions
│   ├── use-branding.ts              Applies theme CSS variables to :root
│   ├── use-datetime-format.ts       User-configured date formatting
│   ├── use-entity-websocket.ts      (REMOVED 2026-07-03 — subscribed to the now-removed /api/ws WebSocket)
│   ├── use-field-labels.ts          Config-driven field label overrides
│   ├── use-offline.ts               `executeOrQueue()` + online/pending/syncing state
│   ├── use-pagination-config.ts
│   ├── use-reauth.ts                Wraps actions in reauth-dialog flow
│   ├── use-report-config.ts
│   ├── use-rfid-guard.ts            Global keydown interceptor, blocks RFID UKB bursts outside data-rfid fields
│   ├── use-role-colors.ts
│   ├── use-session.ts
│   ├── use-single-tab.ts            Disables duplicate tabs for auditability
│   └── use-toast.ts
├── lib/                (15 modules)
│   ├── api-client.ts                fetch wrapper, Authorization header, maps `err.details ?? err.connectionInfo` (line 58 — required for block-change popup)
│   ├── cn.ts                        `clsx` + `tailwind-merge`
│   ├── connectivity.ts              Single source of truth for online state — Capacitor Network plugin + navigator.onLine + /api/health probe every 15s + visibilitychange
│   ├── rfid-bridge.ts               React wrapper for native Capacitor RfidPlugin (Reader_Usb.jar SDK); subscribes to "tag" events; no-op on non-Capacitor platforms
│   ├── offline-store.ts             IndexedDB: operations queue, TTL cache, filters
│   ├── offline-sync-service.ts      Centralized 9-data-type login hydration
│   ├── sync-engine.ts               auto-sync on reconnect, FIFO replay, idempotency-key-aware, JWT refresh during replay, emits 'interrupted' event
│   ├── swr-config.ts                Default fetcher + revalidation policy
│   ├── themes.ts                    10 preset themes
│   ├── theme-styles.ts              Utility-class wrappers (bloat audit P1.1 codemod target)
│   ├── pdf-report.ts                Client-side PDF (jspdf + jspdf-autotable)
│   ├── format-by-least-count.ts     Instrument-reading number formatting (LC integer → 25; 0.1 → 25.0; 0.01 → 25.00)
│   ├── password-utils.ts, filter-constants.ts, url-utils.ts
├── routes/             (23 route folders/files)
│   ├── auth/                        login, forgot-password, change-password, contact-admin
│   ├── mobile/                      mobile-login, mobile-forgot-password, mobile-wrapper (home), mobile-operations (cleaning view)
│   ├── dashboard.tsx                Single file (not a folder)
│   ├── profile/, users/, admin-requests/, approvals/
│   ├── assets/, filter-management/, cleaning-cycles/, my-tasks/, pm-schedules/
│   ├── checklist-form/              End-user checklist submission (renamed from checklist/ in P1.4)
│   ├── checklist-admin/             Admin CRUD for checklist templates (renamed from checklists/ in P1.4)
│   ├── report-templates/, reports/  (rule-chains/ removed 2026-05-17 with the rule-chain tear-out)
│   ├── audit/, notifications/, system-health/, debug/  (alarms/ removed 2026-05-17 with the alarm tear-out)
│   ├── tenant/                      super-admin org management
│   └── config/                      34 config pages (branding, role-access, field-ids, action-reauth, audit-templates, access-matrix, ahu-filter-set-config, cleaning-profile-assignment, filter-data-management, tablet-access, etc.)
└── types/                           Ambient typings
```

## Routing model

- Single top-level `<BrowserRouter>` in `main.tsx`.
- Public routes: `/login`, `/forgot-password`, `/change-password`, `/contact-admin`.
- Mobile routes: `/m/login`, `/m` (wrapper → operations). Deliberately separate so the APK can land on `/m` without sidebar chrome.
- Authenticated routes: nested inside an `<AppLayout>` wrapper (sidebar + header + reauth dialog + toast). Each route is wrapped with `<RequireRole permissions={[…]} roles={[…]}>` — permissions from `@digilog/shared`'s `PERMISSIONS` constants.
- Heavy routes are lazy-loaded with `React.lazy` + `<Suspense fallback={<LazyFallback />}>` to keep the initial bundle small.
- Standalone checklist form (`/checklist/:entityId`) mounts **outside** `AppLayout` so devices can use it without the admin UI.

## Permissions model

- `RequireRole` reads `useAuth()` and checks two things: is the user a `SUPER_ADMIN` (always allowed), or do their permissions include any of the listed permissions / does their role match any of the listed roles.
- `SUPER_ADMIN` bypass is intentional and matches backend behaviour.
- Frontend visibility gating is defense-in-depth — the backend still enforces permission on every protected route.
- Memory rule: feature toggles **must** map to both the frontend visibility permission **and** the backend route permission in `FEATURE_TO_PERMISSION_MAP`.

## Offline model (short version)

1. `offline-store.ts` opens an IndexedDB (`digilog-offline`) with stores for operations, cache, and filters.
2. Pages use `useOffline()` to get `online`, `pendingCount`, `syncing` — and to call `executeOrQueue(fn, fallback)`.
3. When offline, mutations are validated against the cached pipeline graph and queued with an `offlinePerformedAt` timestamp.
4. On reconnect, `sync-engine.ts` replays the queue FIFO; the backend accepts an `x-offline-replay: true` header and uses `offlinePerformedAt` for the event time.
5. Conflicts (e.g., server state has diverged) are skipped, surfaced in the UI, and logged.
6. `navigator.onLine` is **unreliable** on Capacitor WebViews — `lib/connectivity.ts` fans out three signals: Capacitor Network plugin (OS-level on tablet) + `navigator.onLine` + `/api/health` probe every 15 s + on `visibilitychange`.
7. Idempotency: every queued mutation carries a generated `clientOpId` UUID. The sync engine sends it both as `x-client-op-id` header and in the body. Server `lib/idempotency.ts` dedups via `FilterEvent.attributes.clientOpId` match.
8. Stale-profile yellow banner appears when `cycle.profile_id != live block-assignment` after offline replay.

Full architecture: `OFFLINE_SYNC_ARCHITECTURE.md` at repo root.

## Theme model (short version)

- 10 presets defined in `lib/themes.ts` (Ocean, Sapphire, Emerald, Amethyst, Sunset, Slate, Ruby, Forest, Midnight, Coral).
- `applyTheme(name)` sets CSS variables on `:root`: `--theme-primary`, `--theme-gradient-from`, `--theme-gradient-to`, `--theme-focus-ring`.
- `use-branding.ts` runs on app boot, reads `/api/config/branding`, and calls `applyTheme()`.
- All pages share the same theme — **do not** use per-page colors (user memory rule: "unified cyan/teal theme, no different colors per page" applies — pick the active preset and stick with it).

## RFID model

- Global `useRfidGuard()` is wired in `AppLayout`.
- Fields that should accept RFID input must have `data-rfid="true"`. The guard discards keyboard bursts targeted at other fields.
- Scan dialogs (filter scan, RFID assign) debounce scans at 300 ms and dedup repeated tags.
- Offline tag lookup works via the cached identifier map (`identifier-map` in offline-store).

## Testing locally against the APK

The APK bakes in `https://192.168.1.22:3000`. Adjust your dev box IP or rebuild if you want to hit a different host. For pure-web testing, `http://localhost:5173` with `cd apps/web && npm run dev`.

## Where to read next

- `KEY_FILES.md` — annotated pointer to every non-obvious frontend file.
- `PATTERNS.md` — how to write new pages that fit the existing patterns (offline, permissions, themes, errors).
