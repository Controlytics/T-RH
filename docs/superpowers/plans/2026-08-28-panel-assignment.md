# Panel Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every panel that already exists on the dashboard and the instrument trend page assignable per role and per user, on the same screen and in the same shape as instrument scope.

**Architecture:** A nullable `dashboard_cards` JSONB column on both `role_configs` and `user_configs`, resolved server-side by one pure function and shipped on the existing `/api/config/my-config` payload. One catalogue in `@digilog/shared` replaces two hand-synced copies. The old `system_config['dashboard-cards']` surface is migrated and retired.

**Tech Stack:** Fastify + Prisma (PostgreSQL 18) API, React 19 + Vite SPA, vitest, hand-authored SQL migrations.

**Spec:** `docs/superpowers/specs/2026-08-28-panel-assignment-design.md`

## Global Constraints

- **Three states, never collapsed.** `NULL` = inherit (user → role → every panel); `[]` = NO panels; `[keys]` = these panels. A "is anything selected" test that folds `[]` into inherit turns a deny into a grant and is the single failure this feature must not ship.
- **`Prisma.DbNull`, never `Prisma.JsonNull`.** JSON `null` is a different stored value; the contract rests on SQL NULL.
- **Columns are nullable with NO default.** A `DEFAULT '[]'` would hide every panel from everyone the moment the migration runs.
- **Deliberately unlike `sidebarItems`.** `config.service.getMyConfig` uses a `length > 0` test to decide whether a user config wins. Panels must NOT copy that. Do not "make it consistent" later.
- **SUPER_ADMIN always resolves to every panel**, whatever is stored, so an admin cannot hide the screen that would let them undo it.
- **Unknown keys contribute nothing and are never a wildcard.**
- **Hiding a panel is a DISPLAY decision, not an access control.** It does not stop the data being fetched from the API. This sentence must appear on the editor screen.
- **No new permission, reauth action, or audit action.** Reuse `ROLE_MANAGE`, `UPDATE_ROLE_CONFIG`, `CONFIG_CHANGED`.
- **Migrations are hand-authored** per `apps/api/CLAUDE.md`; `npm run db:verify-migrations` must PASS; apply to `compliance_core_db` AND `compliance_core_db_test`.
- **Run `npx tsc --noEmit` on both projects.** vitest never typechecks; a green suite has repeatedly hidden a non-compiling tree here.

---

### Task 1: The shared catalogue and resolver

**Files:**
- Create: `packages/shared/src/types/panels.ts`
- Create: `packages/shared/src/types/panels.test.ts`
- Modify: `packages/shared/src/index.ts` (add exports beside the other type exports)

**Interfaces:**
- Consumes: nothing.
- Produces: `PANELS: readonly PanelDefinition[]`, `PANEL_KEYS: readonly string[]`, `PANEL_PAGES`, `type PanelKey`, `type PanelDefinition`, `isPanelKey(v: unknown): v is PanelKey`, `normalizePanels(v: unknown): string[] | undefined`, `resolvePanels(userRole: string, rolePanels: string[] | null | undefined, userPanels: string[] | null | undefined): string[] | null`, `panelVisible(resolved: string[] | null, key: string): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/types/panels.test.ts
import { describe, it, expect } from 'vitest';
import {
  PANELS, PANEL_KEYS, isPanelKey, normalizePanels, resolvePanels, panelVisible,
} from './panels.js';

describe('PANELS catalogue', () => {
  it('is frozen — the exact keys, in order', () => {
    // A snapshot in code rather than a .snap file: these keys are stored in the
    // database, so adding or renaming one silently orphans saved rows.
    expect(PANEL_KEYS).toEqual([
      'telemetry_table',
      'telemetry_floorplan',
      'trend_gauges',
      'trend_charts',
      'trend_summary',
      'trend_historian_table',
      'trend_alarms',
    ]);
  });

  it('does NOT contain the four retired dashboard keys', () => {
    // total_users / audit_trail / notifications / quick_actions gated sections that
    // were removed from the dashboard. A switch that does nothing on a governance
    // screen is worse than an absent one.
    for (const dead of ['total_users', 'audit_trail', 'notifications', 'quick_actions']) {
      expect(PANEL_KEYS).not.toContain(dead);
    }
  });

  it('gives every panel a page, a label and a description', () => {
    for (const p of PANELS) {
      expect(p.page === 'dashboard' || p.page === 'trend').toBe(true);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate keys', () => {
    expect(new Set(PANEL_KEYS).size).toBe(PANEL_KEYS.length);
  });
});

describe('isPanelKey', () => {
  it('accepts a catalogue key and rejects anything else', () => {
    expect(isPanelKey('trend_charts')).toBe(true);
    expect(isPanelKey('total_users')).toBe(false);
    expect(isPanelKey(7)).toBe(false);
    expect(isPanelKey(null)).toBe(false);
  });
});

describe('normalizePanels', () => {
  it('reads a stored array, dropping keys no longer in the catalogue', () => {
    // A retired key must contribute NOTHING. It must never be read as a wildcard:
    // that would turn a narrow grant into a full one as the catalogue evolves.
    expect(normalizePanels(['trend_charts', 'total_users'])).toEqual(['trend_charts']);
  });

  it('keeps an EMPTY array as an empty array, not as absent', () => {
    // The whole feature rests on this. undefined here would turn "no panels" into
    // "inherit", i.e. into "every panel".
    expect(normalizePanels([])).toEqual([]);
  });

  it('keeps an array whose every member is retired as EMPTY, not absent', () => {
    expect(normalizePanels(['total_users', 'audit_trail'])).toEqual([]);
  });

  it('treats absent and malformed alike as INHERIT, never as deny', () => {
    // A corrupted value must not blank someone's screen: that is an outage
    // presenting as a configuration change, and much harder to diagnose.
    expect(normalizePanels(null)).toBeUndefined();
    expect(normalizePanels(undefined)).toBeUndefined();
    expect(normalizePanels('trend_charts')).toBeUndefined();
    expect(normalizePanels({ panels: [] })).toBeUndefined();
  });

  it('drops non-string members instead of carrying them through', () => {
    expect(normalizePanels(['trend_charts', 7, null])).toEqual(['trend_charts']);
  });
});

describe('resolvePanels', () => {
  it('gives SUPER_ADMIN every panel whatever is stored', () => {
    expect(resolvePanels('SUPER_ADMIN', [], [])).toBeNull();
    expect(resolvePanels('SUPER_ADMIN', ['trend_charts'], [])).toBeNull();
  });

  it('is unrestricted when neither level is set', () => {
    expect(resolvePanels('OPERATOR', null, null)).toBeNull();
    expect(resolvePanels('OPERATOR', undefined, undefined)).toBeNull();
  });

  it('inherits the role list when the user has none', () => {
    expect(resolvePanels('OPERATOR', ['trend_charts'], null)).toEqual(['trend_charts']);
  });

  it('lets the user list REPLACE the role list', () => {
    expect(resolvePanels('OPERATOR', ['trend_charts'], ['trend_alarms'])).toEqual(['trend_alarms']);
  });

  it('lets a user override WIDEN beyond the role, matching effectiveScope', () => {
    expect(resolvePanels('OPERATOR', ['trend_charts'], ['trend_charts', 'trend_alarms']))
      .toEqual(['trend_charts', 'trend_alarms']);
  });

  it('treats an EMPTY user list as NO panels, not as inherit', () => {
    // The deliberate deviation from getMyConfig's `sidebarItems.length > 0` rule.
    expect(resolvePanels('OPERATOR', ['trend_charts'], [])).toEqual([]);
  });

  it('treats an EMPTY role list as NO panels too', () => {
    expect(resolvePanels('OPERATOR', [], null)).toEqual([]);
  });
});

describe('panelVisible', () => {
  it('shows everything when resolution is null', () => {
    expect(panelVisible(null, 'trend_charts')).toBe(true);
  });

  it('shows nothing when the list is empty', () => {
    expect(panelVisible([], 'trend_charts')).toBe(false);
  });

  it('shows only listed panels', () => {
    expect(panelVisible(['trend_charts'], 'trend_charts')).toBe(true);
    expect(panelVisible(['trend_charts'], 'trend_alarms')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/types/panels.test.ts`
Expected: FAIL — `Cannot find module './panels.js'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/types/panels.ts

/**
 * Which panels a role or user may SEE on the dashboard and the instrument trend
 * page.
 *
 * Design: docs/superpowers/specs/2026-08-28-panel-assignment-design.md
 *
 * **A hidden panel is a DISPLAY decision, not an access control.** Hiding the
 * historian table does not stop its data being fetched from
 * `GET /api/instruments/:id/telemetry` by anyone who can reach the API.
 * `instrument_scope` is what restricts data; this restricts clutter. The editor
 * screen says so out loud, because an admin who hides the alarms widget believing
 * they have withheld alarm data has been misled by the UI.
 *
 * This file is the ONE catalogue. It replaced two hand-maintained copies (an
 * `ALL_CARDS` array in the web config page and a `VALID_CARD_KEYS` set in the API
 * route) that carried a "keep in sync" comment — which is a drift with a comment
 * on it, not a solution.
 */

export type PanelPage = 'dashboard' | 'trend';

export interface PanelDefinition {
  key: string;
  page: PanelPage;
  label: string;
  description: string;
}

export const PANEL_PAGES: readonly { page: PanelPage; label: string }[] = [
  { page: 'dashboard', label: 'Dashboard' },
  { page: 'trend', label: 'Instrument trend page' },
] as const;

/**
 * ORDER IS PART OF THE CONTRACT — a frozen test asserts it, because these keys are
 * stored in `role_configs` / `user_configs` and renaming one silently orphans every
 * saved row that names it.
 *
 * The four keys retired on 2026-08-28 — `total_users`, `audit_trail`,
 * `notifications`, `quick_actions` — gated dashboard sections that no longer exist.
 * They are deliberately absent, not commented out.
 */
export const PANELS: readonly PanelDefinition[] = [
  {
    key: 'telemetry_table',
    page: 'dashboard',
    label: 'Instrument Readings — Table',
    description: 'Every instrument’s current temperature and humidity, as a table',
  },
  {
    key: 'telemetry_floorplan',
    page: 'dashboard',
    label: 'Instrument Readings — Floorplan',
    description: 'Rooms drawn on the floor layout, coloured by whether they are in limit',
  },
  {
    key: 'trend_gauges',
    page: 'trend',
    label: 'Band gauges',
    description: 'Latest temperature and humidity against their limits',
  },
  {
    key: 'trend_charts',
    page: 'trend',
    label: 'Trend charts',
    description: 'Temperature and humidity plotted over the selected period',
  },
  {
    key: 'trend_summary',
    page: 'trend',
    label: 'Chart summary strips',
    description: 'Min / max / average and out-of-limit counts beneath each chart',
  },
  {
    key: 'trend_historian_table',
    page: 'trend',
    label: 'Time series (raw readings)',
    description: 'The paged historian table of every stored reading in the period',
  },
  {
    key: 'trend_alarms',
    page: 'trend',
    label: 'Alarms in this period',
    description: 'Alarms raised on this instrument during the selected period',
  },
] as const;

export const PANEL_KEYS: readonly string[] = PANELS.map((p) => p.key);

export type PanelKey = (typeof PANELS)[number]['key'];

const KEY_SET = new Set<string>(PANEL_KEYS);

export function isPanelKey(v: unknown): v is PanelKey {
  return typeof v === 'string' && KEY_SET.has(v);
}

/**
 * Read a stored `dashboard_cards` value, or `undefined` for "nothing stored here".
 *
 * Absent OR malformed both mean INHERIT, not deny — a corrupted value must not
 * blank someone's screen, which is an outage presenting as a configuration change.
 *
 * An EMPTY result stays empty. Returning `undefined` for `[]` would turn every
 * deliberate "no panels" row into "every panel", which is the wrong direction to
 * fail in and the reason this function exists at all rather than an inline filter.
 *
 * A key no longer in the catalogue contributes NOTHING and is never a wildcard.
 */
export function normalizePanels(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter(isPanelKey);
}

/**
 * The effective panel list, or `null` for "every panel".
 *
 * Mirrors `modules/instruments/visibility.ts:effectiveScope` deliberately: the
 * user's list REPLACES the role's rather than intersecting it, so it can widen as
 * well as narrow. Two governance surfaces edited on the same screen behaving
 * differently would be worse than either rule alone.
 */
export function resolvePanels(
  userRole: string,
  rolePanels: string[] | null | undefined,
  userPanels: string[] | null | undefined,
): string[] | null {
  if (userRole === 'SUPER_ADMIN') return null;
  if (userPanels !== null && userPanels !== undefined) return userPanels;
  if (rolePanels !== null && rolePanels !== undefined) return rolePanels;
  return null;
}

/** `null` (unrestricted) shows everything; an empty list shows nothing. */
export function panelVisible(resolved: string[] | null, key: string): boolean {
  return resolved === null || resolved.includes(key);
}
```

- [ ] **Step 4: Export from the package index**

Add to `packages/shared/src/index.ts`, beside the `SIDEBAR_ITEMS` export:

```ts
export {
  PANELS, PANEL_KEYS, PANEL_PAGES, isPanelKey, normalizePanels, resolvePanels, panelVisible,
} from './types/panels.js';
export type { PanelDefinition, PanelKey, PanelPage } from './types/panels.js';
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd packages/shared && npx vitest run src/types/panels.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, 20 tests; tsc silent.

- [ ] **Step 6: Build the package so the API and web resolve the new export**

Run: `cd /c/Users/hello/compliance-core && npm run build -w @digilog/shared`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/panels.ts packages/shared/src/types/panels.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): one catalogue and resolver for assignable panels"
```

---

### Task 2: The migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (add `dashboardCards` to `RoleConfig` and `UserConfig`)
- Create: `apps/api/prisma/migrations/<UTC-timestamp>_panel_access/migration.sql`

**Interfaces:**
- Consumes: the key list from Task 1 (the SQL hardcodes the two surviving dashboard keys and the five trend keys — it must, since SQL cannot import TypeScript).
- Produces: `role_configs.dashboard_cards` and `user_configs.dashboard_cards`, both `JSONB NULL`.

- [ ] **Step 1: Add the columns to the datamodel**

In `apps/api/prisma/schema.prisma`, add to `model RoleConfig` immediately after `attributeAccess`:

```prisma
  /// Which dashboard / trend-page panels this role may SEE. NULL = inherit
  /// (user -> role -> every panel); [] = NO panels; [keys] = these panels.
  /// Nullable with NO default: a default of '[]' would blank every existing
  /// role's dashboard the moment this migration ran.
  /// A hidden panel is a DISPLAY decision, NOT an access control — instrument_scope
  /// is what restricts data. See @digilog/shared types/panels.ts.
  dashboardCards Json? @map("dashboard_cards") @db.JsonB
```

And to `model UserConfig`, immediately after `instrumentScope`:

```prisma
  /// Which dashboard / trend-page panels this user may SEE, overriding their role.
  /// NULL = inherit; [] = NO panels; [keys] = these panels. Same three states as
  /// role_configs.dashboard_cards, and the empty list must never be read as
  /// inherit.
  dashboardCards Json? @map("dashboard_cards") @db.JsonB
```

- [ ] **Step 2: Generate the diff for review (do NOT let Prisma write the migration)**

Run:
```bash
cd apps/api && npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma --script
```
Expected: two `ALTER TABLE ... ADD COLUMN "dashboard_cards" JSONB` statements. **Strip anything else** — this repo's baseline is a `pg_dump` and the diff routinely emits drops for the partitioned telemetry table, `audit_trail.chain_position`, and FK recreations. See the header of `20260811120000_instrument_floorplans/migration.sql`.

- [ ] **Step 3: Hand-author the migration**

Create `apps/api/prisma/migrations/<UTC-timestamp>_panel_access/migration.sql`:

```sql
-- Panel assignment, per role and per user (2026-08-28).
--
-- Nullable with NO DEFAULT on purpose: NULL means "inherit", and a DEFAULT '[]'
-- would mean "no panels" and would blank every existing role's dashboard the
-- moment this ran.
ALTER TABLE "role_configs" ADD COLUMN "dashboard_cards" JSONB;
ALTER TABLE "user_configs" ADD COLUMN "dashboard_cards" JSONB;

-- Carry over the retiring system_config['dashboard-cards'] per-role map.
--
-- TWO deliberate transformations, both of which preserve what the operator
-- actually had:
--
--  1. The four INERT keys (total_users, audit_trail, notifications,
--     quick_actions) are dropped. They gated dashboard sections that no longer
--     exist, so they never affected what anyone saw.
--
--  2. Every TREND key is ADDED. Before this migration the trend page had no
--     governance at all, so everyone saw all five of its panels. Carrying only
--     the two dashboard keys would silently strip the whole trend page from
--     every role that had a row here — a narrowing nobody asked for, and one
--     that would look like a bug in the new feature rather than in this SQL.
--
-- A role PRESENT in the map but left with no surviving dashboard key becomes
-- '[]' for that half, not NULL: it had a list, and the live cards were off in it.
-- A role ABSENT from the map is left NULL (inherit) and is untouched by this
-- statement.
UPDATE "role_configs" rc
SET "dashboard_cards" =
  COALESCE(
    (
      SELECT jsonb_agg(k)
      FROM jsonb_array_elements_text(sc.config_value -> 'roles' -> rc."role") AS k
      WHERE k IN ('telemetry_table', 'telemetry_floorplan')
    ),
    '[]'::jsonb
  )
  || '["trend_gauges","trend_charts","trend_summary","trend_historian_table","trend_alarms"]'::jsonb
FROM "system_config" sc
WHERE sc.config_key = 'dashboard-cards'
  AND sc.config_value -> 'roles' ? rc."role";

-- The old row is NOT deleted here. It is deleted in the retirement task, after
-- this carry-over has been verified against it — per docs/CONTRIBUTING.md's
-- pre-deletion rule.
```

- [ ] **Step 4: Apply to the dev database and verify the carry-over**

```bash
cd apps/api && npx prisma migrate deploy
npx prisma generate
```

Then check the values landed, comparing against the row still in `system_config`:

```bash
cd apps/api && npx tsx -e "0" 2>/dev/null; node -e "1"   # no-op; use the script below instead
```

Write `apps/api/scripts/verify-panel-migration.ts`:

```ts
import { prisma } from '../src/lib/prisma.js';

async function main() {
  const legacy = await prisma.systemConfig.findUnique({ where: { configKey: 'dashboard-cards' } });
  const roles = (legacy?.configValue as { roles?: Record<string, string[]> })?.roles ?? {};
  const rows = await prisma.roleConfig.findMany({ select: { role: true, dashboardCards: true } });
  const TREND = ['trend_gauges', 'trend_charts', 'trend_summary', 'trend_historian_table', 'trend_alarms'];
  let bad = 0;
  for (const [role, cards] of Object.entries(roles)) {
    const got = rows.find((r) => r.role === role)?.dashboardCards as string[] | null | undefined;
    const want = [...cards.filter((c) => c === 'telemetry_table' || c === 'telemetry_floorplan'), ...TREND];
    const ok = Array.isArray(got) && got.length === want.length && want.every((k) => got.includes(k));
    console.log(`${ok ? 'OK  ' : 'BAD '} ${role}: got ${JSON.stringify(got)}`);
    if (!ok) bad++;
  }
  const untouched = rows.filter((r) => !(r.role in roles) && r.dashboardCards !== null);
  for (const r of untouched) console.log(`BAD ${r.role}: absent from the legacy map but not NULL`);
  console.log(bad + untouched.length === 0 ? 'carry-over VERIFIED' : 'carry-over FAILED');
  await prisma.$disconnect();
}
main();
```

Run: `cd apps/api && npx tsx scripts/verify-panel-migration.ts`
Expected: every role `OK`, ending `carry-over VERIFIED`.

- [ ] **Step 5: Run the drift guard**

Run: `cd /c/Users/hello/compliance-core && powershell -ExecutionPolicy Bypass -Command "npm run db:verify-migrations"`
Expected: PASS. (The `-ExecutionPolicy Bypass` is required on this machine — see the `windows-tooling-gotchas` memory.)

- [ ] **Step 6: Apply to the TEST database**

```bash
cd apps/api && DATABASE_URL="postgresql://digilog:digilog123@localhost:5432/compliance_core_db_test?schema=public" npx prisma migrate deploy
```
Expected: applies the one migration. **A migration applied to only one database makes every instrument-touching e2e 500** — this step is not optional.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/scripts/verify-panel-migration.ts
git commit -m "feat(db): dashboard_cards on role_configs and user_configs"
```

---

### Task 3: Server-side resolution on `my-config`

**Files:**
- Create: `apps/api/src/modules/config/panel-access.ts`
- Create: `apps/api/src/modules/config/__tests__/panel-access.test.ts`
- Modify: `apps/api/src/modules/config/static-routes/roles.routes.ts:176-194` (the `/my-config` route)

**Interfaces:**
- Consumes: `resolvePanels`, `normalizePanels` from `@digilog/shared` (Task 1); `role_configs.dashboardCards` / `user_configs.dashboardCards` (Task 2).
- Produces: `resolvePanelsFor(username: string): Promise<string[] | null>` — `null` means every panel.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/config/__tests__/panel-access.test.ts
import { describe, it, expect } from 'vitest';
import { pickPanels } from '../panel-access.js';

/**
 * `pickPanels` is the pure half of the resolver — the database read lives in
 * `resolvePanelsFor`. Split so the rule is testable without a database, exactly as
 * `visibility.ts` splits `effectiveScope` from `resolveVisibility`.
 */
describe('pickPanels', () => {
  it('reads a stored user list, overriding the role', () => {
    expect(pickPanels('OPERATOR', ['trend_charts'], ['trend_alarms'])).toEqual(['trend_alarms']);
  });

  it('treats a stored EMPTY user list as NO panels, not as inherit', () => {
    expect(pickPanels('OPERATOR', ['trend_charts'], [])).toEqual([]);
  });

  it('treats a malformed stored value as inherit rather than as deny', () => {
    expect(pickPanels('OPERATOR', 'nonsense', null)).toBeNull();
  });

  it('drops keys that are no longer in the catalogue', () => {
    expect(pickPanels('OPERATOR', ['trend_charts', 'total_users'], null)).toEqual(['trend_charts']);
  });

  it('gives SUPER_ADMIN every panel whatever is stored', () => {
    expect(pickPanels('SUPER_ADMIN', [], [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/config/__tests__/panel-access.test.ts`
Expected: FAIL — `Cannot find module '../panel-access.js'`

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/config/panel-access.ts
import { prisma } from '../../lib/prisma.js';
import { normalizePanels, resolvePanels } from '@digilog/shared';

/**
 * Which panels a user may see.
 *
 * The rule is resolved ONCE, here, and shipped on `/api/config/my-config`. The
 * browser applies the resulting list to its layout but never re-derives the
 * inherit/none/these resolution — that is a policy decision, and this repo has
 * been bitten before by a client that recomputed one.
 *
 * Note the deliberate difference from `configService.getMyConfig` a few lines
 * away, which decides whether a user config wins by testing
 * `sidebarItems.length > 0`. An empty panel list means NO PANELS and must not fall
 * through to the role. Do not unify these two rules.
 */

/** The pure half: no database, so the rule itself is testable in isolation. */
export function pickPanels(
  userRole: string,
  storedRole: unknown,
  storedUser: unknown,
): string[] | null {
  return resolvePanels(userRole, normalizePanels(storedRole), normalizePanels(storedUser));
}

/** `null` = every panel. */
export async function resolvePanelsFor(username: string): Promise<string[] | null> {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, role: true },
  });
  if (!user) return null;
  if (user.role === 'SUPER_ADMIN') return null;

  const [userCfg, roleCfg] = await Promise.all([
    prisma.userConfig.findUnique({ where: { userId: user.id }, select: { dashboardCards: true } }),
    prisma.roleConfig.findUnique({ where: { role: user.role }, select: { dashboardCards: true } }),
  ]);
  return pickPanels(user.role, roleCfg?.dashboardCards, userCfg?.dashboardCards);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/config/__tests__/panel-access.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Ship it on `/my-config`**

In `apps/api/src/modules/config/static-routes/roles.routes.ts`, import at the top:

```ts
import { resolvePanelsFor } from '../panel-access.js';
```

Replace the `/my-config` response schema's `properties` block and handler with:

```ts
        200: {
          type: 'object',
          properties: {
            sidebarItems: { type: 'array', items: { type: 'string' } },
            homeWidgets: { type: 'array', items: { type: 'string' } },
            permissions: { type: 'object', additionalProperties: true },
            // null = every panel. Fastify STRIPS any field absent from this block,
            // silently, so a field added to the handler without a line here never
            // reaches the wire.
            panels: { type: 'array', items: { type: 'string' }, nullable: true },
          },
        },
```

```ts
  }, async (req) => {
    const [config, panels] = await Promise.all([
      configService.getMyConfig(req.user.username),
      resolvePanelsFor(req.user.username),
    ]);
    return { ...config, panels };
  });
```

- [ ] **Step 6: Typecheck and run the config suites**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json && npx vitest run --pool=forks --poolOptions.forks.singleFork=true src/modules/config src/e2e/config.test.ts`
Expected: tsc silent; suites pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/config/panel-access.ts apps/api/src/modules/config/__tests__/panel-access.test.ts apps/api/src/modules/config/static-routes/roles.routes.ts
git commit -m "feat(api): resolve assignable panels on my-config"
```

---

### Task 4: The admin API

**Files:**
- Modify: `apps/api/src/modules/roles/routes.ts` (add three routes beside the instrument-scope block, which begins at the `// ─── Instrument visibility scope (project D) ───` comment)
- Create: `apps/api/src/e2e/panel-access.test.ts`

**Interfaces:**
- Consumes: `PANEL_KEYS`, `normalizePanels` from `@digilog/shared`; `resolvePanelsFor` (Task 3).
- Produces: `GET /api/roles/panel-access`, `PUT /api/roles/panel-access/role/:name`, `PUT /api/roles/panel-access/user/:userId`.

- [ ] **Step 1: Write the failing e2e**

```ts
// apps/api/src/e2e/panel-access.test.ts
/**
 * Panel assignment, per role and per user.
 *
 * Driven through the seeded OPERATOR over HTTP, never through the resolver
 * directly: SUPER_ADMIN short-circuits to "every panel", so an admin-driven
 * version of these assertions would pass against a route with no resolution at
 * all. Every restricted case is paired with a positive control.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

let app: FastifyInstance;
let auth: Record<string, string>;
let operator: Record<string, string>;
let operatorId = '';
const reauth = { 'x-reauth-password': 'Admin@123' };

/** The panels the seeded OPERATOR resolves to right now. */
async function myPanels(): Promise<string[] | null> {
  const res = await app.inject({ method: 'GET', url: '/api/config/my-config', headers: operator });
  expect(res.statusCode).toBe(200);
  return (res.json() as { panels: string[] | null }).panels;
}

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
  operatorId = (await prisma.user.findUniqueOrThrow({ where: { username: 'RB0001' }, select: { id: true } })).id;
});

afterAll(async () => {
  await prisma.roleConfig.updateMany({ where: { role: 'OPERATOR' }, data: { dashboardCards: Prisma.DbNull } });
  await prisma.userConfig.updateMany({ where: { userId: operatorId }, data: { dashboardCards: Prisma.DbNull } });
  await app.close();
});

describe('panel assignment', () => {
  it('resolves to every panel when nothing is stored', async () => {
    expect(await myPanels()).toBeNull();
  });

  it('applies a role list', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/roles/panel-access/role/OPERATOR',
      headers: { ...auth, ...reauth }, payload: { panels: ['trend_charts'] },
    });
    expect(res.statusCode).toBe(200);
    expect(await myPanels()).toEqual(['trend_charts']);
  });

  it('lets a user override REPLACE the role list, widening it', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/roles/panel-access/user/${operatorId}`,
      headers: { ...auth, ...reauth }, payload: { panels: ['trend_charts', 'trend_alarms'] },
    });
    expect(res.statusCode).toBe(200);
    expect(await myPanels()).toEqual(['trend_charts', 'trend_alarms']);
  });

  it('treats an EMPTY user list as NO panels, never as inherit', async () => {
    // The load-bearing case. If this ever returns the role's list, a deliberate
    // deny has become a grant.
    const res = await app.inject({
      method: 'PUT', url: `/api/roles/panel-access/user/${operatorId}`,
      headers: { ...auth, ...reauth }, payload: { panels: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(await myPanels()).toEqual([]);
  });

  it('writes a real SQL NULL for "all panels", not the JSON value null', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/api/roles/panel-access/user/${operatorId}`,
      headers: { ...auth, ...reauth }, payload: { panels: null },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await prisma.$queryRaw<{ isNull: boolean }[]>`
      SELECT dashboard_cards IS NULL AS "isNull" FROM user_configs WHERE user_id = ${operatorId}::uuid`;
    expect(row.isNull).toBe(true);
    // And it now inherits the role again, which proves the override was what did it.
    expect(await myPanels()).toEqual(['trend_charts']);
  });

  it('rejects a key that is not in the catalogue', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/roles/panel-access/role/OPERATOR',
      headers: { ...auth, ...reauth }, payload: { panels: ['total_users'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('audits both writes, naming the count', async () => {
    await app.inject({
      method: 'PUT', url: '/api/roles/panel-access/role/OPERATOR',
      headers: { ...auth, ...reauth }, payload: { panels: ['trend_charts', 'trend_alarms'] },
    });
    const row = await prisma.auditTrail.findFirst({
      where: { targetType: 'role_config', targetId: 'OPERATOR' },
      orderBy: { timestamp: 'desc' }, select: { signatureMeaning: true },
    });
    expect(row?.signatureMeaning).toContain('2 of 7');
  });

  it('lists every role and every user override', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/roles/panel-access', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { roles: { role: string; panels: string[] | null }[]; users: { userId: string }[] };
    expect(body.roles.find((r) => r.role === 'OPERATOR')!.panels).toEqual(['trend_charts', 'trend_alarms']);
    expect(body.users.some((u) => u.userId === operatorId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true src/e2e/panel-access.test.ts`
Expected: FAIL — 404 on the PUT routes.

- [ ] **Step 3: Add the routes**

In `apps/api/src/modules/roles/routes.ts`, extend the existing shared import:

```ts
import {
  ATTRIBUTE_ACCESS_MODES,
  PANELS,
  PANEL_KEYS,
  normalizePanels,
  parseAttributeAccess,
  parseInstrumentAttributeKeys,
} from '@digilog/shared';
```

Then, immediately after the instrument-scope user PUT (the last route before the closing brace of `roleRoutes`), add:

```ts
  // ─── Panel assignment (2026-08-28) ────────────────────────────────────────
  //
  // Same module, permission, reauth action and audit action as instrument scope
  // above, deliberately: panels and instruments are assigned on one screen, so a
  // second set of conventions would make "why does this user see nothing?" have
  // two answers.
  //
  // A hidden panel is a DISPLAY decision, NOT an access control — it does not stop
  // the data being fetched. instrument_scope is what restricts data.

  const panelsShape = {
    type: 'array',
    nullable: true,
    items: { type: 'string', enum: [...PANEL_KEYS] },
  } as const;

  /** Bounded: `signature_meaning` is VARCHAR(255) and auditLog does not truncate. */
  const describePanels = (panels: string[] | null) =>
    panels === null ? 'ALL panels' : panels.length === 0 ? 'NO panels' : `${panels.length} of ${PANELS.length}`;

  app.get('/panel-access', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Panel assignment for every role and every user override',
      response: {
        200: {
          type: 'object',
          properties: {
            roles: {
              type: 'array',
              items: { type: 'object', properties: { role: { type: 'string' }, panels: panelsShape } },
            },
            users: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  userId: { type: 'string' },
                  username: { type: 'string' },
                  fullName: { type: 'string', nullable: true },
                  role: { type: 'string' },
                  panels: panelsShape,
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const [roles, roleCfgs, users, userCfgs] = await Promise.all([
      prisma.role.findMany({ where: { isActive: true }, select: { name: true }, orderBy: { name: 'asc' } }),
      prisma.roleConfig.findMany({ select: { role: true, dashboardCards: true } }),
      prisma.user.findMany({ select: { id: true, username: true, fullName: true, role: true }, orderBy: { username: 'asc' } }),
      prisma.userConfig.findMany({ select: { userId: true, dashboardCards: true } }),
    ]);
    const byRole = new Map(roleCfgs.map((c) => [c.role, c.dashboardCards]));
    const byUser = new Map(userCfgs.map((c) => [c.userId, c.dashboardCards]));
    // normalizePanels, never a local Array.isArray: this endpoint feeds the admin
    // screen, and a stored row read as "nothing set" would render as "All panels"
    // beside a role that is in fact restricted — and then be saved back that way.
    const read = (v: unknown) => normalizePanels(v) ?? null;
    return {
      roles: roles.map((r) => ({ role: r.name, panels: read(byRole.get(r.name)) })),
      users: users.map((u) => ({
        userId: u.id, username: u.username, fullName: u.fullName, role: u.role,
        panels: read(byUser.get(u.id)),
      })),
    };
  });

  app.put('/panel-access/role/:name', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Set a role\'s assignable panels',
      params: { type: 'object', properties: { name: { type: 'string' } } },
      body: { type: 'object', properties: { panels: panelsShape } },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE_CONFIG', req, reply);
    if (!ok) return;
    const { name } = req.params as { name: string };
    const { panels } = req.body as { panels: string[] | null };
    const ctx = buildContext(req);

    const before = await prisma.roleConfig.findUnique({ where: { role: name }, select: { dashboardCards: true } });
    await prisma.roleConfig.upsert({
      where: { role: name },
      // Prisma.DbNull writes a real SQL NULL. JsonNull would store the JSON value
      // `null`, a DIFFERENT thing — and this feature rests on NULL (inherit) being
      // distinguishable from [] (no panels).
      create: { role: name, dashboardCards: (panels as Prisma.InputJsonValue | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
      update: { dashboardCards: (panels as Prisma.InputJsonValue | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'CONFIG_CHANGED',
      targetType: 'role_config', targetId: name,
      beforeValue: { dashboardCards: before?.dashboardCards ?? null },
      afterValue: { dashboardCards: panels },
      signatureMeaning: `Role "${name.slice(0, 60)}" panels set to ${describePanels(panels)}`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return { role: name, panels };
  });

  app.put('/panel-access/user/:userId', {
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Roles'],
      summary: 'Set one user\'s assignable panels, overriding their role',
      params: { type: 'object', properties: { userId: { type: 'string' } } },
      body: { type: 'object', properties: { panels: panelsShape } },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_ROLE_CONFIG', req, reply);
    if (!ok) return;
    const { userId } = req.params as { userId: string };
    const { panels } = req.body as { panels: string[] | null };
    const ctx = buildContext(req);

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, role: true } });
    if (!user) return reply.code(404).send({ error: 'NOT_FOUND', message: 'User not found.' });

    const before = await prisma.userConfig.findUnique({ where: { userId }, select: { dashboardCards: true } });
    await prisma.userConfig.upsert({
      where: { userId },
      create: { userId, dashboardCards: (panels as Prisma.InputJsonValue | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
      update: { dashboardCards: (panels as Prisma.InputJsonValue | null) ?? Prisma.DbNull, updatedBy: ctx.userId },
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'CONFIG_CHANGED',
      targetType: 'user_config', targetId: userId,
      beforeValue: { dashboardCards: before?.dashboardCards ?? null },
      afterValue: { dashboardCards: panels },
      // An override REPLACES the role's list and can therefore WIDEN it, so the
      // signature names the user and what they were given, not just "changed".
      signatureMeaning: panels === null
        ? `User "${user.username.slice(0, 60)}" panels reset to inherit role "${user.role.slice(0, 60)}"`
        : `User "${user.username.slice(0, 60)}" panels overridden to ${describePanels(panels)}`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return { userId, panels };
  });
```

- [ ] **Step 4: Run the e2e and typecheck**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json && npx vitest run --pool=forks --poolOptions.forks.singleFork=true src/e2e/panel-access.test.ts src/e2e/roles.test.ts`
Expected: tsc silent; 8 new tests pass; `roles.test.ts` unaffected.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/roles/routes.ts apps/api/src/e2e/panel-access.test.ts
git commit -m "feat(api): panel assignment endpoints, per role and per user"
```

---

### Task 5: The admin UI — a Panels tab

**Files:**
- Create: `apps/web/src/routes/config/roles-components/panel-access-tab.tsx`
- Modify: `apps/web/src/routes/config/role-access.tsx` (add `'panels'` to `TabId` at line 24, a tab entry at line 132, and the render line at 282)

**Interfaces:**
- Consumes: `GET/PUT /api/roles/panel-access*` (Task 4); `PANELS`, `PANEL_PAGES` from `@digilog/shared`.
- Produces: `PanelAccessTab` component.

- [ ] **Step 1: Write the tab**

```tsx
// apps/web/src/routes/config/roles-components/panel-access-tab.tsx
import { useState } from 'react';
import useSWR from 'swr';
import { PANELS, PANEL_PAGES } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';

interface RolePanels { role: string; panels: string[] | null }
interface UserPanels { userId: string; username: string; fullName: string | null; role: string; panels: string[] | null }

const ALL_KEYS = PANELS.map((p) => p.key);

const toggle = (list: string[], key: string, on: boolean) =>
  on ? [...list, key] : list.filter((k) => k !== key);

/**
 * The panel checklist, grouped by page. Declared at module scope, NOT inside the
 * tab: a component defined during render is a new type every render, so React
 * remounts it and discards a half-finished selection whenever SWR revalidates.
 */
function PanelPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  return (
    <div className="mt-2 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 md:grid-cols-2">
      {PANEL_PAGES.map(({ page, label }) => (
        <div key={page}>
          <p className="pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
          <div className="space-y-1">
            {PANELS.filter((p) => p.page === page).map((p) => (
              <label key={p.key} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={value.includes(p.key)}
                  onChange={(e) => onChange(toggle(value, p.key, e.target.checked))}
                />
                <span>
                  <span className="font-medium">{p.label}</span>
                  <span className="block text-xs text-slate-500">{p.description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PanelEditor({
  busy, current, inheritFrom, onSave,
}: {
  busy: boolean;
  current: string[] | null;
  inheritFrom?: string | null;
  onSave: (next: string[] | null) => void;
}) {
  const [limited, setLimited] = useState(current !== null);
  const [picked, setPicked] = useState<string[]>(current ?? ALL_KEYS);
  const unlimitedLabel = inheritFrom !== undefined ? 'Inherit role' : 'All panels';

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={!limited} onChange={() => setLimited(false)} />
          <span>{unlimitedLabel}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={limited} onChange={() => setLimited(true)} />
          <span>Only selected panels</span>
        </label>
        <Button className="ml-auto" disabled={busy} onClick={() => onSave(limited ? picked : null)}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {limited && <PanelPicker value={picked} onChange={setPicked} />}
      {limited && picked.length === 0 && (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Nothing selected — this shows <strong>no panels at all</strong>. Choose “{unlimitedLabel}”
          instead if that is not what you mean.
        </p>
      )}
    </div>
  );
}

/**
 * Panel assignment, per role and per user.
 *
 * THREE STATES, kept distinguishable because collapsing them turns a deny into a
 * grant: null = inherit, [] = no panels, [keys] = these panels. Identical to
 * Instrument Scope beside it.
 */
export function PanelAccessTab() {
  const { toast } = useToast();
  const { data, mutate } = useSWR<{ roles: RolePanels[]; users: UserPanels[] }>('/api/roles/panel-access');
  const [saving, setSaving] = useState<string | null>(null);

  const describe = (panels: string[] | null, inheritFrom?: string | null) => {
    if (panels === null) {
      return inheritFrom !== undefined ? `Inherits role${inheritFrom ? ` (${inheritFrom})` : ''}` : 'All panels';
    }
    if (panels.length === 0) return 'No panels';
    return panels.map((k) => PANELS.find((p) => p.key === k)?.label ?? k).join(', ');
  };

  const save = async (kind: 'role' | 'user', key: string, panels: string[] | null) => {
    setSaving(`${kind}:${key}`);
    try {
      await apiClient.put(`/api/roles/panel-access/${kind}/${encodeURIComponent(key)}`, { panels });
      toast.success('Panels updated', panels === null
        ? (kind === 'role' ? 'Sees all panels.' : 'Now inherits the role.')
        : panels.length === 0 ? 'Sees no panels.' : `Limited to ${panels.length} panel(s).`);
      await mutate();
    } catch (e) {
      toast.error('Could not save', (e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-6">
      {/*
        Stated on the screen, not just in the design doc. An admin who hides the
        alarms widget believing they have withheld alarm data has been misled by
        this UI, and that is the failure this feature can most easily cause.
      */}
      <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
        Hiding a panel changes what is <strong>shown</strong>, not what a user may reach. It does not
        withhold data from the API. Use <strong>Instrument Scope</strong> to restrict which
        instruments and readings a user can access.
      </p>

      <div>
        <h3 className="text-sm font-semibold text-slate-800">Per role</h3>
        <p className="mt-0.5 text-xs text-slate-500">Super Admin always sees every panel and is not listed.</p>
        <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {(data?.roles ?? []).filter((r) => r.role !== 'SUPER_ADMIN').map((r) => (
            <div key={r.role} className="p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-semibold text-slate-800">{r.role}</span>
                <span className="text-xs text-slate-500">currently: {describe(r.panels)}</span>
              </div>
              <PanelEditor
                key={JSON.stringify(r.panels)}
                busy={saving === `role:${r.role}`}
                current={r.panels}
                onSave={(p) => save('role', r.role, p)}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-800">Per user — overrides their role</h3>
        <p className="mt-0.5 text-xs text-slate-500">
          An override replaces the role’s list, so it can grant more as well as less.
        </p>
        <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {(data?.users ?? []).filter((u) => u.role !== 'SUPER_ADMIN').map((u) => {
            const rolePanels = data?.roles.find((r) => r.role === u.role)?.panels ?? null;
            return (
              <div key={u.userId} className="p-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold text-slate-800">{u.username}</span>
                  {u.fullName && <span className="text-xs text-slate-500">{u.fullName}</span>}
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">{u.role}</span>
                  <span className="text-xs text-slate-500">
                    currently: {describe(u.panels, u.panels === null ? u.role : undefined)}
                    {' · '}role default: {describe(rolePanels)}
                  </span>
                </div>
                <PanelEditor
                  key={JSON.stringify(u.panels)}
                  busy={saving === `user:${u.userId}`}
                  current={u.panels}
                  inheritFrom={u.role}
                  onSave={(p) => save('user', u.userId, p)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Register the tab**

In `apps/web/src/routes/config/role-access.tsx`:

Line 20 area — add the import:
```tsx
import { PanelAccessTab } from './roles-components/panel-access-tab';
```

Line 24 — extend the union:
```tsx
type TabId = 'roles' | 'permissions' | 'sidebar' | 'reauth' | 'instrument-scope' | 'attribute-access' | 'panels';
```

In the `tabs` array (line 126-133), add after the `instrument-scope` entry:
```tsx
    { id: 'panels', label: 'Panels', icon: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v4H4V5zm0 6h6v8H5a1 1 0 01-1-1v-7zm8 0h8v7a1 1 0 01-1 1h-7v-8z' },
```

After line 282's `instrument-scope` render, add:
```tsx
      {activeTab === 'panels' && <PanelAccessTab />}
```

- [ ] **Step 3: Typecheck and run the web suite**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: tsc silent; the existing 794 tests still pass.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/config/roles-components/panel-access-tab.tsx apps/web/src/routes/config/role-access.tsx
git commit -m "feat(web): Panels tab on Roles & Access"
```

---

### Task 6: Apply the resolution on the dashboard

**Files:**
- Create: `apps/web/src/hooks/use-panels.ts`
- Create: `apps/web/src/hooks/__tests__/use-panels.test.ts`
- Modify: `apps/web/src/routes/dashboard/index.tsx:48-53` (replace the `dashboard-cards` fetch)

**Interfaces:**
- Consumes: `panels` on `/api/config/my-config` (Task 3); `panelVisible` from `@digilog/shared`.
- Produces: `usePanels(): { showPanel: (key: string) => boolean; loaded: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/hooks/__tests__/use-panels.test.ts
import { describe, it, expect } from 'vitest';
import { showPanelFrom } from '../use-panels';

/**
 * The pure half of the hook. The hook itself is one SWR call; this is the rule,
 * and the rule is what can be wrong.
 */
describe('showPanelFrom', () => {
  it('shows everything while the config is still loading', () => {
    // Deliberate: flashing the panels away and back on every page load is worse
    // than a moment of over-showing, and the alternative — hiding everything until
    // the fetch lands — makes a slow network look like a broken dashboard.
    expect(showPanelFrom(undefined, 'trend_charts')).toBe(true);
  });

  it('shows everything when the resolution is null', () => {
    expect(showPanelFrom(null, 'trend_charts')).toBe(true);
  });

  it('shows nothing when the list is empty', () => {
    expect(showPanelFrom([], 'trend_charts')).toBe(false);
  });

  it('shows only listed panels', () => {
    expect(showPanelFrom(['trend_charts'], 'trend_charts')).toBe(true);
    expect(showPanelFrom(['trend_charts'], 'trend_alarms')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/hooks/__tests__/use-panels.test.ts`
Expected: FAIL — cannot resolve `../use-panels`.

- [ ] **Step 3: Write the hook**

```ts
// apps/web/src/hooks/use-panels.ts
import useSWR from 'swr';
import { panelVisible } from '@digilog/shared';

/**
 * Which panels this user may see.
 *
 * The RESOLUTION (inherit → role → user, and SUPER_ADMIN's bypass) happens on the
 * server and rides on `/api/config/my-config`. Nothing here re-derives it — that
 * is a policy decision, and this repo has been bitten before by a client that
 * recomputed one and drifted from the server.
 *
 * Applying the resulting list to the layout IS this file's job, and is correct
 * here: hiding a panel is a display decision, not an access control. The data
 * behind a hidden panel is still reachable from the API; `instrument_scope` is
 * what restricts it.
 */

/** `undefined` = not loaded yet. `null` = every panel. */
export function showPanelFrom(panels: string[] | null | undefined, key: string): boolean {
  if (panels === undefined) return true;
  return panelVisible(panels, key);
}

export function usePanels() {
  const { data } = useSWR<{ panels?: string[] | null }>('/api/config/my-config');
  const panels = data === undefined ? undefined : data.panels ?? null;
  return {
    showPanel: (key: string) => showPanelFrom(panels, key),
    loaded: data !== undefined,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/web && npx vitest run src/hooks/__tests__/use-panels.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Use it on the dashboard**

In `apps/web/src/routes/dashboard/index.tsx`, delete lines 48-53 (the `cardConfig` SWR call, the `visibleCards` memo and the `showCard` helper) and replace with:

```tsx
  // Panel assignment, resolved server-side and shipped on my-config. Replaces the
  // old per-role `dashboard-cards` fetch, which had no per-user layer and which
  // resolved the role lookup in the browser.
  const { showPanel } = usePanels();
```

Add the import at the top:
```tsx
import { usePanels } from '@/hooks/use-panels';
```

Then replace every `showCard(` with `showPanel(` — lines 190, 198, 210, 225, 228. Also remove the now-inaccurate paragraph at lines 30-34 of the file header comment (the one describing the four inert keys) and replace it with:

```
 * Panel visibility comes from `usePanels()` — resolved server-side per role and
 * per user, see @digilog/shared types/panels.ts. The four inert keys that used to
 * be listed here (total_users, audit_trail, notifications, quick_actions) were
 * retired with that change.
```

- [ ] **Step 6: Typecheck and run the web suite**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: tsc silent; suite green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/hooks/use-panels.ts apps/web/src/hooks/__tests__/use-panels.test.ts apps/web/src/routes/dashboard/index.tsx
git commit -m "feat(web): dashboard honours per-user panel assignment"
```

---

### Task 7: Apply the resolution on the trend page

**Files:**
- Modify: `apps/web/src/routes/instruments/trend.tsx`

**Interfaces:**
- Consumes: `usePanels()` (Task 6).
- Produces: nothing.

- [ ] **Step 1: Wire the hook in**

Add the import beside the other hook imports:
```tsx
import { usePanels } from '@/hooks/use-panels';
```

Inside the page component, beside the other hooks:
```tsx
  // Panel assignment. Hiding a panel here changes what is SHOWN — the readings
  // behind it are still reachable from the API, and instrument_scope is what
  // restricts them.
  const { showPanel } = usePanels();
```

- [ ] **Step 2: Gate each panel at its existing anchor**

Wrap each of these five regions in a `{showPanel('<key>') && ( … )}` guard. The anchors, as of this change:

| Key | Anchor |
|---|---|
| `trend_gauges` | the `<BandGauge …>` pair around lines 858 and 870, plus their `GaugeSkeleton` loading branch around 887 |
| `trend_charts` | the `<h2>Charts</h2>` heading at line 901 and the chart block beneath it |
| `trend_summary` | each `<ChartSummaryStrip …>` at lines 939, 973 and 1033 |
| `trend_historian_table` | the card whose `CardTitle` is `Time series (raw readings)` at line 1051 |
| `trend_alarms` | the card whose `CardTitle` is `Alarms in this period` at line 298 |

Pattern, using the historian table as the worked example:

```tsx
      {showPanel('trend_historian_table') && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Time series (raw readings)</CardTitle>
          </CardHeader>
          {/* …unchanged… */}
        </Card>
      )}
```

**Do not gate the data fetching.** `use-trend-data.ts` stays exactly as it is: the PDF report reads the same data, and a hidden panel must not change what a signed §11 report contains. Gate rendering only.

- [ ] **Step 3: Verify the report is unaffected**

Run: `cd apps/web && npx vitest run src/routes/instruments/__tests__`
Expected: PASS — in particular the trend-report and trend-summary tests, which must not change behaviour.

- [ ] **Step 4: Typecheck and full web suite**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: tsc silent; suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/instruments/trend.tsx
git commit -m "feat(web): trend page honours panel assignment"
```

---

### Task 8: Retire the old surface, and sync the docs

**Files:**
- Delete: `apps/api/src/modules/config/static-routes/dashboard-cards.routes.ts`
- Delete: `apps/web/src/routes/config/dashboard-cards.tsx`
- Modify: the static-routes registration that imports `dashboardCardsRoutes`
- Modify: `apps/web/src/routes/config/appearance.tsx` (drop the Dashboard Cards sub-editor)
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `apps/api/CLAUDE.md`, `apps/web/CLAUDE.md`

- [ ] **Step 1: Read both files for unique knowledge before deleting**

Run: `cd /c/Users/hello/compliance-core && cat apps/api/src/modules/config/static-routes/dashboard-cards.routes.ts apps/web/src/routes/config/dashboard-cards.tsx`

The knowledge to carry is `VALID_CARD_KEYS` and the `ALL_CARDS` labels — both already in `@digilog/shared/types/panels.ts` from Task 1. Confirm that before deleting; `docs/CONTRIBUTING.md`'s pre-deletion rule exists because a bulk delete here was reverted twice.

- [ ] **Step 2: Confirm the carry-over one last time, then drop the legacy row**

Run: `cd apps/api && npx tsx scripts/verify-panel-migration.ts`
Expected: `carry-over VERIFIED`.

Then:
```bash
cd apps/api && npx tsx -e "1" >/dev/null 2>&1 || true
```
Write and run `apps/api/scripts/drop-legacy-dashboard-cards.ts`:

```ts
import { prisma } from '../src/lib/prisma.js';

async function main() {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'dashboard-cards' } });
  if (!row) { console.log('already gone'); return prisma.$disconnect(); }
  console.log('deleting system_config row, final value was:', JSON.stringify(row.configValue));
  await prisma.systemConfig.delete({ where: { configKey: 'dashboard-cards' } });
  console.log('deleted 1 row');
  await prisma.$disconnect();
}
main();
```

Run it against BOTH databases (dev, then test with `DATABASE_URL` overridden).

- [ ] **Step 3: Delete the files and their registrations**

```bash
git rm apps/api/src/modules/config/static-routes/dashboard-cards.routes.ts
git rm apps/web/src/routes/config/dashboard-cards.tsx
```

Remove the `dashboardCardsRoutes` import and its registration call (find with `grep -rn dashboardCardsRoutes apps/api/src`), and remove the Dashboard Cards import and its rendering from `apps/web/src/routes/config/appearance.tsx`.

- [ ] **Step 4: Re-derive every count the docs quote**

```bash
cd /c/Users/hello/compliance-core
grep -cE "^model " apps/api/prisma/schema.prisma
grep -cE "^enum " apps/api/prisma/schema.prisma
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts
grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts
ls apps/api/src/modules/ | wc -l
ls apps/api/src/modules/config/defs/*.def.ts | wc -l
ls apps/web/src/routes/config/*.tsx | wc -l
grep -cE "<Route" apps/web/src/main.tsx
```

Expected: models **36**, enums **13**, permissions **42**, reauth actions **48**, modules **24**, defs **25**, config pages **24** (was 25 — `dashboard-cards.tsx` deleted), routes **50**. Update `CLAUDE.md`, `apps/api/CLAUDE.md` and `apps/web/CLAUDE.md` wherever the config-page count appears, and run the stale-stat sweep: `grep -rn "25 corresponding pages\|25\*\* corresponding" --include=*.md .`

- [ ] **Step 5: Write the CHANGELOG entry**

Prepend to `CHANGELOG.md` under `# Changelog`, covering: the two new columns and the migration; the one shared catalogue replacing two hand-synced copies; the four retired inert keys; the three-state rule and its deliberate divergence from `sidebarItems`; the display-not-access-control boundary and the banner that states it; the retirement of the old page and route; and the count that moved (config pages 25 → 24).

- [ ] **Step 6: Full verification**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json && npm test
cd ../web && npx tsc --noEmit -p tsconfig.json && npx vitest run
cd ../../packages/shared && npx vitest run
```
Expected: all green. `npm test` in `apps/api` is already wired to the required single-fork invocation.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: retire the per-role dashboard-cards surface"
```

---

## Self-review notes

- **Spec coverage.** Storage decision → Task 2. Catalogue → Task 1. Three states → Tasks 1, 3, 4, 5 (asserted in each). SUPER_ADMIN bypass → Tasks 1, 3. Resolution on `my-config` → Task 3. API → Task 4. Admin surface + the display-not-access banner → Task 5. Applying it → Tasks 6 and 7. Retirement + docs + counts → Task 8. Testing section → the test steps in every task.
- **Type consistency.** `normalizePanels` / `resolvePanels` / `panelVisible` / `pickPanels` / `resolvePanelsFor` / `showPanelFrom` / `usePanels` are each defined once and referenced by those exact names downstream. The column is `dashboardCards` in Prisma and `dashboard_cards` in SQL throughout.
- **Known risk, called out rather than papered over:** the migration hardcodes the panel keys because SQL cannot import the catalogue. Task 1's frozen-key test and Task 2's `verify-panel-migration.ts` are the two guards that keep them from drifting apart.
