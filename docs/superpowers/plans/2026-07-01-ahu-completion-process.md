# AHU Cleaning Completion Process — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global config (`Interlock` / `Popup` / `None`, default `None`) that gates finishing a filter at its final cleaning stage on every filter in the same AHU having reached its final stage.

**Architecture:** A new auto-discovered `SystemConfig` def stores the mode. Interlock is enforced server-side at the single completion choke point in `submit-checklist.ts` (the terminal-checklist completion, per design decision D1) via a new stateless gate helper. Popup is client-only. No DB schema change.

**Tech Stack:** Fastify + TypeScript (backend, `apps/api`), Prisma (PostgreSQL), Vitest (tests, single-fork), React + Vite + SWR (frontend, `apps/web`), `@digilog/shared` pipeline executor (`findReachable`).

**Design spec:** `docs/superpowers/specs/2026-07-01-ahu-completion-process-design.md` (read it first).

## Global Constraints

- **Light theme only** — dialogs use `bg-white`, `border-slate-200`, gradient headers OK. No dark theme.
- **Config value shape:** `system_config` row `config_key = 'ahu-completion-process'`, `config_value = { "mode": "NONE" | "POPUP" | "INTERLOCK" }`.
- **Never hardcode stage names.** Final stage is always derived from the pinned profile graph via `executor.findReachable(node.id, nodes, edges).hasEndNext && reachableStages.length === 0`.
- **Offline (D2):** the Interlock gate must be skipped when `ctx.isOfflineReplay === true` (never re-block synced offline ops).
- **"Reached final" predicate (D4 + D7):** a counted filter is satisfied iff `(currentCycleId != null && currentLifecycleState === finalStageKey)` **OR** `(currentCycleId == null && currentLifecycleState === 'CLEANING_CYCLE_COMPLETED')`. Everything else (never-started, idle, mid-cleaning, terminated, different new cycle) blocks.
- **Counted set (D3 + open-item #1):** child `AssetInstance` of the AHU with `isActive === true`, `status != 'Retired'`, and an assigned cleaning profile (`FilterDetails.filterProfileId != null`). PM `pmFilterSetMode` is ignored.
- **Tests:** run with `cd apps/api && npm test` (single-fork). New e2e/integration files must provision a **unique** SUPER_ADMIN user in `beforeAll` (see `apps/api/CLAUDE.md` "Per-file authoring tip"), not the shared `admin`.
- **Permissions reused:** `CONFIG_READ` / `CONFIG_UPDATE` for the config; `ASSET_READ` for the status endpoint. No new permission constants.

---

## File Structure

**Backend (`apps/api`):**
- Create `src/modules/config/defs/ahu-completion-process.def.ts` — the config def (mode select).
- Modify `src/lib/config-discovery.ts` — one `import()` line.
- Create `src/modules/filter-operations/ahu-completion-gate.ts` — mode reader, AHU resolver, counted-filters loader, final-stage resolver, `assertAhuInterlockSatisfied`, and the pure `reachedFinal` predicate + status computation.
- Create `src/modules/filter-operations/__tests__/ahu-completion-gate.test.ts` — unit tests for the pure predicate + final-stage resolver.
- Modify `src/modules/config/static-routes/` (new file `ahu-completion-process.routes.ts` or fold into an existing filter-management routes file) — `GET /api/config/ahu-completion-process/current`.
- Modify `src/modules/filter-operations/routes.ts` — `GET /api/filters/ahu/:ahuId/completion-status`.
- Modify `src/modules/filter-operations/cycle-write/submit-checklist.ts` — one guarded gate call.
- Create `src/modules/filter-operations/__tests__/ahu-completion-gate.e2e.test.ts` — integration/e2e for the endpoint + submit-checklist block.

**Frontend (`apps/web`):**
- Create `src/hooks/use-ahu-completion-mode.ts` — SWR mode hook.
- Modify `src/routes/config/index.tsx` — config card.
- Create `src/routes/filter-management/components/remaining-filters-dialog.tsx` — shared Popup/Interlock dialog.
- Create `src/lib/filter-ops/ahu-completion-check.ts` — shared client interception helper.
- Modify `src/routes/filter-management/filter-operations.tsx` — wire interception (desktop).
- Modify `src/routes/mobile/mobile-operations.tsx` — wire interception (tablet).

**Docs:** `CHANGELOG.md`, `CLAUDE.md`, `apps/api/CLAUDE.md`, `tasks/todo.md`.

---

## Task 1: Config definition, discovery, reader, and runtime endpoint

**Files:**
- Create: `apps/api/src/modules/config/defs/ahu-completion-process.def.ts`
- Modify: `apps/api/src/lib/config-discovery.ts`
- Create: `apps/api/src/modules/config/static-routes/ahu-completion-process.routes.ts`
- Modify: `apps/api/src/modules/config/routes.ts` (register the new static route file — confirm how other `static-routes/*.routes.ts` are registered and follow that pattern)
- Create: `apps/api/src/modules/filter-operations/ahu-completion-gate.ts` (reader only in this task)
- Test: `apps/api/src/modules/filter-operations/__tests__/ahu-completion-gate.e2e.test.ts` (endpoint test)

**Interfaces:**
- Produces: `getAhuCompletionMode(): Promise<'NONE'|'POPUP'|'INTERLOCK'>` (from `ahu-completion-gate.ts`).
- Produces: `GET /api/config/ahu-completion-process/current` → `{ mode: 'NONE'|'POPUP'|'INTERLOCK' }`.

- [ ] **Step 1: Read the reference config def and the discovery file**

Read `apps/api/src/modules/config/defs/pm-schedule-settings.def.ts` (structure) and `apps/api/src/modules/config/defs/stage-interlock.def.ts` (closest analog: SUPER_ADMIN + select). Read `apps/api/src/lib/config-discovery.ts` (the `import()` array). Read one `static-routes/*.routes.ts` (e.g. `offline-cache.routes.ts`) to copy the `/current` endpoint pattern and how it is registered in `config/routes.ts`.

- [ ] **Step 2: Write the config def**

Create `apps/api/src/modules/config/defs/ahu-completion-process.def.ts`:

```ts
import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const ahuCompletionProcessDef: ModuleConfigDefinition = {
  moduleKey: 'ahu-completion-process',
  moduleName: 'AHU Cleaning Completion Process',
  description: 'Controls what happens when a filter is submitted at its final cleaning stage.',
  icon: 'shield-check',
  category: 'filter-management',
  sortOrder: 72,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'mode', type: 'select', label: 'Completion Enforcement Mode',
      group: 'General', default: 'NONE',
      options: [
        { value: 'NONE', label: 'None — no check (default)' },
        { value: 'POPUP', label: 'Popup — warn but allow' },
        { value: 'INTERLOCK', label: 'Interlock — block until all AHU filters reach final stage' },
      ],
    },
  ],
};
```

- [ ] **Step 3: Register in discovery**

In `apps/api/src/lib/config-discovery.ts`, add to the `import()` array (near `stage-interlock.def.js`):

```ts
import('../modules/config/defs/ahu-completion-process.def.js'),
```

- [ ] **Step 4: Write the reader**

Create `apps/api/src/modules/filter-operations/ahu-completion-gate.ts`:

```ts
import { prisma } from '../../lib/prisma.js';

export type AhuCompletionMode = 'NONE' | 'POPUP' | 'INTERLOCK';

export async function getAhuCompletionMode(): Promise<AhuCompletionMode> {
  const cfg = await prisma.systemConfig.findUnique({ where: { configKey: 'ahu-completion-process' } });
  const m = (cfg?.configValue as { mode?: string } | null)?.mode;
  return m === 'INTERLOCK' || m === 'POPUP' ? m : 'NONE';
}
```

(Confirm the prisma import path matches other files in `filter-operations/` — e.g. `import { prisma } from '../../lib/prisma.js'`.)

- [ ] **Step 5: Write the runtime `/current` endpoint**

Create `apps/api/src/modules/config/static-routes/ahu-completion-process.routes.ts` mirroring `offline-cache.routes.ts`'s `/current` handler. It must be readable by any authenticated user (no admin gate) and return `{ mode }` from `getAhuCompletionMode()`. Register it in `config/routes.ts` following the existing registration pattern.

- [ ] **Step 6: Write the endpoint test**

Create `apps/api/src/modules/filter-operations/__tests__/ahu-completion-gate.e2e.test.ts`. Provision a unique SUPER_ADMIN in `beforeAll` (copy the pattern from an existing filter-operations e2e file). Test:

```ts
it('GET /api/config/ahu-completion-process/current returns NONE by default', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/config/ahu-completion-process/current', headers: authHeaders });
  expect(res.statusCode).toBe(200);
  expect(res.json().mode).toBe('NONE');
});

it('PUT dynamic config sets mode to INTERLOCK and /current reflects it', async () => {
  const put = await app.inject({
    method: 'PUT', url: '/api/config/dynamic/ahu-completion-process',
    headers: authHeaders, payload: { mode: 'INTERLOCK' },
  });
  expect(put.statusCode).toBe(200);
  const res = await app.inject({ method: 'GET', url: '/api/config/ahu-completion-process/current', headers: authHeaders });
  expect(res.json().mode).toBe('INTERLOCK');
});
```

- [ ] **Step 7: Run tests, verify pass**

Run: `cd apps/api && npm test -- ahu-completion-gate.e2e`
Expected: PASS. (Reset the config row to `NONE` at the end of the test to avoid leaking state — `afterAll` PUT `{ mode: 'NONE' }`, per the "no test-writes to real config" rule.)

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/config/defs/ahu-completion-process.def.ts apps/api/src/lib/config-discovery.ts apps/api/src/modules/config/static-routes/ahu-completion-process.routes.ts apps/api/src/modules/config/routes.ts apps/api/src/modules/filter-operations/ahu-completion-gate.ts apps/api/src/modules/filter-operations/__tests__/ahu-completion-gate.e2e.test.ts
git commit -m "feat(config): add AHU Cleaning Completion Process mode config + runtime endpoint"
```

---

## Task 2: Pure final-stage resolver + reachedFinal predicate

**Files:**
- Modify: `apps/api/src/modules/filter-operations/ahu-completion-gate.ts`
- Test: `apps/api/src/modules/filter-operations/__tests__/ahu-completion-gate.test.ts`

**Interfaces:**
- Consumes: `executor.findReachable(fromNodeId, nodes, edges)` from `@digilog/shared` — the SAME shape `advance.ts:350` passes (`profile.nodes`, `profile.edges`).
- Produces: `computeFinalStageKey(profile: { nodes; edges }): string | null`
- Produces: `reachedFinal(f: CountedFilter, finalStageByFilter: Map<string,string|null>): boolean`
- Produces: `type CountedFilter = { id: string; name: string; currentCycleId: string|null; currentLifecycleState: string|null }`

- [ ] **Step 1: Read how advance.ts computes reachability**

Read `apps/api/src/modules/filter-operations/cycle-write/advance.ts:345-380` and `packages/shared/src/pipeline-executor/transitions.ts:279-304`. Confirm: `findReachable` takes `(fromNodeId, allStages, connections)`, a STAGE node has `.id`, `.nodeType === 'STAGE'`, `.stateKey`, and the final stage is the STAGE where `findReachable(node.id, nodes, edges).hasEndNext && reachableStages.length === 0`.

- [ ] **Step 2: Write the failing unit test**

Create `apps/api/src/modules/filter-operations/__tests__/ahu-completion-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeFinalStageKey, reachedFinal } from '../ahu-completion-gate.js';

// Minimal graph: S1 -> S2 -> END
const nodes = [
  { id: 'n1', nodeType: 'STAGE', stateKey: 'S1' },
  { id: 'n2', nodeType: 'STAGE', stateKey: 'S2' },
  { id: 'nEnd', nodeType: 'END', stateKey: null },
];
const edges = [
  { fromStageId: 'n1', toStageId: 'n2' },
  { fromStageId: 'n2', toStageId: 'nEnd' },
];

describe('computeFinalStageKey', () => {
  it('returns the last STAGE that leads to END', () => {
    expect(computeFinalStageKey({ nodes, edges })).toBe('S2');
  });
});

describe('reachedFinal', () => {
  const finalMap = new Map<string, string | null>([['f-active', 'S2']]);
  it('active cycle parked at final stage → reached', () => {
    expect(reachedFinal({ id: 'f-active', name: 'F', currentCycleId: 'c1', currentLifecycleState: 'S2' }, finalMap)).toBe(true);
  });
  it('active cycle NOT at final → not reached', () => {
    expect(reachedFinal({ id: 'f-active', name: 'F', currentCycleId: 'c1', currentLifecycleState: 'S1' }, finalMap)).toBe(false);
  });
  it('no cycle + CLEANING_CYCLE_COMPLETED → reached', () => {
    expect(reachedFinal({ id: 'f-done', name: 'F', currentCycleId: null, currentLifecycleState: 'CLEANING_CYCLE_COMPLETED' }, finalMap)).toBe(true);
  });
  it('never started (null state) → not reached', () => {
    expect(reachedFinal({ id: 'f-idle', name: 'F', currentCycleId: null, currentLifecycleState: null }, finalMap)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `cd apps/api && npm test -- ahu-completion-gate.test`
Expected: FAIL ("computeFinalStageKey is not a function").

- [ ] **Step 4: Implement**

Add to `apps/api/src/modules/filter-operations/ahu-completion-gate.ts` (confirm the exact executor import used elsewhere, e.g. `import * as executor from '@digilog/shared'` or a named `findReachable` import — match `advance.ts`):

```ts
import { findReachable } from '@digilog/shared'; // match advance.ts's import style

export type CountedFilter = {
  id: string; name: string;
  currentCycleId: string | null; currentLifecycleState: string | null;
};

export function computeFinalStageKey(profile: { nodes: any[]; edges: any[] }): string | null {
  for (const node of profile.nodes) {
    if (node.nodeType !== 'STAGE' || !node.stateKey) continue;
    const r = findReachable(node.id, profile.nodes, profile.edges);
    if (r.hasEndNext && r.reachableStages.length === 0) return node.stateKey;
  }
  return null;
}

export function reachedFinal(f: CountedFilter, finalStageByFilter: Map<string, string | null>): boolean {
  if (f.currentCycleId) {
    const finalKey = finalStageByFilter.get(f.id);
    return !!finalKey && f.currentLifecycleState === finalKey;
  }
  return f.currentLifecycleState === 'CLEANING_CYCLE_COMPLETED';
}
```

- [ ] **Step 5: Run test, verify pass**

Run: `cd apps/api && npm test -- ahu-completion-gate.test`
Expected: PASS. If `findReachable` import path differs, fix to match `advance.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/filter-operations/ahu-completion-gate.ts apps/api/src/modules/filter-operations/__tests__/ahu-completion-gate.test.ts
git commit -m "feat(filters): pure final-stage resolver + reachedFinal predicate for AHU gate"
```

---

## Task 3: AHU resolver + counted-filters loader + final-stage map + status computation

**Files:**
- Modify: `apps/api/src/modules/filter-operations/ahu-completion-gate.ts`
- Test: `apps/api/src/modules/filter-operations/__tests__/ahu-completion-gate.e2e.test.ts` (add cases)

**Interfaces:**
- Consumes: `loadLocalContext(filterId)` from `cycle-write/local-context.ts` — returns `{ profile: { nodes, edges }, ... }` (confirm exact shape; it is what `advance.ts` uses).
- Produces: `resolveAhuId(filterId): Promise<string | null>`
- Produces: `loadCountedFilters(ahuId): Promise<CountedFilter[]>`
- Produces: `computeAhuCompletionStatus(ahuId, excludeFilterId): Promise<{ allAtFinal: boolean; pending: { id: string; name: string; stage: string }[] }>`

- [ ] **Step 1: Read the helpers to reuse**

Read `pm-deviations.ts:62-93` (`loadCountedFilters` query shape), `cycle-write/local-context.ts` (`loadLocalContext` return shape — confirm it exposes `profile.nodes`/`profile.edges`), and `stage-interlock.ts:131-173` (the `parentId`→AHU `templateKind` walk).

- [ ] **Step 2: Write failing integration test (add to e2e file)**

Add fixtures: an AHU with two child filters sharing a profile `S1→S2→[CHECKLIST]→END`; put filter A parked at `S2` (active cycle, `currentLifecycleState='S2'`) and filter B mid-cleaning at `S1`. (Copy the cycle/fixture setup from an existing filter-operations e2e test.) Then:

```ts
it('computeAhuCompletionStatus reports the mid-cleaning sibling as pending', async () => {
  const status = await computeAhuCompletionStatus(ahuId, filterAId);
  expect(status.allAtFinal).toBe(false);
  expect(status.pending.map(p => p.id)).toContain(filterBId);
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `cd apps/api && npm test -- ahu-completion-gate.e2e`
Expected: FAIL ("computeAhuCompletionStatus is not a function").

- [ ] **Step 4: Implement**

Add to `ahu-completion-gate.ts`:

```ts
import { loadLocalContext } from './cycle-write/local-context.js'; // confirm path/name

export async function resolveAhuId(filterId: string): Promise<string | null> {
  const self = await prisma.assetInstance.findUnique({
    where: { id: filterId }, select: { parentId: true },
  });
  if (!self?.parentId) return null;
  const parent = await prisma.assetInstance.findUnique({
    where: { id: self.parentId }, select: { id: true, template: { select: { templateKind: true } } },
  });
  return parent?.template?.templateKind === 'AHU' ? parent.id : null;
}

export async function loadCountedFilters(ahuId: string): Promise<CountedFilter[]> {
  const rows = await prisma.assetInstance.findMany({
    where: {
      parentId: ahuId, isActive: true, status: { not: 'Retired' },
      filterDetails: { filterProfileId: { not: null } }, // exclude un-cleanable (open-item #1)
    },
    select: {
      id: true, name: true,
      filterDetails: { select: { currentCycleId: true, currentLifecycleState: true } },
    },
  });
  return rows.map(r => ({
    id: r.id, name: r.name,
    currentCycleId: r.filterDetails?.currentCycleId ?? null,
    currentLifecycleState: r.filterDetails?.currentLifecycleState ?? null,
  }));
}

export async function computeAhuCompletionStatus(
  ahuId: string, excludeFilterId: string,
): Promise<{ allAtFinal: boolean; pending: { id: string; name: string; stage: string }[] }> {
  const others = (await loadCountedFilters(ahuId)).filter(f => f.id !== excludeFilterId);
  // Resolve final stage only for filters with an active cycle.
  const finalStageByFilter = new Map<string, string | null>();
  for (const f of others) {
    if (!f.currentCycleId) continue;
    const ctx = await loadLocalContext(f.id);            // reuse advance's loader
    finalStageByFilter.set(f.id, computeFinalStageKey(ctx.profile));
  }
  const pending = others
    .filter(f => !reachedFinal(f, finalStageByFilter))
    .map(f => ({ id: f.id, name: f.name, stage: f.currentLifecycleState ?? 'Not started' }));
  return { allAtFinal: pending.length === 0, pending };
}
```

> Performance note: `loadLocalContext` is called once per active-cycle sibling (N small). Memoise by `(profileId,profileVersion)` later if profiled as hot; not required now.

- [ ] **Step 5: Run test, verify pass**

Run: `cd apps/api && npm test -- ahu-completion-gate.e2e`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/filter-operations/ahu-completion-gate.ts apps/api/src/modules/filter-operations/__tests__/ahu-completion-gate.e2e.test.ts
git commit -m "feat(filters): AHU resolver, counted-filters loader, completion-status computation"
```

---

## Task 4: The Interlock assert + completion-status endpoint

**Files:**
- Modify: `apps/api/src/modules/filter-operations/ahu-completion-gate.ts`
- Modify: `apps/api/src/modules/filter-operations/routes.ts`
- Test: `apps/api/src/modules/filter-operations/__tests__/ahu-completion-gate.e2e.test.ts` (add cases)

**Interfaces:**
- Produces: `assertAhuInterlockSatisfied({ filterId, isOfflineReplay }): Promise<void>` (throws HTTP 422 `AHU_INTERLOCK_PENDING` with `{ pendingFilters }`).
- Produces: `GET /api/filters/ahu/:ahuId/completion-status` → `{ allAtFinal, pending }`.

- [ ] **Step 1: Read the error-throwing pattern**

Read `stage-interlock.ts:85-110` (`assertStageApprovedToLeave`) to see exactly how it throws an HTTP-status error with a `code` (it uses 423). Mirror that class/mechanism but with status **422** and code `AHU_INTERLOCK_PENDING`, attaching `details: { pendingFilters }`.

- [ ] **Step 2: Write failing test — assert throws when a sibling is pending**

```ts
it('assertAhuInterlockSatisfied throws 422 when a sibling is not at final', async () => {
  // mode = INTERLOCK (PUT dynamic config), filter A parked at S2, filter B at S1
  await expect(assertAhuInterlockSatisfied({ filterId: filterAId, isOfflineReplay: false }))
    .rejects.toMatchObject({ statusCode: 422, code: 'AHU_INTERLOCK_PENDING' });
});

it('assertAhuInterlockSatisfied passes on offline replay', async () => {
  await expect(assertAhuInterlockSatisfied({ filterId: filterAId, isOfflineReplay: true }))
    .resolves.toBeUndefined();
});

it('GET completion-status returns pending list', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/filters/ahu/${ahuId}/completion-status`, headers: authHeaders });
  expect(res.statusCode).toBe(200);
  expect(res.json().allAtFinal).toBe(false);
});
```

- [ ] **Step 3: Run test, verify fail**

Run: `cd apps/api && npm test -- ahu-completion-gate.e2e`
Expected: FAIL.

- [ ] **Step 4: Implement the assert**

Add to `ahu-completion-gate.ts` (using the confirmed error class from Step 1):

```ts
export async function assertAhuInterlockSatisfied(params: {
  filterId: string; isOfflineReplay: boolean;
}): Promise<void> {
  if (params.isOfflineReplay) return;                     // D2
  if ((await getAhuCompletionMode()) !== 'INTERLOCK') return;

  const ahuId = await resolveAhuId(params.filterId);
  if (!ahuId) return;                                     // not under an AHU → don't gate

  const { allAtFinal, pending } = await computeAhuCompletionStatus(ahuId, params.filterId);
  if (!allAtFinal) {
    // Mirror stage-interlock's error throw, status 422, code AHU_INTERLOCK_PENDING.
    throw makeHttpError(422, 'AHU_INTERLOCK_PENDING',
      'All filters belonging to this AHU must reach their final cleaning stage before submission.',
      { pendingFilters: pending });
  }
}
```

- [ ] **Step 5: Implement the endpoint**

In `routes.ts`, add (gated `ASSET_READ`, matching sibling GET routes):

```ts
app.get('/ahu/:ahuId/completion-status', { preHandler: requirePermission('ASSET_READ') }, async (req) => {
  const { ahuId } = req.params as { ahuId: string };
  const excludeFilterId = (req.query as { exclude?: string }).exclude ?? '';
  return computeAhuCompletionStatus(ahuId, excludeFilterId);
});
```

(Confirm the exact `requirePermission` import and route-registration style used in `routes.ts`.)

- [ ] **Step 6: Run tests, verify pass**

Run: `cd apps/api && npm test -- ahu-completion-gate.e2e`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/filter-operations/ahu-completion-gate.ts apps/api/src/modules/filter-operations/routes.ts apps/api/src/modules/filter-operations/__tests__/ahu-completion-gate.e2e.test.ts
git commit -m "feat(filters): AHU interlock assert + completion-status endpoint"
```

---

## Task 5: Wire the gate into submit-checklist completion

**Files:**
- Modify: `apps/api/src/modules/filter-operations/cycle-write/submit-checklist.ts`
- Test: `apps/api/src/modules/filter-operations/__tests__/ahu-completion-gate.e2e.test.ts` (add end-to-end submit case)

**Interfaces:**
- Consumes: `assertAhuInterlockSatisfied` (Task 4), `shouldComplete` + `ctx.isOfflineReplay` (existing in `submit-checklist.ts`).

- [ ] **Step 1: Read the completion path**

Read `submit-checklist.ts:154-243`. Confirm `shouldComplete` is computed at ~line 170 and the completion transaction begins at ~line 215.

- [ ] **Step 2: Write failing e2e — final-stage checklist submit is blocked in INTERLOCK**

Set mode = INTERLOCK. Filter A parked at final `S2` with a pending terminal checklist, sibling B at `S1`. Submit A's terminal checklist → expect 422:

```ts
it('submit-checklist at final stage is blocked (422) when a sibling is not at final', async () => {
  const res = await app.inject({
    method: 'POST', url: `/api/filters/${filterAId}/submit-checklist`,
    headers: reauthHeaders, payload: { answers: validAnswers, tapeVersion: currentTapeVersion, _currentPassword: pw },
  });
  expect(res.statusCode).toBe(422);
  expect(res.json().code ?? res.json().error).toContain('AHU_INTERLOCK_PENDING');
});

it('submit-checklist completes when all siblings are at final', async () => {
  // advance B to S2 (parked at final) first, then submit A
  // ... expect 200 and cycle COMPLETED
});
```

- [ ] **Step 3: Run test, verify fail**

Run: `cd apps/api && npm test -- ahu-completion-gate.e2e`
Expected: FAIL (submit currently succeeds → 200, not 422).

- [ ] **Step 4: Implement the wire-in**

In `submit-checklist.ts`, immediately after `shouldComplete` is computed (~line 170) and **before** the completion transaction (~line 215), add:

```ts
import { assertAhuInterlockSatisfied } from '../ahu-completion-gate.js';
// ...
if (shouldComplete) {
  await assertAhuInterlockSatisfied({ filterId, isOfflineReplay: ctx.isOfflineReplay === true });
}
```

Place the call so a thrown 422 aborts before any DB write. Confirm `ctx` (the request context with `isOfflineReplay`) and `filterId` are in scope at that point.

- [ ] **Step 5: Run tests, verify pass; run the focused submit-checklist suite for regressions**

Run: `cd apps/api && npm test -- ahu-completion-gate.e2e`
Run: `cd apps/api && npm test -- submit-checklist`
Expected: PASS (new + existing submit-checklist tests green).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/filter-operations/cycle-write/submit-checklist.ts apps/api/src/modules/filter-operations/__tests__/ahu-completion-gate.e2e.test.ts
git commit -m "feat(filters): enforce AHU interlock at final-stage checklist completion"
```

---

## Task 6: Frontend — config card + runtime mode hook

**Files:**
- Create: `apps/web/src/hooks/use-ahu-completion-mode.ts`
- Modify: `apps/web/src/routes/config/index.tsx`

**Interfaces:**
- Produces: `useAhuCompletionMode(): 'NONE'|'POPUP'|'INTERLOCK'`

- [ ] **Step 1: Read the analog hook + card registry**

Read `apps/web/src/hooks/use-pagination-config.ts` (SWR `/current` hook shape) and `apps/web/src/routes/config/index.tsx` (a `superAdminCards` entry).

- [ ] **Step 2: Write the hook**

Create `apps/web/src/hooks/use-ahu-completion-mode.ts`:

```ts
import useSWR from 'swr';

export function useAhuCompletionMode(): 'NONE' | 'POPUP' | 'INTERLOCK' {
  const { data } = useSWR('/api/config/ahu-completion-process/current',
    { revalidateOnMount: true, dedupingInterval: 5000, revalidateOnFocus: false });
  const m = data?.mode;
  return m === 'INTERLOCK' || m === 'POPUP' ? m : 'NONE';
}
```

(Confirm the project's SWR fetcher is globally configured — `use-pagination-config.ts` relies on it.)

- [ ] **Step 3: Add the config card**

In `apps/web/src/routes/config/index.tsx`, add a `superAdminCards` entry: `{ title: 'AHU Cleaning Completion Process', description: 'Interlock / Popup / None for final-stage submission', href: '/config/dynamic/ahu-completion-process', icon: <matching icon>, gradient: <existing filter-management gradient>, reauth: false }`. Match the exact object shape of neighboring entries.

- [ ] **Step 4: Manual verify**

Run the app (`npx vite --host` + API). As superadmin, open Config → the new card → the dynamic page renders a `mode` dropdown with the three options. Change to Interlock, save; reload → persists. Check no console errors and the dropdown is styled (light theme).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/use-ahu-completion-mode.ts apps/web/src/routes/config/index.tsx
git commit -m "feat(web): AHU completion mode hook + config card"
```

---

## Task 7: Frontend — Remaining Filters dialog + submit interception (web + tablet)

**Files:**
- Create: `apps/web/src/routes/filter-management/components/remaining-filters-dialog.tsx`
- Create: `apps/web/src/lib/filter-ops/ahu-completion-check.ts`
- Modify: `apps/web/src/routes/filter-management/filter-operations.tsx`
- Modify: `apps/web/src/routes/mobile/mobile-operations.tsx`

**Interfaces:**
- Consumes: `useAhuCompletionMode` (Task 6), `GET /api/filters/ahu/:ahuId/completion-status`.
- Produces: `checkAhuCompletion(mode, ahuId, filterId): Promise<{ block: boolean; pending: {id;name;stage}[] }>`
- Produces: `<RemainingFiltersDialog mode="POPUP"|"INTERLOCK" pending={...} onContinue onCancel />`

- [ ] **Step 1: Read the existing completing-action call sites + dialog style**

Read where `filter-operations.tsx` and `mobile-operations.tsx` submit the terminal checklist / final advance (the completing action), and `components/checklist-dialog.tsx` for the dialog style (gradient header, light theme).

- [ ] **Step 2: Write the check helper**

Create `apps/web/src/lib/filter-ops/ahu-completion-check.ts`:

```ts
import { apiClient } from '../api-client'; // confirm exact import

export async function checkAhuCompletion(
  mode: 'NONE' | 'POPUP' | 'INTERLOCK', ahuId: string | null, filterId: string, online: boolean,
): Promise<{ block: boolean; pending: { id: string; name: string; stage: string }[] }> {
  if (mode === 'NONE' || !ahuId) return { block: false, pending: [] };
  if (mode === 'INTERLOCK' && !online) return { block: false, pending: [] }; // D2 best-effort
  const res = await apiClient.get(`/api/filters/ahu/${ahuId}/completion-status?exclude=${filterId}`);
  const pending = res.pending ?? [];
  // INTERLOCK: hard block when pending. POPUP: warn (Continue/Cancel) when pending.
  return { block: mode === 'INTERLOCK' && pending.length > 0, pending };
}
```

- [ ] **Step 3: Write the dialog**

Create `remaining-filters-dialog.tsx` — light theme, gradient header. Title "Remaining Filters". Message from spec. Renders `pending` as `Name — Stage` rows. Buttons: POPUP → Continue / Cancel; INTERLOCK → single OK/Close (blocking, no Continue). Include loading + error states.

- [ ] **Step 4: Wire desktop interception**

In `filter-operations.tsx`, before the completing action fires, call `checkAhuCompletion(mode, ahuId, filterId, online)`:
- POPUP + pending → show dialog; Continue → proceed, Cancel → abort.
- INTERLOCK + block → show blocking dialog + abort (server also enforces).
- else → proceed unchanged.
(Read `ahuId` from the loaded filter/current-state; `online` from the existing connectivity hook.)

- [ ] **Step 5: Wire tablet interception**

Repeat Step 4 in `mobile-operations.tsx` (same helper + dialog). Per the "never separate tablet impl" rule, reuse the identical helper and dialog component.

- [ ] **Step 6: Manual verify (web + tablet)**

With mode=POPUP and a sibling not at final: completing a filter shows the popup; Continue completes, Cancel stays. With mode=INTERLOCK: completing is blocked with the message; server returns 422 if the client is bypassed. With mode=NONE: no dialog. Verify light theme, no console errors, no unstyled elements.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/filter-management/components/remaining-filters-dialog.tsx apps/web/src/lib/filter-ops/ahu-completion-check.ts apps/web/src/routes/filter-management/filter-operations.tsx apps/web/src/routes/mobile/mobile-operations.tsx
git commit -m "feat(web): Remaining Filters dialog + AHU completion interception (web + tablet)"
```

---

## Task 8: Admin warning for un-enforceable profiles

**Files:**
- Modify: `apps/api/src/modules/filter-operations/routes.ts` (or config route) — add `GET /api/filters/cleaning-profiles/without-final-checklist`
- Modify: `apps/web/src/routes/config/index.tsx` or the dynamic config page area to surface the warning

**Interfaces:**
- Produces: `GET .../without-final-checklist` → `{ profiles: { id: string; name: string }[] }` — cleaning profiles in use whose final STAGE does **not** lead to a terminal CHECKLIST before END (i.e. would auto-complete in `advance` and thus not be gated — §11.1).

- [ ] **Step 1: Write failing test**

Seed one profile ending `…→S2→END` (no terminal checklist) and one ending `…→S2→CHECKLIST→END`. Assert the endpoint returns only the first.

- [ ] **Step 2: Run, verify fail.** Run: `cd apps/api && npm test -- without-final-checklist` → FAIL.

- [ ] **Step 3: Implement**

Compute, per active `FilterCleaningProfile`, whether the final STAGE's forward path to END passes through a CHECKLIST node (reuse `findReachable`/graph walk). Return those that do **not**.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Surface in UI**

On the AHU Completion config page (or its card), when mode ≠ NONE, fetch the endpoint and show an amber note: "These cleaning profiles do not end with a checklist and will NOT be enforced by Interlock: …". Light theme.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(filters): admin warning listing cleaning profiles unenforceable by interlock"
```

---

## Task 9: Docs + counts

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `apps/api/CLAUDE.md`, `tasks/todo.md`

- [ ] **Step 1: Update counts** — config defs 34→35 (`ls apps/api/src/modules/config/defs/*.def.ts | wc -l` to verify). Update the config-defs count in `CLAUDE.md` System Stats and `apps/api/CLAUDE.md`. If a config page count is quoted (30 pages), confirm whether the dynamic def adds a page (it reuses `dynamic-config.tsx`, so likely no) — verify with `ls apps/web/src/routes/config/*.tsx | wc -l` and only change if the number actually moved.
- [ ] **Step 2: CHANGELOG** — add an entry describing the feature, the three modes, decisions D1–D7, and the §11.1 limitation.
- [ ] **Step 3: tasks/todo.md** — add the audit-log entry.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: AHU Cleaning Completion Process — changelog, counts, todo audit entry"
```

---

## Self-Review

**Spec coverage:** Config (Task 1), Interlock server enforcement (Tasks 2–5), Popup (Task 7), None (no-op, inherent), counted-filters D3 + no-profile exclusion (Task 3), reachedFinal D4/D7 (Task 2), offline D2 (Task 4/5), completion-status endpoint (Task 4), config card + dropdown D5 (Task 6), dialog + web/tablet parity (Task 7), §11.1 admin warning (Task 8), performance memo note (Task 3), audit/security (config audit is automatic via dynamic route; blocked-submission logging flows through existing failed-op traces), docs (Task 9). Deliverables 9 (flow) & 10 (sequence) diagrams live in the spec. **No gaps found.**

**Placeholder scan:** Remaining "confirm X" notes are verification instructions (exact file named), not vague TODOs — acceptable. No "add error handling"/"TBD".

**Type consistency:** `CountedFilter`, `computeFinalStageKey`, `reachedFinal`, `computeAhuCompletionStatus`, `assertAhuInterlockSatisfied`, `getAhuCompletionMode`, `useAhuCompletionMode`, `checkAhuCompletion` are named identically across all tasks.

**Known verification points to resolve during implementation (named, not placeholders):** exact `findReachable` import style (match `advance.ts`); `loadLocalContext` return shape/path; the HTTP-error class used by `stage-interlock.ts`; `requirePermission` import in `routes.ts`; SWR global fetcher. Each is a "read file X, mirror it" step.
