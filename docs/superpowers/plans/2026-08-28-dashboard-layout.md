# Customisable Dashboard Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each user drag, resize and persist the arrangement of their dashboard panels, starting from a role default an admin can set.

**Architecture:** `react-grid-layout` renders the four assignable panels as grid items. The layout is a nullable JSONB column on `user_configs` (the user's own) and `role_configs` (the role default), resolved server-side by one pure function and shipped on `/api/config/my-config` beside `panels`. Drag is off until the operator presses **Arrange**.

**Tech Stack:** React 19 + Vite, `react-grid-layout@2.2.4` (verified: installs clean against React 19), Fastify + Prisma, vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-dashboard-layout-design.md`

## Global Constraints

- **TWO states, not three.** `NULL` on the user row = use the role default; `NULL` on the role row = use the built-in. There is no "empty means deny" here, deliberately unlike `dashboard_cards`. Do not unify the two rules.
- **A user's own layout is NOT audited.** A role's default IS (`CONFIG_CHANGED`, `ROLE_MANAGE` + `UPDATE_ROLE_CONFIG`).
- **Layout never grants or withholds anything.** A layout entry for a panel the viewer may not see is ignored and reserves NO space; a visible panel with no entry is appended rather than lost.
- **An unknown panel key is dropped**, never treated as a wildcard — the same rule `normalizePanels` follows.
- **Drag is off by default**, behind an Arrange button, and disabled below the `md` breakpoint.
- **Only the `lg` layout is stored.**
- **`npx tsc --noEmit` on every project touched**; vitest never typechecks.
- The Table | Graphical toggle is REPLACED by two independent cards — operator confirmed 2026-08-28.

---

### Task 1: The shared layout module

**Files:**
- Create: `packages/shared/src/types/dashboard-layout.ts`
- Create: `packages/shared/src/types/dashboard-layout.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `PANEL_KEYS`, `isPanelKey` from `./panels.js`.
- Produces: `DEFAULT_DASHBOARD_LAYOUT`, `LAYOUT_VERSION`, `type LayoutItem`, `type DashboardLayout`, `normalizeLayout(v)`, `resolveLayout(userLayout, roleLayout, visiblePanels)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/types/dashboard-layout.test.ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DASHBOARD_LAYOUT, normalizeLayout, resolveLayout,
} from './dashboard-layout.js';

const item = (i: string, y: number) => ({ i, x: 0, y, w: 12, h: 6 });

describe('normalizeLayout', () => {
  it('reads a stored layout', () => {
    const stored = { version: 1, items: [item('dashboard_trend', 0)] };
    expect(normalizeLayout(stored)?.items).toEqual([item('dashboard_trend', 0)]);
  });

  it('DROPS an item whose panel key no longer exists', () => {
    // Same rule normalizePanels follows: a retired key contributes nothing and is
    // never a wildcard.
    const stored = { version: 1, items: [item('total_users', 0), item('dashboard_trend', 1)] };
    expect(normalizeLayout(stored)?.items.map((i) => i.i)).toEqual(['dashboard_trend']);
  });

  it('returns undefined for absent or malformed values rather than an empty layout', () => {
    // An empty layout would render a blank dashboard. Falling back to the default
    // is the only safe direction: a corrupted preference must not look like a
    // deliberate "show nothing".
    expect(normalizeLayout(null)).toBeUndefined();
    expect(normalizeLayout(undefined)).toBeUndefined();
    expect(normalizeLayout('nonsense')).toBeUndefined();
    expect(normalizeLayout({ items: 'no' })).toBeUndefined();
    expect(normalizeLayout({ version: 1, items: [{ i: 'dashboard_trend' }] })).toBeUndefined();
  });

  it('rejects a layout from a future version rather than guessing', () => {
    expect(normalizeLayout({ version: 99, items: [item('dashboard_trend', 0)] })).toBeUndefined();
  });
});

describe('resolveLayout', () => {
  const visible = ['telemetry_table', 'dashboard_trend'];

  it('prefers the user layout over the role default', () => {
    const user = { version: 1, items: [item('dashboard_trend', 0)] };
    const role = { version: 1, items: [item('telemetry_table', 0)] };
    expect(resolveLayout(user, role, visible).items[0].i).toBe('dashboard_trend');
  });

  it('falls back to the role default, then to the built-in', () => {
    const role = { version: 1, items: [item('dashboard_trend', 0)] };
    expect(resolveLayout(undefined, role, visible).items[0].i).toBe('dashboard_trend');
    expect(resolveLayout(undefined, undefined, visible).items.length).toBeGreaterThan(0);
  });

  it('IGNORES an entry for a panel the viewer may not see', () => {
    // And reserves no space for it. A hole where a hidden panel would be discloses
    // that the panel exists, which is the opposite of hiding it.
    const user = { version: 1, items: [item('trend_alarms', 0), item('dashboard_trend', 1)] };
    expect(resolveLayout(user, undefined, ['dashboard_trend']).items.map((i) => i.i))
      .toEqual(['dashboard_trend']);
  });

  it('APPENDS a visible panel that has no entry, rather than losing it', () => {
    // A newly granted panel must appear. Silently vanishing would look like the
    // grant failed.
    const user = { version: 1, items: [item('dashboard_trend', 0)] };
    const out = resolveLayout(user, undefined, ['dashboard_trend', 'telemetry_table']);
    expect(out.items.map((i) => i.i)).toEqual(['dashboard_trend', 'telemetry_table']);
    // Below everything already placed, so it cannot land on top of something.
    expect(out.items[1].y).toBeGreaterThanOrEqual(out.items[0].y + out.items[0].h);
  });

  it('returns only visible panels when nothing is stored', () => {
    expect(resolveLayout(undefined, undefined, ['dashboard_trend']).items.map((i) => i.i))
      .toEqual(['dashboard_trend']);
  });

  it('the built-in default covers every panel in the catalogue', () => {
    // Otherwise granting a panel would rely on the append path forever, and the
    // shipped arrangement would silently omit one.
    const keys = DEFAULT_DASHBOARD_LAYOUT.items.map((i) => i.i);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```

- [ ] **Step 2: Run it — expect module-not-found.**

- [ ] **Step 3: Write the module.** `LAYOUT_VERSION = 1`; `normalizeLayout` validates version, array shape and every numeric field, dropping unknown keys and returning `undefined` on anything malformed; `resolveLayout` does user → role → built-in, filters to `visiblePanels`, and appends missing ones below the lowest occupied row.

- [ ] **Step 4: Export from `index.ts`, run tests, `tsc --noEmit`, rebuild the package, commit.**

---

### Task 2: The migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<UTC-timestamp>_dashboard_layout/migration.sql`

- [ ] **Step 1:** Add `dashboardLayout Json? @map("dashboard_layout") @db.JsonB` to `RoleConfig` and `UserConfig`, each with a comment recording the TWO-state rule and why it differs from `dashboard_cards` beside it.

- [ ] **Step 2:** Generate the diff for review:
```bash
cd apps/api && DBURL=$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"') \
  && npx prisma migrate diff --from-url "$DBURL" --to-schema-datamodel prisma/schema.prisma --script
```
Expect two `ADD COLUMN` lines plus the three known noise statements this baseline always emits — `DROP TABLE instrument_telemetry_history`, `ALTER audit_trail.chain_position DROP NOT NULL`, and an `instrument_credentials` FK drop/recreate. **Strip all three.** Applying any of them is destructive.

- [ ] **Step 3:** Hand-author the migration with only the two `ADD COLUMN` statements and a header naming the stripped three. **No data carry-over** — there is no prior layout to migrate, and NULL already means "use the default".

- [ ] **Step 4:** `npx prisma migrate deploy`, then stop the dev API before `npx prisma generate` (it EPERMs while `tsx watch` holds the query-engine DLL), then restart it.

- [ ] **Step 5:** `powershell -ExecutionPolicy Bypass -Command "npm run db:verify-migrations"` — must PASS.

- [ ] **Step 6:** Apply to the TEST database too:
```bash
DATABASE_URL="postgresql://digilog:digilog123@localhost:5432/compliance_core_db_test?schema=public" npx prisma migrate deploy
```
A migration applied to only one database makes every instrument-touching e2e 500.

- [ ] **Step 7: Commit.**

---

### Task 3: Server resolution and the three routes

**Files:**
- Create: `apps/api/src/modules/config/dashboard-layout.ts`
- Create: `apps/api/src/modules/config/__tests__/dashboard-layout.test.ts`
- Modify: `apps/api/src/modules/config/static-routes/roles.routes.ts` (`/my-config`, plus the two self-service routes)
- Modify: `apps/api/src/modules/roles/routes.ts` (the role-default route, beside `panel-access`)
- Create: `apps/api/src/e2e/dashboard-layout.test.ts`

**Interfaces:**
- Consumes: `resolveLayout` / `normalizeLayout` (Task 1); `resolvePanelsFor` from `./panel-access.js`.
- Produces: `resolveLayoutFor(username)`; `PUT`/`DELETE /api/config/my-dashboard-layout`; `PUT /api/roles/dashboard-layout/role/:name`.

- [ ] **Step 1: Write the failing e2e**, through the seeded OPERATOR:
  - the layout round-trips on `my-config`;
  - the per-user PUT writes **NO** audit row (count `audit_trail` before and after);
  - the role PUT **DOES**, and refuses without `ROLE_MANAGE`;
  - `DELETE` restores the role default;
  - an entry for a panel the caller cannot see never appears in the resolved layout.

- [ ] **Step 2: Write the resolver** — reads both rows, calls `resolveLayout` with the panels `resolvePanelsFor` already resolved so the two answers cannot disagree.

- [ ] **Step 3: Ship `layout` on `/my-config`**, declared in the response schema — Fastify strips undeclared fields silently.

- [ ] **Step 4: Add the routes.** The self-service pair is authenticated only, no reauth, **no `auditLog` call** — with a comment saying that is deliberate, so nobody "fixes" the omission later. The role route mirrors `panel-access/role/:name` exactly.

- [ ] **Step 5: Run, typecheck, commit.**

---

### Task 4: The grid shell and edit mode

**Files:**
- Modify: `apps/web/package.json` (add `react-grid-layout`, `@types/react-grid-layout`)
- Create: `apps/web/src/routes/dashboard/panel-grid.tsx`
- Create: `apps/web/src/hooks/use-dashboard-layout.ts`
- Create: `apps/web/src/routes/dashboard/__tests__/panel-grid.test.ts` (pure helpers)

- [ ] **Step 1: Install**
```bash
cd /c/Users/hello/compliance-core && npm install react-grid-layout --workspace @digilog/web && npm install -D @types/react-grid-layout --workspace @digilog/web
```
Verified 2026-08-28: 8 packages, no peer conflict against React 19.

- [ ] **Step 2:** `use-dashboard-layout.ts` — reads `layout` from `my-config`, holds the draft while in edit mode, and exposes `save()` / `cancel()` / `reset()`. The draft lives in the hook so Cancel is a real discard rather than a refetch.

- [ ] **Step 3:** `panel-grid.tsx` wraps `ResponsiveGridLayout`: 12 cols at `lg`, 6 at `md`, 1 at `sm`; `isDraggable`/`isResizable` both `editing && breakpoint !== 'sm'`; `onLayoutChange` updates the draft only at `lg`.

- [ ] **Step 4:** The Arrange / Save / Cancel / Reset control bar, shown above the grid. Import `react-grid-layout/css/styles.css` and `react-resizable/css/styles.css` once, in `panel-grid.tsx`.

- [ ] **Step 5: Typecheck, run the web suite, `vite build`, commit.**

---

### Task 5: Move the panels into the grid, splitting the toggle

**Files:**
- Modify: `apps/web/src/routes/dashboard/index.tsx`

- [ ] **Step 1: Remove the Table | Graphical toggle** and the `?view=` param handling. Operator-confirmed: they become two independent cards. Leave a comment recording the change and the date, since this alters a screen in daily use.

- [ ] **Step 2:** Render the four panels as grid children, each keyed by its panel key, each still wrapped in its `showPanel(...)` guard so assignment continues to decide what exists.

- [ ] **Step 3:** Leave the drill-down entry cards and the Alarms count card ABOVE the grid, untouched and undraggable — they are generated from the location tree and their number changes with the level.

- [ ] **Step 4: Typecheck, web suite, `vite build`, commit.**

---

### Task 6: Docs and counts

- [ ] **Step 1:** Re-derive every count. Expect: models **36**, enums **13**, permissions **42**, reauth **48**, modules **24**, defs **25**, pages **24**, `<Route>`s **50**, shared types **18 → 19**.
- [ ] **Step 2:** CHANGELOG entry covering the two-state rule, the not-audited decision, the dependency, and the toggle split.
- [ ] **Step 3:** Note the new dependency in `apps/web/CLAUDE.md` — the first UI dependency added here in a long time, after `reactflow` / `monaco` / `chartjs` were each removed, so a future reader does not assume it is vestigial.
- [ ] **Step 4:** Full verification: `npm test` (api), `npx vitest run` (web), `tsc` on all three, `vite build`. Commit.

## Self-review notes

- **Spec coverage:** storage and two-state → Tasks 1, 2; resolution and fallback → Tasks 1, 3; auditing split → Task 3; API → Task 3; grid, edit mode, responsive → Task 4; the toggle split and what stays fixed → Task 5; counts, dependency note → Task 6.
- **Type consistency:** `normalizeLayout` / `resolveLayout` / `resolveLayoutFor` / `useDashboardLayout` / `PanelGrid` are each defined once and used by those names.
- **Known risk:** `react-grid-layout` ships its own CSS and expects `react-resizable`'s too. Omitting either leaves resize handles invisible — the drag works, the corner does not, and it reads as a broken feature. Task 4 Step 4 imports both.
