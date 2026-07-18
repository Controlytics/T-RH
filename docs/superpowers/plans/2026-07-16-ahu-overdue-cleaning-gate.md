# AHU Overdue-Replacement Cleaning Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block STARTING a new cleaning cycle on any active filter under an AHU whose replacement task is overdue, until that specific filter is replaced — enforced online (authoritative server gate) and offline (cached blocked-filter set on the tablet).

**Architecture:** A single server helper computes the set of blocked filter IDs from the existing replacement-schedule data (overdue entries' AHU filters minus already-replaced ones). A small open-to-any-role endpoint returns it. `start-cycle` re-checks one filter authoritatively (exempting offline replay). The tablet caches the set like it caches `checklist-profiles` and refuses a cycle start offline via the shared `validateOfflineGate`.

**Tech Stack:** Fastify + Prisma (`apps/api`), React + SWR + IndexedDB (`apps/web`), vitest (both), Capacitor APK.

## Global Constraints

- **Overdue = `MISSED`** from `deriveTaskStatus` (`replacement-schedule/service.ts`): `today > windowEnd` (UTC date-only) AND `remaining > 0`. Only APPROVED entries.
- **Blocked scope = ALL active FILTER-kind filters under the AHU** (`parentId === ahuId`, `isActive`, `status != 'Retired'`), regardless of micron/size — matches `activeFilterIdsByAhu`.
- **A filter is unblocked** the moment it is one of its overdue entry's replacement `newFilterId`s (per-filter, immediate).
- **Gate is START-only.** In-flight cycles finish; do NOT touch advance / checklist / atomic ops.
- **Offline replay is EXEMPT** on the server (`!ctx.isOfflineReplay`), mirroring `validateBlockChange`.
- **No new permission.** Endpoint open-to-any authenticated role, like `/due` and `/tasks`.
- **Error code:** `409 AHU_REPLACEMENT_OVERDUE`.
- **Tests run against `digilog_test_db`** in single-fork: `cd apps/api && npm test`. Web: `cd apps/web && npm test`. Do not assume ambient data; each test provisions its own rows.
- **Baselines to protect:** API 1196 pass / 115 files, web 597 pass / 44 files.

---

### Task 1: Server — `blockedFilterIdsForCleaning` + `isFilterBlockedForCleaning` helpers

**Files:**
- Modify: `apps/api/src/modules/replacement-schedule/service.ts` (add helpers; extract a shared per-entry blocked-ids function reused by `listTaskEntries`)
- Test: `apps/api/src/modules/replacement-schedule/__tests__/blocked-filters.test.ts` (create)

**Interfaces:**
- Consumes: existing `service.ts` internals — `deriveTaskStatus(e, remaining, total, today)`, `activeFilterIdsByAhu(ahuIds)`, `todayUtcDateOnly()`, and `prisma.replacementExecution`.
- Produces:
  - `blockedEntryFilterIds(entry, ahuFilterIds: string[], replacedNewFilterIds: Set<string>, today: string): string[]` — internal; the AHU filters minus replaced, or `[]` when the entry is not `MISSED`.
  - `export async function blockedFilterIdsForCleaning(): Promise<Set<string>>`
  - `export async function isFilterBlockedForCleaning(filterId: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/replacement-schedule/__tests__/blocked-filters.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import { blockedFilterIdsForCleaning, isFilterBlockedForCleaning } from '../service.js';
import { randomUUID } from 'node:crypto';

const S = Date.now().toString(36).slice(-5);

// UTC date-only string offset from today by `days`.
function dayISO(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

describe('blockedFilterIdsForCleaning / isFilterBlockedForCleaning', () => {
  let ahuId = '';
  let filterTemplateId = '';
  const filterIds: string[] = [];
  let overdueEntryId = '';
  let dueEntryId = '';
  let ahuId2 = '';
  let newFilterId = '';

  beforeAll(async () => {
    // assetTemplate.templateKind FKs the TemplateKind lookup — ensure FILTER exists.
    await prisma.templateKind.upsert({ where: { code: 'FILTER' }, update: {}, create: { code: 'FILTER', label: 'Filter', isSystem: true } });
    filterTemplateId = (await prisma.assetTemplate.create({
      data: { name: `BF Tpl ${S}`, templateKind: 'FILTER' },
    })).id;
    // AHU must be a REAL AssetInstance: assetInstance.parentId is a self-FK with
    // onDelete:Restrict, so filters can only point at an existing instance. The
    // AHU rows have parentId=null, so activeFilterIdsByAhu (which selects
    // parentId IN ahuIds) never counts them — reusing the FILTER template for
    // them is harmless and avoids needing an 'AHU' TemplateKind.
    ahuId = (await prisma.assetInstance.create({ data: { name: `BF-AHU-${S}`, templateId: filterTemplateId } })).id;
    ahuId2 = (await prisma.assetInstance.create({ data: { name: `BF-AHU2-${S}`, templateId: filterTemplateId } })).id;
    // Two active filters under the overdue AHU.
    for (let i = 0; i < 2; i++) {
      const f = await prisma.assetInstance.create({
        data: { name: `BF-F${i}-${S}`, templateId: filterTemplateId, parentId: ahuId, isActive: true, status: 'Active' },
      });
      filterIds.push(f.id);
    }
    // A "new" replacement filter under the same AHU (already replaced → unblocked).
    newFilterId = (await prisma.assetInstance.create({
      data: { name: `BF-NEW-${S}`, templateId: filterTemplateId, parentId: ahuId, isActive: true, status: 'Active' },
    })).id;
    // One active filter under a DIFFERENT AHU whose entry is only DUE (not overdue).
    const f2 = await prisma.assetInstance.create({
      data: { name: `BF-DUE-${S}`, templateId: filterTemplateId, parentId: ahuId2, isActive: true, status: 'Active' },
    });
    filterIds.push(f2.id);

    const sch = await prisma.replacementSchedule.create({
      data: { fileName: `bf-${S}.xlsx`, status: 'ACTIVE', uploadedBy: randomUUID(), uploadedByName: 'bf-test' },
    });
    // Overdue: windowEnd in the past, qty not fully met.
    const overdue = await prisma.replacementScheduleEntry.create({
      data: {
        scheduleId: sch.id, ahuId, ahuName: `AHU-${S}`, qty: 2,
        scheduleDate: dayISO(-10), toleranceDays: 0, windowStart: dayISO(-10), windowEnd: dayISO(-5),
        approvalStatus: 'APPROVED',
      },
    });
    overdueEntryId = overdue.id;
    // Mark newFilterId as replaced under the overdue entry.
    await prisma.replacementExecution.create({
      data: { entryId: overdueEntryId, newFilterId, oldFilterId: filterIds[0], performedBy: randomUUID() },
    });
    // A DUE entry (window spans today) for the other AHU — must NOT block.
    const due = await prisma.replacementScheduleEntry.create({
      data: {
        scheduleId: sch.id, ahuId: ahuId2, ahuName: `AHU2-${S}`, qty: 1,
        scheduleDate: dayISO(0), toleranceDays: 2, windowStart: dayISO(-2), windowEnd: dayISO(2),
        approvalStatus: 'APPROVED',
      },
    });
    dueEntryId = due.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.replacementExecution.deleteMany({ where: { entryId: { in: [overdueEntryId, dueEntryId] } } }).catch(() => {});
    await prisma.replacementScheduleEntry.deleteMany({ where: { id: { in: [overdueEntryId, dueEntryId] } } }).catch(() => {});
    await prisma.replacementSchedule.deleteMany({ where: { fileName: `bf-${S}.xlsx` } }).catch(() => {});
    // Children (filters) before parents (AHUs) — parentId FK is onDelete:Restrict.
    for (const id of [...filterIds, newFilterId]) await prisma.assetInstance.delete({ where: { id } }).catch(() => {});
    for (const id of [ahuId, ahuId2]) await prisma.assetInstance.delete({ where: { id } }).catch(() => {});
    await prisma.assetTemplate.delete({ where: { id: filterTemplateId } }).catch(() => {});
  }, 30_000);

  it('blocks the un-replaced filters under the overdue AHU', async () => {
    const blocked = await blockedFilterIdsForCleaning();
    expect(blocked.has(filterIds[0])).toBe(true);
    expect(blocked.has(filterIds[1])).toBe(true);
  });

  it('does NOT block the already-replaced (new) filter', async () => {
    const blocked = await blockedFilterIdsForCleaning();
    expect(blocked.has(newFilterId)).toBe(false);
  });

  it('does NOT block a filter whose entry is only DUE (within window)', async () => {
    const blocked = await blockedFilterIdsForCleaning();
    expect(blocked.has(filterIds[2])).toBe(false);
  });

  it('isFilterBlockedForCleaning agrees for a blocked and an unblocked filter', async () => {
    expect(await isFilterBlockedForCleaning(filterIds[0])).toBe(true);
    expect(await isFilterBlockedForCleaning(newFilterId)).toBe(false);
    expect(await isFilterBlockedForCleaning(filterIds[2])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true src/modules/replacement-schedule/__tests__/blocked-filters.test.ts`
Expected: FAIL — `blockedFilterIdsForCleaning`/`isFilterBlockedForCleaning` are not exported.

- [ ] **Step 3: Add the helpers to `service.ts`**

First read the existing `listTaskEntries` (`service.ts`, `export async function listTaskEntries()`) and the private `deriveTaskStatus` + `activeFilterIdsByAhu`. Add, near them:

```ts
/**
 * Blocked filter ids for ONE overdue entry: every active AHU filter that has not
 * yet been replaced under it. Returns [] when the entry is not overdue (MISSED),
 * so it composes cleanly with the sweep. Shared with listTaskEntries so the gate
 * and the "replaced X of Y" progress cannot drift.
 */
function blockedEntryFilterIds(
  entry: { windowStart: Date; windowEnd: Date },
  ahuFilterIds: string[],
  replacedNewFilterIds: Set<string>,
  today: string,
): string[] {
  const total = ahuFilterIds.length;
  const remaining = ahuFilterIds.filter((id) => !replacedNewFilterIds.has(id)).length;
  if (deriveTaskStatus(entry, remaining, total, today) !== 'MISSED') return [];
  return ahuFilterIds.filter((id) => !replacedNewFilterIds.has(id));
}

/**
 * The full set of filter ids blocked from STARTING a cleaning cycle because
 * their AHU has an overdue (MISSED) replacement entry and they are not yet
 * replaced. Union across all overdue entries.
 */
export async function blockedFilterIdsForCleaning(): Promise<Set<string>> {
  const today = todayUtcDateOnly();
  const entries = await prisma.replacementScheduleEntry.findMany({
    where: { approvalStatus: 'APPROVED' },
  });
  if (entries.length === 0) return new Set();
  const ahuIds = [...new Set(entries.map((e) => e.ahuId))];
  const entryIds = entries.map((e) => e.id);
  const [filtersByAhu, execs] = await Promise.all([
    activeFilterIdsByAhu(ahuIds),
    prisma.replacementExecution.findMany({ where: { entryId: { in: entryIds } }, select: { entryId: true, newFilterId: true } }),
  ]);
  const newIdsByEntry = new Map<string, Set<string>>();
  for (const x of execs) {
    if (!x.newFilterId) continue;
    const set = newIdsByEntry.get(x.entryId) ?? new Set<string>();
    set.add(x.newFilterId);
    newIdsByEntry.set(x.entryId, set);
  }
  const blocked = new Set<string>();
  for (const e of entries) {
    const ahuFilterIds = filtersByAhu.get(e.ahuId) ?? [];
    const replaced = newIdsByEntry.get(e.id) ?? new Set<string>();
    for (const id of blockedEntryFilterIds(e, ahuFilterIds, replaced, today)) blocked.add(id);
  }
  return blocked;
}

/**
 * Single-filter check for the start-cycle hot path — scoped to the filter's AHU
 * so it doesn't sweep every entry.
 */
export async function isFilterBlockedForCleaning(filterId: string): Promise<boolean> {
  const filter = await prisma.assetInstance.findUnique({ where: { id: filterId }, select: { parentId: true } });
  if (!filter?.parentId) return false;
  const today = todayUtcDateOnly();
  const entries = await prisma.replacementScheduleEntry.findMany({
    where: { approvalStatus: 'APPROVED', ahuId: filter.parentId },
  });
  if (entries.length === 0) return false;
  const [filtersByAhu, execs] = await Promise.all([
    activeFilterIdsByAhu([filter.parentId]),
    prisma.replacementExecution.findMany({ where: { entryId: { in: entries.map((e) => e.id) } }, select: { entryId: true, newFilterId: true } }),
  ]);
  const ahuFilterIds = filtersByAhu.get(filter.parentId) ?? [];
  const newIdsByEntry = new Map<string, Set<string>>();
  for (const x of execs) {
    if (!x.newFilterId) continue;
    const set = newIdsByEntry.get(x.entryId) ?? new Set<string>();
    set.add(x.newFilterId);
    newIdsByEntry.set(x.entryId, set);
  }
  for (const e of entries) {
    const replaced = newIdsByEntry.get(e.id) ?? new Set<string>();
    if (blockedEntryFilterIds(e, ahuFilterIds, replaced, today).includes(filterId)) return true;
  }
  return false;
}
```

Then, in `listTaskEntries`, leave the `remaining`/`computedStatus` computation as-is (it already produces the same numbers) — no behavior change; `blockedEntryFilterIds` is additive. (If `deriveTaskStatus` or `activeFilterIdsByAhu` or `todayUtcDateOnly` are declared **below** the new code, move the new functions after them or hoist — they are function declarations so hoisting applies, but keep source order readable.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true src/modules/replacement-schedule/__tests__/blocked-filters.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `cd .. && npx tsc -p apps/api/tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/replacement-schedule/service.ts apps/api/src/modules/replacement-schedule/__tests__/blocked-filters.test.ts
git commit -m "feat(replacement): blockedFilterIdsForCleaning + isFilterBlockedForCleaning helpers"
```

---

### Task 2: Server — `GET /api/replacement-schedules/blocked-filters` endpoint

**Files:**
- Modify: `apps/api/src/modules/replacement-schedule/routes.ts` (add route near the `/tasks` route)
- Test: `apps/api/src/modules/replacement-schedule/__tests__/blocked-filters-route.test.ts` (create)

**Interfaces:**
- Consumes: `blockedFilterIdsForCleaning()` (Task 1).
- Produces: `GET /api/replacement-schedules/blocked-filters` → `{ filterIds: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/replacement-schedule/__tests__/blocked-filters-route.test.ts`. Mirror the app-boot + `loginAs` pattern from `filter-operations/__tests__/advance-with-checklist-atomic.test.ts` (unique SUPER_ADMIN per file; register `authRoutes` at `/api/auth` and `replacementScheduleRoutes` at `/api/replacement-schedules`). The single assertion:

```ts
it('returns { filterIds: [...] } to an authenticated user', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/replacement-schedules/blocked-filters',
    headers: authHeaders,
  });
  expect(res.statusCode).toBe(200);
  expect(Array.isArray(res.json().filterIds)).toBe(true);
});
```

(Provision one overdue entry + AHU + filter in `beforeAll` like Task 1 and assert its filter id is present, if you want a stronger check; the membership logic is already covered in Task 1, so a shape+auth assertion is sufficient here.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true src/modules/replacement-schedule/__tests__/blocked-filters-route.test.ts`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Add the route**

In `routes.ts`, import the helper and add next to the `/tasks` route (same open-to-any auth — no `preHandler`):

```ts
// Blocked-filter set for the cleaning gate (2026-07-16). Any authenticated role,
// same posture as /due and /tasks — operators need it to know which filters they
// may start cleaning. Returns only filter ids.
app.get('/blocked-filters', {
  schema: {
    tags: ['Replacement Schedule'],
    summary: 'Filter ids blocked from starting a cleaning cycle (overdue AHU replacement)',
    response: { 200: { type: 'object', properties: { filterIds: { type: 'array', items: { type: 'string' } } } }, ...errorResponses },
  },
}, async () => {
  const set = await blockedFilterIdsForCleaning();
  return { filterIds: [...set] };
});
```

Add `blockedFilterIdsForCleaning` to the existing `import { ... } from './service.js'` line.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true src/modules/replacement-schedule/__tests__/blocked-filters-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/replacement-schedule/routes.ts apps/api/src/modules/replacement-schedule/__tests__/blocked-filters-route.test.ts
git commit -m "feat(replacement): GET /blocked-filters endpoint"
```

---

### Task 3: Server — start-cycle gate (exempt offline replay)

**Files:**
- Modify: `apps/api/src/modules/filter-operations/cycle-write/start-cycle.ts` (add the gate after the `CYCLE_ACTIVE` check)
- Test: `apps/api/src/modules/filter-operations/__tests__/start-cycle-replacement-gate.test.ts` (create)

**Interfaces:**
- Consumes: `isFilterBlockedForCleaning(filterId)` (Task 1); `ctx.isOfflineReplay`.
- Produces: `409 AHU_REPLACEMENT_OVERDUE` on a blocked online start.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/filter-operations/__tests__/start-cycle-replacement-gate.test.ts`, mirroring `advance-with-checklist-atomic.test.ts`'s harness (real Fastify, unique SUPER_ADMIN, `digilog_test_db`). Provision: an AHU (`parentId`), a filter under it with an ACTIVE FilterProfile → cleaning profile (copy the profile/filter setup from that file), and an APPROVED overdue `ReplacementScheduleEntry` for the AHU with qty unmet. Assertions:

```ts
it('rejects start-cycle on a filter whose AHU replacement is overdue', async () => {
  const res = await app.inject({
    method: 'POST', url: `/api/filters/${filterId}/start-cycle`, headers: authHeaders,
    payload: { cleaningReasonKey: REASON_KEY, _currentPassword: PASSWORD },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toBe('AHU_REPLACEMENT_OVERDUE');
});

it('allows start-cycle on an offline-replay start even when blocked (exemption)', async () => {
  // Offline replay is authorized via the HMAC grant header, which sets
  // ctx.isOfflineReplay. Reuse the offline-replay grant helper the other e2e
  // tests use (search the suite for `x-offline-replay` / getOfflineReplayHeader).
  const res = await app.inject({
    method: 'POST', url: `/api/filters/${filterId}/start-cycle`, headers: { ...authHeaders, ...offlineReplayHeaders },
    payload: { cleaningReasonKey: REASON_KEY, offlinePerformedAt: new Date().toISOString() },
  });
  expect(res.statusCode).toBe(201);
});
```

If wiring a valid offline-replay grant in-test is impractical, replace the second test with a direct unit call of `startCycleImpl` passing `ctx.isOfflineReplay = true` and asserting no throw, following whatever ctx-construction the other cycle-write unit tests use.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true src/modules/filter-operations/__tests__/start-cycle-replacement-gate.test.ts`
Expected: FAIL — the blocked start returns 201, not 409.

- [ ] **Step 3: Add the gate**

In `start-cycle.ts`, add the import:

```ts
import { isFilterBlockedForCleaning } from '../../replacement-schedule/service.js';
```

Immediately after the `CYCLE_ACTIVE` block (the `if (filter.currentCycleId) { ... }` that ends ~line 95), insert:

```ts
// AHU overdue-replacement gate (2026-07-16). A filter under an AHU with an
// overdue (MISSED) replacement entry cannot START a new cleaning cycle until it
// is replaced — it is due to be physically swapped out. Offline replay is EXEMPT
// (mirrors validateBlockChange): the offline client already gated this at scan
// time, and re-checking on replay could strand a legitimately-queued start. The
// online start is authoritative here.
if (!ctx.isOfflineReplay && await isFilterBlockedForCleaning(filterId)) {
  throw new AppError(409, 'AHU_REPLACEMENT_OVERDUE',
    'This filter’s AHU has an overdue replacement. Replace the filter before starting a cleaning cycle.');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.singleFork=true src/modules/filter-operations/__tests__/start-cycle-replacement-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Full API suite (no regression)**

Run: `cd apps/api && npm test`
Expected: **1196+ passing** (prior baseline 1196) — the new tests add to it; 0 failed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/filter-operations/cycle-write/start-cycle.ts apps/api/src/modules/filter-operations/__tests__/start-cycle-replacement-gate.test.ts
git commit -m "feat(filter-ops): block start-cycle under an overdue AHU replacement (exempt replay)"
```

---

### Task 4: Client — `validateOfflineGate` gains `replacementBlocked`

**Files:**
- Modify: `apps/web/src/lib/filter-ops/validate-offline-gate.ts`
- Test: `apps/web/src/lib/filter-ops/__tests__/validate-offline-gate.test.ts` (create if absent; else append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GateInput.replacementBlocked?: boolean`; when true AND `!cycleInProgress`, the gate returns `{ ok: false, reason: 'AHU replacement overdue — replace this filter before cleaning' }`.

- [ ] **Step 1: Write the failing test**

Create/append `apps/web/src/lib/filter-ops/__tests__/validate-offline-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateOfflineGate, type GateInput } from '../validate-offline-gate';

const base: GateInput = {
  activeStageKey: 'WASH_IN', activeStageLabel: 'Wash In', online: true,
  currentLifecycle: null, actions: [], hasGraph: false, hasLinearPipeline: false,
  pipelineGraph: null, cycleInProgress: false, hasPendingChecklist: false,
};

describe('validateOfflineGate — replacementBlocked', () => {
  it('refuses a cycle START when the filter is replacement-blocked', () => {
    const r = validateOfflineGate({ ...base, replacementBlocked: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/replacement overdue/i);
  });

  it('does NOT refuse an in-progress cycle even if flagged (running cycles finish)', () => {
    const r = validateOfflineGate({
      ...base, replacementBlocked: true, cycleInProgress: true,
      actions: [{ type: 'ADVANCE_TO_STAGE', params: { targetState: 'WASH_OUT' } } as any],
      currentLifecycle: 'WASH_IN', activeStageKey: 'WASH_OUT', activeStageLabel: 'Wash Out',
    });
    expect(r.ok).toBe(true);
  });

  it('does not affect a normal start when not flagged', () => {
    const r = validateOfflineGate({ ...base });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/filter-ops/__tests__/validate-offline-gate.test.ts`
Expected: FAIL — the first test gets `ok: true` (field ignored).

- [ ] **Step 3: Implement**

In `validate-offline-gate.ts`, add to `GateInput`:

```ts
  /** Filter is under an AHU with an overdue replacement — block a cycle START. */
  replacementBlocked?: boolean;
```

Add this check at the TOP of the cycle-start branch, right after the `!g.online && !hasValidation` stale-cache guard and before the first-stage validation:

```ts
  // AHU overdue-replacement gate (2026-07-16). START-only: an in-flight cycle is
  // never frozen (running cycles finish). The server is authoritative online;
  // this is the offline enforcement + an instant online message.
  if (!g.cycleInProgress && g.replacementBlocked) {
    return { ok: false, reason: 'AHU replacement overdue — replace this filter before cleaning' };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/filter-ops/__tests__/validate-offline-gate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/filter-ops/validate-offline-gate.ts apps/web/src/lib/filter-ops/__tests__/validate-offline-gate.test.ts
git commit -m "feat(filter-ops): validateOfflineGate blocks cycle-start when replacementBlocked"
```

---

### Task 5: Client — cache the blocked set + wire the flag (tablet + desktop), rebuild APK

**Files:**
- Modify: `apps/web/src/routes/mobile/mobile-operations.tsx` (SWR fetch + IDB cache + read into a Set + pass `replacementBlocked` at both `validateOfflineGate` call sites, ~962 and ~1730)
- Modify: `apps/web/src/routes/filter-management/filter-operations.tsx` (same, if it maintains its own gate/cache — confirm and mirror; the server gate already backstops it either way)

**Interfaces:**
- Consumes: `GET /api/replacement-schedules/blocked-filters` → `{ filterIds }`; `validateOfflineGate` (Task 4).
- Produces: no new exports — page-local wiring.

- [ ] **Step 1: Add the SWR fetch + IDB cache (mobile)**

Next to the existing `checklist-profiles` SWR (`mobile-operations.tsx` ~439) and its cache effect (~567):

```tsx
const { data: blockedFiltersData } = useSWR(online ? '/api/replacement-schedules/blocked-filters' : null, { refreshInterval: 30000, revalidateOnReconnect: true });
```

And an effect mirroring the checklist-profiles one:

```tsx
useEffect(() => {
  const ids = (blockedFiltersData as any)?.filterIds;
  if (Array.isArray(ids)) cache('blocked-filter-ids', ids, 24 * 60 * 60 * 1000);
}, [blockedFiltersData, cache]);
```

- [ ] **Step 2: Read the cached set at handler entry**

In `handleSubmitQueue` (and the single-scan submit handler that calls `validateOfflineGate` ~1730), near where `scanQueueSnapshot` / cached state is read, load the set once:

```tsx
const blockedIds = new Set<string>((await getCache<string[]>('blocked-filter-ids')) ?? []);
```

(Use the same `getCache` helper the handler already uses for `filter-state-*`.)

- [ ] **Step 3: Pass the flag at BOTH gate call sites**

In each `validateOfflineGate({ ... })` call (batch ~962 and single ~1730), add:

```tsx
  replacementBlocked: blockedIds.has(item.filterId),
```

(For the single-scan site, the filter id variable may be named differently — use whatever id that handler already uses for the scanned filter.)

- [ ] **Step 4: Confirm the START path reaches the gate**

Trace the cycle-START scan on the tablet: a scan of a filter with no active cycle must hit `validateOfflineGate` (the `!cycleInProgress` branch) BEFORE the reason dialog opens. If it does (expected — the gate runs per scanned item), no extra code is needed. If a start path opens the reason dialog WITHOUT passing through the gate, add an explicit guard there:

```tsx
if (blockedIds.has(scannedFilterId)) { setError('AHU replacement overdue — replace this filter before cleaning'); return; }
```

Document in the commit which path you confirmed.

- [ ] **Step 5: Desktop parity**

Open `filter-management/filter-operations.tsx`. If it has its own cache/SWR block and its own `validateOfflineGate` usage (it references the gate ~650), mirror Steps 1–3 there. If desktop does not run the offline gate for starts, note that the server gate covers desktop online (desktop is not the offline surface) and skip — state this in the commit.

- [ ] **Step 6: Typecheck + web suite**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json && npm test`
Expected: clean typecheck; **597+ passing** (baseline 597 + Task 4's 3), 0 failed.

- [ ] **Step 7: Rebuild dist + APK**

```bash
cd apps/web && npx vite build
export JAVA_HOME=/c/Users/hello/jdk-21.0.2 ANDROID_HOME=/c/Users/hello/Android/Sdk PATH="$JAVA_HOME/bin:$PATH"
cd ../android && npx cap sync android && cd android && ./gradlew assembleDebug
cd /c/Users/hello/21cfrlogbook-DigitalFMS && cp apps/android/android/app/build/outputs/apk/debug/app-debug.apk ./DigiLog-FilterOps.apk
```

Verify the endpoint string is in the bundle: `grep -rl "replacement-schedules/blocked-filters" apps/web/dist/assets/`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/routes/mobile/mobile-operations.tsx apps/web/src/routes/filter-management/filter-operations.tsx DigiLog-FilterOps.apk
git commit -m "feat(filter-ops): cache + enforce the overdue-AHU cleaning gate on tablet (and desktop)"
```

---

### Task 6: Docs + on-device verification handoff

**Files:**
- Modify: `CHANGELOG.md` (one entry)
- Modify: `docs/superpowers/specs/2026-07-16-ahu-overdue-cleaning-gate-design.md` (mark implemented, link commits)

- [ ] **Step 1: CHANGELOG entry** — one paragraph: overdue-AHU cleaning gate, start-only, per-filter, online (server-authoritative) + offline (cached set), replay-exempt.

- [ ] **Step 2: Mark the spec implemented** with the commit hashes.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-07-16-ahu-overdue-cleaning-gate-design.md
git commit -m "docs: record the AHU overdue-replacement cleaning gate"
```

- [ ] **Step 4: On-device verification (operator)** — cannot be self-verified; hand off this checklist:
  1. Mark an AHU's replacement task overdue (past window, qty unmet). Scan one of its filters on the tablet → starting a cycle must be refused with the overdue message, **online and offline** (airplane mode after one sync).
  2. Replace one of that AHU's filters → the NEW filter can start a cycle; un-replaced siblings still cannot.
  3. A filter already mid-cycle when the AHU went overdue → its advance/checklist/complete still work (running cycle finishes).
  4. Re-sync after an offline block → the set refreshes; a filter replaced by someone else unblocks.

## Self-Review notes

- **Spec coverage:** rule (Task 1), endpoint (Task 2), server gate + replay exemption (Task 3), offline gate (Task 4), cache + wiring + APK (Task 5), docs + device checklist (Task 6). All spec sections covered.
- **Type consistency:** `blockedFilterIdsForCleaning(): Promise<Set<string>>`, `isFilterBlockedForCleaning(filterId): Promise<boolean>`, `GateInput.replacementBlocked?: boolean`, error `AHU_REPLACEMENT_OVERDUE`, cache key `'blocked-filter-ids'`, endpoint `/api/replacement-schedules/blocked-filters` — used identically across tasks.
- **Known softness:** Task 5 Step 4/5 require in-situ confirmation of the start path in two 4000-line page files — called out explicitly rather than guessed. The server gate (Task 3) is the authoritative backstop, so a missed client wiring degrades to "online-only enforced + one extra round-trip offline," never to a silent bypass online.
