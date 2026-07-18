# Step 8 — Option D Architecture Plan (2026-05-02)

**Adopted after audit pivot from original 8.4 cutover.** The original plan to "delete the FE graph walker and switch FE to consume server `actions[]`" was reframed once the field-bucket audit revealed the FE walker is Tier-2 fallback and the real drift lives in `updateOfflineState()`. The audit (48 guards across 4 write methods) classified 35 pure (73%), 5 hybrid (10%, already solved by 8.3 tapeVersion + clientOpId), and 8 server-only (17%, concurrency control that can never move client-side).

**Option D adopted:** Tablet is a versioned local replica of the server's read model for the offline-relevant slice, with a shared executor running the same code on both sides.

## Architecture (three layers)

### Layer 1 — Versioned local cache

Tablet keeps a versioned copy of every entity the executor reads. Each entity has a per-row `version` field. FE syncs incrementally.

| Entity | Versioning status |
|---|---|
| `FilterCleaningProfile` | shipped (Phase A.2) |
| `FilterProfile` | shipped (Phase A.3 sidecar) |
| `EquipmentGroup` | shipped (Phase A.4 sidecar) |
| `ChecklistProfile` | needs version column |
| `AssetTemplate` | needs version column |
| `Filter` (+ block/area/AHU) | needs `updatedAt` watermark |
| `Cycle` + `FilterEvent` | already monotonic; `tapeVersion` from 8.3 = profileVersion × 1M + eventCount |
| `User` / `Permissions` | session-bound (JWT), live |

Sync protocol: `GET /api/sync/since?versions={profile:X,checklist:Y,equipment:Z,assetTemplate:W}` returns rows with `version > clientVersion`. FE polls on app start, visibility change, every 60s online.

### Layer 2 — Shared executor

`packages/shared/src/pipeline-executor/` — pure functions, no Prisma, no fetch, no `Date.now()` (timestamps injected). Read inputs from a `LocalContext`:

```ts
interface LocalContext {
  profile: FilterCleaningProfile;
  cycle: CleaningCycle;
  events: FilterEvent[];
  stageLookup: Record<string, StageInfo>;
  filter: Filter & { block, area, ahu };
  equipmentGroup: EquipmentGroup | null;
  checklistProfile: ChecklistProfile | null;
  user: { id, role, permissions };
  now: number;
}
```

Pure guards become functions of `LocalContext`. Tape generator becomes `(ctx) => executor.computeNextActions(ctx)`. Server `advance()` becomes transaction-wrapper + `executor.canAdvance(ctx, target)` + 8 server-only checks. **35 pure guards are the same code on both sides — drift impossible by construction.**

### Layer 3 — Reconciliation (the 17% server-only)

Already shipped in 8.3:
- `tapeVersion` mismatch → 409 STALE_TAPE → FE refetch + retry
- `clientOpId` dedup → silent on duplicate replay
- Row locks, lost-update detection, dup-submit → fire on conflict, FE handles via STALE_TAPE flow

The 8 server-only guards are concurrency, not logic. Their replay failures present as "another operator got there first" — comprehensible UX, not "why didn't the button work."

## What's already shipped (under Option D framing)

| Phase | Role under D |
|---|---|
| **8.0** server tape generator | Becomes a thin wrapper around `executor.computeNextActions()` |
| **8.1** shared `Action[]` types + FE skeleton | Stays — output type of executor |
| **8.2** per-action renderers + ActionDialog | Stays — dumb UI primitives |
| **8.3** tapeVersion + 409 STALE_TAPE + IDB v3 | Stays — reconciliation contract |
| **8.4 Commit 1** I-1/I-3/M-3/M3 | Stays — bug fixes valid under any architecture |

Nothing shipped is wasted.

## Phase plan (~12 days focused work)

### Phase 8.4 — Local-cache foundation (~3 days)
- Add `version` columns to `ChecklistProfile`, `AssetTemplate` (Postgres migration; Phase A.5 pattern)
- Add per-write triggers / service-layer convention to bump version on every UPDATE
- Build `GET /api/sync/since` endpoint accepting `?versions=...` query
- Build FE sync engine consuming it
- IDB schema bump (v4 → v5) adding stores for `checklistProfile`, `assetTemplate`, `equipmentGroup`, `filterProfile`, `filterCleaningProfile`
- Tests: server endpoint contract, FE sync engine resolves `since` correctly, IDB migration

### Phase 8.5 — Shared executor extraction (~4 days)
- `packages/shared/src/pipeline-executor/` package with `LocalContext` interface
- Extract the 35 pure guards (full inventory from scout audit)
- Server's 4 write methods rewritten: load context → `executor.canX(ctx)` → 8 server-only guards → transaction
- Tape generator rewrites as `(ctx) => executor.computeNextActions(ctx)`
- Existing tape + service tests must still pass; add per-guard unit tests against `LocalContext` fixtures
- Tests: each pure guard isolated; round-trip parity test (server output = executor on same context)

### Phase 8.6 — FE consumes shared executor (~3 days)
- `mobile-operations.tsx` + `filter-operations.tsx` build `LocalContext` from IDB cache
- Render via `executor.computeNextActions(ctx)` directly — no server roundtrip needed for online OR offline
- Delete the FE walker, delete `updateOfflineState()`, delete `nextAllowedStages` / `pendingChecklist` derivations
- Stage-card grid stays; each card filters `actions[]` by target stage
- Online still calls `getCurrentState()` to refresh cycle/events but uses local executor for action computation
- Tests: per-component integration test with seeded IDB context

### Phase 8.7 — Cutover & cleanup (~2 days)
- Remove `TAPE_PARALLEL` flag; tape always emitted
- Tighten `tapeVersion` to required on the 4 write routes
- Remove old derived response fields (`nextAllowedStages`, `pendingChecklist`)
- Update `routes.ts` response schemas
- Coordinated full smoke test: online + offline + concurrent-operator scenarios

### Phase 8.8 — APK rebuild + tablet field QA (~1 day work + tablet time)
- Rebuild APK; install on physical tablet
- Field QA: full cycle (start → wash → dry → terminate), bypass, checklist, offline replay, concurrent-operator collision

## Acceptance criteria for declaring Option D done

1. `packages/shared/src/pipeline-executor/` compiles + tests pass
2. Server's 4 write methods import from shared; no duplicated guard logic in service
3. Tape generator is < 50 lines (delegates to shared executor)
4. FE's `mobile-operations.tsx` + `filter-operations.tsx` import shared executor; no local walker remaining
5. `nextAllowedStages` / `pendingChecklist` removed from getCurrentState response
6. Versioned `/api/sync/since` endpoint live; FE syncs all required entities
7. Parity test: for any `LocalContext` fixture, `server.computeActions(ctx) === executor.computeNextActions(ctx)`
8. Regression test: full offline cycle (start → wash → wash-out → checklist → dry-in → dry-out → terminate) works without server contact between start and terminate

## Inventory needed before 8.5 starts

Scout audit produced counts (35 pure / 5 hybrid / 8 server-only) but not the full enumerated list. Phase 8.5 needs the concrete extraction list:

- Each pure guard: its current location (file:line), its inputs from `LocalContext`, its output shape
- Each hybrid guard: server-only check delta from the pure portion
- Each server-only guard: which server-only state it reads (lock / live count / live JWT)

Scout dispatched to produce this list; result drives the 8.5 implementation.
