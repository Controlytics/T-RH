# Bulk Filter-Operate Endpoint — Design Spec

- **Date:** 2026-07-09
- **Branch:** RFID
- **Status:** Approved for planning (awaiting spec review)
- **Author:** Claude (with user)
- **Related:** Bulk-operations performance audit (artifact, 2026-07-09); prior client-side
  optimizations to `handleSubmitQueue` (same session)

## 1. Problem

On the tablet, an operator scans 50–100 filter RFID tags at a cleaning stage and hits
**Submit**. Today `handleSubmitQueue` (`apps/web/src/routes/mobile/mobile-operations.tsx`)
processes them in a **sequential loop, one HTTP request per filter**. There is **no
server-side bulk write endpoint** — every queued op POSTs individually to the single-filter
routes under `apps/api/src/modules/filter-operations/cycle-write/`.

Measured cost drivers (online path — the network-bound case):

- **`advance`** → 1 round-trip per filter (`POST /:id/advance`).
- **`start-and-advance`** (a fresh cycle) → **up to 3 round-trips per filter**:
  `POST /:id/start-cycle` → `GET /:id/current-state` (fresh tapeVersion) →
  `POST /:id/advance` (`use-offline.ts` online switch, ~line 202–236).
- **Post-loop priming** → one `GET /:id/current-state` per filter (already bounded to
  concurrency 6 in the prior session).

A "mix of both" batch (the confirmed real workflow) of 50 filters is therefore ~100+
sequential round-trips plus priming. Over WiFi/HTTPS on a tablet, that serial network
time **is** the wait, and it scales linearly with tag count.

Client-side tuning cannot remove sequential network round-trips. Only a request that
carries the whole batch can.

## 2. Goal / Non-Goals

**Goal:** collapse a batch submit into **one HTTP round-trip** and **one reauth prompt**, so
submit time is roughly flat regardless of tag count, while every business rule, validation,
permission, audit record, and e-signature stays identical to today.

**Non-goals:**

- Not batching audit rows into one write (hash chain must stay sequential — see §5).
- Not wrapping all filters in one giant transaction (would break partial success).
- Not touching the **offline** submit path or the offline-sync engine (protected surface).
- Not covering `bypass` (a deliberate single-filter deviation with its own permission).
- No Prisma schema / migration change — this is code + one shared constant only.

## 3. Architecture

The bulk endpoint is an **orchestrator, not a reimplementation**. It reuses the existing
service methods verbatim in a server-side loop:

- `service.advance(ctx, filterId, data)` → `advanceImpl` (`filter-operations.service.ts:80`)
- `service.startCycle(ctx, filterId, data)` → `startCycleImpl` (`:75`)
- `service.submitChecklist(ctx, filterId, data)` → `submitChecklistImpl` (`:70`)

Each already runs in its **own transaction** with its **own audit write**, checklist
enforcement, stage interlock, and `tapeVersion` staleness guard. The bulk endpoint adds only
orchestration: iterate, dispatch per `kind`, catch per item, aggregate.

## 4. Backend — `POST /api/filters/bulk-operate`

Registered in `apps/api/src/modules/filter-operations/routes.ts`, gated by
`app.requirePermission('FILTER_OPERATE')`.

### 4.1 Request

```jsonc
{
  "items": [
    { "clientOpId": "uuid", "filterId": "uuid", "kind": "advance",
      "payload": { /* same body as POST /:id/advance: targetState, tapeVersion,
                      cleaningAreaId, remarks, dryerAction, dryerDurationMinutes, ... */ } },

    { "clientOpId": "uuid", "filterId": "uuid", "kind": "start-and-advance",
      "cyclePayload":   { /* same body as POST /:id/start-cycle */ },
      "advancePayload": { /* same body as POST /:id/advance */ } },

    { "clientOpId": "uuid", "filterId": "uuid", "kind": "submit-checklist",
      "payload": { /* same body as POST /:id/submit-checklist: answers, tapeVersion, ... */ } }
  ]
}
```

- `items`: 1–200 entries (cap mirrors the bulk-upload limit; >200 → `400 BATCH_TOO_LARGE`).
- `kind ∈ { 'advance', 'start-and-advance', 'submit-checklist' }`.
- Each `payload` is validated by the **same** field constraints the single routes use
  (shared JSON-schema fragments where practical, so bulk items can't bypass a single-route
  guard).

### 4.2 Processing

```
// Reauth once for the batch, reusing the EXISTING per-op reauth actions.
// enforceReauth accepts an array and prompts if ANY is config-required for the
// role (its documented multi-action behavior). Mid-cycle advance is not
// reauth-gated; start-cycle + submit-checklist are. So the batch prompts iff it
// contains an op kind that individually would — no new reauth action needed.
reauthActions = union of:
  'advance'           -> 'ADVANCE_FILTER_STAGE'
  'start-and-advance' -> 'START_CLEANING_CYCLE'         // the reauth-gated half of the pair
  'submit-checklist'  -> 'SUBMIT_CHECKLIST_WITH_SIGNATURE'
enforceReauth(reauthActions, req, reply)           // once for the whole batch
ctx = buildContext(req)
results = []
for (item of items) {
  try {
    switch (item.kind) {
      case 'advance':           snap = await service.advance(ctx, item.filterId, item.payload); break
      case 'start-and-advance': await service.startCycle(ctx, item.filterId, item.cyclePayload)
                                snap = await service.advance(ctx, item.filterId, item.advancePayload); break
      case 'submit-checklist':  snap = await service.submitChecklist(ctx, item.filterId, item.payload); break
    }
    results.push({ clientOpId: item.clientOpId, filterId: item.filterId, status: 'ok', snapshot: snap })
  } catch (e) {
    results.push({ clientOpId: item.clientOpId, filterId: item.filterId, status: 'failed',
                   error: { code: e.code ?? 'OP_FAILED', message: e.message } })
  }
}
return { results }
```

- **Partial success:** one item failing does not affect the others; its state change +
  audit stay atomic per item (own transaction), exactly as today's incremental-commit loop.
- **`start-and-advance` in-process:** no intermediate `GET /current-state` — the server
  already holds fresh state after `startCycle`, so `advance` uses it directly. This removes
  the round-trip the client is forced to make today.
- **Reauth internal errors** (`REAUTH_REQUIRED`/`REAUTH_FAILED`) are enforced up-front for
  the whole batch and short-circuit before the loop.

### 4.3 Response

```jsonc
{
  "results": [
    { "clientOpId": "uuid", "filterId": "uuid", "status": "ok",
      "snapshot": { "filterId", "filterName", "currentState", "currentCycle",
                    "actions", "tapeVersion", "equipmentGroup", ... } },   // same shape single routes return
    { "clientOpId": "uuid", "filterId": "uuid", "status": "failed",
      "error": { "code": "STALE_TAPE", "message": "..." } }
  ]
}
```

Each `snapshot` is the identical post-write state object the single endpoints return, so the
client updates caches **from the response** — eliminating the post-loop `/current-state`
priming loop entirely.

## 5. Client integration

**Principle: change the dispatch leaf, not the structure.** File:
`apps/web/src/routes/mobile/mobile-operations.tsx`.

**Unchanged:**

- **Offline path** — still enqueues each op to IndexedDB via `executeOrQueue`; gated on the
  existing `online` flag. The bulk endpoint is **online-only**. Offline-sync engine untouched.
- **Every interactive gate** — reason/equipment dialog, per-row dryer durations, shared
  checklist dialog, cross-block gate, AHU-completion pre-flight, and the `pendingBatchReplayRef`
  replay mechanism — all run before dispatch, exactly as today.

**Changed — two code paths route through the endpoint:**

1. **Main advance / start-and-advance batch** (`handleSubmitQueue` loop leaf, ~line 823+):
   instead of calling `core.advance` / `core.startAndAdvance` (each a network POST) per
   filter, accumulate a resolved op `{clientOpId, filterId, kind, payload|cyclePayload/advancePayload}`
   into an array; after the loop, one `bulkOperate(ops)` call.
2. **Batch checklist-submit** (`handleChecklistSubmit` batch branch, ~line 2274+): the same
   collapse — N `core.submitChecklist` posts become one bulk call of `submit-checklist` items.

- **Reauth:** the existing single `reauth.execute(...)` wrapper around the batch now wraps the
  one bulk call (`BULK_FILTER_OPERATE`) → still one password prompt.
- **Cache updates:** driven by the response snapshots (`recentOps`, Currently-Drying panel,
  `filter-state-<id>` cache). The post-loop `/current-state` priming loop is deleted.
- **Failure handling:** per-item `failed` entries populate the same error list shown today.
  A whole-request transport error keeps the scan queue intact for retry.
- **Fallback safety net:** the existing per-item loop stays in place. If `bulkOperate` fails
  at the transport level (e.g. 404/500 wholesale, not per-item failures), the client falls
  back to the old per-item loop for that submit — a field problem degrades to "old slow
  behavior," never a broken submit.

A thin client helper `bulkOperate(ops)` (in `lib/filter-ops` or `use-core`) POSTs
`/api/filters/bulk-operate` with reauth and returns the `results` array.

## 6. Compliance & safety

Because the endpoint calls the existing `service.*` methods unchanged, compliance properties
are inherited:

| Dimension | Guarantee | Mechanism |
|---|---|---|
| Audit hash chain | Byte-for-byte identical rows | each `service.*` writes its own audit row in loop order, own tx; no audit batching; `verify-chain` still passes |
| Granular audit actions | Preserved | rows still record `ADVANCE_FILTER_STAGE`/`START_CLEANING_CYCLE`/`SUBMIT_CHECKLIST…`; only the reauth prompt is batched |
| Business logic & validation | Per-filter, verbatim | pipeline graph, checklist enforcement, stage interlock, `tapeVersion` guard, cross-block — the single-endpoint code |
| RBAC | Same gate | endpoint `FILTER_OPERATE`; each service re-checks ctx |
| E-signatures | Not weakened | operator re-auths for the batch; each checklist submit still writes its signed audit row — equivalent to today's 10s reauth cache spanning many submits |
| Idempotency | Preserved | per-item `clientOpId` dedup in the services |
| Atomicity | Unchanged (per-filter) | each filter's state + audit atomic together; no giant tx |
| Reauth | Existing actions + config, honored | `enforceReauth([...])` over the actions the batch's op kinds imply; prompts once iff any is config-required |

**No new compliance-surface item.** Reauth reuses the existing per-op actions
(`ADVANCE_FILTER_STAGE` / `START_CLEANING_CYCLE` / `SUBMIT_CHECKLIST_WITH_SIGNATURE`) and the
existing admin `action-reauth` config, enforced once for the batch via
`enforceReauth(actions[], …)`. No new reauth action, no count change, no config seeding.
This is a change from the initial design (which proposed `BULK_FILTER_OPERATE`), adopted
during planning because it is both simpler and more faithful to current per-op reauth policy.

**Guardrails:** batch cap 200; `bypass` excluded.

## 7. Testing

**Backend e2e** (against `digilog_test_db`):

- Mixed batch (advance + start-and-advance + submit-checklist) → correct final states.
- Partial success — one stale-`tapeVersion` item fails, rest succeed; `results` reflects it.
- Equivalence — a filter advanced via bulk ends in the same state + same audit action as via
  the single endpoint.
- Audit chain — `GET /api/audit/verify-chain` valid after a batch; one ordered row per item.
- Idempotency — replaying the same `clientOpId`s does not double-apply.
- Guards — no reauth → 403 for the batch; non-`FILTER_OPERATE` → 403; >200 items → 400.

**Client** (vitest): online path builds the correct bulk payload and posts once; **offline
path still queues individually** (explicit assertion); response snapshots update caches;
failures populate the error list.

**Real verification** (`/verify` + manual-tester): drive a real ~50-filter mixed batch in
browser dev (`localhost:5175 → https://localhost:3000`); confirm states + audit; measure
before/after wall-clock. Then APK rebuild + one real tablet timing.

## 8. Rollout & rollback

1. Backend endpoint + tests — additive, nothing calls it yet → zero risk. Shippable alone.
   (Reauth reuses existing actions — no shared/config change.)
2. Client `bulkOperate` helper + test.
3. Client wiring (online only), old per-item loop retained as fallback. Verify in browser.
4. Measure on tablet; confirm the win.

**Rollback:** Step 1 additive/harmless; Steps 2–3 keep the old path as fallback → rollback =
revert the client-wiring commit.

## 9. Doc sync on completion

`CHANGELOG.md`; `API_REFERENCE.md` (new endpoint); root + `apps/api` `CLAUDE.md` endpoint
lists; memory note. (No reauth-count change — reauth reuses existing actions, see §6.)

## 10. File touchpoints

**Backend:**
- `apps/api/src/modules/filter-operations/routes.ts` — new `POST /bulk-operate` handler
- `apps/api/src/modules/filter-operations/filter-operations.service.ts` — optional
  `bulkOperate` orchestration method (or inline in the route)
- `apps/api/src/modules/filter-operations/cycle-write/__tests__/` — new e2e test file

**Shared:** none — reauth reuses existing actions (see §6).

**Frontend:**
- `apps/web/src/routes/mobile/mobile-operations.tsx` — `handleSubmitQueue` +
  `handleChecklistSubmit` dispatch leaves; delete post-loop priming; fallback
- `apps/web/src/lib/filter-ops/` (or `use-core.ts`) — `bulkOperate(ops)` helper + its test

**Open decisions (resolved):**
- Partial success (not all-or-nothing) — **resolved: partial success.**
- `bypass` inclusion — **resolved: excluded.**
- Batch cap — **resolved: 200.**
