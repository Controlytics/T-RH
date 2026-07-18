# Bulk Filter-Operate Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the tablet's 50–100 tag batch submit from N sequential HTTP round-trips into one `POST /api/filters/bulk-operate` request, with partial success and one reauth prompt.

**Architecture:** A new route handler orchestrates the existing `service.advance / startCycle / submitChecklist` methods in a server-side per-item loop (each in its own transaction, per-item try/catch → partial success). The tablet's online `handleSubmitQueue` / `handleChecklistSubmit` accumulate resolved ops and post them once; offline path and the offline-sync engine are untouched; the old per-item loop stays as a transport-level fallback.

**Tech Stack:** Fastify + Prisma + PostgreSQL (backend); React 19 + Vite + SWR + IndexedDB (frontend); vitest (both).

## Global Constraints

- **No Prisma schema / migration change.** Code + no shared constant. (Reauth reuses existing actions.)
- **Reuse existing service methods verbatim** — no cleaning logic reimplemented. `service.advance(ctx, filterId, data)`, `service.startCycle(ctx, filterId, data)`, `service.submitChecklist(ctx, filterId, data)` (`apps/api/src/modules/filter-operations/filter-operations.service.ts:70-81`).
- **Reauth** via `enforceReauth(actions[], req, reply)` (`apps/api/src/lib/reauth-check.ts:134`) — one call, over the union of actions the batch's kinds imply: `advance→ADVANCE_FILTER_STAGE`, `start-and-advance→START_CLEANING_CYCLE`, `submit-checklist→SUBMIT_CHECKLIST_WITH_SIGNATURE`.
- **Permission gate** `FILTER_OPERATE` (matches the single write routes).
- **Batch cap 200** → `400 BATCH_TOO_LARGE` above it. **`bypass` excluded.**
- **Partial success:** one item failing must not affect the others or roll back their audit rows.
- **Offline path untouched** — the bulk endpoint is online-only, gated on the existing `online` flag. Never touch `OFFLINE_SYNC_ARCHITECTURE.md` or the sync engine.
- **Backend tests run against `digilog_test_db`**; run the suite single-fork: `cd apps/api && npm test`.
- **Commit messages** end with the Co-Authored-By trailer used in this repo.

---

### Task 1: Backend `POST /api/filters/bulk-operate` endpoint

**Files:**
- Modify: `apps/api/src/modules/filter-operations/routes.ts` (add handler near the other write routes, after `/:id/bypass` ~line 450)
- Create: `apps/api/src/modules/filter-operations/cycle-write/bulk-operate.ts` (orchestration function)
- Create: `apps/api/src/e2e/bulk-operate.test.ts` (route-level e2e, mocked service)

**Interfaces:**
- Consumes: `service.advance / startCycle / submitChecklist(ctx, filterId, data)`; `enforceReauth`; `buildContext`.
- Produces: `bulkOperate(service, ctx, items)` → `Promise<{ results: BulkOpResult[] }>` where
  `BulkOpItem = { clientOpId: string; filterId: string; kind: 'advance'|'start-and-advance'|'submit-checklist'; payload?: any; cyclePayload?: any; advancePayload?: any }`
  and `BulkOpResult = { clientOpId: string; filterId: string; status: 'ok'; snapshot: any } | { clientOpId: string; filterId: string; status: 'failed'; error: { code: string; message: string } }`.

- [ ] **Step 1: Write the orchestration function**

Create `apps/api/src/modules/filter-operations/cycle-write/bulk-operate.ts`:

```typescript
import type { RequestContext } from '../../../lib/build-context.js';
import type { FilterOperationsService } from '../filter-operations.service.js';

export type BulkOpKind = 'advance' | 'start-and-advance' | 'submit-checklist';

export interface BulkOpItem {
  clientOpId: string;
  filterId: string;
  kind: BulkOpKind;
  payload?: any;          // advance | submit-checklist body
  cyclePayload?: any;     // start-and-advance: start-cycle body
  advancePayload?: any;   // start-and-advance: advance body
}

export type BulkOpResult =
  | { clientOpId: string; filterId: string; status: 'ok'; snapshot: any }
  | { clientOpId: string; filterId: string; status: 'failed'; error: { code: string; message: string } };

/** Reauth action implied by each op kind (mid-cycle advance is not reauth-gated). */
export function reauthActionsForItems(items: BulkOpItem[]): string[] {
  const set = new Set<string>();
  for (const it of items) {
    if (it.kind === 'advance') set.add('ADVANCE_FILTER_STAGE');
    else if (it.kind === 'start-and-advance') set.add('START_CLEANING_CYCLE');
    else if (it.kind === 'submit-checklist') set.add('SUBMIT_CHECKLIST_WITH_SIGNATURE');
  }
  return [...set];
}

/**
 * Orchestrate a batch of cleaning ops. Each item runs via the existing single-op
 * service method (own transaction, own audit row, all gates). Per-item try/catch
 * → partial success: a failed filter does not affect the others.
 */
export async function bulkOperate(
  service: FilterOperationsService,
  ctx: RequestContext,
  items: BulkOpItem[],
): Promise<{ results: BulkOpResult[] }> {
  const results: BulkOpResult[] = [];
  for (const item of items) {
    try {
      let snapshot: any;
      if (item.kind === 'advance') {
        snapshot = await service.advance(ctx, item.filterId, item.payload);
      } else if (item.kind === 'start-and-advance') {
        await service.startCycle(ctx, item.filterId, item.cyclePayload);
        snapshot = await service.advance(ctx, item.filterId, item.advancePayload);
      } else {
        snapshot = await service.submitChecklist(ctx, item.filterId, item.payload);
      }
      results.push({ clientOpId: item.clientOpId, filterId: item.filterId, status: 'ok', snapshot });
    } catch (e: any) {
      results.push({
        clientOpId: item.clientOpId,
        filterId: item.filterId,
        status: 'failed',
        error: { code: e?.code ?? 'OP_FAILED', message: e?.message ?? 'Operation failed' },
      });
    }
  }
  return { results };
}
```

- [ ] **Step 2: Register the route** in `apps/api/src/modules/filter-operations/routes.ts`

Add this import near the top (with the other `./cycle-write/...`-adjacent imports is fine; it's imported here directly):

```typescript
import { bulkOperate, reauthActionsForItems, type BulkOpItem } from './cycle-write/bulk-operate.js';
```

Add the handler after the `/:id/bypass` route (~line 450), before the retire/replace routes:

```typescript
  app.post('/bulk-operate', {
    preHandler: [app.requirePermission('FILTER_OPERATE')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Batch cleaning ops (advance / start-and-advance / submit-checklist) in one request',
      body: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            items: {
              type: 'object',
              required: ['clientOpId', 'filterId', 'kind'],
              properties: {
                clientOpId: { type: 'string', maxLength: 100 },
                filterId: { type: 'string', format: 'uuid' },
                kind: { type: 'string', enum: ['advance', 'start-and-advance', 'submit-checklist'] },
                payload: { type: 'object', additionalProperties: true, maxProperties: MAX_OBJECT_PROPS },
                cyclePayload: { type: 'object', additionalProperties: true, maxProperties: MAX_OBJECT_PROPS },
                advancePayload: { type: 'object', additionalProperties: true, maxProperties: MAX_OBJECT_PROPS },
              },
            },
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { items } = req.body as { items: BulkOpItem[] };
    const { ok } = await enforceReauth(reauthActionsForItems(items), req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    return service.bulkOperate(ctx, items);
  });
```

- [ ] **Step 3: Add the thin service method** in `apps/api/src/modules/filter-operations/filter-operations.service.ts` (after the `advance` method, ~line 82):

```typescript
  async bulkOperate(ctx: RequestContext, items: BulkOpItem[]) {
    return bulkOperate(this, ctx, items);
  }
```

Add its import at the top of that file (near the other `./cycle-write/...` imports, lines 18-20):

```typescript
import { bulkOperate, type BulkOpItem } from './cycle-write/bulk-operate.js';
```

- [ ] **Step 4: Write the route-level e2e test** — mirror `apps/api/src/e2e/phase2-filter-operations.test.ts` (real auth + prisma, **mocked** `FilterOperationsService`).

Create `apps/api/src/e2e/bulk-operate.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';

// Mock the service so the test controls each method's return + can assert dispatch.
const advance = vi.fn();
const startCycle = vi.fn();
const submitChecklist = vi.fn();
const bulkOperateSpy = vi.fn();
vi.mock('../modules/filter-operations/filter-operations.service.js', () => ({
  FilterOperationsService: vi.fn().mockImplementation(() => ({
    advance, startCycle, submitChecklist,
    // real orchestration over the mocked single methods:
    bulkOperate: async (_ctx: any, items: any[]) => {
      bulkOperateSpy(items);
      const results = [];
      for (const it of items) {
        try {
          let snapshot;
          if (it.kind === 'advance') snapshot = await advance(_ctx, it.filterId, it.payload);
          else if (it.kind === 'start-and-advance') { await startCycle(_ctx, it.filterId, it.cyclePayload); snapshot = await advance(_ctx, it.filterId, it.advancePayload); }
          else snapshot = await submitChecklist(_ctx, it.filterId, it.payload);
          results.push({ clientOpId: it.clientOpId, filterId: it.filterId, status: 'ok', snapshot });
        } catch (e: any) {
          results.push({ clientOpId: it.clientOpId, filterId: it.filterId, status: 'failed', error: { code: e?.code ?? 'OP_FAILED', message: e?.message } });
        }
      }
      return { results };
    },
  })),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

describe('POST /api/filters/bulk-operate', () => {
  let app: FastifyInstance;
  let token: string;
  beforeAll(async () => {
    app = await buildApp();
    const { default: routes } = await import('../modules/filter-operations/routes.js');
    await app.register(routes, { prefix: '/api/filters' });
    await app.ready();
    ({ token } = await loginAs(app, 'admin'));
    advance.mockResolvedValue({ filterId: 'x', currentState: 'WASH_OUT', tapeVersion: 2, actions: [] });
    startCycle.mockResolvedValue({ id: 'cyc' });
    submitChecklist.mockResolvedValue({ filterId: 'x', currentState: 'DRY_IN', tapeVersion: 3, actions: [] });
  });
  afterAll(async () => { await app.close(); });

  it('dispatches a mixed batch and returns per-item ok results', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/filters/bulk-operate',
      headers: { authorization: `Bearer ${token}` },
      payload: { items: [
        { clientOpId: 'a', filterId: uuid(1), kind: 'advance', payload: { targetState: 'WASH_OUT', tapeVersion: 1 } },
        { clientOpId: 'b', filterId: uuid(2), kind: 'start-and-advance', cyclePayload: { cleaningReasonKey: 'ROUTINE' }, advancePayload: { targetState: 'WASH_IN', tapeVersion: 1 } },
        { clientOpId: 'c', filterId: uuid(3), kind: 'submit-checklist', payload: { answers: {}, tapeVersion: 1 } },
      ] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(3);
    expect(body.results.every((r: any) => r.status === 'ok')).toBe(true);
    expect(startCycle).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledTimes(2); // advance item + start-and-advance's advance
    expect(submitChecklist).toHaveBeenCalledTimes(1);
  });

  it('returns partial success — one failed item does not fail the batch', async () => {
    advance.mockReset();
    advance.mockImplementationOnce(async () => { const e: any = new Error('stale'); e.code = 'STALE_TAPE'; throw e; });
    advance.mockResolvedValue({ filterId: 'x', currentState: 'WASH_OUT', tapeVersion: 2, actions: [] });
    const res = await app.inject({
      method: 'POST', url: '/api/filters/bulk-operate',
      headers: { authorization: `Bearer ${token}` },
      payload: { items: [
        { clientOpId: 'a', filterId: uuid(1), kind: 'advance', payload: { targetState: 'WASH_OUT', tapeVersion: 1 } },
        { clientOpId: 'b', filterId: uuid(2), kind: 'advance', payload: { targetState: 'WASH_OUT', tapeVersion: 1 } },
      ] },
    });
    const body = res.json();
    expect(body.results[0]).toMatchObject({ status: 'failed', error: { code: 'STALE_TAPE' } });
    expect(body.results[1]).toMatchObject({ status: 'ok' });
  });

  it('rejects >200 items with 400', async () => {
    const items = Array.from({ length: 201 }, (_, i) => ({ clientOpId: `k${i}`, filterId: uuid(1), kind: 'advance', payload: { targetState: 'X', tapeVersion: 1 } }));
    const res = await app.inject({ method: 'POST', url: '/api/filters/bulk-operate', headers: { authorization: `Bearer ${token}` }, payload: { items } });
    expect(res.statusCode).toBe(400);
  });

  it('requires auth (401 without token)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/filters/bulk-operate', payload: { items: [] } });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && npx vitest run src/e2e/bulk-operate.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: 4 tests PASS. (If the mock-registration order needs adjusting, follow the exact `vi.mock` + dynamic route `import()` ordering in `phase2-filter-operations.test.ts`.)

- [ ] **Step 6: Typecheck backend**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/filter-operations/cycle-write/bulk-operate.ts \
        apps/api/src/modules/filter-operations/routes.ts \
        apps/api/src/modules/filter-operations/filter-operations.service.ts \
        apps/api/src/e2e/bulk-operate.test.ts
git commit -m "feat(filter-ops): add POST /api/filters/bulk-operate batch endpoint

Orchestrates advance/start-and-advance/submit-checklist over the existing
single-op service methods (per-item tx, partial success). One reauth over
the union of implied actions. Additive — no client caller yet.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Client `bulkOperate` helper

**Files:**
- Create: `apps/web/src/lib/filter-ops/bulk-operate.ts`
- Create: `apps/web/src/lib/filter-ops/__tests__/bulk-operate.test.ts`

**Interfaces:**
- Consumes: `apiClient.post` / `apiClient.postWithReauth` (`apps/web/src/lib/api-client.ts`).
- Produces: `bulkOperate(items, password?)` → `Promise<{ results: BulkClientResult[] }>` with the same `results` shape the backend returns.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/filter-ops/__tests__/bulk-operate.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-client', () => ({
  apiClient: { post: vi.fn(), postWithReauth: vi.fn() },
}));
import { apiClient } from '@/lib/api-client';
import { bulkOperate } from '../bulk-operate';

describe('bulkOperate client helper', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('posts all items in one request and returns results', async () => {
    (apiClient.post as any).mockResolvedValue({ results: [{ clientOpId: 'a', filterId: 'f1', status: 'ok', snapshot: {} }] });
    const items = [{ clientOpId: 'a', filterId: 'f1', kind: 'advance' as const, payload: {} }];
    const out = await bulkOperate(items);
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith('/api/filters/bulk-operate', { items });
    expect(out.results).toHaveLength(1);
  });

  it('uses postWithReauth when a password is supplied', async () => {
    (apiClient.postWithReauth as any).mockResolvedValue({ results: [] });
    const items = [{ clientOpId: 'a', filterId: 'f1', kind: 'submit-checklist' as const, payload: {} }];
    await bulkOperate(items, 'pw');
    expect(apiClient.postWithReauth).toHaveBeenCalledWith('/api/filters/bulk-operate', { items }, 'pw');
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module not found)

Run: `cd apps/web && npx vitest run src/lib/filter-ops/__tests__/bulk-operate.test.ts`
Expected: FAIL — cannot resolve `../bulk-operate`.

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/lib/filter-ops/bulk-operate.ts`:

```typescript
import { apiClient } from '@/lib/api-client';

export type BulkClientKind = 'advance' | 'start-and-advance' | 'submit-checklist';

export interface BulkClientItem {
  clientOpId: string;
  filterId: string;
  kind: BulkClientKind;
  payload?: any;
  cyclePayload?: any;
  advancePayload?: any;
}

export type BulkClientResult =
  | { clientOpId: string; filterId: string; status: 'ok'; snapshot: any }
  | { clientOpId: string; filterId: string; status: 'failed'; error: { code: string; message: string } };

/**
 * POST a whole batch of cleaning ops in one request. When `password` is given
 * (reauth retry), use the reauth-aware post so the server-side enforceReauth
 * gate is satisfied. Returns the per-item results array.
 */
export async function bulkOperate(
  items: BulkClientItem[],
  password?: string,
): Promise<{ results: BulkClientResult[] }> {
  const body = { items };
  return password
    ? apiClient.postWithReauth('/api/filters/bulk-operate', body, password)
    : apiClient.post('/api/filters/bulk-operate', body);
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd apps/web && npx vitest run src/lib/filter-ops/__tests__/bulk-operate.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/filter-ops/bulk-operate.ts apps/web/src/lib/filter-ops/__tests__/bulk-operate.test.ts
git commit -m "feat(filter-ops-web): add bulkOperate client helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

> **REVISED 2026-07-09 (post-stall re-plan).** The original Tasks 3–4 assumed the
> tablet had two online batch write-sites; a code trace found **three**, in
> **three separate handlers** of `mobile-operations.tsx`, plus a subtle ordering
> dependency and an insufficient review gate. Corrected decomposition below.
> All three sites POST the SAME endpoint and share ONE helper. Verified call-sites:
> - **`handleSubmitQueue`** (~L824) — mid-cycle **advances** (`executeOrQueue('advance')` leaf ~L1160; DRY_IN `SET_DURATION` `core.advance` ~L1100). Post-loop **checklist dispatch (~L1230)** consumes `serverActionsByFilter` populated *during* the loop.
> - **`handleEquipSubmit`** (~L1941) — batch **cycle-starts**: first `core.startAndAdvance` (~L2000) + a `for (const rest of batchRest)` loop (~L2075), each `reauth.execute('START_CLEANING_CYCLE')`. Post-loop **unified checklist dispatch (~L2114)** consumes `cycleStartActionsByFilter`.
> - **`handleChecklistSubmit`** (~L2267) — batch branch `for (const item of batch)` (~L2324) of `core.submitChecklist`.
> - NOT in scope: `handleReasonSubmit` (~L1706) fires a **single-filter** `startAndAdvance` (no batch loop) — one round-trip, not a batch-perf concern. Leave it on `core.startAndAdvance`.
> **Gate note:** a diff-review CANNOT verify the early-return gates still behave — only a real mixed-batch run can. Behavioral verification (Task 6) is the true gate; do not treat green typecheck + clean diff-review as "correct."

### Task 3: Shared `runBulkOnline` helper + wire `handleSubmitQueue` advances

**Files:**
- Modify: `apps/web/src/routes/mobile/mobile-operations.tsx` — add a `runBulkOnline` helper inside the component; wire `handleSubmitQueue` (~L824) + delete its post-loop `/current-state` priming.

**Interfaces:**
- Consumes: `bulkOperate(items, password?)` + `BulkClientItem`/`BulkClientResult` (Task 2); `reauth.execute`, `cache` (already in scope).
- Produces (used by Tasks 4 & 5): `runBulkOnline(ops: BulkClientItem[], reauthAction: string): Promise<BulkOnlineOutcome | 'transport_error'>` where `BulkOnlineOutcome = { results: BulkClientResult[]; actionsByFilter: Map<string, any[]>; okCount: number; failures: string[] }`. It wraps the ONE bulk POST in `reauth.execute`, re-throws `REAUTH_REQUIRED`/`REAUTH_FAILED`, returns `'transport_error'` on any other throw, and for each `ok` result primes `filter-state-<id>` cache + records `snapshot.actions` in `actionsByFilter`.

- [ ] **Step 1:** Add the import at the top of the file:
```typescript
import { bulkOperate, type BulkClientItem, type BulkClientResult } from '@/lib/filter-ops/bulk-operate';
```

- [ ] **Step 2:** Add the shared helper inside `MobileOperationsPage` (near the other async handlers, e.g. just above `handleSubmitQueue`):
```typescript
  // Post one batch of resolved ops to /bulk-operate (online only), wrapped in a
  // single reauth prompt. Primes each ok filter's cache from its returned
  // snapshot and exposes the per-filter post-write `actions` tape so the callers'
  // existing post-loop checklist dispatch keeps working. Re-throws REAUTH so the
  // password dialog stays open; returns 'transport_error' on a wholesale failure
  // so the caller can keep its queue and let the operator retry.
  const runBulkOnline = async (
    ops: BulkClientItem[],
    reauthAction: string,
  ): Promise<{ results: BulkClientResult[]; actionsByFilter: Map<string, any[]>; okCount: number; failures: string[] } | 'transport_error'> => {
    let resp: { results: BulkClientResult[] };
    try {
      resp = await reauth.execute(reauthAction, (password?: string) => bulkOperate(ops, password));
    } catch (e: any) {
      const code = e?.error ?? e?.code;
      if (code === 'REAUTH_REQUIRED' || code === 'REAUTH_FAILED') throw e;
      return 'transport_error';
    }
    const actionsByFilter = new Map<string, any[]>();
    const failures: string[] = [];
    let okCount = 0;
    for (const r of resp.results) {
      if (r.status === 'ok') {
        okCount++;
        if (r.snapshot) {
          await cache(`filter-state-${r.filterId}`, r.snapshot, 24 * 60 * 60 * 1000);
          if (Array.isArray((r.snapshot as any).actions)) actionsByFilter.set(r.filterId, (r.snapshot as any).actions);
        }
      } else {
        failures.push(`${r.filterId}: ${r.error?.message ?? 'failed'}`);
      }
    }
    return { results: resp.results, actionsByFilter, okCount, failures };
  };
```

- [ ] **Step 3:** In `handleSubmitQueue`, add `const bulkOps: BulkClientItem[] = [];` next to `serverActionsByFilter`. At the two ONLINE advance leaves, instead of the network call, push a resolved op and `continue`:
  - Mid-cycle advance leaf (`executeOrQueue('advance', …)`, ~L1160): read that call's exact payload and mirror it — `bulkOps.push({ clientOpId: crypto.randomUUID(), filterId: item.filterId, kind: 'advance', payload: { targetState: activeStage.key, cleaningAreaId: selectedBlock?.id, remarks: remarks || \`${activeStage.label} - ${item.filterName}\`, tapeVersion: <same source the current call uses> } })`.
  - DRY_IN `SET_DURATION` (`core.advance({… dryerAction:'SET_DURATION' …})`, ~L1100): mirror its payload into `kind:'advance'` with `dryerAction:'SET_DURATION'`, `dryerDurationMinutes: dur`.
  - **Offline (`!online`): leave both leaves EXACTLY as-is** (`executeOrQueue`/`core.advance`). Only the `online` branch accumulates.
  - **Read the current call to find the `tapeVersion` source** (cache `filter-state-<id>`'s `tapeVersion`/`currentCycle`, or the resolved actions). Mirror it; do not invent it. If genuinely unclear, DONE_WITH_CONCERNS.

- [ ] **Step 4:** After the loop, BEFORE the existing post-loop checklist-dispatch block (the `if (successCount > 0 || failed.length > 0)` block, ~L1220), dispatch the batch and feed `serverActionsByFilter` from the response so that block keeps working unchanged:
```typescript
    if (online && bulkOps.length > 0) {
      const out = await runBulkOnline(bulkOps, 'ADVANCE_FILTER_STAGE');
      if (out === 'transport_error') {
        setError('Could not reach the server to submit the batch. Please try Submit again.');
        setLoading(false);
        return; // keep scanQueue intact for retry — do NOT clear it
      }
      successCount += out.okCount;
      failed.push(...out.failures);
      for (const [fid, actions] of out.actionsByFilter) serverActionsByFilter.set(fid, actions);
      for (const r of out.results) {
        if (r.status === 'ok') setRecentOps(prev => [{ stage: activeStage.label, filter: bulkOps.find(o => o.filterId === r.filterId) ? scanQueueSnapshot.find(q => q.filterId === r.filterId)?.filterName ?? r.filterId : r.filterId, time: formatTime(new Date()), queued: false }, ...prev].slice(0, 20));
      }
    }
```
  (The existing post-loop checklist-dispatch block then runs unchanged, reading `serverActionsByFilter`.)

- [ ] **Step 5:** DELETE the now-dead post-loop online priming block (`if (online) { await mutate('/api/assets/instances', …); await runWithConcurrency(queuedIds, 6, …/current-state…) }`, ~L1305) — snapshots came from the response. Replace it with a single `if (online) await mutate('/api/assets/instances', undefined, { revalidate: true });`. **Keep the `runWithConcurrency` helper** (still used elsewhere) and the trailing `refreshOfflineData()`.

- [ ] **Step 6:** No per-item fallback extraction (dropped — the reused service methods make a per-item fallback low-value and fragile; `'transport_error'` keeps the queue for retry, which is the safety net).

- [ ] **Step 7: Typecheck + tests + commit**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vitest run src/lib/filter-ops` → clean + PASS.
```bash
git add apps/web/src/routes/mobile/mobile-operations.tsx
git commit -m "feat(mobile-ops): batch advances via bulk-operate + shared runBulkOnline

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire `handleEquipSubmit` batch cycle-start to `bulkOperate`

**Files:**
- Modify: `apps/web/src/routes/mobile/mobile-operations.tsx` — `handleEquipSubmit` (~L1941).

**Interfaces:** Consumes `runBulkOnline` (Task 3), `bulkOperate`, `BulkClientItem`.

- [ ] **Step 1:** In the `if (pendingCyclePayload)` branch (~L1992), when `online`, replace BOTH the first `core.startAndAdvance` (~L2000) AND the `for (const rest of batchRest)` loop (~L2075) with ONE bulk call. Build the ops array from `[{ filterId: equipFiltId, filterName: equipFiltName }, ...batchRest]`, each `kind:'start-and-advance'` with `cyclePayload: pendingCyclePayload` and the SAME `advancePayload` shape the current call builds (targetState, cleaningAreaId, equipmentGroupId: selectedEquipGroup.id, instrumentReadings: readings, dryerAction when DRY_IN, remarks), `clientOpId: crypto.randomUUID()`:
```typescript
      const ops: BulkClientItem[] = [{ filterId: equipFiltId, filterName: equipFiltName }, ...batchRest].map(f => ({
        clientOpId: crypto.randomUUID(),
        filterId: f.filterId,
        kind: 'start-and-advance' as const,
        cyclePayload: pendingCyclePayload,
        advancePayload: {
          targetState,
          cleaningAreaId: selectedBlock?.id,
          equipmentGroupId: selectedEquipGroup.id,
          instrumentReadings: readings,
          ...(isDryerReadings ? { dryerAction: 'SUBMIT_READINGS' } : {}),
          remarks: remarks || `${equipStage.replace(/_/g, ' ')} - ${f.filterName}`,
        },
      }));
      const out = await runBulkOnline(ops, 'START_CLEANING_CYCLE');
      if (out === 'transport_error') { setError('Could not reach the server to start the cycles. Please try again.'); setLoading(false); return; }
      setPendingCyclePayload(null);
      executed = out.okCount > 0;
      out.failures.forEach(f => setError(f));
      for (const [fid, actions] of out.actionsByFilter) cycleStartActionsByFilter.set(fid, actions);
```
  - **OFFLINE (`!online`): keep the existing per-filter `core.startAndAdvance` + `batchRest` loop EXACTLY as-is.** Gate the new bulk path on `online`; the old code stays in the `else`.
  - Preserve `cycleStartActionsByFilter` population (now from `out.actionsByFilter`) so the **unified checklist dispatch (~L2114)** downstream keeps working unchanged.
  - Preserve `dialogOpenedByCore`, `setStageSubmitRecap`, `setRecentOps` messaging, and the `if (typeof executed !== 'boolean')` bail semantics as closely as possible (the reauth cancel now surfaces via `runBulkOnline` throwing REAUTH; a cancelled reauth leaves the dialog open — verify this matches current UX in Task 6).
  - **Known semantic (ledger):** a `start-and-advance` item that fails on the advance half may have CREATED a cycle; server guards a re-start with `CYCLE_ACTIVE` 409. Surface the failure; the operator retries by re-scanning. Note in report.

- [ ] **Step 2: Typecheck + tests + commit**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vitest run src/lib/filter-ops` → clean + PASS.
```bash
git add apps/web/src/routes/mobile/mobile-operations.tsx
git commit -m "feat(mobile-ops): batch cycle-start via bulk-operate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire `handleChecklistSubmit` batch to `bulkOperate`

**Files:**
- Modify: `apps/web/src/routes/mobile/mobile-operations.tsx` — `handleChecklistSubmit` batch branch (~L2324).

**Interfaces:** Consumes `runBulkOnline`, `bulkOperate`, `BulkClientItem`.

- [ ] **Step 1:** In the batch branch's `for (const item of batch)` loop (~L2324), when `online`, replace the per-member `core.submitChecklist` calls with ONE bulk call of `kind:'submit-checklist'` items:
```typescript
        const ops: BulkClientItem[] = batch.map(item => ({
          clientOpId: crypto.randomUUID(),
          filterId: item.filterId,
          kind: 'submit-checklist' as const,
          payload: { answers: checklistAnswers, tapeVersion: <same source the current core.submitChecklist call uses for this member> },
        }));
        const out = await runBulkOnline(ops, 'SUBMIT_CHECKLIST_WITH_SIGNATURE');
        if (out === 'transport_error') { setError('Could not reach the server to submit the checklist. Please try again.'); setLoading(false); return; }
        out.failures.forEach(f => setError(f));
```
  - **RESOLVE-BY-READING (critical):** read exactly how the current `core.submitChecklist({...})` call in this branch obtains `tapeVersion` for each member (it may read `filter-state-<id>` cache, `pendingBatch` item field, or resolved actions). Mirror that EXACT source per member. The submit-checklist backend requires `tapeVersion` (409 STALE_TAPE otherwise). If you cannot determine the per-member source with confidence, return **DONE_WITH_CONCERNS** documenting the ambiguity — do NOT guess.
  - **OFFLINE: keep the existing per-member loop as-is.** Gate the bulk path on `online`.
  - Preserve the terminal-checklist `willComplete` detection + queue-clear that follows, and any post-branch state cleanup. Replace the batch branch's post-loop `Promise.all(batch.map(...current-state...))` prime — snapshots come from the response.

- [ ] **Step 2: Typecheck + tests + commit**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vitest run src/lib/filter-ops` → clean + PASS.
```bash
git add apps/web/src/routes/mobile/mobile-operations.tsx
git commit -m "feat(mobile-ops): batch checklist submit via bulk-operate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Behavioral verification — the real gate (do NOT skip)

**Files:** none. **This is the gate for Tasks 3–5** — the diff-reviews cannot prove the early-return gates still behave.

- [ ] **Step 1:** Restart API (`cd apps/api && npx tsx watch src/app.ts` — tsx watch is stale-prone on Windows) + Vite (`cd apps/web && npx vite --host`). Confirm TLS: `curl -sk -o /dev/null -w "%{http_code}" https://localhost:3000/health`.
- [ ] **Step 2:** Use the `manual-tester` skill / Playwright against `http://localhost:5175/m`. Log in, pick a block. Run these batches and confirm ONE `POST /api/filters/bulk-operate` per Submit (network tab), correct final states, no console errors:
  - **Mid-cycle batch** — several filters at the same mid-cycle stage → advance.
  - **Cycle-start batch** — several filters with no active cycle at WASH_IN (equipment dialog) → start.
  - **Checklist batch** — a stage whose profile has a checklist → shared dialog answered once → all submit.
  - **Mixed batch** — cycle-start + mid-cycle together (the user's real case).
  - **Gate preservation** — confirm the cross-block dialog, reason dialog, AHU pre-flight, and DRY_IN duration flow still trigger correctly.
  - **Partial failure** — force one stale filter; confirm it reports failed while others succeed and the queue behavior is sane.
- [ ] **Step 3:** Audit integrity: `GET /api/audit/verify-chain` valid; one ordered audit row per submitted op; each row's action is the correct granular action.
- [ ] **Step 4:** Measure wall-clock for a ~50-filter mixed submit (before via `git stash` the wiring, after). Record numbers for the CHANGELOG.
- [ ] **Step 5 (tablet):** `cd apps/web && npx vite build; cd ../android && npx cap copy android && cd android && ./gradlew assembleDebug`; sideload; one real tablet timing.
- [ ] **If any check fails:** fix before proceeding — do not mark the client work done on a red behavioral run.

---

### Task 7: Doc sync + memory

**Files:** `CHANGELOG.md`, `API_REFERENCE.md`, `CLAUDE.md` (root), `apps/api/CLAUDE.md`; new memory note.

- [ ] **Step 1:** Add to `API_REFERENCE.md` + the "Key API Endpoints (filter operations)" block in root + `apps/api` `CLAUDE.md`: `POST /api/filters/bulk-operate — Batch advance / start-and-advance / submit-checklist in one request (partial success)`.
- [ ] **Step 2:** `CHANGELOG.md` entry with the measured before/after numbers from Task 6.
- [ ] **Step 3:** Memory file `project_bulk_filter_operate_2026_07_09.md` (+ `MEMORY.md` pointer): endpoint reuses single-op service methods; reauth via existing actions; THREE client call-sites (handleSubmitQueue/handleEquipSubmit/handleChecklistSubmit) share `runBulkOnline`; offline untouched; transport-error keeps queue for retry.
- [ ] **Step 4: Commit**
```bash
git add CHANGELOG.md API_REFERENCE.md CLAUDE.md apps/api/CLAUDE.md
git commit -m "docs: bulk filter-operate endpoint + measured perf numbers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Tasks 3–5 all edit `mobile-operations.tsx` and share `runBulkOnline`.** Do them in order (3 defines the helper). Each touches a different handler.
- **Change only the ONLINE execute-leaf; preserve every early-return gate** (DRY_IN replay via `pendingBatchReplayRef`, terminal-checklist suppression, cross-block gate, AHU pre-flight, reason/equipment dialogs). If a payload/`tapeVersion` source is unclear, READ the current call at that spot and mirror it — never invent a compliance-relevant field; DONE_WITH_CONCERNS if truly unclear.
- **Do not touch** the offline `executeOrQueue`/`core.*` branches, `sync-engine.ts`, or `OFFLINE_SYNC_ARCHITECTURE.md`. The bulk path is `online`-gated; offline stays byte-for-byte.
- **The diff-review is not the gate for Tasks 3–5 — Task 6's behavioral run is.** A clean typecheck + green unit tests are necessary, not sufficient.
- **After Task 1**, the endpoint is live and testable with `curl` before any client change.
