# Data Injection Layer — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the configuration backbone of the Data Injection Layer — hierarchy, gateways, instruments, communication profiles, and UNS topic derivation — fully wired into the existing RBAC and audit trail, with no protocol adapter and no broker.

**Architecture:** Four new Fastify modules following the existing `modules/<name>/routes.ts` convention, backed by 7 new Prisma models. Location hierarchy uses a PostgreSQL `ltree` materialised path (the extension is already installed), accessed through a thin raw-SQL repository because Prisma maps `ltree` to `Unsupported()`. UNS topics are **derived on read** from the hierarchy path; only per-instrument overrides are stored. Every mutation writes a hash-chained audit row in the same transaction.

**Tech Stack:** Fastify 5, Prisma 6, PostgreSQL 18 (+ `ltree`, `pgcrypto`), React 19, Vite 6, SWR, Tailwind v4, react-hook-form + Zod, vitest.

**Spec:** `docs/superpowers/specs/2026-08-01-data-injection-p1-foundation-design.md`

## Global Constraints

- **Audit boundary (spec D1):** configuration changes are audited; telemetry is not. P1 is entirely configuration, so **every mutating route in this plan writes an audit row**.
- **`auditLog` must receive `userId`** — it throws at runtime otherwise (`apps/api/src/lib/audit.ts:100`). Always pass `ctx.userId`.
- **Migrations are hand-authored.** `prisma db push` and `prisma migrate dev` auto-generation are **forbidden** against a populated database — they can silently drop audit data. `npm run db:verify-migrations` must PASS before any schema commit.
- **`PERMISSION_TREE` is the single source of truth.** `FEATURE_PRIVILEGES`, `FEATURE_TO_PERMISSION_MAP`, `SIDEBAR_PRIVILEGE_MAP` are derived. The frozen snapshot test must be regenerated in the same commit as any tree change.
- **`gate` ≠ `permissions`.** `gate` is the discriminating backend permission. `permissions` is the grant-expansion set including read dependencies. **Never OR over `permissions` as an auth check** — that is the historical `ASSET_*` privilege leak.
- **All text input is HTML-stripped** via `lib/sanitize.ts` before persistence.
- **Secrets never round-trip.** `CommunicationProfile.config` goes through `lib/mask-secrets.ts` on every read, and the masked form is what lands in audit diffs.
- **Light theme only.** No dark-mode styling. `bg-white`, `bg-slate-50`, `border-slate-200`.
- **Tests run single-fork:** `cd apps/api && npm test`. Multi-fork causes shared-`admin`-user races that are not real bugs.
- **New test files provision their own uniquely-named user** in `beforeAll` rather than reusing the shared `admin`.
- Target counts on completion: **30 models, 8 enums, 22 API modules, 46 permissions, 51 reauth actions, 9 sidebar groups, 10 sidebar items, 44 frontend routes, 22 config surfaces.**
- **CI baseline is a documented ratchet, not a fudge.** The `BASELINE` constant must carry a comment naming each failing suite and why it is Phase 0 domain-strip debt. It may only ever be lowered. This is the agreed resolution of the tension with the project rule against hardcoding values to make tests pass: the gate exists to fail on *new* breakage, and the baseline is the thing being ratcheted away.

---

## File Structure

**Created — backend**
```
apps/api/src/modules/hierarchy/routes.ts                  HTTP surface for hierarchy nodes
apps/api/src/modules/hierarchy/hierarchy.repository.ts    ALL raw ltree SQL lives here, nowhere else
apps/api/src/modules/hierarchy/__tests__/hierarchy.repository.test.ts
apps/api/src/modules/communication-profiles/routes.ts     profile CRUD + protocol registry
apps/api/src/modules/gateways/routes.ts                   gateway CRUD
apps/api/src/modules/instruments/routes.ts                instrument CRUD + topic endpoints
apps/api/src/modules/instruments/topic-resolver.ts        pure derivation function
apps/api/src/modules/instruments/__tests__/topic-resolver.test.ts
apps/api/src/modules/config/defs/uns-settings.def.ts      22nd config surface
apps/api/src/e2e/data-injection.test.ts                   end-to-end: create → derive → audit
apps/api/src/e2e/route-parity.test.ts                     frontend↔backend contract
```

**Created — shared / frontend / CI**
```
packages/shared/src/types/data-injection.ts               Zod schemas + shared enums
apps/web/src/routes/data-injection/index.tsx              dashboard
apps/web/src/routes/data-injection/hierarchy.tsx          tree
apps/web/src/routes/data-injection/gateways.tsx           list + detail
apps/web/src/routes/data-injection/instruments.tsx        list
apps/web/src/routes/data-injection/instrument-wizard.tsx  3-step create
apps/web/src/routes/data-injection/profiles.tsx           profile editor
.github/workflows/ci.yml                                  typecheck + tests + audit
```

**Modified**
```
apps/api/prisma/schema.prisma                             +7 models, +2 enums
apps/api/prisma/migrations/<UTC>_data_injection_p1/migration.sql
apps/api/src/app.ts                                       register 4 modules
apps/api/src/lib/audit-actions.ts                         +15 action constants
apps/api/src/lib/config-discovery.ts                      import uns-settings def
packages/shared/src/types/permissions.ts                  30 → 46
packages/shared/src/types/reauth-actions.ts               39 → 51
packages/shared/src/types/sidebar-items.ts                9 → 10
packages/shared/src/types/permission-tree.ts              +1 group, +16 nodes
packages/shared/src/types/__snapshots__/legacy-maps-snapshot.ts   regenerated
apps/web/src/main.tsx                                     38 → 43 routes
```

**Responsibility boundaries.** `hierarchy.repository.ts` is the *only* file containing raw SQL — every other module reaches the hierarchy through it. `topic-resolver.ts` is a pure function with no database access, so it is exhaustively unit-testable without fixtures.

---

## Task 1: CI baseline + route-parity contract test

Nothing else in this plan is verifiable without this. The repo has **no CI** and **23 pre-existing test failures**; CI starts by baselining them so it is green on commit one.

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `apps/api/src/e2e/route-parity.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a green CI baseline every later task must keep green

- [ ] **Step 1: Record the actual failure baseline**

```bash
cd packages/shared && npx vitest run 2>&1 | tail -5
cd ../../apps/web && npx vitest run 2>&1 | tail -5
cd ../api && npm test 2>&1 | tail -5
```

Write the three "N failed" numbers down. The spec expects 3 / 6 / 14 = 23 total. **If the numbers differ, use the numbers you observed** — do not force them to match the spec.

- [ ] **Step 2: Write the route-parity test (it must fail first)**

```ts
// apps/api/src/e2e/route-parity.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Frontend↔backend route parity.
 *
 * This gap has already shipped bugs: a dead `/api/filters/dashboard-stats`
 * poll 404'd every 20s for months, unnoticed, because nothing asserted that
 * the paths the SPA calls actually exist on the server.
 */
const WEB_SRC = resolve(__dirname, '../../../web/src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Extract `/api/...` string literals, normalising `${...}` interpolation to `:param`. */
export function extractApiPaths(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/['"`](\/api\/[^'"`\s?]*)/g)) {
    const path = m[1].replace(/\$\{[^}]*\}/g, ':param').replace(/\/+$/, '');
    if (path.length > 5) found.add(path);
  }
  return [...found];
}

describe('frontend↔backend route parity', () => {
  it('extracts and normalises interpolated paths', () => {
    expect(extractApiPaths('fetch(`/api/users/${id}/lock`)')).toEqual(['/api/users/:param/lock']);
  });

  it('every /api path the SPA calls exists on the server', async () => {
    const { buildApp } = await import('./test-helper.js');
    const app = await buildApp();
    const spec = app.swagger() as { paths: Record<string, unknown> };
    // Server paths as regexes: /api/users/:id → ^/api/users/[^/]+$
    const serverMatchers = Object.keys(spec.paths).map(
      p => new RegExp('^' + p.replace(/\{[^}]+\}/g, '[^/]+').replace(/\//g, '\\/') + '$'),
    );
    const called = walk(WEB_SRC).flatMap(f => extractApiPaths(readFileSync(f, 'utf8')));
    const orphans = [...new Set(called)].filter(
      c => !serverMatchers.some(rx => rx.test(c.replace(/:param/g, 'x'))),
    );
    expect(orphans, `SPA calls endpoints that do not exist:\n${orphans.join('\n')}`).toEqual([]);
    await app.close();
  });
});
```

- [ ] **Step 3: Run it — expect either PASS or a real orphan list**

```bash
cd apps/api && npx vitest run src/e2e/route-parity.test.ts
```

If it reports orphans, those are **real bugs**. Fix each by removing the dead caller or adding the route, then re-run until green. Do not weaken the assertion.

- [ ] **Step 4: Write the CI workflow using your Step 1 numbers**

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18
        env: { POSTGRES_PASSWORD: postgres, POSTGRES_DB: compliance_core_db_test }
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready --health-interval 10s
          --health-timeout 5s --health-retries 5
    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/compliance_core_db_test?schema=public
      JWT_SECRET: CI_JWT_SECRET_AT_LEAST_32_CHARACTERS_LONG_FOR_HS256
      INITIAL_ADMIN_PASSWORD: Admin@123
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: psql "$DATABASE_URL" -f apps/api/prisma/sql/extensions.sql
      - run: npm run build -w @digilog/shared && npm run build -w @digilog/queue
      - run: npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
      - run: npx tsc --noEmit -p apps/api/tsconfig.json
      - name: Tests (known-failing baseline enforced)
        run: node scripts/ci-test-gate.mjs
      - run: npm audit --audit-level=critical || true
```

- [ ] **Step 5: Write the baseline gate**

Replace `SHARED`/`WEB`/`API` with **your Step 1 numbers**.

```js
// scripts/ci-test-gate.mjs
import { execSync } from 'node:child_process';

/**
 * Known-failing baseline — a documented RATCHET, not a fudge.
 *
 * These failures are Phase 0 domain-strip test debt that predates this work;
 * every one fails identically on a clean checkout of HEAD. CI fails only when
 * failures EXCEED the baseline, so no NEW breakage can land. That property is
 * what makes "extends without breaking existing functionality" verifiable
 * across the other 14 tasks.
 *
 * Itemised so this is auditable rather than a magic number:
 *   shared (3) — 1 audit-template placeholder for a removed domain template,
 *                2 permission-tree gate tests for removed nodes
 *                (cleaning_profiles.toggle, checklists.submit)
 *   web    (6) — 3 url-utils tests referencing route files deleted in the strip,
 *                2 use-can tests asserting gates for removed nodes
 *                (FCP_UPDATE, CP_PAGE_EDIT), 1 route-guard count from pre-strip
 *   api   (14) — not individually triaged; confirmed identical before/after the
 *                preceding change set. Triage is tracked as rebuild-plan A2.
 *
 * These numbers may only ever be LOWERED. Raising one to make CI pass is
 * forbidden — fix the regression instead.
 */
const BASELINE = { shared: 3, web: 6, api: 14 };

const run = (name, cmd, cwd) => {
  let out = '';
  try { out = execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  const failed = Number(/(\d+) failed/.exec(out)?.[1] ?? 0);
  const budget = BASELINE[name];
  console.log(`${name}: ${failed} failed (baseline ${budget})`);
  if (failed > budget) {
    console.error(`\nFAIL: ${name} regressed — ${failed} > ${budget}\n${out.slice(-4000)}`);
    return 1;
  }
  return 0;
};

const code =
  run('shared', 'npx vitest run', 'packages/shared') +
  run('web', 'npx vitest run', 'apps/web') +
  run('api', 'npm test', 'apps/api');
process.exit(code ? 1 : 0);
```

- [ ] **Step 6: Verify the gate locally**

```bash
node scripts/ci-test-gate.mjs; echo "exit=$?"
```
Expected: `exit=0`, three lines each at or under baseline.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml scripts/ci-test-gate.mjs apps/api/src/e2e/route-parity.test.ts
git commit -m "Add CI with known-failing baseline and route-parity contract test"
```

---

## Task 2: Permissions, reauth actions, sidebar item

**Files:**
- Modify: `packages/shared/src/types/permissions.ts`
- Modify: `packages/shared/src/types/reauth-actions.ts`
- Modify: `packages/shared/src/types/sidebar-items.ts`
- Test: `packages/shared/src/types/__tests__/data-injection-perms.test.ts`

**Interfaces:**
- Produces: `HIERARCHY_*`, `GATEWAY_*`, `INSTRUMENT_*`, `COMM_PROFILE_*` permission constants; 12 reauth actions; sidebar item `data-injection`. Tasks 3–14 consume these.

- [ ] **Step 1: Write the failing count test**

```ts
// packages/shared/src/types/__tests__/data-injection-perms.test.ts
import { describe, it, expect } from 'vitest';
import { PERMISSIONS } from '../permissions.js';
import { REAUTH_ACTIONS } from '../reauth-actions.js';
import { SIDEBAR_ITEMS } from '../sidebar-items.js';

describe('data-injection RBAC surface', () => {
  it('adds 16 permissions (30 → 46)', () => {
    expect(Object.keys(PERMISSIONS)).toHaveLength(46);
    for (const p of [
      'HIERARCHY_VIEW', 'HIERARCHY_CREATE', 'HIERARCHY_UPDATE', 'HIERARCHY_DELETE',
      'GATEWAY_VIEW', 'GATEWAY_CREATE', 'GATEWAY_UPDATE', 'GATEWAY_DELETE',
      'INSTRUMENT_VIEW', 'INSTRUMENT_CREATE', 'INSTRUMENT_UPDATE', 'INSTRUMENT_DELETE',
      'COMM_PROFILE_VIEW', 'COMM_PROFILE_CREATE', 'COMM_PROFILE_UPDATE', 'COMM_PROFILE_DELETE',
    ]) expect(PERMISSIONS).toHaveProperty(p, p);
  });

  it('adds 12 reauth actions (39 → 51), all in the Data Injection category', () => {
    expect(Object.keys(REAUTH_ACTIONS)).toHaveLength(51);
    expect(REAUTH_ACTIONS.CREATE_INSTRUMENT).toEqual({
      label: 'Create Instrument', category: 'Data Injection',
    });
  });

  it('adds the data-injection sidebar item (9 → 10)', () => {
    expect(SIDEBAR_ITEMS).toHaveLength(10);
    expect(SIDEBAR_ITEMS.find(i => i.id === 'data-injection')?.label).toBe('Data Injection');
  });
});
```

- [ ] **Step 2: Run it to confirm failure**

```bash
cd packages/shared && npx vitest run src/types/__tests__/data-injection-perms.test.ts
```
Expected: FAIL — received length 30.

- [ ] **Step 3: Add the permission constants**

Append inside the `PERMISSIONS` object in `packages/shared/src/types/permissions.ts`, before the closing `}`:

```ts
  // ── Data Injection (P1) ────────────────────────────────────
  // Location hierarchy (Company→Line) backing UNS topic paths.
  HIERARCHY_VIEW: 'HIERARCHY_VIEW',
  HIERARCHY_CREATE: 'HIERARCHY_CREATE',
  HIERARCHY_UPDATE: 'HIERARCHY_UPDATE',
  HIERARCHY_DELETE: 'HIERARCHY_DELETE',

  GATEWAY_VIEW: 'GATEWAY_VIEW',
  GATEWAY_CREATE: 'GATEWAY_CREATE',
  GATEWAY_UPDATE: 'GATEWAY_UPDATE',
  GATEWAY_DELETE: 'GATEWAY_DELETE',

  INSTRUMENT_VIEW: 'INSTRUMENT_VIEW',
  INSTRUMENT_CREATE: 'INSTRUMENT_CREATE',
  INSTRUMENT_UPDATE: 'INSTRUMENT_UPDATE',
  INSTRUMENT_DELETE: 'INSTRUMENT_DELETE',

  // Communication profiles hold broker credentials — masked on read.
  COMM_PROFILE_VIEW: 'COMM_PROFILE_VIEW',
  COMM_PROFILE_CREATE: 'COMM_PROFILE_CREATE',
  COMM_PROFILE_UPDATE: 'COMM_PROFILE_UPDATE',
  COMM_PROFILE_DELETE: 'COMM_PROFILE_DELETE',
```

- [ ] **Step 4: Add the reauth actions**

Append inside `REAUTH_ACTIONS` in `packages/shared/src/types/reauth-actions.ts`:

```ts
  // Data Injection
  CREATE_HIERARCHY_NODE: { label: 'Create Hierarchy Node', category: 'Data Injection' },
  UPDATE_HIERARCHY_NODE: { label: 'Update Hierarchy Node', category: 'Data Injection' },
  DELETE_HIERARCHY_NODE: { label: 'Delete Hierarchy Node', category: 'Data Injection' },
  CREATE_GATEWAY: { label: 'Create Gateway', category: 'Data Injection' },
  UPDATE_GATEWAY: { label: 'Update Gateway', category: 'Data Injection' },
  DELETE_GATEWAY: { label: 'Delete Gateway', category: 'Data Injection' },
  CREATE_INSTRUMENT: { label: 'Create Instrument', category: 'Data Injection' },
  UPDATE_INSTRUMENT: { label: 'Update Instrument', category: 'Data Injection' },
  DELETE_INSTRUMENT: { label: 'Delete Instrument', category: 'Data Injection' },
  CREATE_COMM_PROFILE: { label: 'Create Communication Profile', category: 'Data Injection' },
  UPDATE_COMM_PROFILE: { label: 'Update Communication Profile', category: 'Data Injection' },
  DELETE_COMM_PROFILE: { label: 'Delete Communication Profile', category: 'Data Injection' },
```

- [ ] **Step 5: Add the sidebar item**

Append to `SIDEBAR_ITEMS` in `packages/shared/src/types/sidebar-items.ts`:

```ts
  { id: 'data-injection', label: 'Data Injection', icon: '\u{1F517}', description: 'Instruments, gateways and industrial communication' },
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd packages/shared && npx vitest run src/types/__tests__/data-injection-perms.test.ts
```
Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/
git commit -m "Add Data Injection permissions, reauth actions and sidebar item"
```

---

## Task 3: PERMISSION_TREE data-injection group

**Files:**
- Modify: `packages/shared/src/types/permission-tree.ts`
- Modify: `packages/shared/src/types/__snapshots__/legacy-maps-snapshot.ts`

**Interfaces:**
- Consumes: permission constants + reauth actions from Task 2
- Produces: node ids `hierarchy.view|create|edit|delete`, `gateways.*`, `instruments.*`, `comm_profiles.*` — consumed by `useCan()` in Tasks 12–14

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/types/__tests__/data-injection-tree.test.ts
import { describe, it, expect } from 'vitest';
import { PERMISSION_TREE } from '../permission-tree.js';

describe('data-injection permission group', () => {
  const group = () => PERMISSION_TREE.find(g => g.sidebarId === 'data-injection');

  it('exists with 16 nodes, all configurable and all enforce:a', () => {
    const g = group();
    expect(g).toBeDefined();
    expect(g!.nodes).toHaveLength(16);
    expect(g!.nodes.every(n => n.configurable === true)).toBe(true);
    expect(g!.nodes.every(n => n.enforce === 'a')).toBe(true);
  });

  it('gate is the single discriminating permission, never the grant set', () => {
    const create = group()!.nodes.find(n => n.id === 'instruments.create')!;
    expect(create.gate).toEqual(['INSTRUMENT_CREATE']);
    // grant set includes read dependencies — must NOT equal the gate
    expect(create.permissions).toContain('INSTRUMENT_VIEW');
    expect(create.permissions.length).toBeGreaterThan(create.gate.length);
  });

  it('brings the tree to 9 groups and 54 nodes', () => {
    expect(PERMISSION_TREE).toHaveLength(9);
    expect(PERMISSION_TREE.flatMap(g => g.nodes)).toHaveLength(54);
  });
});
```

> **Note:** 38 existing nodes + 16 = 54. If the existing count differs when you run it, use the observed number and adjust this assertion — the meaningful part is `+16`.

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/shared && npx vitest run src/types/__tests__/data-injection-tree.test.ts
```
Expected: FAIL — `g` is undefined.

- [ ] **Step 3: Append the group to PERMISSION_TREE**

Add as the last element of the `PERMISSION_TREE` array in `packages/shared/src/types/permission-tree.ts`:

```ts
  // ---- Data Injection (P1) ----
  {
    sidebarId: 'data-injection', label: 'Data Injection', icon: '\u{1F517}',
    description: 'Instruments, gateways and industrial communication',
    visibilityPrivilegeIds: [
      'hierarchy.view', 'gateways.view', 'instruments.view', 'comm_profiles.view',
    ],
    nodes: [
      { id: 'hierarchy.view', label: 'View Hierarchy', sidebarId: 'data-injection', page: 'Hierarchy', action: 'View',
        icon: 'sitemap', category: 'Data Injection', permissions: ['HIERARCHY_VIEW'], enforce: 'a',
        gate: ['HIERARCHY_VIEW'], configurable: true },
      { id: 'hierarchy.create', label: 'Create Hierarchy Node', sidebarId: 'data-injection', page: 'Hierarchy', action: 'Add',
        icon: 'plus', category: 'Data Injection', permissions: ['HIERARCHY_CREATE', 'HIERARCHY_VIEW'],
        reauthAction: 'CREATE_HIERARCHY_NODE', enforce: 'a', gate: ['HIERARCHY_CREATE'], configurable: true },
      { id: 'hierarchy.edit', label: 'Edit Hierarchy Node', sidebarId: 'data-injection', page: 'Hierarchy', action: 'Edit',
        icon: 'edit', category: 'Data Injection', permissions: ['HIERARCHY_UPDATE', 'HIERARCHY_VIEW'],
        reauthAction: 'UPDATE_HIERARCHY_NODE', enforce: 'a', gate: ['HIERARCHY_UPDATE'], configurable: true },
      { id: 'hierarchy.delete', label: 'Delete Hierarchy Node', sidebarId: 'data-injection', page: 'Hierarchy', action: 'Delete',
        icon: 'trash', category: 'Data Injection', permissions: ['HIERARCHY_DELETE', 'HIERARCHY_VIEW'],
        reauthAction: 'DELETE_HIERARCHY_NODE', enforce: 'a', gate: ['HIERARCHY_DELETE'], configurable: true },

      { id: 'gateways.view', label: 'View Gateways', sidebarId: 'data-injection', page: 'Gateways', action: 'View',
        icon: 'router', category: 'Data Injection', permissions: ['GATEWAY_VIEW'], enforce: 'a',
        gate: ['GATEWAY_VIEW'], configurable: true },
      { id: 'gateways.create', label: 'Create Gateway', sidebarId: 'data-injection', page: 'Gateways', action: 'Add',
        icon: 'plus', category: 'Data Injection', permissions: ['GATEWAY_CREATE', 'GATEWAY_VIEW', 'HIERARCHY_VIEW', 'COMM_PROFILE_VIEW'],
        reauthAction: 'CREATE_GATEWAY', enforce: 'a', gate: ['GATEWAY_CREATE'], configurable: true },
      { id: 'gateways.edit', label: 'Edit Gateway', sidebarId: 'data-injection', page: 'Gateways', action: 'Edit',
        icon: 'edit', category: 'Data Injection', permissions: ['GATEWAY_UPDATE', 'GATEWAY_VIEW', 'HIERARCHY_VIEW', 'COMM_PROFILE_VIEW'],
        reauthAction: 'UPDATE_GATEWAY', enforce: 'a', gate: ['GATEWAY_UPDATE'], configurable: true },
      { id: 'gateways.delete', label: 'Delete Gateway', sidebarId: 'data-injection', page: 'Gateways', action: 'Delete',
        icon: 'trash', category: 'Data Injection', permissions: ['GATEWAY_DELETE', 'GATEWAY_VIEW'],
        reauthAction: 'DELETE_GATEWAY', enforce: 'a', gate: ['GATEWAY_DELETE'], configurable: true },

      { id: 'instruments.view', label: 'View Instruments', sidebarId: 'data-injection', page: 'Instruments', action: 'View',
        icon: 'cpu', category: 'Data Injection', permissions: ['INSTRUMENT_VIEW'], enforce: 'a',
        gate: ['INSTRUMENT_VIEW'], configurable: true },
      { id: 'instruments.create', label: 'Create Instrument', sidebarId: 'data-injection', page: 'Instruments', action: 'Add',
        icon: 'plus', category: 'Data Injection', permissions: ['INSTRUMENT_CREATE', 'INSTRUMENT_VIEW', 'HIERARCHY_VIEW', 'GATEWAY_VIEW', 'COMM_PROFILE_VIEW'],
        reauthAction: 'CREATE_INSTRUMENT', enforce: 'a', gate: ['INSTRUMENT_CREATE'], configurable: true },
      { id: 'instruments.edit', label: 'Edit Instrument', sidebarId: 'data-injection', page: 'Instruments', action: 'Edit',
        icon: 'edit', category: 'Data Injection', permissions: ['INSTRUMENT_UPDATE', 'INSTRUMENT_VIEW', 'HIERARCHY_VIEW', 'GATEWAY_VIEW', 'COMM_PROFILE_VIEW'],
        reauthAction: 'UPDATE_INSTRUMENT', enforce: 'a', gate: ['INSTRUMENT_UPDATE'], configurable: true },
      { id: 'instruments.delete', label: 'Delete Instrument', sidebarId: 'data-injection', page: 'Instruments', action: 'Delete',
        icon: 'trash', category: 'Data Injection', permissions: ['INSTRUMENT_DELETE', 'INSTRUMENT_VIEW'],
        reauthAction: 'DELETE_INSTRUMENT', enforce: 'a', gate: ['INSTRUMENT_DELETE'], configurable: true },

      { id: 'comm_profiles.view', label: 'View Communication Profiles', sidebarId: 'data-injection', page: 'Communication Profiles', action: 'View',
        icon: 'plug', category: 'Data Injection', permissions: ['COMM_PROFILE_VIEW'], enforce: 'a',
        gate: ['COMM_PROFILE_VIEW'], configurable: true },
      { id: 'comm_profiles.create', label: 'Create Communication Profile', sidebarId: 'data-injection', page: 'Communication Profiles', action: 'Add',
        icon: 'plus', category: 'Data Injection', permissions: ['COMM_PROFILE_CREATE', 'COMM_PROFILE_VIEW'],
        reauthAction: 'CREATE_COMM_PROFILE', enforce: 'a', gate: ['COMM_PROFILE_CREATE'], configurable: true },
      { id: 'comm_profiles.edit', label: 'Edit Communication Profile', sidebarId: 'data-injection', page: 'Communication Profiles', action: 'Edit',
        icon: 'edit', category: 'Data Injection', permissions: ['COMM_PROFILE_UPDATE', 'COMM_PROFILE_VIEW'],
        reauthAction: 'UPDATE_COMM_PROFILE', enforce: 'a', gate: ['COMM_PROFILE_UPDATE'], configurable: true },
      { id: 'comm_profiles.delete', label: 'Delete Communication Profile', sidebarId: 'data-injection', page: 'Communication Profiles', action: 'Delete',
        icon: 'trash', category: 'Data Injection', permissions: ['COMM_PROFILE_DELETE', 'COMM_PROFILE_VIEW'],
        reauthAction: 'DELETE_COMM_PROFILE', enforce: 'a', gate: ['COMM_PROFILE_DELETE'], configurable: true },
    ],
  },
```

- [ ] **Step 4: Run the new test**

```bash
cd packages/shared && npx vitest run src/types/__tests__/data-injection-tree.test.ts
```
Expected: 3 passed.

- [ ] **Step 5: Regenerate the frozen snapshot and run the whole shared suite**

```bash
cd packages/shared && npx vitest run -u && npx vitest run
```
Expected: the snapshot file updates; failures stay at your Task 1 baseline (3) — **not higher**.

- [ ] **Step 6: Verify derivation picked the nodes up**

```bash
cd packages/shared && npm run build && node -e "
const t=require('./dist/types/permission-tree.js');
const f=require('./dist/types/feature-privileges.js');
console.log('nodes', t.PERMISSION_TREE.flatMap(g=>g.nodes).length);
console.log('privileges', f.FEATURE_PRIVILEGES.length);"
```
Expected: `nodes 54`, `privileges 42` (26 + 16).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/
git commit -m "Add data-injection group to PERMISSION_TREE (16 nodes) and refresh snapshot"
```

---

## Task 4: Prisma schema + hand-authored migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<UTC>_data_injection_p1/migration.sql`

**Interfaces:**
- Produces: models `HierarchyNode`, `Protocol`, `CommunicationProfile`, `Gateway`, `Instrument`, `InstrumentSetting`, `InstrumentTopic`; enums `HierarchyLevel`, `TopicCategory`. All later backend tasks consume these.

- [ ] **Step 1: Add the models to `schema.prisma`**

```prisma
enum HierarchyLevel { COMPANY SITE PLANT BUILDING BLOCK AREA LINE }

enum TopicCategory {
  TELEMETRY ATTRIBUTES ALARM COMMAND RPC HEARTBEAT EVENT
  STATUS CONFIG RESPONSE SETTINGS PUBLISH SUBSCRIBE
}

model HierarchyNode {
  id        String         @id @default(uuid())
  parentId  String?        @map("parent_id")
  level     HierarchyLevel
  name      String
  slug      String
  sortOrder Int            @default(0) @map("sort_order")
  isActive  Boolean        @default(true) @map("is_active")
  createdAt DateTime       @default(now()) @map("created_at")
  updatedAt DateTime       @updatedAt @map("updated_at")
  createdBy String?        @map("created_by")

  parent    HierarchyNode?  @relation("NodeTree", fields: [parentId], references: [id], onDelete: Restrict)
  children  HierarchyNode[] @relation("NodeTree")
  gateways    Gateway[]
  instruments Instrument[]

  @@unique([parentId, slug])
  @@index([level])
  @@map("hierarchy_nodes")
}

model Protocol {
  key          String  @id
  name         String
  isEnabled    Boolean @default(false) @map("is_enabled")
  capabilities Json
  profiles     CommunicationProfile[]
  @@map("protocols")
}

model CommunicationProfile {
  id          String   @id @default(uuid())
  name        String   @unique
  protocolKey String   @map("protocol_key")
  config      Json
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  createdBy   String?  @map("created_by")

  protocol    Protocol     @relation(fields: [protocolKey], references: [key], onDelete: Restrict)
  gateways    Gateway[]
  instruments Instrument[]
  @@map("communication_profiles")
}

model Gateway {
  id                     String   @id @default(uuid())
  name                   String
  code                   String   @unique
  slug                   String
  gatewayType            String   @map("gateway_type")
  externalId             String   @map("external_id")
  hierarchyNodeId        String   @map("hierarchy_node_id")
  communicationProfileId String   @map("communication_profile_id")
  description            String?
  isActive               Boolean  @default(true) @map("is_active")
  createdAt              DateTime @default(now()) @map("created_at")
  updatedAt              DateTime @updatedAt @map("updated_at")
  createdBy              String?  @map("created_by")

  hierarchyNode HierarchyNode        @relation(fields: [hierarchyNodeId], references: [id], onDelete: Restrict)
  profile       CommunicationProfile @relation(fields: [communicationProfileId], references: [id], onDelete: Restrict)
  instruments   Instrument[]

  @@unique([hierarchyNodeId, slug])
  @@index([hierarchyNodeId])
  @@map("gateways")
}

model Instrument {
  id                     String   @id @default(uuid())
  name                   String
  code                   String   @unique
  slug                   String
  instrumentType         String   @map("instrument_type")
  manufacturer           String?
  model                  String?
  serialNumber           String?  @map("serial_number")
  description            String?
  hierarchyNodeId        String   @map("hierarchy_node_id")
  gatewayId              String?  @map("gateway_id")
  deviceKey              String?  @map("device_key")
  communicationProfileId String?  @map("communication_profile_id")
  isActive               Boolean  @default(true) @map("is_active")
  createdAt              DateTime @default(now()) @map("created_at")
  updatedAt              DateTime @updatedAt @map("updated_at")
  createdBy              String?  @map("created_by")

  hierarchyNode HierarchyNode         @relation(fields: [hierarchyNodeId], references: [id], onDelete: Restrict)
  gateway       Gateway?              @relation(fields: [gatewayId], references: [id], onDelete: Restrict)
  profile       CommunicationProfile? @relation(fields: [communicationProfileId], references: [id], onDelete: Restrict)
  setting       InstrumentSetting?
  topics        InstrumentTopic[]

  @@unique([gatewayId, deviceKey])
  @@unique([hierarchyNodeId, slug])
  @@index([gatewayId])
  @@map("instruments")
}

model InstrumentSetting {
  instrumentId String     @id @map("instrument_id")
  values       Json
  updatedAt    DateTime   @updatedAt @map("updated_at")
  instrument   Instrument @relation(fields: [instrumentId], references: [id], onDelete: Cascade)
  @@map("instrument_settings")
}

model InstrumentTopic {
  id           String        @id @default(uuid())
  instrumentId String        @map("instrument_id")
  category     TopicCategory
  customTopic  String?       @map("custom_topic")
  qos          Int           @default(1)
  retain       Boolean       @default(false)
  enabled      Boolean       @default(true)
  instrument   Instrument    @relation(fields: [instrumentId], references: [id], onDelete: Cascade)
  @@unique([instrumentId, category])
  @@map("instrument_topics")
}
```

> `path ltree` is deliberately **absent** from the Prisma model. Prisma would map it to `Unsupported("ltree")`, which makes the whole model unselectable in the typed client. The column is added by raw SQL in Step 2 and read only through the repository in Task 5.

- [ ] **Step 2: Generate a candidate diff, then hand-author the migration**

```bash
cd apps/api && npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma --script > /tmp/candidate.sql
```

Create `apps/api/prisma/migrations/20260801120000_data_injection_p1/migration.sql` with the reviewed contents of `/tmp/candidate.sql`, then **append** the three things Prisma cannot express:

```sql
-- ltree materialised path. Not in schema.prisma: Prisma maps ltree to
-- Unsupported(), which would make HierarchyNode unselectable in the client.
-- Read/written only via hierarchy.repository.ts.
ALTER TABLE "hierarchy_nodes" ADD COLUMN "path" ltree;
CREATE INDEX "hierarchy_nodes_path_gist_idx" ON "hierarchy_nodes" USING GIST ("path");
CREATE INDEX "hierarchy_nodes_path_btree_idx" ON "hierarchy_nodes" USING BTREE ("path");

-- An instrument must be reachable: either it hangs off a gateway (and inherits
-- that gateway's profile), or it communicates independently and must carry its
-- own profile. Prisma cannot express a conditional NOT NULL.
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_reachable_chk"
  CHECK ("gateway_id" IS NOT NULL OR "communication_profile_id" IS NOT NULL);

-- Seed the protocol registry. Only MQTT is enabled: P1 ships no adapters, and
-- an enabled protocol with no adapter would be a lie in the UI.
INSERT INTO "protocols" ("key","name","is_enabled","capabilities") VALUES
  ('mqtt','MQTT',            false, '{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('mqtts','MQTT over TLS',  false, '{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('http','HTTP',            false, '{"publish":true,"subscribe":false,"poll":true,"write":true}'),
  ('https','HTTPS',          false, '{"publish":true,"subscribe":false,"poll":true,"write":true}'),
  ('websocket','WebSocket',  false, '{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('wss','Secure WebSocket', false, '{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('tcp','TCP/IP',           false, '{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('udp','UDP',              false, '{"publish":true,"subscribe":true,"poll":false,"write":false}'),
  ('serial','Serial Port',   false, '{"publish":true,"subscribe":true,"poll":true,"write":true}'),
  ('modbus-tcp','Modbus TCP',false, '{"publish":false,"subscribe":false,"poll":true,"write":true}'),
  ('modbus-rtu','Modbus RTU',false, '{"publish":false,"subscribe":false,"poll":true,"write":true}'),
  ('opcua','OPC-UA',         false, '{"publish":false,"subscribe":true,"poll":true,"write":true}'),
  ('kafka','Kafka',          false, '{"publish":true,"subscribe":true,"poll":false,"write":false}'),
  ('amqp','AMQP',            false, '{"publish":true,"subscribe":true,"poll":false,"write":false}'),
  ('azure-iot','Azure IoT Hub', false,'{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('aws-iot','AWS IoT Core', false, '{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('webhook','Webhook',      false, '{"publish":true,"subscribe":false,"poll":false,"write":false}'),
  ('rest','REST API',        false, '{"publish":true,"subscribe":false,"poll":true,"write":true}')
ON CONFLICT ("key") DO NOTHING;
```

> **OPC-DA is deliberately absent** from this list. It is COM/DCOM and has no viable Node implementation (spec §2). Seeding a row for it would advertise a capability that cannot be built.

- [ ] **Step 3: Apply and regenerate the client**

```bash
cd apps/api && npx prisma migrate deploy && npx prisma generate
```
Expected: `1 migration applied`.

- [ ] **Step 4: Run the drift guard — it MUST pass**

```bash
cd /c/Users/hello/compliance-core && npm run db:verify-migrations
```
Expected: PASS / empty diff. **If it fails, stop and fix the migration** — do not proceed.

- [ ] **Step 5: Verify the raw objects landed**

```bash
psql -U digilog -d compliance_core_db -c "\d hierarchy_nodes" | grep -E "path|gist"
psql -U digilog -d compliance_core_db -c "SELECT count(*) FROM protocols;"
```
Expected: a `path | ltree` column, a GiST index, and `18`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/
git commit -m "Add Data Injection P1 schema: 7 models, 2 enums, ltree path, protocol registry"
```

---

## Task 5: Hierarchy repository (all raw ltree SQL)

The riskiest code in P1. Every raw query lives here and nowhere else.

**Files:**
- Create: `apps/api/src/modules/hierarchy/hierarchy.repository.ts`
- Test: `apps/api/src/modules/hierarchy/__tests__/hierarchy.repository.test.ts`

**Interfaces:**
- Consumes: Prisma client from Task 4
- Produces:
  - `sanitizeSlug(name: string): string`
  - `createNode(input: {parentId: string|null; level: HierarchyLevel; name: string; sortOrder?: number; createdBy?: string}): Promise<HierarchyNodeRow>`
  - `getAncestryPath(nodeId: string): Promise<string[]>` — root→leaf slugs, **one query**
  - `moveNode(nodeId: string, newParentId: string|null): Promise<void>`
  - `renameNode(nodeId: string, name: string): Promise<void>`
  - `listTree(): Promise<HierarchyNodeRow[]>`
  - `type HierarchyNodeRow = { id, parentId, level, name, slug, path, sortOrder, isActive }`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/hierarchy/__tests__/hierarchy.repository.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import {
  sanitizeSlug, createNode, getAncestryPath, moveNode, renameNode,
} from '../hierarchy.repository.js';

describe('sanitizeSlug', () => {
  it('lowercases, hyphenates spaces and strips specials', () => {
    expect(sanitizeSlug('  Plant #01  ')).toBe('plant-01');
    expect(sanitizeSlug('Block A / Area 2')).toBe('block-a-area-2');
    expect(sanitizeSlug('Área—02')).toBe('rea-02');
  });
  it('collapses and trims hyphens', () => {
    expect(sanitizeSlug('a   ---   b')).toBe('a-b');
    expect(sanitizeSlug('---x---')).toBe('x');
  });
});

describe('hierarchy repository (ltree)', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "hierarchy_nodes" CASCADE');
  });

  it('materialises the path on create', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    const site = await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    expect(co.path).toBe('controlyt');
    expect(site.path).toBe('controlyt.india');
  });

  it('returns full ancestry in ONE query', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    const site = await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    const plant = await createNode({ parentId: site.id, level: 'PLANT', name: 'Plant 01' });
    expect(await getAncestryPath(plant.id)).toEqual(['controlyt', 'india', 'plant-01']);
  });

  it('supports gaps — a skipped level is simply absent', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    // SITE and PLANT skipped entirely; AREA hangs directly off COMPANY
    const area = await createNode({ parentId: co.id, level: 'AREA', name: 'Area 02' });
    expect(await getAncestryPath(area.id)).toEqual(['controlyt', 'area-02']);
  });

  it('rewrites EVERY descendant path when a node moves', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    const s1 = await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    const s2 = await createNode({ parentId: co.id, level: 'SITE', name: 'Germany' });
    const plant = await createNode({ parentId: s1.id, level: 'PLANT', name: 'Plant 01' });
    const line = await createNode({ parentId: plant.id, level: 'LINE', name: 'Packing' });

    await moveNode(plant.id, s2.id);

    expect(await getAncestryPath(plant.id)).toEqual(['controlyt', 'germany', 'plant-01']);
    expect(await getAncestryPath(line.id)).toEqual(['controlyt', 'germany', 'plant-01', 'packing']);
  });

  it('rewrites descendant paths on rename', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    const site = await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    await renameNode(co.id, 'Controlytics');
    expect(await getAncestryPath(site.id)).toEqual(['controlytics', 'india']);
  });

  it('rejects a move that would make a node its own ancestor', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    const site = await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    await expect(moveNode(co.id, site.id)).rejects.toThrow(/cycle/i);
  });

  it('rejects duplicate slugs under one parent', async () => {
    const co = await createNode({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    await createNode({ parentId: co.id, level: 'SITE', name: 'India' });
    await expect(createNode({ parentId: co.id, level: 'SITE', name: 'India' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/api && npx vitest run src/modules/hierarchy/__tests__/hierarchy.repository.test.ts
```
Expected: FAIL — cannot resolve `../hierarchy.repository.js`.

- [ ] **Step 3: Implement the repository**

```ts
// apps/api/src/modules/hierarchy/hierarchy.repository.ts
/**
 * Hierarchy repository — the ONLY place raw ltree SQL lives.
 *
 * `hierarchy_nodes.path` is an ltree column deliberately absent from
 * schema.prisma: Prisma maps ltree to Unsupported(), which would make the whole
 * model unselectable through the typed client. Everything below therefore uses
 * $queryRaw / $executeRaw, and every other module reaches the hierarchy through
 * these functions rather than touching the column.
 */
import { prisma } from '../../lib/prisma.js';
import { ValidationError } from '../../lib/errors.js';

export type HierarchyLevel =
  | 'COMPANY' | 'SITE' | 'PLANT' | 'BUILDING' | 'BLOCK' | 'AREA' | 'LINE';

export interface HierarchyNodeRow {
  id: string;
  parentId: string | null;
  level: HierarchyLevel;
  name: string;
  slug: string;
  path: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Sanitise a display name into a UNS path segment.
 * Ported from the upstream uns-path-builder. ltree labels accept only
 * [A-Za-z0-9_], so hyphens are encoded as underscores at the storage layer
 * (see toLabel) while the public slug keeps hyphens for readable topics.
 */
export function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** ltree labels forbid '-'; store as '_' and reverse on read. */
const toLabel = (slug: string) => slug.replace(/-/g, '_');
const fromLabel = (label: string) => label.replace(/_/g, '-');

export async function createNode(input: {
  parentId: string | null;
  level: HierarchyLevel;
  name: string;
  sortOrder?: number;
  createdBy?: string;
}): Promise<HierarchyNodeRow> {
  const slug = sanitizeSlug(input.name);
  if (!slug) throw new ValidationError('Name must contain at least one alphanumeric character.');

  const parentPath = input.parentId ? await getRawPath(input.parentId) : null;
  if (input.parentId && parentPath === null) {
    throw new ValidationError(`Parent node ${input.parentId} does not exist.`);
  }
  const path = parentPath ? `${parentPath}.${toLabel(slug)}` : toLabel(slug);

  const rows = await prisma.$queryRaw<HierarchyNodeRow[]>`
    INSERT INTO hierarchy_nodes (id, parent_id, level, name, slug, path, sort_order, is_active, created_at, updated_at, created_by)
    VALUES (gen_random_uuid(), ${input.parentId}, ${input.level}::"HierarchyLevel", ${input.name},
            ${slug}, ${path}::ltree, ${input.sortOrder ?? 0}, true, now(), now(), ${input.createdBy ?? null})
    RETURNING id, parent_id AS "parentId", level, name, slug, path::text AS path,
              sort_order AS "sortOrder", is_active AS "isActive"`;
  return { ...rows[0], path: fromLabel(rows[0].path) };
}

async function getRawPath(nodeId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ path: string }[]>`
    SELECT path::text AS path FROM hierarchy_nodes WHERE id = ${nodeId}`;
  return rows[0]?.path ?? null;
}

/**
 * Full root→leaf slug chain in ONE query.
 * The upstream implementation walked the parent chain with one query per level
 * (N+1). `@>` is the ltree ancestor operator and uses the GiST index.
 */
export async function getAncestryPath(nodeId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ slug: string }[]>`
    SELECT a.slug
    FROM hierarchy_nodes n
    JOIN hierarchy_nodes a ON a.path @> n.path
    WHERE n.id = ${nodeId}
    ORDER BY nlevel(a.path)`;
  return rows.map(r => r.slug);
}

/** Reparent a node and rewrite every descendant's path in one statement. */
export async function moveNode(nodeId: string, newParentId: string | null): Promise<void> {
  const oldPath = await getRawPath(nodeId);
  if (oldPath === null) throw new ValidationError(`Node ${nodeId} does not exist.`);

  const newParentPath = newParentId ? await getRawPath(newParentId) : null;
  if (newParentId && newParentPath === null) {
    throw new ValidationError(`Target parent ${newParentId} does not exist.`);
  }
  // A node cannot move beneath itself or its own descendant.
  if (newParentPath && (newParentPath === oldPath || newParentPath.startsWith(`${oldPath}.`))) {
    throw new ValidationError('Cannot move a node beneath itself — that would create a cycle.');
  }

  const leaf = oldPath.split('.').pop()!;
  const newPath = newParentPath ? `${newParentPath}.${leaf}` : leaf;

  await prisma.$transaction([
    prisma.$executeRaw`UPDATE hierarchy_nodes SET parent_id = ${newParentId}, updated_at = now() WHERE id = ${nodeId}`,
    // Rewrite this node AND its whole subtree. `<@` is "is descendant of (or equal)".
    prisma.$executeRaw`
      UPDATE hierarchy_nodes
      SET path = ${newPath}::ltree || subpath(path, nlevel(${oldPath}::ltree)),
          updated_at = now()
      WHERE path <@ ${oldPath}::ltree`,
  ]);
}

/** Rename a node, re-deriving its slug and every descendant path. */
export async function renameNode(nodeId: string, name: string): Promise<void> {
  const slug = sanitizeSlug(name);
  if (!slug) throw new ValidationError('Name must contain at least one alphanumeric character.');

  const oldPath = await getRawPath(nodeId);
  if (oldPath === null) throw new ValidationError(`Node ${nodeId} does not exist.`);

  const parts = oldPath.split('.');
  parts[parts.length - 1] = toLabel(slug);
  const newPath = parts.join('.');

  await prisma.$transaction([
    prisma.$executeRaw`UPDATE hierarchy_nodes SET name = ${name}, slug = ${slug}, updated_at = now() WHERE id = ${nodeId}`,
    prisma.$executeRaw`
      UPDATE hierarchy_nodes
      SET path = ${newPath}::ltree || subpath(path, nlevel(${oldPath}::ltree)),
          updated_at = now()
      WHERE path <@ ${oldPath}::ltree`,
  ]);
}

export async function listTree(): Promise<HierarchyNodeRow[]> {
  const rows = await prisma.$queryRaw<HierarchyNodeRow[]>`
    SELECT id, parent_id AS "parentId", level, name, slug, path::text AS path,
           sort_order AS "sortOrder", is_active AS "isActive"
    FROM hierarchy_nodes ORDER BY path`;
  return rows.map(r => ({ ...r, path: fromLabel(r.path) }));
}
```

- [ ] **Step 4: Run tests until green**

```bash
cd apps/api && npx vitest run src/modules/hierarchy/__tests__/hierarchy.repository.test.ts
```
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/hierarchy/
git commit -m "Add hierarchy repository with ltree paths, single-query ancestry and cycle guard"
```

---

## Task 6: Topic resolver + `uns-settings` config surface

**Files:**
- Create: `apps/api/src/modules/instruments/topic-resolver.ts`
- Create: `apps/api/src/modules/instruments/__tests__/topic-resolver.test.ts`
- Create: `apps/api/src/modules/config/defs/uns-settings.def.ts`
- Modify: `apps/api/src/lib/config-discovery.ts`

**Interfaces:**
- Consumes: `getAncestryPath` (Task 5)
- Produces:
  - `TOPIC_CATEGORIES: readonly TopicCategory[]` (13 entries)
  - `resolveTopics(input: ResolveTopicsInput): Record<TopicCategory, string>`
  - `interface UnsSettings { prefix: string; separator: string; includeGateway: boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/modules/instruments/__tests__/topic-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { resolveTopics, TOPIC_CATEGORIES } from '../topic-resolver.js';

const settings = { prefix: 'controlyt', separator: '/', includeGateway: true };
const base = {
  settings,
  ancestry: ['india', 'hyderabad', 'plant01', 'blocka', 'area02', 'packing'],
  gatewaySlug: 'gw001',
  instrumentSlug: 'temp001',
  overrides: {},
};

describe('resolveTopics', () => {
  it('produces all 13 categories', () => {
    expect(TOPIC_CATEGORIES).toHaveLength(13);
    expect(Object.keys(resolveTopics(base))).toHaveLength(13);
  });

  it('builds the documented UNS topic', () => {
    expect(resolveTopics(base).TELEMETRY).toBe(
      'controlyt/india/hyderabad/plant01/blocka/area02/packing/gw001/temp001/telemetry',
    );
  });

  it('omits the gateway segment for an independent instrument', () => {
    expect(resolveTopics({ ...base, gatewaySlug: null }).ALARM).toBe(
      'controlyt/india/hyderabad/plant01/blocka/area02/packing/temp001/alarm',
    );
  });

  it('omits the gateway segment when includeGateway is false', () => {
    const s = { ...settings, includeGateway: false };
    expect(resolveTopics({ ...base, settings: s }).COMMAND).toContain('/packing/temp001/command');
    expect(resolveTopics({ ...base, settings: s }).COMMAND).not.toContain('gw001');
  });

  it('honours an explicit override verbatim', () => {
    const out = resolveTopics({ ...base, overrides: { TELEMETRY: 'legacy/raw/feed' } });
    expect(out.TELEMETRY).toBe('legacy/raw/feed');
    expect(out.ALARM).toContain('controlyt/'); // others still derived
  });

  it('handles hierarchy gaps without emitting blank segments', () => {
    const out = resolveTopics({ ...base, ancestry: ['india', 'packing'] });
    expect(out.HEARTBEAT).toBe('controlyt/india/packing/gw001/temp001/heartbeat');
    expect(out.HEARTBEAT).not.toContain('//');
  });

  it('respects a custom separator and empty prefix', () => {
    const out = resolveTopics({
      ...base, settings: { prefix: '', separator: '.', includeGateway: false },
      ancestry: ['india'],
    });
    expect(out.STATUS).toBe('india.temp001.status');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/api && npx vitest run src/modules/instruments/__tests__/topic-resolver.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

```ts
// apps/api/src/modules/instruments/topic-resolver.ts
/**
 * UNS topic derivation — a pure function, no database access.
 *
 * Topics are DERIVED, not stored (spec D5): renaming a hierarchy node
 * re-derives every descendant's topics with no backfill. Only explicit
 * customisations are persisted, in instrument_topics.
 */

export const TOPIC_CATEGORIES = [
  'TELEMETRY', 'ATTRIBUTES', 'ALARM', 'COMMAND', 'RPC', 'HEARTBEAT', 'EVENT',
  'STATUS', 'CONFIG', 'RESPONSE', 'SETTINGS', 'PUBLISH', 'SUBSCRIBE',
] as const;

export type TopicCategory = (typeof TOPIC_CATEGORIES)[number];

export interface UnsSettings {
  prefix: string;
  separator: string;
  includeGateway: boolean;
}

export interface ResolveTopicsInput {
  settings: UnsSettings;
  /** Root→leaf hierarchy slugs, from getAncestryPath(). */
  ancestry: string[];
  /** Gateway slug, or null when the instrument communicates independently. */
  gatewaySlug: string | null;
  instrumentSlug: string;
  /** Persisted per-category overrides. */
  overrides: Partial<Record<TopicCategory, string>>;
}

export function resolveTopics(input: ResolveTopicsInput): Record<TopicCategory, string> {
  const { settings, ancestry, gatewaySlug, instrumentSlug, overrides } = input;

  const segments = [
    settings.prefix,
    ...ancestry,
    settings.includeGateway ? gatewaySlug : null,
    instrumentSlug,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);

  const base = segments.join(settings.separator);

  const out = {} as Record<TopicCategory, string>;
  for (const category of TOPIC_CATEGORIES) {
    out[category] = overrides[category] ?? `${base}${settings.separator}${category.toLowerCase()}`;
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/modules/instruments/__tests__/topic-resolver.test.ts
```
Expected: 7 passed.

- [ ] **Step 5: Add the config definition**

```ts
// apps/api/src/modules/config/defs/uns-settings.def.ts
import type { ConfigDefinition } from '../../../lib/config-registry.js';

/**
 * UNS topic-shape settings — the 22nd config surface.
 * Renders through the dynamic config page (no bespoke route file).
 */
export const unsSettingsDef: ConfigDefinition = {
  moduleKey: 'uns-settings',
  title: 'UNS Topic Settings',
  description: 'Controls how Unified Namespace topics are generated for instruments.',
  permissions: { read: 'CONFIG_READ', update: 'CONFIG_UPDATE' },
  requiresReauth: true,
  reauthAction: 'UPDATE_SYSTEM_CONFIG',
  fields: [
    { key: 'prefix', label: 'Topic Prefix', type: 'string', default: 'controlyt',
      help: 'Leading namespace segment, e.g. the company slug. Leave blank to omit.' },
    { key: 'separator', label: 'Separator', type: 'select', default: '/',
      options: [{ value: '/', label: 'Slash (MQTT style)' }, { value: '.', label: 'Dot' }] },
    { key: 'includeGateway', label: 'Include Gateway Segment', type: 'boolean', default: true,
      help: 'When enabled, a gateway-attached instrument includes the gateway slug in its topic.' },
  ],
};

export default unsSettingsDef;
```

> Confirm the exact `ConfigDefinition` field names against an existing def (e.g. `apps/api/src/modules/config/defs/export-limit.def.ts`) before writing — match that file's shape exactly rather than this sketch if they differ.

- [ ] **Step 6: Register the def in discovery**

Add the import alongside the others in `apps/api/src/lib/config-discovery.ts`:

```ts
import './../modules/config/defs/uns-settings.def.js';
```

- [ ] **Step 7: Verify the registry count went 21 → 22**

```bash
cd apps/api && npx tsx src/app.ts 2>&1 | grep "config-registry"
```
Expected: `[config-registry] 22 modules registered`. Stop the server after checking.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/instruments/ apps/api/src/modules/config/defs/uns-settings.def.ts apps/api/src/lib/config-discovery.ts
git commit -m "Add UNS topic resolver and uns-settings config surface"
```

---

## Task 7: Communication profiles module

**Files:**
- Create: `apps/api/src/modules/communication-profiles/routes.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `PERMISSIONS.COMM_PROFILE_*`, reauth actions (Task 2); `Protocol`/`CommunicationProfile` models (Task 4)
- Produces: `GET/POST/PUT/DELETE /api/communication-profiles`, `GET /api/protocols`

- [ ] **Step 1: Write the failing e2e test**

```ts
// apps/api/src/e2e/communication-profiles.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, createTestUser, loginAs } from './test-helper.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let token: string;

beforeAll(async () => {
  app = await buildApp();
  // Own uniquely-named user — never the shared `admin` (single-fork race).
  await createTestUser('commprof_admin', 'SUPER_ADMIN');
  token = await loginAs('commprof_admin');
});
afterAll(async () => { await app.close(); });

const auth = { authorization: `Bearer ${token}` };

describe('communication profiles', () => {
  it('lists the seeded protocol registry', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/protocols', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(18);
  });

  it('creates a profile and MASKS the secret on read', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/communication-profiles', headers: auth,
      payload: {
        name: 'Plant MQTT', protocolKey: 'mqtt',
        config: { brokerUrl: 'mqtts://broker:8883', username: 'svc', password: 'S3cret!', qos: 1 },
      },
    });
    expect(create.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/communication-profiles', headers: auth });
    const profile = list.json().find((p: { name: string }) => p.name === 'Plant MQTT');
    expect(profile.config.password).not.toBe('S3cret!');
    expect(profile.config.brokerUrl).toBe('mqtts://broker:8883');
  });

  it('rejects an unknown protocol key', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/communication-profiles', headers: auth,
      payload: { name: 'Bad', protocolKey: 'opc-da', config: {} },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/api && npx vitest run src/e2e/communication-profiles.test.ts
```
Expected: FAIL — 404 on `/api/protocols`.

- [ ] **Step 3: Implement the routes**

```ts
// apps/api/src/modules/communication-profiles/routes.ts
/**
 * Communication Profiles — reusable per-protocol connection settings.
 *
 * config holds broker credentials and certificates, so every read path goes
 * through maskSecrets(); the masked form is also what lands in audit diffs.
 * Writing a raw secret into an audit row would make it permanently
 * unredactable-in-practice, since audit rows are immutable.
 */
import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { maskSecrets } from '../../lib/mask-secrets.js';
import { sanitizeText } from '../../lib/sanitize.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';

export default async function communicationProfileRoutes(app: FastifyInstance) {

  app.get('/protocols', {
    preHandler: [app.requirePermission('COMM_PROFILE_VIEW')],
    schema: { tags: ['Data Injection'], summary: 'List the protocol registry' },
  }, async () => prisma.protocol.findMany({ orderBy: { name: 'asc' } }));

  app.get('/', {
    preHandler: [app.requirePermission('COMM_PROFILE_VIEW')],
    schema: { tags: ['Data Injection'], summary: 'List communication profiles' },
  }, async () => {
    const rows = await prisma.communicationProfile.findMany({ orderBy: { name: 'asc' } });
    return rows.map(r => ({ ...r, config: maskSecrets(r.config as Record<string, unknown>) }));
  });

  app.post('/', {
    preHandler: [app.requirePermission('COMM_PROFILE_CREATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Create communication profile',
      body: {
        type: 'object', required: ['name', 'protocolKey', 'config'], additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          protocolKey: { type: 'string', minLength: 1, maxLength: 40 },
          config: { type: 'object' },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('CREATE_COMM_PROFILE', req, reply)).ok) return reply;
    const body = req.body as { name: string; protocolKey: string; config: Record<string, unknown> };
    const ctx = buildContext(req);

    const protocol = await prisma.protocol.findUnique({ where: { key: body.protocolKey } });
    if (!protocol) throw new ValidationError(`Unknown protocol '${body.protocolKey}'.`);

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.communicationProfile.create({
        data: {
          name: sanitizeText(body.name),
          protocolKey: body.protocolKey,
          config: body.config,
          createdBy: ctx.userId,
        },
      });
      await auditLog({
        action: 'COMMUNICATION_PROFILE_CREATED', targetType: 'CommunicationProfile', targetId: row.id,
        afterValue: { name: row.name, protocolKey: row.protocolKey, config: maskSecrets(body.config) },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return { ...created, config: maskSecrets(created.config as Record<string, unknown>) };
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('COMM_PROFILE_UPDATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Update communication profile',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          config: { type: 'object' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('UPDATE_COMM_PROFILE', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; config?: Record<string, unknown>; isActive?: boolean };
    const ctx = buildContext(req);

    const before = await prisma.communicationProfile.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Communication profile not found.');

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.communicationProfile.update({
        where: { id },
        data: {
          ...(body.name !== undefined && { name: sanitizeText(body.name) }),
          ...(body.config !== undefined && { config: body.config }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        },
      });
      await auditLog({
        action: 'COMMUNICATION_PROFILE_UPDATED', targetType: 'CommunicationProfile', targetId: id,
        beforeValue: { name: before.name, config: maskSecrets(before.config as Record<string, unknown>), isActive: before.isActive },
        afterValue: { name: row.name, config: maskSecrets(row.config as Record<string, unknown>), isActive: row.isActive },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return { ...updated, config: maskSecrets(updated.config as Record<string, unknown>) };
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission('COMM_PROFILE_DELETE')],
    schema: {
      tags: ['Data Injection'], summary: 'Delete communication profile',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('DELETE_COMM_PROFILE', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);

    const before = await prisma.communicationProfile.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Communication profile not found.');

    await prisma.$transaction(async (tx) => {
      await tx.communicationProfile.delete({ where: { id } });
      await auditLog({
        action: 'COMMUNICATION_PROFILE_DELETED', targetType: 'CommunicationProfile', targetId: id,
        beforeValue: { name: before.name, protocolKey: before.protocolKey },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    return { success: true };
  });
}
```

> `Restrict` on the gateway/instrument foreign keys means deleting an in-use profile raises a Prisma `P2003`. The existing global error handler maps that to a 409; confirm and, if it does not, add an explicit in-use check before the delete.

- [ ] **Step 4: Register the module in `app.ts`**

Add the import next to the others, and the registration in the same block as the existing `app.register(...)` calls:

```ts
import communicationProfileRoutes from './modules/communication-profiles/routes.js';
// ...
await app.register(communicationProfileRoutes, { prefix: '/api/communication-profiles' });
```

> `GET /api/protocols` is intentionally served under the profiles prefix as `/api/communication-profiles/protocols`. **Update the test's URL to match**, or register a second thin route at `/api/protocols` — pick one and keep the test and the route consistent.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/api && npx vitest run src/e2e/communication-profiles.test.ts
```
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/communication-profiles/ apps/api/src/app.ts apps/api/src/e2e/communication-profiles.test.ts
git commit -m "Add communication profiles module with secret masking and audit"
```

---

## Task 8: Audit action constants

**Files:**
- Modify: `apps/api/src/lib/audit-actions.ts`

**Interfaces:**
- Produces: the 15 action keys used by Tasks 7, 9, 10, 11

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/lib/__tests__/data-injection-audit-actions.test.ts
import { describe, it, expect } from 'vitest';
import { AUDIT_ACTIONS } from '../audit-actions.js';

describe('data-injection audit actions', () => {
  it('registers all 15 actions so historic rows render', () => {
    for (const a of [
      'HIERARCHY_NODE_CREATED', 'HIERARCHY_NODE_UPDATED', 'HIERARCHY_NODE_MOVED', 'HIERARCHY_NODE_DELETED',
      'GATEWAY_CREATED', 'GATEWAY_UPDATED', 'GATEWAY_DELETED',
      'INSTRUMENT_CREATED', 'INSTRUMENT_UPDATED', 'INSTRUMENT_DELETED',
      'INSTRUMENT_TOPIC_OVERRIDE_SET', 'INSTRUMENT_TOPIC_OVERRIDE_CLEARED',
      'COMMUNICATION_PROFILE_CREATED', 'COMMUNICATION_PROFILE_UPDATED', 'COMMUNICATION_PROFILE_DELETED',
    ]) expect(AUDIT_ACTIONS, `missing ${a}`).toHaveProperty(a);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/api && npx vitest run src/lib/__tests__/data-injection-audit-actions.test.ts
```
Expected: FAIL on the first missing key.

- [ ] **Step 3: Add the constants**

Open `apps/api/src/lib/audit-actions.ts`, match the existing entry shape exactly (copy the structure of a neighbouring entry — it carries a label and category), and append a `Data Injection` block containing the 15 keys listed in the test.

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/api && npx vitest run src/lib/__tests__/data-injection-audit-actions.test.ts
```
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/audit-actions.ts apps/api/src/lib/__tests__/data-injection-audit-actions.test.ts
git commit -m "Register Data Injection audit action constants"
```

---

## Task 9: Hierarchy routes

**Files:**
- Create: `apps/api/src/modules/hierarchy/routes.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: repository functions (Task 5), permissions (Task 2), audit actions (Task 8)
- Produces: `GET /api/hierarchy`, `POST /api/hierarchy`, `PUT /api/hierarchy/:id`, `POST /api/hierarchy/:id/move`, `DELETE /api/hierarchy/:id`

- [ ] **Step 1: Write the failing e2e test**

```ts
// apps/api/src/e2e/hierarchy.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, createTestUser, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let token: string;

beforeAll(async () => {
  app = await buildApp();
  await createTestUser('hierarchy_admin', 'SUPER_ADMIN');
  token = await loginAs('hierarchy_admin');
});
afterAll(async () => { await app.close(); });

const auth = { authorization: `Bearer ${token}` };
const post = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/hierarchy', headers: auth, payload });

describe('hierarchy routes', () => {
  it('creates a node and writes an audit row', async () => {
    const res = await post({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    expect(res.statusCode).toBe(200);
    expect(res.json().slug).toBe('controlyt');

    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'HIERARCHY_NODE_CREATED', targetId: res.json().id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe('hierarchy_admin');
  });

  it('returns the tree with materialised paths', async () => {
    const co = await post({ parentId: null, level: 'COMPANY', name: 'TreeCo' });
    await post({ parentId: co.json().id, level: 'SITE', name: 'Site One' });
    const res = await app.inject({ method: 'GET', url: '/api/hierarchy', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().some((n: { path: string }) => n.path === 'treeco/site-one')).toBe(true);
  });

  it('rejects a cyclic move with 400', async () => {
    const co = await post({ parentId: null, level: 'COMPANY', name: 'CycleCo' });
    const site = await post({ parentId: co.json().id, level: 'SITE', name: 'CycleSite' });
    const res = await app.inject({
      method: 'POST', url: `/api/hierarchy/${co.json().id}/move`,
      headers: auth, payload: { newParentId: site.json().id },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires HIERARCHY_VIEW — a token without it gets 403', async () => {
    await createTestUser('hierarchy_viewer', 'VIEWER');
    const viewerToken = await loginAs('hierarchy_viewer');
    const res = await app.inject({
      method: 'GET', url: '/api/hierarchy',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/api && npx vitest run src/e2e/hierarchy.test.ts
```
Expected: FAIL — 404.

- [ ] **Step 3: Implement the routes**

```ts
// apps/api/src/modules/hierarchy/routes.ts
/**
 * Hierarchy routes — the location tree (Company→Line) that backs UNS paths.
 * All ltree access is delegated to hierarchy.repository.ts.
 */
import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { sanitizeText } from '../../lib/sanitize.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import {
  createNode, listTree, moveNode, renameNode, type HierarchyLevel,
} from './hierarchy.repository.js';

const LEVELS = ['COMPANY', 'SITE', 'PLANT', 'BUILDING', 'BLOCK', 'AREA', 'LINE'] as const;

export default async function hierarchyRoutes(app: FastifyInstance) {

  app.get('/', {
    preHandler: [app.requirePermission('HIERARCHY_VIEW')],
    schema: { tags: ['Data Injection'], summary: 'List hierarchy nodes (flat, path-ordered)' },
  }, async () => listTree());

  app.post('/', {
    preHandler: [app.requirePermission('HIERARCHY_CREATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Create hierarchy node',
      body: {
        type: 'object', required: ['level', 'name'], additionalProperties: false,
        properties: {
          parentId: { type: ['string', 'null'] },
          level: { type: 'string', enum: [...LEVELS] },
          name: { type: 'string', minLength: 1, maxLength: 100 },
          sortOrder: { type: 'integer' },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('CREATE_HIERARCHY_NODE', req, reply)).ok) return reply;
    const body = req.body as { parentId?: string | null; level: HierarchyLevel; name: string; sortOrder?: number };
    const ctx = buildContext(req);

    const node = await createNode({
      parentId: body.parentId ?? null,
      level: body.level,
      name: sanitizeText(body.name),
      sortOrder: body.sortOrder,
      createdBy: ctx.userId,
    });
    await auditLog({
      action: 'HIERARCHY_NODE_CREATED', targetType: 'HierarchyNode', targetId: node.id,
      afterValue: { name: node.name, level: node.level, path: node.path },
      userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return node;
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('HIERARCHY_UPDATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Rename hierarchy node',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', required: ['name'], additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('UPDATE_HIERARCHY_NODE', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const { name } = req.body as { name: string };
    const ctx = buildContext(req);

    const before = await prisma.hierarchyNode.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Hierarchy node not found.');

    await renameNode(id, sanitizeText(name));
    await auditLog({
      action: 'HIERARCHY_NODE_UPDATED', targetType: 'HierarchyNode', targetId: id,
      beforeValue: { name: before.name, slug: before.slug },
      afterValue: { name },
      userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return { success: true };
  });

  app.post('/:id/move', {
    preHandler: [app.requirePermission('HIERARCHY_UPDATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Reparent a hierarchy node and its subtree',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', required: ['newParentId'], additionalProperties: false,
        properties: { newParentId: { type: ['string', 'null'] } },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('UPDATE_HIERARCHY_NODE', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const { newParentId } = req.body as { newParentId: string | null };
    const ctx = buildContext(req);

    const before = await prisma.hierarchyNode.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Hierarchy node not found.');

    await moveNode(id, newParentId);
    await auditLog({
      action: 'HIERARCHY_NODE_MOVED', targetType: 'HierarchyNode', targetId: id,
      beforeValue: { parentId: before.parentId },
      afterValue: { parentId: newParentId },
      userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return { success: true };
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission('HIERARCHY_DELETE')],
    schema: {
      tags: ['Data Injection'], summary: 'Delete a leaf hierarchy node',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('DELETE_HIERARCHY_NODE', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);

    const before = await prisma.hierarchyNode.findUnique({
      where: { id },
      include: { _count: { select: { children: true, gateways: true, instruments: true } } },
    });
    if (!before) throw new NotFoundError('Hierarchy node not found.');
    const { children, gateways, instruments } = before._count;
    if (children || gateways || instruments) {
      throw new ValidationError(
        `Cannot delete: node still has ${children} child node(s), ${gateways} gateway(s) and ${instruments} instrument(s).`,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.hierarchyNode.delete({ where: { id } });
      await auditLog({
        action: 'HIERARCHY_NODE_DELETED', targetType: 'HierarchyNode', targetId: id,
        beforeValue: { name: before.name, level: before.level },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    return { success: true };
  });
}
```

- [ ] **Step 4: Register in `app.ts`**

```ts
import hierarchyRoutes from './modules/hierarchy/routes.js';
// ...
await app.register(hierarchyRoutes, { prefix: '/api/hierarchy' });
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/api && npx vitest run src/e2e/hierarchy.test.ts
```
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/hierarchy/routes.ts apps/api/src/app.ts apps/api/src/e2e/hierarchy.test.ts
git commit -m "Add hierarchy routes with audit, reauth and cycle protection"
```

---

## Task 10: Gateways module

**Files:**
- Create: `apps/api/src/modules/gateways/routes.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `sanitizeSlug` (Task 5), permissions, audit actions
- Produces: `GET/POST/PUT/DELETE /api/gateways`, `GET /api/gateways/:id/instruments`

- [ ] **Step 1: Write the failing e2e test**

```ts
// apps/api/src/e2e/gateways.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, createTestUser, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let token: string; let nodeId: string; let profileId: string;

beforeAll(async () => {
  app = await buildApp();
  await createTestUser('gateway_admin', 'SUPER_ADMIN');
  token = await loginAs('gateway_admin');
  const auth = { authorization: `Bearer ${token}` };
  nodeId = (await app.inject({ method: 'POST', url: '/api/hierarchy', headers: auth,
    payload: { parentId: null, level: 'COMPANY', name: 'GwCo' } })).json().id;
  profileId = (await app.inject({ method: 'POST', url: '/api/communication-profiles', headers: auth,
    payload: { name: 'GW MQTT', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://b:1883' } } })).json().id;
});
afterAll(async () => { await app.close(); });

const auth = () => ({ authorization: `Bearer ${token}` });

describe('gateways', () => {
  it('creates a gateway, derives its slug and audits it', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/gateways', headers: auth(),
      payload: { name: 'GW 001', code: 'GW001', gatewayType: 'edge',
                 externalId: 'gw-001', hierarchyNodeId: nodeId, communicationProfileId: profileId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().slug).toBe('gw-001');
    expect(await prisma.auditTrail.findFirst({
      where: { action: 'GATEWAY_CREATED', targetId: res.json().id },
    })).not.toBeNull();
  });

  it('rejects a duplicate code', async () => {
    const payload = { name: 'Dup', code: 'DUPGW', gatewayType: 'edge',
                      externalId: 'dup', hierarchyNodeId: nodeId, communicationProfileId: profileId };
    await app.inject({ method: 'POST', url: '/api/gateways', headers: auth(), payload });
    const second = await app.inject({ method: 'POST', url: '/api/gateways', headers: auth(), payload });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/api && npx vitest run src/e2e/gateways.test.ts
```
Expected: FAIL — 404.

- [ ] **Step 3: Implement the routes**

```ts
// apps/api/src/modules/gateways/routes.ts
/**
 * Gateways — a parent device that fronts many child instruments.
 * P1 stores configuration only; payload fan-out arrives in P2 and resolves
 * against Instrument.deviceKey.
 */
import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { sanitizeText } from '../../lib/sanitize.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { sanitizeSlug } from '../hierarchy/hierarchy.repository.js';

export default async function gatewayRoutes(app: FastifyInstance) {

  app.get('/', {
    preHandler: [app.requirePermission('GATEWAY_VIEW')],
    schema: { tags: ['Data Injection'], summary: 'List gateways' },
  }, async () => prisma.gateway.findMany({
    include: { hierarchyNode: { select: { name: true } }, _count: { select: { instruments: true } } },
    orderBy: { name: 'asc' },
  }));

  app.get('/:id/instruments', {
    preHandler: [app.requirePermission('GATEWAY_VIEW')],
    schema: {
      tags: ['Data Injection'], summary: 'List child instruments of a gateway',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return prisma.instrument.findMany({ where: { gatewayId: id }, orderBy: { name: 'asc' } });
  });

  app.post('/', {
    preHandler: [app.requirePermission('GATEWAY_CREATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Create gateway',
      body: {
        type: 'object', additionalProperties: false,
        required: ['name', 'code', 'gatewayType', 'externalId', 'hierarchyNodeId', 'communicationProfileId'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          code: { type: 'string', minLength: 1, maxLength: 50 },
          gatewayType: { type: 'string', minLength: 1, maxLength: 50 },
          externalId: { type: 'string', minLength: 1, maxLength: 100 },
          hierarchyNodeId: { type: 'string' },
          communicationProfileId: { type: 'string' },
          description: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('CREATE_GATEWAY', req, reply)).ok) return reply;
    const b = req.body as Record<string, string>;
    const ctx = buildContext(req);

    const node = await prisma.hierarchyNode.findUnique({ where: { id: b.hierarchyNodeId } });
    if (!node) throw new ValidationError('hierarchyNodeId does not reference an existing node.');

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.gateway.create({
        data: {
          name: sanitizeText(b.name), code: b.code, slug: sanitizeSlug(b.name),
          gatewayType: b.gatewayType, externalId: b.externalId,
          hierarchyNodeId: b.hierarchyNodeId, communicationProfileId: b.communicationProfileId,
          description: b.description ? sanitizeText(b.description) : null,
          createdBy: ctx.userId,
        },
      });
      await auditLog({
        action: 'GATEWAY_CREATED', targetType: 'Gateway', targetId: row.id,
        afterValue: { name: row.name, code: row.code, externalId: row.externalId },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return created;
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('GATEWAY_UPDATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Update gateway',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          gatewayType: { type: 'string', maxLength: 50 },
          externalId: { type: 'string', maxLength: 100 },
          communicationProfileId: { type: 'string' },
          description: { type: 'string', maxLength: 500 },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('UPDATE_GATEWAY', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const ctx = buildContext(req);

    const before = await prisma.gateway.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Gateway not found.');

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.gateway.update({
        where: { id },
        data: {
          ...(b.name !== undefined && { name: sanitizeText(b.name as string), slug: sanitizeSlug(b.name as string) }),
          ...(b.gatewayType !== undefined && { gatewayType: b.gatewayType as string }),
          ...(b.externalId !== undefined && { externalId: b.externalId as string }),
          ...(b.communicationProfileId !== undefined && { communicationProfileId: b.communicationProfileId as string }),
          ...(b.description !== undefined && { description: sanitizeText(b.description as string) }),
          ...(b.isActive !== undefined && { isActive: b.isActive as boolean }),
        },
      });
      await auditLog({
        action: 'GATEWAY_UPDATED', targetType: 'Gateway', targetId: id,
        beforeValue: { name: before.name, externalId: before.externalId, isActive: before.isActive },
        afterValue: { name: row.name, externalId: row.externalId, isActive: row.isActive },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return updated;
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission('GATEWAY_DELETE')],
    schema: {
      tags: ['Data Injection'], summary: 'Delete gateway',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('DELETE_GATEWAY', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);

    const before = await prisma.gateway.findUnique({
      where: { id }, include: { _count: { select: { instruments: true } } },
    });
    if (!before) throw new NotFoundError('Gateway not found.');
    if (before._count.instruments > 0) {
      throw new ValidationError(
        `Cannot delete: ${before._count.instruments} instrument(s) still attached. Reassign or delete them first.`,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.gateway.delete({ where: { id } });
      await auditLog({
        action: 'GATEWAY_DELETED', targetType: 'Gateway', targetId: id,
        beforeValue: { name: before.name, code: before.code },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    return { success: true };
  });
}
```

- [ ] **Step 4: Register in `app.ts`**

```ts
import gatewayRoutes from './modules/gateways/routes.js';
// ...
await app.register(gatewayRoutes, { prefix: '/api/gateways' });
```

- [ ] **Step 5: Run the test**

```bash
cd apps/api && npx vitest run src/e2e/gateways.test.ts
```
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/gateways/ apps/api/src/app.ts apps/api/src/e2e/gateways.test.ts
git commit -m "Add gateways module with child-instrument roster and delete guard"
```

---

## Task 11: Instruments module + resolved topics endpoint

**Files:**
- Create: `apps/api/src/modules/instruments/routes.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `resolveTopics`, `TOPIC_CATEGORIES` (Task 6); `getAncestryPath`, `sanitizeSlug` (Task 5)
- Produces: `GET/POST/PUT/DELETE /api/instruments`, `GET /api/instruments/:id/topics`, `PUT /api/instruments/:id/topics/:category`

- [ ] **Step 1: Write the failing e2e test**

```ts
// apps/api/src/e2e/instruments.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, createTestUser, loginAs } from './test-helper.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let token: string; let areaId: string; let gatewayId: string; let profileId: string;

beforeAll(async () => {
  app = await buildApp();
  await createTestUser('instrument_admin', 'SUPER_ADMIN');
  token = await loginAs('instrument_admin');
  const h = { authorization: `Bearer ${token}` };
  const co = (await app.inject({ method: 'POST', url: '/api/hierarchy', headers: h,
    payload: { parentId: null, level: 'COMPANY', name: 'InstCo' } })).json();
  areaId = (await app.inject({ method: 'POST', url: '/api/hierarchy', headers: h,
    payload: { parentId: co.id, level: 'AREA', name: 'Area 02' } })).json().id;
  profileId = (await app.inject({ method: 'POST', url: '/api/communication-profiles', headers: h,
    payload: { name: 'Inst MQTT', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://b:1883' } } })).json().id;
  gatewayId = (await app.inject({ method: 'POST', url: '/api/gateways', headers: h,
    payload: { name: 'GW 001', code: 'IGW001', gatewayType: 'edge', externalId: 'igw-001',
               hierarchyNodeId: areaId, communicationProfileId: profileId } })).json().id;
});
afterAll(async () => { await app.close(); });

const auth = () => ({ authorization: `Bearer ${token}` });

describe('instruments', () => {
  it('creates a gateway-attached instrument and derives 13 topics', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { name: 'TEMP001', code: 'TEMP001', instrumentType: 'temperature-sensor',
                 hierarchyNodeId: areaId, gatewayId, deviceKey: 'temp001' },
    });
    expect(res.statusCode).toBe(200);

    const topics = await app.inject({
      method: 'GET', url: `/api/instruments/${res.json().id}/topics`, headers: auth(),
    });
    const body = topics.json();
    expect(Object.keys(body)).toHaveLength(13);
    expect(body.TELEMETRY).toBe('controlyt/instco/area-02/gw-001/temp001/telemetry');
  });

  it('rejects an independent instrument with no profile (CHECK constraint)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { name: 'Orphan', code: 'ORPHAN1', instrumentType: 'sensor',
                 hierarchyNodeId: areaId },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a duplicate deviceKey within one gateway', async () => {
    const payload = { name: 'Dup A', code: 'DUPA', instrumentType: 'sensor',
                      hierarchyNodeId: areaId, gatewayId, deviceKey: 'shared-key' };
    await app.inject({ method: 'POST', url: '/api/instruments', headers: auth(), payload });
    const second = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { ...payload, name: 'Dup B', code: 'DUPB' },
    });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('honours a topic override', async () => {
    const inst = (await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth(),
      payload: { name: 'OVR001', code: 'OVR001', instrumentType: 'sensor',
                 hierarchyNodeId: areaId, gatewayId, deviceKey: 'ovr001' },
    })).json();
    await app.inject({
      method: 'PUT', url: `/api/instruments/${inst.id}/topics/TELEMETRY`, headers: auth(),
      payload: { customTopic: 'legacy/raw/ovr001', qos: 2, retain: true, enabled: true },
    });
    const topics = (await app.inject({
      method: 'GET', url: `/api/instruments/${inst.id}/topics`, headers: auth(),
    })).json();
    expect(topics.TELEMETRY).toBe('legacy/raw/ovr001');
    expect(topics.ALARM).toContain('controlyt/');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd apps/api && npx vitest run src/e2e/instruments.test.ts
```
Expected: FAIL — 404.

- [ ] **Step 3: Implement the routes**

```ts
// apps/api/src/modules/instruments/routes.ts
/**
 * Instruments — sensors, PLCs, meters and other addressable devices.
 *
 * An instrument either hangs off a gateway (inheriting its profile) or
 * communicates independently (and must carry its own profile). That is enforced
 * both here and by the instruments_reachable_chk CHECK constraint.
 */
import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { sanitizeText } from '../../lib/sanitize.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { getAncestryPath, sanitizeSlug } from '../hierarchy/hierarchy.repository.js';
import { resolveTopics, TOPIC_CATEGORIES, type TopicCategory, type UnsSettings } from './topic-resolver.js';
import { getConfigValue } from '../../lib/config-registry.js';

const DEFAULT_UNS: UnsSettings = { prefix: 'controlyt', separator: '/', includeGateway: true };

async function unsSettings(): Promise<UnsSettings> {
  const stored = await getConfigValue('uns-settings');
  return { ...DEFAULT_UNS, ...(stored as Partial<UnsSettings> | null ?? {}) };
}

export default async function instrumentRoutes(app: FastifyInstance) {

  app.get('/', {
    preHandler: [app.requirePermission('INSTRUMENT_VIEW')],
    schema: { tags: ['Data Injection'], summary: 'List instruments' },
  }, async () => prisma.instrument.findMany({
    include: {
      hierarchyNode: { select: { name: true } },
      gateway: { select: { name: true, slug: true } },
    },
    orderBy: { name: 'asc' },
  }));

  app.get('/:id/topics', {
    preHandler: [app.requirePermission('INSTRUMENT_VIEW')],
    schema: {
      tags: ['Data Injection'], summary: 'Resolved UNS topics for an instrument',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = await prisma.instrument.findUnique({
      where: { id }, include: { gateway: true, topics: true },
    });
    if (!inst) throw new NotFoundError('Instrument not found.');

    const overrides: Partial<Record<TopicCategory, string>> = {};
    for (const t of inst.topics) {
      if (t.customTopic) overrides[t.category as TopicCategory] = t.customTopic;
    }
    return resolveTopics({
      settings: await unsSettings(),
      ancestry: await getAncestryPath(inst.hierarchyNodeId),
      gatewaySlug: inst.gateway?.slug ?? null,
      instrumentSlug: inst.slug,
      overrides,
    });
  });

  app.post('/', {
    preHandler: [app.requirePermission('INSTRUMENT_CREATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Create instrument',
      body: {
        type: 'object', additionalProperties: false,
        required: ['name', 'code', 'instrumentType', 'hierarchyNodeId'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          code: { type: 'string', minLength: 1, maxLength: 50 },
          instrumentType: { type: 'string', minLength: 1, maxLength: 50 },
          manufacturer: { type: 'string', maxLength: 100 },
          model: { type: 'string', maxLength: 100 },
          serialNumber: { type: 'string', maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          hierarchyNodeId: { type: 'string' },
          gatewayId: { type: ['string', 'null'] },
          deviceKey: { type: ['string', 'null'], maxLength: 100 },
          communicationProfileId: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('CREATE_INSTRUMENT', req, reply)).ok) return reply;
    const b = req.body as Record<string, string | null>;
    const ctx = buildContext(req);

    // Mirror of the instruments_reachable_chk CHECK constraint, surfaced as a
    // readable 400 rather than a raw Postgres violation.
    if (!b.gatewayId && !b.communicationProfileId) {
      throw new ValidationError(
        'An instrument with no gateway must have its own communication profile.',
      );
    }
    if (b.gatewayId && !b.deviceKey) {
      throw new ValidationError(
        'A gateway-attached instrument needs a deviceKey so inbound payloads can be routed to it.',
      );
    }

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.instrument.create({
        data: {
          name: sanitizeText(b.name!), code: b.code!, slug: sanitizeSlug(b.name!),
          instrumentType: b.instrumentType!,
          manufacturer: b.manufacturer ?? null, model: b.model ?? null,
          serialNumber: b.serialNumber ?? null,
          description: b.description ? sanitizeText(b.description) : null,
          hierarchyNodeId: b.hierarchyNodeId!,
          gatewayId: b.gatewayId ?? null, deviceKey: b.deviceKey ?? null,
          communicationProfileId: b.communicationProfileId ?? null,
          createdBy: ctx.userId,
        },
      });
      await auditLog({
        action: 'INSTRUMENT_CREATED', targetType: 'Instrument', targetId: row.id,
        afterValue: { name: row.name, code: row.code, gatewayId: row.gatewayId, deviceKey: row.deviceKey },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return created;
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Update instrument',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          instrumentType: { type: 'string', maxLength: 50 },
          manufacturer: { type: 'string', maxLength: 100 },
          model: { type: 'string', maxLength: 100 },
          serialNumber: { type: 'string', maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          deviceKey: { type: ['string', 'null'], maxLength: 100 },
          communicationProfileId: { type: ['string', 'null'] },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('UPDATE_INSTRUMENT', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const ctx = buildContext(req);

    const before = await prisma.instrument.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Instrument not found.');

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.instrument.update({
        where: { id },
        data: {
          ...(b.name !== undefined && { name: sanitizeText(b.name as string), slug: sanitizeSlug(b.name as string) }),
          ...(b.instrumentType !== undefined && { instrumentType: b.instrumentType as string }),
          ...(b.manufacturer !== undefined && { manufacturer: b.manufacturer as string }),
          ...(b.model !== undefined && { model: b.model as string }),
          ...(b.serialNumber !== undefined && { serialNumber: b.serialNumber as string }),
          ...(b.description !== undefined && { description: sanitizeText(b.description as string) }),
          ...(b.deviceKey !== undefined && { deviceKey: b.deviceKey as string | null }),
          ...(b.communicationProfileId !== undefined && { communicationProfileId: b.communicationProfileId as string | null }),
          ...(b.isActive !== undefined && { isActive: b.isActive as boolean }),
        },
      });
      await auditLog({
        action: 'INSTRUMENT_UPDATED', targetType: 'Instrument', targetId: id,
        beforeValue: { name: before.name, deviceKey: before.deviceKey, isActive: before.isActive },
        afterValue: { name: row.name, deviceKey: row.deviceKey, isActive: row.isActive },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return updated;
  });

  app.put('/:id/topics/:category', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Set a per-instrument topic override',
      params: {
        type: 'object', required: ['id', 'category'],
        properties: { id: { type: 'string' }, category: { type: 'string', enum: [...TOPIC_CATEGORIES] } },
      },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          customTopic: { type: ['string', 'null'], maxLength: 500 },
          qos: { type: 'integer', minimum: 0, maximum: 2 },
          retain: { type: 'boolean' },
          enabled: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('UPDATE_INSTRUMENT', req, reply)).ok) return reply;
    const { id, category } = req.params as { id: string; category: TopicCategory };
    const b = req.body as { customTopic?: string | null; qos?: number; retain?: boolean; enabled?: boolean };
    const ctx = buildContext(req);

    const inst = await prisma.instrument.findUnique({ where: { id } });
    if (!inst) throw new NotFoundError('Instrument not found.');

    const row = await prisma.$transaction(async (tx) => {
      const saved = await tx.instrumentTopic.upsert({
        where: { instrumentId_category: { instrumentId: id, category } },
        create: {
          instrumentId: id, category,
          customTopic: b.customTopic ?? null,
          qos: b.qos ?? 1, retain: b.retain ?? false, enabled: b.enabled ?? true,
        },
        update: {
          ...(b.customTopic !== undefined && { customTopic: b.customTopic }),
          ...(b.qos !== undefined && { qos: b.qos }),
          ...(b.retain !== undefined && { retain: b.retain }),
          ...(b.enabled !== undefined && { enabled: b.enabled }),
        },
      });
      await auditLog({
        action: b.customTopic ? 'INSTRUMENT_TOPIC_OVERRIDE_SET' : 'INSTRUMENT_TOPIC_OVERRIDE_CLEARED',
        targetType: 'InstrumentTopic', targetId: saved.id,
        afterValue: { instrumentId: id, category, customTopic: saved.customTopic, qos: saved.qos, retain: saved.retain },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return saved;
    });
    return row;
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_DELETE')],
    schema: {
      tags: ['Data Injection'], summary: 'Delete instrument',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('DELETE_INSTRUMENT', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);

    const before = await prisma.instrument.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Instrument not found.');

    await prisma.$transaction(async (tx) => {
      await tx.instrument.delete({ where: { id } });   // topics + settings cascade
      await auditLog({
        action: 'INSTRUMENT_DELETED', targetType: 'Instrument', targetId: id,
        beforeValue: { name: before.name, code: before.code },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    return { success: true };
  });
}
```

> `getConfigValue` is assumed to exist on `lib/config-registry.ts`. **Verify its real name and signature** before writing — if it differs, use the actual accessor and keep the `DEFAULT_UNS` fallback behaviour.

- [ ] **Step 4: Register in `app.ts`**

```ts
import instrumentRoutes from './modules/instruments/routes.js';
// ...
await app.register(instrumentRoutes, { prefix: '/api/instruments' });
```

- [ ] **Step 5: Run the test**

```bash
cd apps/api && npx vitest run src/e2e/instruments.test.ts
```
Expected: 4 passed.

- [ ] **Step 6: Run the whole API suite — failures must not exceed baseline**

```bash
cd apps/api && npm test 2>&1 | tail -5
```
Expected: failures ≤ your Task 1 API baseline (14).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/instruments/routes.ts apps/api/src/app.ts apps/api/src/e2e/instruments.test.ts
git commit -m "Add instruments module with derived UNS topics and reachability guard"
```

---

## Task 12: Frontend — routes, sidebar, dashboard

**Files:**
- Create: `apps/web/src/routes/data-injection/index.tsx`
- Modify: `apps/web/src/main.tsx`

**Interfaces:**
- Consumes: `useCan` node ids from Task 3; the API endpoints from Tasks 7–11
- Produces: the `/data-injection` route tree that Tasks 13–14 add pages to

- [ ] **Step 1: Write the dashboard page**

```tsx
// apps/web/src/routes/data-injection/index.tsx
import useSWR from 'swr';
import { Link } from 'react-router-dom';
import { useCan } from '@/hooks/use-can';

interface CountCard { label: string; count: number; to: string; visible: boolean }

export default function DataInjectionDashboard() {
  const can = useCan();
  const { data: instruments } = useSWR<unknown[]>(can('instruments.view') ? '/api/instruments' : null);
  const { data: gateways } = useSWR<unknown[]>(can('gateways.view') ? '/api/gateways' : null);
  const { data: profiles } = useSWR<unknown[]>(can('comm_profiles.view') ? '/api/communication-profiles' : null);
  const { data: nodes } = useSWR<unknown[]>(can('hierarchy.view') ? '/api/hierarchy' : null);

  const cards: CountCard[] = [
    { label: 'Instruments', count: instruments?.length ?? 0, to: '/data-injection/instruments', visible: can('instruments.view') },
    { label: 'Gateways', count: gateways?.length ?? 0, to: '/data-injection/gateways', visible: can('gateways.view') },
    { label: 'Communication Profiles', count: profiles?.length ?? 0, to: '/data-injection/profiles', visible: can('comm_profiles.view') },
    { label: 'Hierarchy Nodes', count: nodes?.length ?? 0, to: '/data-injection/hierarchy', visible: can('hierarchy.view') },
  ];

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Data Injection</h1>
      <p className="mt-1 text-sm text-slate-500">
        Instruments, gateways and industrial communication configuration.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.filter(c => c.visible).map(c => (
          <Link key={c.label} to={c.to}
            className="rounded-lg border border-slate-200 bg-white p-5 transition hover:border-slate-300 hover:shadow-sm
                       focus-visible:ring-2 focus-visible:ring-offset-2">
            <div className="text-3xl font-semibold text-slate-900">{c.count}</div>
            <div className="mt-1 text-sm text-slate-600">{c.label}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

> **Conditional SWR keys are deliberate.** Passing `null` when the user lacks the permission prevents a 403 storm in the console for lower roles — the established convention in this codebase.

- [ ] **Step 2: Register the routes in `main.tsx`**

Add the lazy imports beside the existing ones and five `<Route>` entries inside the authenticated layout, matching the surrounding `<RequireRole>` style:

```tsx
const DataInjectionDashboard = lazy(() => import('./routes/data-injection/index'));
const HierarchyPage = lazy(() => import('./routes/data-injection/hierarchy'));
const GatewaysPage = lazy(() => import('./routes/data-injection/gateways'));
const InstrumentsPage = lazy(() => import('./routes/data-injection/instruments'));
const ProfilesPage = lazy(() => import('./routes/data-injection/profiles'));
```

```tsx
<Route path="/data-injection" element={<RequireRole permissions={[PERMISSIONS.INSTRUMENT_VIEW]}><DataInjectionDashboard /></RequireRole>} />
<Route path="/data-injection/hierarchy" element={<RequireRole permissions={[PERMISSIONS.HIERARCHY_VIEW]}><HierarchyPage /></RequireRole>} />
<Route path="/data-injection/gateways" element={<RequireRole permissions={[PERMISSIONS.GATEWAY_VIEW]}><GatewaysPage /></RequireRole>} />
<Route path="/data-injection/instruments" element={<RequireRole permissions={[PERMISSIONS.INSTRUMENT_VIEW]}><InstrumentsPage /></RequireRole>} />
<Route path="/data-injection/profiles" element={<RequireRole permissions={[PERMISSIONS.COMM_PROFILE_VIEW]}><ProfilesPage /></RequireRole>} />
```

- [ ] **Step 3: Create the four remaining pages as minimal stubs so the build passes**

Each of `hierarchy.tsx`, `gateways.tsx`, `instruments.tsx`, `profiles.tsx` gets a placeholder now; Tasks 13–14 fill them in:

```tsx
export default function Page() {
  return <div className="p-6 text-slate-500">Loading…</div>;
}
```

- [ ] **Step 4: Verify the route count is 43 and the build succeeds**

```bash
cd apps/web && grep -cE "<Route" src/main.tsx && npx vite build
```
Expected: `43`, and a successful build.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/data-injection/ apps/web/src/main.tsx
git commit -m "Add Data Injection route tree, sidebar entry and dashboard"
```

---

## Task 13: Frontend — hierarchy tree page

**Files:**
- Modify: `apps/web/src/routes/data-injection/hierarchy.tsx`

**Interfaces:**
- Consumes: `GET/POST/PUT/DELETE /api/hierarchy`, `POST /api/hierarchy/:id/move`

- [ ] **Step 1: Implement the tree page**

```tsx
// apps/web/src/routes/data-injection/hierarchy.tsx
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { useCan } from '@/hooks/use-can';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';

const LEVELS = ['COMPANY', 'SITE', 'PLANT', 'BUILDING', 'BLOCK', 'AREA', 'LINE'] as const;
type Level = (typeof LEVELS)[number];

interface Node {
  id: string; parentId: string | null; level: Level;
  name: string; slug: string; path: string; isActive: boolean;
}

export default function HierarchyPage() {
  const can = useCan();
  const { toast } = useToast();
  const { data: nodes, mutate, isLoading } = useSWR<Node[]>('/api/hierarchy');
  const [parentId, setParentId] = useState<string | null>(null);
  const [level, setLevel] = useState<Level>('COMPANY');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  // Path-ordered from the API, so depth is derivable without building a tree.
  const rows = useMemo(
    () => (nodes ?? []).map(n => ({ ...n, depth: n.path.split('/').length - 1 })),
    [nodes],
  );

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await apiClient.post('/api/hierarchy', { parentId, level, name });
      toast({ title: 'Node created', variant: 'success' });
      setName('');
      await mutate();
    } catch (e) {
      toast({ title: 'Could not create node', description: (e as Error).message, variant: 'error' });
    } finally { setBusy(false); }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;
    try {
      await apiClient.delete(`/api/hierarchy/${id}`);
      toast({ title: 'Node deleted', variant: 'success' });
      await mutate();
    } catch (e) {
      toast({ title: 'Could not delete node', description: (e as Error).message, variant: 'error' });
    }
  }

  if (isLoading) return <div className="p-6 text-slate-500">Loading hierarchy…</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Hierarchy</h1>
      <p className="mt-1 text-sm text-slate-500">
        The location tree that UNS topic paths are derived from. A skipped level is simply omitted.
      </p>

      {can('hierarchy.create') && (
        <div className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <label className="flex flex-col text-sm">
            <span className="mb-1 text-slate-600">Parent</span>
            <select className="rounded border border-slate-300 px-2 py-1.5"
              value={parentId ?? ''} onChange={e => setParentId(e.target.value || null)}>
              <option value="">(root)</option>
              {rows.map(n => <option key={n.id} value={n.id}>{' '.repeat(n.depth * 2)}{n.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 text-slate-600">Level</span>
            <select className="rounded border border-slate-300 px-2 py-1.5"
              value={level} onChange={e => setLevel(e.target.value as Level)}>
              {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 text-slate-600">Name</span>
            <input className="rounded border border-slate-300 px-2 py-1.5" value={name}
              onChange={e => setName(e.target.value)} placeholder="e.g. Plant 01" />
          </label>
          <button onClick={create} disabled={busy || !name.trim()}
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40">
            Add node
          </button>
        </div>
      )}

      <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
            <tr><th className="p-3">Name</th><th className="p-3">Level</th><th className="p-3">UNS path</th><th className="p-3" /></tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={4} className="p-6 text-center text-slate-400">No hierarchy nodes yet.</td></tr>
            )}
            {rows.map(n => (
              <tr key={n.id} className="border-b border-slate-100 last:border-0">
                <td className="p-3" style={{ paddingLeft: `${12 + n.depth * 20}px` }}>{n.name}</td>
                <td className="p-3 text-slate-500">{n.level}</td>
                <td className="p-3 font-mono text-xs text-slate-500">{n.path}</td>
                <td className="p-3 text-right">
                  {can('hierarchy.delete') && (
                    <button onClick={() => remove(n.id, n.name)}
                      className="text-xs text-red-600 hover:underline">Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

> Drag-and-drop reordering calls `POST /api/hierarchy/:id/move`, which already exists. It is deliberately **not** built in P1 — the indented table plus the move endpoint covers the functional need; the drag interaction is a P4 UI refinement.

- [ ] **Step 2: Verify against the running app**

```bash
cd /c/Users/hello/compliance-core && ./start-app.bat -SkipBrowser
```
Open `https://localhost:5176/data-injection/hierarchy`, log in as `superadmin`. Create Company "Controlyt" → Site "India" → Area "Area 02". Confirm the UNS path column reads `controlyt`, `controlyt/india`, `controlyt/india/area-02`, and that **the browser console is clean** — no 403s, no unhandled rejections.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/data-injection/hierarchy.tsx
git commit -m "Add hierarchy tree page with UNS path column"
```

---

## Task 14: Frontend — instruments list, 3-step wizard, gateways, profiles

**Files:**
- Modify: `apps/web/src/routes/data-injection/instruments.tsx`
- Create: `apps/web/src/routes/data-injection/instrument-wizard.tsx`
- Modify: `apps/web/src/routes/data-injection/gateways.tsx`
- Modify: `apps/web/src/routes/data-injection/profiles.tsx`
- Modify: `apps/web/src/main.tsx` (one more route)

**Interfaces:**
- Consumes: all Data Injection endpoints
- Produces: the P1 UI surface

- [ ] **Step 1: Build the 3-step wizard**

```tsx
// apps/web/src/routes/data-injection/instrument-wizard.tsx
import { useState } from 'react';
import useSWR from 'swr';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';

interface Option { id: string; name: string; path?: string; slug?: string }

const TYPES = [
  'temperature-sensor', 'humidity-sensor', 'pressure-sensor', 'flow-meter',
  'energy-meter', 'plc', 'controller', 'rfid-reader', 'vfd', 'analyzer', 'custom',
];

export default function InstrumentWizard() {
  const nav = useNavigate();
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: '', code: '', description: '', instrumentType: TYPES[0],
    manufacturer: '', model: '', serialNumber: '',
    hierarchyNodeId: '', communicationProfileId: '',
    gatewayEnabled: false, gatewayId: '', deviceKey: '',
  });

  const { data: nodes } = useSWR<Option[]>('/api/hierarchy');
  const { data: profiles } = useSWR<Option[]>('/api/communication-profiles');
  const { data: gateways } = useSWR<Option[]>('/api/gateways');

  const set = (k: keyof typeof form, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));

  const step1Valid = form.name.trim() && form.code.trim() && form.hierarchyNodeId;
  const step3Valid = form.gatewayEnabled
    ? Boolean(form.gatewayId && form.deviceKey.trim())
    : Boolean(form.communicationProfileId);

  async function submit() {
    setBusy(true);
    try {
      await apiClient.post('/api/instruments', {
        name: form.name, code: form.code, instrumentType: form.instrumentType,
        manufacturer: form.manufacturer || undefined, model: form.model || undefined,
        serialNumber: form.serialNumber || undefined, description: form.description || undefined,
        hierarchyNodeId: form.hierarchyNodeId,
        gatewayId: form.gatewayEnabled ? form.gatewayId : null,
        deviceKey: form.gatewayEnabled ? form.deviceKey : null,
        communicationProfileId: form.gatewayEnabled ? null : form.communicationProfileId,
      });
      toast({ title: 'Instrument created', variant: 'success' });
      nav('/data-injection/instruments');
    } catch (e) {
      toast({ title: 'Could not create instrument', description: (e as Error).message, variant: 'error' });
    } finally { setBusy(false); }
  }

  const field = 'w-full rounded border border-slate-300 px-2 py-1.5 text-sm';

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-slate-900">Create Instrument</h1>

      <ol className="mt-4 flex gap-2 text-xs" role="group" aria-label="Wizard progress">
        {['Basic details', 'Communication', 'Gateway'].map((label, i) => (
          <li key={label} aria-current={step === i + 1 ? 'step' : undefined}
            className={`flex-1 rounded px-3 py-2 text-center ${
              step === i + 1 ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      <div className="mt-6 space-y-4 rounded-lg border border-slate-200 bg-white p-5">
        {step === 1 && (
          <>
            <label className="block text-sm">Instrument Name
              <input className={field} value={form.name} onChange={e => set('name', e.target.value)} /></label>
            <label className="block text-sm">Instrument Code
              <input className={field} value={form.code} onChange={e => set('code', e.target.value)} /></label>
            <label className="block text-sm">Type
              <select className={field} value={form.instrumentType} onChange={e => set('instrumentType', e.target.value)}>
                {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select></label>
            <label className="block text-sm">Manufacturer
              <input className={field} value={form.manufacturer} onChange={e => set('manufacturer', e.target.value)} /></label>
            <label className="block text-sm">Model
              <input className={field} value={form.model} onChange={e => set('model', e.target.value)} /></label>
            <label className="block text-sm">Serial Number
              <input className={field} value={form.serialNumber} onChange={e => set('serialNumber', e.target.value)} /></label>
            <label className="block text-sm">Location (hierarchy node)
              <select className={field} value={form.hierarchyNodeId} onChange={e => set('hierarchyNodeId', e.target.value)}>
                <option value="">Select…</option>
                {(nodes ?? []).map(n => <option key={n.id} value={n.id}>{n.path}</option>)}
              </select></label>
          </>
        )}

        {step === 2 && (
          <label className="block text-sm">Communication Profile
            <select className={field} value={form.communicationProfileId}
              onChange={e => set('communicationProfileId', e.target.value)}>
              <option value="">Select…</option>
              {(profiles ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <span className="mt-1 block text-xs text-slate-500">
              Ignored if this instrument sits behind a gateway — it inherits the gateway's profile.
            </span>
          </label>
        )}

        {step === 3 && (
          <>
            <fieldset>
              <legend className="text-sm text-slate-700">Gateway Enabled?</legend>
              <div className="mt-2 flex gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" checked={form.gatewayEnabled} onChange={() => set('gatewayEnabled', true)} /> Yes
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={!form.gatewayEnabled} onChange={() => set('gatewayEnabled', false)} /> No
                </label>
              </div>
            </fieldset>
            {form.gatewayEnabled ? (
              <>
                <label className="block text-sm">Gateway
                  <select className={field} value={form.gatewayId} onChange={e => set('gatewayId', e.target.value)}>
                    <option value="">Select…</option>
                    {(gateways ?? []).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select></label>
                <label className="block text-sm">Device Key
                  <input className={field} value={form.deviceKey} onChange={e => set('deviceKey', e.target.value)} />
                  <span className="mt-1 block text-xs text-slate-500">
                    How this device is addressed inside the gateway's payload. Must be unique within the gateway.
                  </span></label>
              </>
            ) : (
              <p className="text-sm text-slate-500">
                This instrument communicates independently and will use the profile chosen in step 2.
              </p>
            )}
          </>
        )}
      </div>

      <div className="mt-4 flex justify-between">
        <button onClick={() => setStep(s => Math.max(1, s - 1))} disabled={step === 1}
          className="rounded border border-slate-300 px-4 py-2 text-sm disabled:opacity-40">Back</button>
        {step < 3 ? (
          <button onClick={() => setStep(s => s + 1)} disabled={step === 1 && !step1Valid}
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40">Next</button>
        ) : (
          <button onClick={submit} disabled={busy || !step3Valid}
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40">Create instrument</button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the wizard route to `main.tsx`**

```tsx
const InstrumentWizard = lazy(() => import('./routes/data-injection/instrument-wizard'));
// ...
<Route path="/data-injection/instruments/create" element={<RequireRole permissions={[PERMISSIONS.INSTRUMENT_CREATE]}><InstrumentWizard /></RequireRole>} />
```

Route count becomes **44**. Update the Task 12 expectation accordingly.

- [ ] **Step 3: Build the instruments list**

```tsx
// apps/web/src/routes/data-injection/instruments.tsx
import useSWR from 'swr';
import { Link } from 'react-router-dom';
import { useCan } from '@/hooks/use-can';

interface Row {
  id: string; name: string; code: string; instrumentType: string;
  deviceKey: string | null; isActive: boolean;
  hierarchyNode: { name: string } | null;
  gateway: { name: string } | null;
}

export default function InstrumentsPage() {
  const can = useCan();
  const { data, isLoading } = useSWR<Row[]>('/api/instruments');

  if (isLoading) return <div className="p-6 text-slate-500">Loading instruments…</div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Instruments</h1>
        {can('instruments.create') && (
          <Link to="/data-injection/instruments/create"
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white">Create Instrument</Link>
        )}
      </div>
      <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
            <tr>
              <th className="p-3">Name</th><th className="p-3">Code</th><th className="p-3">Type</th>
              <th className="p-3">Location</th><th className="p-3">Gateway</th>
              <th className="p-3">Device key</th><th className="p-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-400">No instruments yet.</td></tr>
            )}
            {(data ?? []).map(r => (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="p-3">{r.name}</td>
                <td className="p-3 font-mono text-xs">{r.code}</td>
                <td className="p-3 text-slate-500">{r.instrumentType}</td>
                <td className="p-3 text-slate-500">{r.hierarchyNode?.name ?? '—'}</td>
                <td className="p-3 text-slate-500">{r.gateway?.name ?? 'Independent'}</td>
                <td className="p-3 font-mono text-xs text-slate-500">{r.deviceKey ?? '—'}</td>
                <td className="p-3">
                  <span className={`rounded px-2 py-0.5 text-xs ${
                    r.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                    {r.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Build gateways and profiles list pages**

Both follow the exact table structure in Step 3. `gateways.tsx` fetches `/api/gateways` and shows Name, Code, Type, External ID, Location, Instrument count, Status. `profiles.tsx` fetches `/api/communication-profiles` and shows Name, Protocol, Status — and **must never render `config` values**, since they are masked secrets.

- [ ] **Step 5: Verify in the browser**

Start the app, then at `https://localhost:5176/data-injection/instruments/create`:
1. Create a communication profile and a gateway first.
2. Walk the wizard: step 1 (name/code/location) → step 2 (profile) → step 3 (Gateway Enabled = Yes, pick gateway, device key `temp001`).
3. Confirm the instrument appears in the list, and that `GET /api/instruments/<id>/topics` returns 13 topics with the expected UNS path.
4. **Confirm the console is clean** — no 403s, no unhandled rejections, no React key warnings.

- [ ] **Step 6: Full verification sweep**

```bash
cd apps/web && npx vite build && npx vitest run 2>&1 | tail -3
cd ../api && npm test 2>&1 | tail -3
cd ../.. && node scripts/ci-test-gate.mjs; echo "gate exit=$?"
```
Expected: build succeeds; failures at or below baseline; `gate exit=0`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/data-injection/ apps/web/src/main.tsx
git commit -m "Add instruments list, 3-step create wizard, gateways and profiles pages"
```

---

## Task 15: Documentation sync

**Files:**
- Modify: `docs/recreation/02-inventory/README.md`
- Modify: `docs/recreation/04-roles-permissions/README.md`
- Modify: `docs/recreation/05-database/README.md`
- Modify: `docs/recreation/06-api/README.md`
- Modify: `docs/recreation/07-ui/README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the finished implementation

- [ ] **Step 1: Re-derive every count from live code**

```bash
cd /c/Users/hello/compliance-core
grep -cE "^model " apps/api/prisma/schema.prisma
grep -cE "^enum " apps/api/prisma/schema.prisma
ls apps/api/src/modules/ | wc -l
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts
grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts
grep -cE "<Route" apps/web/src/main.tsx
ls apps/api/src/modules/config/defs/*.def.ts | wc -l
curl -sk https://localhost:3001/docs/json | jq '.paths | length'
```

Expected: `30`, `8`, `22`, `46`, `51`, `44`, `22`, and a path count ~139 + the new routes.

- [ ] **Step 2: Update the dossier with the observed numbers**

Update **only** `docs/recreation/`. **Do not touch the root docs** (`CLAUDE.md`, `PROJECT_ARCHITECTURE.md`, `API_REFERENCE.md`, `BACKEND_GUIDE.md`, `FRONTEND_GUIDE.md`) — they describe pre-strip DigiLog and are wholesale wrong. Editing port numbers or counts inside them makes them look maintained while everything else in them stays false.

Add a "Data Injection (P1)" subsection to `02-inventory`, the new group to `04-roles-permissions`, the 7 models to `05-database`, the new paths to `06-api`, and the 6 routes to `07-ui`.

- [ ] **Step 3: Add a CHANGELOG entry**

Record: the 7 models, the `ltree` hierarchy, derived-topic design, the audit boundary decision (config audited, telemetry not), the protocol registry seeded but all disabled, and that **no protocol adapter exists yet**.

- [ ] **Step 4: Commit**

```bash
git add docs/recreation/ CHANGELOG.md
git commit -m "Sync recreation dossier and changelog for Data Injection P1"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §2 conflicts (multi-tenant, dark mode, HA, brokers, OPC-DA) | Recorded in Global Constraints; OPC-DA excluded from the registry seed in Task 4 |
| §4 D1 audit boundary | Every mutating route in Tasks 7, 9, 10, 11 calls `auditLog`; Task 8 registers the actions |
| §4 D3 partitioning | Deferred to P3 by design; no P1 task — telemetry tables are out of P1 scope |
| §4 D4 ltree hierarchy | Tasks 4, 5 |
| §4 D5 derived topics | Task 6, consumed in Task 11 |
| §5.1 module layout | Tasks 7, 9, 10, 11 |
| §5.2 schema | Task 4 |
| §5.3 topic derivation + `uns-settings` | Task 6 |
| §6 RBAC | Tasks 2, 3 |
| §7 audit + secret masking | Tasks 7, 8 |
| §8 UI | Tasks 12, 13, 14 |
| §9 testing + CI | Task 1; per-task tests throughout |
| §10 migration | Task 4 |
| §11 R1/R2 ltree risks | Task 5 tests cover move, rename, cycle |

**Placeholder scan.** No TBD/TODO. Three steps carry explicit *verify-before-writing* notes (`ConfigDefinition` shape in Task 6, `getConfigValue` in Task 11, `/api/protocols` prefix in Task 7) — these are deliberate: they name the exact file to check and what to do if it differs, rather than inventing a signature I have not read.

**Type consistency.** `sanitizeSlug` (Task 5) is imported unchanged by Tasks 9, 10, 11. `resolveTopics` / `TOPIC_CATEGORIES` / `UnsSettings` (Task 6) are consumed with matching signatures in Task 11. `HierarchyLevel` is defined in Task 5 and re-used in Task 9. Node ids in Task 3 (`instruments.create`, `hierarchy.delete`, …) match every `can(...)` call in Tasks 12–14.

**Known count correction.** Task 12 states 43 routes; Task 14 adds the wizard route, making **44**. Task 14 Step 2 flags this explicitly.
