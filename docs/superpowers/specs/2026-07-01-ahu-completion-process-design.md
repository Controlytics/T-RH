# AHU Cleaning Completion Process — Design & Requirement Analysis

**Date:** 2026-07-01
**Branch:** RFID
**Status:** Design (pending user spec review → implementation plan)
**Author:** Claude (with sivamunnangi1211)

---

## 0. Confirmed decisions (from brainstorming)

| # | Decision | Choice | Consequence |
|---|----------|--------|-------------|
| D1 | How filters "park" at the final stage | **Require a final checklist** | Interlock enforces only in the `submit-checklist` completion path; `advance.ts` auto-complete is untouched. Small, low-risk. |
| D2 | Offline strictness for Interlock | **Best-effort (online-only)** | Gate runs only when `!isOfflineReplay`; synced offline completions pass through unblocked (no sync-queue poisoning). Documented gap. |
| D3 | Which filters count as "belonging to the AHU" | **All active filters** | `isActive && status != 'Retired'` child filters of the AHU, **ignoring** `pmFilterSetMode`. |
| D4 | Batch scoping | **Every active filter must reach final — idle / never-started filters DO block** (revised 2026-07-01 per user) | The whole AHU must be cleaned to final before any filter submits. A never-started filter holds the AHU until it is cleaned. |
| D5 | Config UI (default) | **Dropdown** (`select`) | Reuses the auto-generated dynamic config renderer; radio would require a custom page. |
| D6 | Admin force-complete (`instance.service.ts:487`) | **Ungated** | Intentional admin override bypasses the batch rule. |
| D7 | Cycle-id handling (per user) | **State is interpreted against the filter's current cycle id** | Uses the `CLEANING_CYCLE_COMPLETED` marker (set on completion, reset when a *different* new cycle starts) so stale completions from a different cycle id are not counted. |

D5 is a default chosen in the user's absence and may be revised at spec review.

---

## 1. Functional analysis

### 1.1 Objective
A new **global** system configuration, **AHU Cleaning Completion Process**, with three mutually-exclusive modes controlling what happens when an operator finishes a filter's **final cleaning stage**:

- **Interlock** — hard block: a filter cannot be submitted at its final stage until every *active-batch* sibling filter in the same AHU has also reached its final stage.
- **Popup** — soft, informational warning listing siblings not yet at final; operator may Continue or Cancel. Non-blocking.
- **None** — today's behaviour. No check, no popup, no block.

Default: **None**. Only one mode active at a time.

### 1.2 How "final stage submission" maps onto DigiLog reality
DigiLog has **no discrete "submit / complete cycle" endpoint**. A cleaning cycle completes implicitly at one of two choke points (verified):

1. `apps/api/src/modules/filter-operations/cycle-write/advance.ts:459-493` — when the operator **advances into** a stage whose only forward path leads to `END` with no further stages (`willComplete`, line 379). Auto-completes inline.
2. `apps/api/src/modules/filter-operations/cycle-write/submit-checklist.ts:215-243` — when a **terminal CHECKLIST** sits between the final STAGE and `END`; the filter *parks* at the final stage until the operator submits that checklist, which completes the cycle (`shouldComplete`, line 170).

Both use the same graph predicate `findReachable(node.id).hasEndNext && reachableStages.length === 0` (`packages/shared/src/pipeline-executor/transitions.ts:279-304`).

**Because of D1 (require final checklist), the "parked at final stage → submit" state the spec assumes is exactly choke point #2.** The Interlock gate is therefore a single insertion in `submit-checklist.ts` guarded by `shouldComplete`. Choke point #1 (`advance` auto-complete) is left unchanged — profiles without a terminal checklist are not gated (see §11 limitation).

### 1.3 "Final stage" is dynamic, never hardcoded
Per profile, the final STAGE node `S` is the one where `findReachable(S.id, nodes, edges).hasEndNext === true && .reachableStages.length === 0`. Cleaning profiles vary in stage count and stage keys; the check always derives the final stage from the cycle's **pinned** profile version (`cleaning_cycles.profileId` + `profileVersion`), so mixed profiles within one AHU each resolve their own final stage. No stage-name constants anywhere.

### 1.4 "Reached final stage" — precise definition (revised per D4 + D7)
A counted filter **has reached its final stage** iff **exactly one** of:
- (a) it has an **active** cycle (`FilterDetails.currentCycleId != null`) **and** `FilterDetails.currentLifecycleState === finalStageKey(its active cycle's pinned profile)` — *parked at final*; or
- (b) it has **no** active cycle (`currentCycleId == null`) **and** `currentLifecycleState === 'CLEANING_CYCLE_COMPLETED'` — *completed this cycle*.

Everything else **blocks**, including:
- **never-started / idle** filters (`currentCycleId == null` and state is `null` or an initial/non-completed value) — per D4 they hold the AHU;
- **mid-cleaning** filters (active cycle, not at final);
- **terminated** filters (`terminate-cycle` clears both fields → state ≠ `CLEANING_CYCLE_COMPLETED` → must be re-cleaned);
- filters that **completed then started a different new cycle** (the new `start-cycle` resets `currentLifecycleState`, so the stale completion no longer counts — D7).

The Interlock gate **blocks the submission** when **any** counted filter of the AHU has not reached final by this definition. Rationale (D7): the check reads state strictly against `currentCycleId`; the `CLEANING_CYCLE_COMPLETED` marker is set on completion (`advance.ts:471`, `submit-checklist.ts:226`) and reset when a *different* cycle starts, so "different cycle id" states are automatically excluded — no separate round/batch id is needed. The predicate uses only two `FilterDetails` columns (plus the active cycle's pinned profile to resolve `finalStageKey`), so it needs no extra cycle-status query for completed filters.

### 1.5 Worked example (matches the spec)
AHU-01, profile `Stage1→Stage2→Stage3→FinalStage→[Checklist]→END`. Filters 1/2/6 parked at FinalStage (checklist pending); 3/7/10 at Stage3; 4/8 at Stage2; 5/9 at Stage1.
Operator submits Filter-1's terminal checklist → gate loads AHU-01's active-cycle siblings → 3,4,5,7,8,9,10 are not at final → **reject** with:

> All filters belonging to AHU-01 must reach their final cleaning stage before submission.
> Pending Filters: Filter-3 – Stage3, Filter-4 – Stage2, … Filter-10 – Stage3.
> Please complete the remaining filters before submitting.

Once 3–10 also park at FinalStage, every filter's checklist submit passes, one by one. No deadlock (parking ≠ completing).

---

## 2. Database impact analysis

**No schema changes, no new tables, no new columns, no indexes.**

- The config is stored as a single JSON row in the existing `SystemConfig` table (`apps/api/prisma/schema.prisma:210`), keyed `config_key = 'ahu-completion-process'`, value `{ "mode": "NONE" }`. Auto-seeded by `configRegistry.seedDefaults()`.
- Sibling state is read from existing columns: `AssetInstance(parentId, isActive, status)` and the `FilterDetails` 1:1 sidecar (`currentCycleId`, `currentLifecycleState`, `assetInstanceId`). `AssetInstance.parentId` and `FilterDetails.assetInstanceId` are already indexed (FK / unique). The counted-filters query filters on `parentId IN (…)` which uses the existing `parentId` index.
- Profile graphs are read from `FilterCleaningProfile` + `FilterPipelineStage` + `FilterPipelineConnection` (already loaded per cycle via the pinned `profileId`/`profileVersion`).

Query cost is bounded (see §12). No migration required.

---

## 3. Backend implementation plan

### 3.1 New config definition
`apps/api/src/modules/config/defs/ahu-completion-process.def.ts`:

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

Auto-generates GET/PUT at `/api/config/dynamic/ahu-completion-process` (write gated on `CONFIG_UPDATE`), auto-writes a `CONFIG_CHANGED` hash-chained audit row on every change (`dynamic-routes.ts`).

### 3.2 Discovery registration
Add one line to `apps/api/src/lib/config-discovery.ts` inside the `import()` array:
```ts
import('../modules/config/defs/ahu-completion-process.def.js'),
```

### 3.3 Public runtime-read endpoint + reader
Operators (non-admins) must read the mode at runtime for Popup + client-side Interlock UX. Add:
- A static route `GET /api/config/ahu-completion-process/current` returning `{ mode }` (readable by any authenticated user) — placed in a small `static-routes/ahu-completion-process.routes.ts` (or folded into an existing filter-management routes file).
- Whitelist its path in `PUBLIC_GET_PATHS` (`apps/api/src/plugins/auth.ts`) **only if** it should be readable pre-full-auth; otherwise plain authenticated read is sufficient (recommended — leave it authenticated, not public).
- A backend reader used by the gate:

```ts
// apps/api/src/modules/filter-operations/ahu-completion-gate.ts
export type AhuCompletionMode = 'NONE' | 'POPUP' | 'INTERLOCK';
export async function getAhuCompletionMode(): Promise<AhuCompletionMode> {
  const cfg = await prisma.systemConfig.findUnique({ where: { configKey: 'ahu-completion-process' } });
  const m = (cfg?.configValue as any)?.mode;
  return m === 'INTERLOCK' || m === 'POPUP' ? m : 'NONE';
}
```

### 3.4 Shared counted-filters helper (de-duplication)
`loadCountedFilters()` is currently **module-private** in `pm-deviations.ts:62-93` and **duplicated inline** in `pm-due-tasks.ts:152-215`. Promote a single exported helper (e.g. `apps/api/src/modules/filter-operations/ahu-filters.ts`) and have PM call it, removing the duplication. For **this feature** (D3 "all active filters") add a variant that **ignores** `pmFilterSetMode`:

```ts
export async function loadAhuActiveFilters(ahuId: string): Promise<Array<{
  id: string; name: string;
  currentCycleId: string | null; currentLifecycleState: string | null;
  cycleProfileId: string | null; cycleProfileVersion: number | null;
}>> {
  return prisma.assetInstance.findMany({
    where: { parentId: ahuId, isActive: true, status: { not: 'Retired' } },
    select: {
      id: true, name: true,
      filterDetails: { select: { currentCycleId: true, currentLifecycleState: true } },
    },
  }).then(rows => /* flatten + join active cycle's profileId/version */);
}
```

The active cycle's pinned `profileId`/`profileVersion` are read from `CleaningCycle` where `id === currentCycleId` (one batched `findMany` over the non-null `currentCycleId`s).

### 3.5 The Interlock gate (server enforcement)
`apps/api/src/modules/filter-operations/ahu-completion-gate.ts`:

```ts
export async function assertAhuInterlockSatisfied(params: {
  filterId: string; isOfflineReplay: boolean;
}): Promise<void> {
  if (params.isOfflineReplay) return;              // D2: best-effort, never re-block on replay
  if (await getAhuCompletionMode() !== 'INTERLOCK') return;

  const ahuId = await resolveAhuId(params.filterId); // parentId (robust templateKind walk fallback)
  if (!ahuId) return;

  // D4: ALL counted filters (all active, non-retired) must have reached final —
  // including idle/never-started ones. The submitting filter itself is excluded.
  const siblings = await loadAhuActiveFilters(ahuId);
  const others = siblings.filter(s => s.id !== params.filterId);
  if (!others.length) return;                     // single-filter AHU

  // Only filters with an ACTIVE cycle need their pinned profile's final stage.
  const active = others.filter(s => s.currentCycleId);
  const finalStageByProfile = await buildFinalStageMap(active); // ≤ k distinct profile versions

  const reached = (s) => {
    if (s.currentCycleId) {                        // parked at final?
      const finalKey = finalStageByProfile.get(`${s.cycleProfileId}@${s.cycleProfileVersion}`);
      return !!finalKey && s.currentLifecycleState === finalKey;
    }
    return s.currentLifecycleState === 'CLEANING_CYCLE_COMPLETED'; // completed this cycle (D7)
  };
  const pending = others.filter(s => !reached(s));  // never-started/idle/mid/terminated all land here
  if (pending.length) {
    throw new HttpError(422, 'AHU_INTERLOCK_PENDING', {
      message: 'All filters belonging to this AHU must reach their final cleaning stage before submission.',
      pendingFilters: pending.map(p => ({ id: p.id, name: p.name, stage: p.currentLifecycleState })),
    });
  }
}
```

`buildFinalStageMap` loads each distinct `(profileId, profileVersion)` graph once and computes the final STAGE key via the shared `findReachable` predicate (or `buildStageLookup`), caching per profile version.

### 3.6 Wire-in point
`apps/api/src/modules/filter-operations/cycle-write/submit-checklist.ts`, guarded by the existing `shouldComplete` (line 170), **before** the completion transaction (line 215):

```ts
if (shouldComplete) {
  await assertAhuInterlockSatisfied({ filterId, isOfflineReplay: ctx.isOfflineReplay === true });
}
```

HTTP **422** (`AHU_INTERLOCK_PENDING`) deliberately differs from the existing stage-interlock's **423** so telemetry/clients can distinguish the two gates.

No change to `advance.ts`, `bypass.ts`, `terminate-cycle.ts`, or the tape generator.

---

## 4. Frontend implementation plan

### 4.1 Config card + page
- Register a card in `apps/web/src/routes/config/index.tsx` (title "AHU Cleaning Completion Process", href `/config/dynamic/ahu-completion-process`, `filter-management` group). SUPER_ADMIN also sees it auto-listed under "Additional Modules" without the card, but the explicit card serves discoverability.
- The **dynamic renderer** (`dynamic-config.tsx`) shows the `select` as a dropdown automatically — no new page needed (D5).

### 4.2 Runtime mode hook
`apps/web/src/hooks/use-ahu-completion-mode.ts` — SWR over `/api/config/ahu-completion-process/current`, returns `'NONE' | 'POPUP' | 'INTERLOCK'` (default `'NONE'`), mirroring `use-pm-filters-enabled.ts`.

### 4.3 Submit interception (shared for web + tablet)
Both the desktop filter-operations page (`apps/web/src/routes/filter-management/filter-operations.tsx`) and the tablet (`apps/web/src/routes/mobile/mobile-operations.tsx`) finish a filter through the same checklist-submit path (and the terminal `advance` for non-checklist profiles). Add a shared helper in `apps/web/src/lib/filter-ops/` invoked right before the completing action:

- **Read mode** via the hook.
- **NONE** → proceed unchanged.
- **POPUP** → fetch sibling states (`GET /api/filters/batch-states`), compute which active-cycle siblings aren't at final (same predicate, client-side), and if any exist show the **Remaining Filters** dialog (title, message, `Filter — Stage` rows, Continue / Cancel). Continue → proceed; Cancel → abort. Works for all profiles.
- **INTERLOCK (online)** → same computation; if pending, **block** with the validation message + pending list and disable submit. If offline (best-effort), allow (optionally show a soft "cannot verify offline" note). Server remains the authority online.

### 4.4 New dialog component
`RemainingFiltersDialog` (light theme, `bg-white`, gradient header) reused for both Popup (Continue/Cancel) and Interlock (single OK/close, blocking) — mode-aware, mirroring the existing `checklist-dialog.tsx` style. Includes loading and error states for the `batch-states` fetch.

### 4.5 `batch-states` shape check
Confirm `GET /api/filters/batch-states` returns per-filter `currentLifecycleState` (and enough to compute final stage). If it lacks the pinned-profile final-stage info, either extend it to include a boolean `atFinalStage` per filter (preferred — keeps the predicate server-side and consistent) or add a small dedicated `GET /api/filters/ahu/:ahuId/completion-status` returning `{ pending: [{id,name,stage}], allAtFinal: boolean }`. **Recommended: add the dedicated endpoint** so both Popup and Interlock client checks reuse the exact server predicate (single source of truth).

---

## 5. API changes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/config/dynamic/ahu-completion-process` | `CONFIG_READ` (SUPER_ADMIN) | Admin read (auto-generated) |
| PUT | `/api/config/dynamic/ahu-completion-process` | `CONFIG_UPDATE` (SUPER_ADMIN) | Admin write + `CONFIG_CHANGED` audit (auto-generated) |
| GET | `/api/config/ahu-completion-process/current` | authenticated | Runtime mode for operators (new, small) |
| GET | `/api/filters/ahu/:ahuId/completion-status` | `ASSET_READ` | Pending-sibling list for Popup + client Interlock UX (new; recommended over extending `batch-states`) |

Modified endpoint (behaviour only, same signature): `POST /api/filters/:id/submit-checklist` — now may return **422 `AHU_INTERLOCK_PENDING`** with `{ pendingFilters }` when mode = INTERLOCK, online, and siblings aren't all at final.

---

## 6. Entity / model changes
**None.** No Prisma model, enum, or column changes. Config lives in `SystemConfig`.

## 7. Service-layer changes
- New `ahu-completion-gate.ts` (mode reader + `assertAhuInterlockSatisfied` + `buildFinalStageMap` + `resolveAhuId`).
- New/promoted `ahu-filters.ts` (`loadAhuActiveFilters`, and the consolidated `loadCountedFilters` PM helper).
- `submit-checklist.ts` gains one guarded call.
- `pm-deviations.ts` / `pm-due-tasks.ts` refactored to call the shared helper (no behaviour change).

## 8. Repository / query changes
- One `AssetInstance.findMany` (counted siblings) + one `CleaningCycle.findMany` (active cycles' pinned profiles) + at most *k* `FilterCleaningProfile` graph loads where *k* = distinct pinned profile versions in the AHU (typically 1–2), memoised. No new repository files strictly required; queries can live in `ahu-filters.ts`.

---

## 9. Validation flow diagram

```
Operator submits terminal checklist (final stage)  ──►  submit-checklist.ts
                                                          │
                                              shouldComplete? ──no──► normal (no gate)
                                                          │yes
                                              isOfflineReplay? ──yes──► proceed (D2 best-effort)
                                                          │no
                                              mode = ? ──NONE──► proceed
                                                       ──POPUP─► (server proceeds; popup was client-side)
                                                       │INTERLOCK
                                              resolve AHU (parentId)
                                                          │
                                              load active-cycle siblings (all active filters, D3)
                                                          │
                                              for each: parked at its final stage?
                                                 (currentLifecycleState == finalStageKey(pinned profile))
                                                          │
                                        any pending? ──yes──► 422 AHU_INTERLOCK_PENDING {pendingFilters}
                                                          │no
                                              complete cycle (existing tx, unchanged)
```

## 10. Sequence diagram (Interlock, online)

```
Operator      Tablet/Web            API (submit-checklist)     ahu-completion-gate      DB
   │  submit final checklist │                 │                        │               │
   │────────────────────────►│                 │                        │               │
   │        │  POST /submit-checklist          │                        │               │
   │        │────────────────────────────────►│                        │               │
   │        │                 │  shouldComplete=true                    │               │
   │        │                 │  assertAhuInterlockSatisfied()          │               │
   │        │                 │───────────────────────────────────────►│               │
   │        │                 │                 │  getAhuCompletionMode │──findUnique──►│
   │        │                 │                 │  loadAhuActiveFilters │──findMany────►│
   │        │                 │                 │  buildFinalStageMap   │──findMany────►│
   │        │                 │  pending? ──yes──► throw 422            │               │
   │        │◄────────────────────────────────422 AHU_INTERLOCK_PENDING │               │
   │◄───────│  show validation msg + pending list                       │               │
   │        │                 │  (no)  ──► complete cycle tx (unchanged) │──update─────►│
```

---

## 11. Edge-case analysis

| Case | Handling |
|------|----------|
| **AHU with a single filter** | Only sibling is itself; `active` list empty → gate passes. Submits normally. |
| **Disabled filters** | No per-filter "disabled" flag exists; `pmFilterSetMode DISABLED` is per-AHU and per D3 is **ignored** here. An AHU marked DISABLED for PM still gates for cleaning. (Flag at review if DISABLED AHUs should be exempt.) |
| **Retired filters** | Excluded by `status != 'Retired'`. |
| **Replacement filters** | Replacement retires the old filter (→ excluded) and creates a new **active** one. Per D4 the new filter **blocks** until it is cleaned to final (state ≠ `CLEANING_CYCLE_COMPLETED`). Operationally: a replaced filter must be cleaned before the AHU batch can submit. |
| **Newly onboarded filter** | Active, no cycle, state not `CLEANING_CYCLE_COMPLETED` → **blocks** (D4). A brand-new filter holds the AHU until cleaned. **This is the sharpest consequence of D4 — surface it in the pending list with stage label "Not started".** |
| **Different profiles in one AHU** | Final stage resolved per pinned profile version; mixed profiles handled. Completed filters need no profile lookup (marker-only). |
| **Missing cleaning profile** | Filter cannot start a cycle (`start-cycle` rejects `NO_PROFILE`) and can never reach `CLEANING_CYCLE_COMPLETED` → per D4 it would **block the AHU permanently**. **Mitigation:** exclude filters with **no assigned cleaning profile** from the counted set (they are un-cleanable), and surface them in the admin warning. Confirm at review. |
| **Terminated filter** | `terminate-cycle` clears both `FilterDetails` fields → state ≠ `CLEANING_CYCLE_COMPLETED` → **blocks** until re-cleaned (D7). |
| **Completed then re-started (different cycle id)** | New `start-cycle` resets `currentLifecycleState` → stale completion no longer counts → re-evaluated against the new cycle (D7). |
| **Non-terminal-checklist profile (Interlock)** | Completes via `advance` auto-complete → **not gated** (D1 limitation, §11.1). Warned to admin. |
| **Deleted filters** | Soft-deleted/inactive excluded by `isActive`. |
| **Concurrent submissions (two operators)** | Each submit runs the gate under its own `submit-checklist` tx with the existing `SELECT … FOR UPDATE` filter lock; the last-to-satisfy wins. Two filters both parked at final can both pass legitimately (both siblings are at final). No double-complete (cycle-scoped idempotency + status recheck). |
| **Offline sync conflict** | Gate is `!isOfflineReplay` (D2) → replayed completions pass. Best-effort documented gap. |
| **Task reassignment** | Gate is stateless w.r.t. task ownership; unaffected. |
| **Partial synchronization** | A partially-synced AHU may momentarily show stale sibling states offline; online submit re-checks against DB truth. |
| **Duplicate submissions** | Existing `clientOpId` cycle-scoped idempotency + `ALREADY_SUBMITTED` guard in `submit-checklist.ts` prevent double-complete; gate runs before the idempotent write. |
| **Mode switch mid-batch** | Parked filters are ordinary pending-checklist cycles; switching to NONE lets them finish with no gate → no stranding (D6-adjacent). |

### 11.1 Known limitation (accepted per D1)
Interlock enforces **only** on cleaning profiles that end with a checklist. Profiles that complete via `advance` auto-complete are not blocked. Mitigations: (a) an admin warning on the config page listing in-use cleaning profiles whose last node is **not** a checklist; (b) documentation that full Interlock coverage requires all profiles used under Interlock to end with a checklist. Upgrading to full coverage later means suppressing `advance.ts` auto-complete in Interlock mode + adding an explicit gated complete action — deliberately deferred (higher risk).

---

## 12. Performance considerations
- Per submit in Interlock mode: **3 queries + ≤k profile loads** (k = distinct pinned profile versions in the AHU, typically 1). No N+1: sibling FilterDetails come in one `findMany`; active cycles' profiles in one `findMany`; final-stage computed once per profile version and memoised.
- NONE mode: **1 cheap `findUnique`** on `system_config` (could be cached in-process with short TTL like `reauth-check.ts`; optional).
- POPUP mode: server does nothing extra; the client's one `completion-status` call is on-demand at submit time only.
- The gate runs only on the **completing** submit (`shouldComplete`), not on every advance/checklist.
- No new indexes needed — existing `parentId` FK index and `FilterDetails` unique key cover the access paths.

## 13. Security considerations
- Config is **SUPER_ADMIN-only** to write (`requiredRole: 'SUPER_ADMIN'` + `CONFIG_UPDATE`); reads gated by `CONFIG_READ`.
- Every config change is audited as `CONFIG_CHANGED` (hash-chained, before/after values, signature meaning) automatically.
- **Log validation failures:** each `AHU_INTERLOCK_PENDING` rejection is written to the operation/debug trace (FAILED API writes already flow to `/debug` traces) — optionally emit a lightweight audit/notification if compliance wants an explicit record of blocked submissions.
- Gate cannot be bypassed by the normal online path; the offline gap is explicit and accepted (D2).
- No new PII or secrets; no new permission surface (reuses `CONFIG_*` / `ASSET_READ`).

---

## 14. Step-by-step implementation plan

1. **Config def** — add `ahu-completion-process.def.ts`; add its `import()` to `lib/config-discovery.ts`. Rebuild nothing (backend TS).
2. **Public/runtime read** — `GET /api/config/ahu-completion-process/current` + `use-ahu-completion-mode.ts` hook.
3. **Shared filters helper** — create `ahu-filters.ts` (`loadAhuActiveFilters`), promote/consolidate PM `loadCountedFilters`; refactor `pm-deviations.ts` + `pm-due-tasks.ts` to use it (behaviour-preserving).
4. **Gate module** — `ahu-completion-gate.ts` (`getAhuCompletionMode`, `resolveAhuId`, `buildFinalStageMap`, `assertAhuInterlockSatisfied`).
5. **Completion-status endpoint** — `GET /api/filters/ahu/:ahuId/completion-status` returning `{ allAtFinal, pending[] }` using the same predicate.
6. **Wire gate** — one guarded call in `submit-checklist.ts` under `shouldComplete`.
7. **Config card** — `apps/web/src/routes/config/index.tsx`.
8. **Client interception** — shared `filter-ops` helper + `RemainingFiltersDialog`; wire into desktop `filter-operations.tsx` and tablet `mobile-operations.tsx` completing actions.
9. **Admin warning** — config page note listing in-use profiles without a terminal checklist.
10. **Docs + counts** — `CHANGELOG.md`, `CLAUDE.md`/apps CLAUDE.md config-count updates (34→35 defs, 30→31 pages if a card counts), `tasks/todo.md` audit entry, memory note.
11. **Tests** — §15.

## 15. Testing scenarios

**Backend (vitest, single-fork):**
- NONE: submit-checklist completes normally (no gate).
- INTERLOCK, sibling not at final → 422 `AHU_INTERLOCK_PENDING` with correct `pendingFilters`.
- INTERLOCK, all active siblings parked at final → completes.
- INTERLOCK, single-filter AHU → completes.
- INTERLOCK, idle/never-started sibling present → does not block (D4).
- INTERLOCK, retired/replaced sibling → excluded.
- INTERLOCK, mixed profiles (different stage counts) → each final stage resolved correctly.
- INTERLOCK, `isOfflineReplay` → passes (D2).
- Config PUT writes `CONFIG_CHANGED` audit; non-SUPER_ADMIN write → 403.
- Performance: AHU with 50 filters → query count assertion (≤ 3 + k).

**Frontend/e2e:**
- POPUP: pending siblings → dialog shown; Continue completes; Cancel aborts.
- INTERLOCK online: submit disabled/blocked with message + list.
- NONE: no dialog, no block.
- Offline INTERLOCK: submission allowed (best-effort), no console errors, no unstyled dialog.

## 16. Regression impact analysis
- **`submit-checklist.ts`** — the only completion path touched; new call is behind `shouldComplete && !isOfflineReplay && mode===INTERLOCK`. In NONE/POPUP or offline, code path is effectively unchanged. Existing submit-checklist tests must stay green.
- **PM refactor** — `pm-deviations.ts` / `pm-due-tasks.ts` switch to the shared helper; must produce byte-identical counted sets. Guard with existing PM tests + a focused equivalence test.
- **`advance.ts`, tape, offline sync** — untouched → no regression by construction.
- **Config subsystem** — additive def; auto-discovery + seed already covered by existing config tests. Config counts in docs must be updated (doc-sync rule).
- **No schema/migration** → no drift-guard impact.

## 17. Recommended approach & possible improvements
- **Recommended now:** the low-risk D1 path above (gate only in `submit-checklist`, require terminal checklist). Ship with the admin warning so operators know which profiles are unenforced.
- **Optional hardening (future):** for full coverage regardless of profile shape, add an explicit gated "Complete Cycle" action and suppress `advance.ts` auto-complete in Interlock mode — larger change to a validated/audited/offline path; only pursue if unenforced profiles become a real gap.
- **Consistency win:** consolidating the duplicated counted-filters logic (PM) into one helper is a net maintainability improvement carried by this feature.
- **Optional:** in-process short-TTL cache for `getAhuCompletionMode()` (mirrors `reauth-check.ts`) if the extra `findUnique` per submit is ever measured as hot (unlikely).
- **Optional compliance:** emit an explicit audit/notification on blocked submissions if inspectors want a positive record of interlock enforcement.

---

## Open items for spec review
1. **No-profile filters** — confirm filters with **no assigned cleaning profile** are excluded from the counted set (they can never reach `CLEANING_CYCLE_COMPLETED`, so including them would block the AHU permanently). Recommended: exclude + list in the admin warning.
2. **D5 UI** — dropdown (default) vs. radio (needs custom page).
3. **DISABLED AHUs** — should a `pmFilterSetMode = DISABLED` AHU be exempt from this cleaning gate? (Currently no, per D3.)
4. Whether blocked submissions need an explicit audit record (§13).
5. **Terminated filters** — confirm a terminated cycle should block until re-cleaned (current design), vs. treating terminated as "done".
