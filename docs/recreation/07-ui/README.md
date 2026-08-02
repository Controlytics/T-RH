# Phase 7 — UI Analysis

```bash
grep -cE '<Route' apps/web/src/main.tsx   # → 44 (2026-08-01; was 38)
ls apps/web/src/routes/                   # → 12 groups (2026-08-01; was 11 — new `data-injection` dir)
ls apps/web/src/hooks/*.ts                # → 17 (unchanged)
ls apps/web/src/lib/*.ts                  # → 20 (unchanged)
```

*Updated 2026-08-01 for the Data Injection (P1) frontend — 6 new routes under
`routes/data-injection/`. See §2 and §11.*

---

## 1. Stack and deliberate non-choices

| Concern | Choice |
|---|---|
| Framework | React 19 |
| Build | Vite 6 |
| Routing | react-router-dom v6 |
| Data | **SWR** (no Redux, no React Query) |
| Styling | **Tailwind CSS v4** — no component library |
| Forms | react-hook-form + Zod resolvers |
| Icons | lucide-react |
| PDF | jsPDF + jspdf-autotable (client-side) |
| Excel | ExcelJS |
| PWA | vite-plugin-pwa (installable; **not** offline-capable) |

The brief's stack expectation (MUI/Redux) was explicitly **rejected** during the
fork. UI primitives are hand-rolled in `components/ui/`. A rebuild that adopts a
component library would change every screen's appearance — out of scope for
"preserve the user experience".

## 2. Route map — 12 groups, 45 routes (38 before P1, 44 after P1)

> **P2 (2026-08-02)** added `/data-injection/instruments/:id` — the instrument
> detail page (live telemetry polling every 5s, derived topics, filterable
> history). The Data Injection dashboard also gained an ingestion-health strip.
> Verified `grep -cE "<Route" apps/web/src/main.tsx` = 45.

| Group | Representative routes |
|---|---|
| `auth` | `/login`, `/change-password`, `/forgot-password`, `/contact-admin` |
| *(root)* | `/` (dashboard), `/home` (Module Guide) |
| `users` | `/users`, `/users/create`, `/users/edit/:id` |
| `admin-requests` | `/admin-requests` |
| `config` | `/config` + 20 sub-pages |
| `notifications` | `/notifications` |
| `audit` | `/audit` |
| `system-health` | `/system-health` |
| `debug` | `/debug/traces` |
| `profile` | `/profile` |
| `data-injection` **(P1, new)** | `/data-injection`, `/data-injection/hierarchy`, `/data-injection/gateways`, `/data-injection/instruments`, `/data-injection/instruments/create`, `/data-injection/profiles` |

**Sidebar shows 10 items** (was 9): Home, Dashboard, Users, Admin Requests,
Configuration, Notifications, Audit Trail, System Health, Debug Traces,
**Data Injection**.

Heavy pages are `lazy()`-loaded with a `<Suspense>` fallback; guards wrap routes
as `<RequireRole permissions={[PERMISSIONS.X]}>`.

## 3. Layout

```
┌──────────────────────────────────────────────────────┐
│ Sidebar (collapsible)  │  Header: notifications · user│
│  ├─ logo / app name    ├──────────────────────────────┤
│  ├─ 10 nav items       │                              │
│  │   (RBAC-filtered)   │   <main> — routed page       │
│  └─ footer:            │                              │
│     company · "21 CFR  │                              │
│     Part 11 Compliant" │                              │
└──────────────────────────────────────────────────────┘
```

`AppLayout` wraps authenticated routes and owns auth + session management
(idle-timeout warning, single-tab enforcement, JWT refresh).

## 4. Theming

**Light theme only** — an explicit product decision, not an oversight.
`bg-white` cards, `bg-slate-50` sections, `border-slate-200`; gradient dialog
headers are permitted.

**10 colour presets** in `lib/themes.ts` — Ocean, Sapphire, Emerald, Amethyst,
Sunset, Slate, Ruby, Forest, Midnight, Coral — applied via **CSS custom
properties** (`--theme-primary`, `--theme-gradient-from/to`, …) and selected on
Config → Appearance → Branding. `use-branding` applies the theme on load.

Because theming is CSS variables rather than class swapping, a new preset is a
data change, not a code change. **Preserve this.**

> "Midnight" is a dark *accent palette*, not a dark UI mode. There is no dark
> mode anywhere in the application.

## 5. Data fetching

SWR throughout, configured in `lib/swr-config.ts` with a global error handler
that logs `[SWR Error]`. Typical usage:

```ts
const { data } = useSWR('/api/users?page=1', {
  revalidateOnMount: true, revalidateOnFocus: true,
  dedupingInterval: 2000, refreshInterval: 30000,
});
```

Conventions:
- Conditional fetch by passing `null` as the key when the user lacks the
  permission — this prevents 403s hitting the console for lower roles.
- Mutations go through `lib/api-client.ts`, which owns base-URL resolution,
  the JWT header, refresh coalescing, and error normalisation.
- `lib/api-base.ts` resolves the API origin, reading
  `localStorage['digilog.serverUrl']` first — a leftover from the tablet
  deployment model. With no mobile client, this is a **simplification candidate**.

## 6. Permission-aware UI

```ts
const can = useCan();
{can('users.delete') && <DeleteButton />}
```

`use-can` resolves the node's **`gate`** (never the grant set) and ORs against
the user's permissions, with a SUPER_ADMIN bypass. Sidebar visibility uses
`isSidebarItemVisible()` over the same tree. See
[`../04-roles-permissions/README.md`](../04-roles-permissions/README.md).

## 7. Report pages

`components/report-page-wrapper.tsx` provides shared on-screen report chrome:
company/application header, "By: <user>", record count, "Page X of Y" footer
(suppressible via `hideFooter` / `hideFooterStats`).

Applied to the Audit Trail page — the only surviving report surface. Export goes
through `ExportMenu` → PDF (`lib/pdf-report.ts`) or Excel (`lib/excel-export.ts`),
gated by `AUDIT_EXPORT` and bounded by the configurable `export-limit`.

## 8. Interaction states

| State | Treatment |
|---|---|
| Loading | Skeletons / spinner; lazy routes show `<LazyFallback />` |
| Empty | Explicit empty text per table (e.g. "No data") |
| Error | **Toast notifications, never `alert()`**; error popups over inline banners |
| Validation | Inline field errors via react-hook-form + Zod |
| Success | Toast |
| Destructive | Confirmation dialog; mode-aware (e.g. Redact vs Delete Permanently) |
| Step-up auth | `ReauthDialog` — autofill suppressed, focus managed on close |

## 9. Accessibility & responsiveness

**Present:** semantic landmarks (`<nav>`, `<main>`, `<banner>`), `role="group"`
and `aria-pressed` on toggle groups, `aria-label` on icon buttons,
`aria-hidden` on decorative SVGs, visible focus rings
(`focus-visible:ring-2`), responsive collapsible sidebar, `overflow-x` scroll
containers on wide tables.

**Gaps a rebuild should close:**
- No skip-to-content link.
- No documented keyboard-shortcut scheme.
- Sidebar labels are visually hidden on collapse in a way that did not surface in
  an accessibility-tree snapshot — worth verifying against a real screen reader.
- Colour contrast across all 10 themes has not been audited to WCAG AA.
- No automated a11y test in the suite.

## 10. Notable UI behaviours to preserve

1. **Concurrent-session dialog** — shows the existing session's IP and login time
   and requires explicit confirmation before terminating it.
2. **Single-tab enforcement** — BroadcastChannel + localStorage heartbeat; keys
   cleaned on tab close via `beforeunload`. Notably, logout is **not** sent on
   `beforeunload`, because that fires on refresh too and would kill the session
   on every reload. Server-side idle timeout handles real closures instead.
3. **Network error ≠ logout** — `use-auth` distinguishes them, so a blip does not
   eject the user.
4. **Module Guide (`/home`)** renders each module's workflow with the roles
   *currently configured* to perform each step, read live from
   `/api/roles/access-matrix` — plus a "My modules / All modules (audit)" toggle
   for a full auditor view.
5. **PWA update banner** — the service worker uses `skipWaiting` + `clientsClaim`
   so a new bundle activates on the next request, with a dismissible reload
   prompt. This exists because operators on long shifts kept running an old
   bundle against an upgraded server.

## 11. Known UI debt

- `lib/report-review.ts` + `components/SendForReviewButton.tsx` post to
  `/api/report-reviews`, a module removed in the Phase 0 strip. The button is
  hard-disabled (`SEND_FOR_REVIEW_ENABLED = false`) so it is unreachable — but
  its comment says it is "retained for easy re-enable", which is no longer true.
  **Delete it or restore the backend.**
- Report **labels** and **signatories** are no longer configurable (their config
  defs were stripped); the resolvers return built-in defaults. Either restore the
  config surfaces or remove the indirection.
- `lib/api-base.ts`'s `localStorage` server-URL override is mobile-era vestige.

## 12. Data Injection (P1) — 6 new pages, landed 2026-08-01

All 6 files live in `routes/data-injection/`, lazy-loaded with the same
`<Suspense>`/`<LazyFallback />`/`<RequireRole permissions={[...]}>` pattern
as every other route (§2, §6) — no new loading/guard mechanism was
introduced.

| File | Route | Purpose |
|---|---|---|
| `index.tsx` | `/data-injection` | Dashboard — 4 SWR-backed count cards (Instruments, Gateways, Communication Profiles, Hierarchy Nodes), each conditionally fetched via `useCan(...)` (`null` SWR key when the user lacks the view permission, per the §5 convention) and linking to its page. |
| `hierarchy.tsx` | `/data-injection/hierarchy` | Tree view + CRUD over `HierarchyNode` (create, edit, move, delete). |
| `gateways.tsx` | `/data-injection/gateways` | Gateway list + CRUD, referencing a hierarchy node and a communication profile per gateway. |
| `instruments.tsx` | `/data-injection/instruments` | Instrument list + edit/delete; create is routed to the wizard rather than an inline form. |
| `instrument-wizard.tsx` | `/data-injection/instruments/create` | **3-step wizard**: (1) name/code/hierarchy-node — gates "Next" on `step1Valid`; (2) gateway vs. independent communication profile choice; (3) confirm — gates submit on `step3Valid` (mirrors the backend's `instruments_reachable_chk`, §11.4 of the database doc, in the UI before the request is even sent). |
| `profiles.tsx` | `/data-injection/profiles` | Communication profile list + CRUD, with the protocol picker sourced from `GET /api/communication-profiles/protocols`. |

**Permission gates on the routes** (`main.tsx`): the dashboard and
instruments list both gate on `PERMISSIONS.INSTRUMENT_VIEW`; hierarchy gates
on `HIERARCHY_VIEW`; gateways on `GATEWAY_VIEW`; the wizard on
`INSTRUMENT_CREATE`; profiles on `COMM_PROFILE_VIEW` — one gate per route,
same one-permission-per-guard convention as the rest of the app.

**No new hooks or lib modules were added** — the pages reuse `useCan`, `useSWR`,
and the existing `api-client`/`toast` primitives (§5, §6, §8), which is why the
hooks/lib counts in the header of this doc are unchanged.

**What these pages do not do:** none of the 6 pages connect to a device, poll
a broker, or render live telemetry. They are CRUD forms and a tree editor over
configuration rows — consistent with the backend's P1 scope
([`../06-api/README.md`](../06-api/README.md) §9,
[`../05-database/README.md`](../05-database/README.md) §11.9).
