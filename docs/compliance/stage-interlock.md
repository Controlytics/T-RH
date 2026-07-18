# Cleaning Stage Interlock & Stage Approvals

> 21 CFR Part 11 second-person verification gate on cleaning cycles.
> Status: shipped, **OFF by default**. Last updated 2026-06-22.

## 1. What it is

A cleaning cycle moves a filter through stages:

```
WASH_IN → WASH_OUT → DRY_IN → DRY_OUT → STORAGE_IN → STORAGE_OUT
```

The **stage interlock** is a two-point QA gate. After **WASH_OUT** and after
**DRY_OUT** the cycle *pauses*: the operator cannot leave the stage until a
designated approver verifies the filter and signs off with their password (the
digital signature). It implements a "second-person verification" control for
the two most critical cleaning checkpoints.

It does nothing until an admin turns it on.

### Configuration — `system_config['stage-interlock']`

Defined in `apps/api/src/modules/filter-operations/stage-interlock.ts`:

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `false` | Master switch. Nothing gates until `true`. |
| `washOutApproverRole` | `ADMIN` | Role allowed to decide a WASH_OUT approval. |
| `dryOutApproverRole` | `ADMIN` | Role allowed to decide a DRY_OUT approval. |
| `requireDifferentApprover` | `true` | Segregation of duties — the operator who performed the stage cannot sign their own approval. |

The **two gate points are fixed (not configurable)** — `INTERLOCK_POINTS`:

| Gated stage | Reject sends the filter back to |
|-------------|---------------------------------|
| `WASH_OUT`  | `WASH_IN` |
| `DRY_OUT`   | `DRY_IN` (and clears the dryer state so the operator must re-dry) |

## 2. Data model

`CleaningStageApproval` (table `cleaning_stage_approvals`):

- `cycleId`, `filterId`, `stageKey` (`WASH_OUT` | `DRY_OUT`)
- `status` — `PENDING` | `APPROVED` | `REJECTED`
- `approverRole` — frozen at creation from config
- `rejectToStateKey` — frozen reject target
- `attemptSeq` — increments on each reject→re-clean→re-gate loop so attempts stay distinct
- `detailsSnapshot` — **frozen** filter identity (name, block/area/AHU, micron, type, dimensions, set) so the approver verifies exactly what was cleaned even if the hierarchy later changes
- `requestedBy` / `requestedByName`, `decidedBy` / `decidedByName`, `decisionRemarks`

## 3. Online flow (the normal path)

### a) Entering a gated stage
An online `advance()` into WASH_OUT / DRY_OUT creates a **PENDING approval inside
the same DB transaction** as the state change (`requestStageApprovalTx`) — no
window where the filter sits at the gate ungated. A best-effort notification
fires to the approver role. *(Auto-completion exception: if entering the stage
also completes the cycle — leads straight to END — no gate is raised.)*

### b) Operator blocked from leaving
The next `advance()`/`bypass()` out of the gated stage calls
`assertStageApprovedToLeave()`, which throws **HTTP 423** unless the latest
approval for that `(cycle, stage)` is `APPROVED`. This is the **authoritative
server gate**. In parallel, `getCurrentState` **strips the advance/bypass
actions** from the action tape, so the operator's "Next stage" button vanishes
and a banner explains the stage is awaiting QA approval.

### c) Approver decides — `/stage-approvals`
The approver's **password is their digital signature** — always required via
`enforceReauthAlways` (intrinsic to the action, cannot be toggled off).

- **Approve** → status `APPROVED` + immutable `APPROVAL_GRANTED` filter event +
  hash-chained `STAGE_APPROVAL_APPROVED` audit row. The operator is released to
  continue. Operator gets a notification.
- **Reject** → status `REJECTED` (**remarks mandatory**, min 3 chars) + immutable
  deviation event. The filter's `currentLifecycleState` is moved **back**
  (WASH_OUT→WASH_IN, DRY_OUT→DRY_IN). A DRY_OUT reject also clears
  `dryerStartedAt` / `dryerDurationMinutes` / `dryerReadingsSubmitted` so the
  operator must genuinely re-dry. They re-clean, re-reach the gate, and a fresh
  PENDING is raised with `attemptSeq + 1`.

Guards on every decision:
- **Role match** — decider's role must equal the approval's frozen `approverRole`
  (SUPER_ADMIN always allowed).
- **Segregation of duties** — when `requireDifferentApprover`, the performer
  cannot sign their own stage.
- **Stale-orphan guard** — `assertFilterStillAtGate` (see §5).

### d) Self-heal
If interlock is enabled *after* a filter is already parked at a gated stage (so
`advance` never created an approval), any online `getCurrentState` poll lazily
creates the missing PENDING — attributed to the **actual stage performer** (from
the event log), not the poller, so segregation of duties still holds.

### Bulk approve/reject
The Stage Approvals page supports selecting multiple pending items and
approving/rejecting them in one action. **One password signs the whole batch**,
but each item still produces its own audit signature, filter event, and operator
notification — identical to the single-item path. Stale orphans in a batch are
reported as per-item failures.

## 4. Offline flow (interlock-exempt — by design)

The interlock is an **online-only** control. An operator working offline in a
cleanroom cannot reach an approver, so blocking them would poison the whole
offline queue. Decision (commit `d8afc02`): **offline cleaning runs normally,
with no interlock.** Enforced at three layers:

1. **Server replay** (`cycle-write/advance.ts`) — when a queued op replays
   (`ctx.isOfflineReplay === true`), the server **skips** both the leave-gate
   *and* creating the PENDING approval. The state transition + its
   `offlinePerformedAt` audit row are still recorded.
2. **Self-heal skip** (`current-state.ts`) — never backfills an approval during a
   replay, so it can't recreate the PENDING the replay intentionally skipped.
3. **Offline action computation** — the shared pipeline executor
   (`packages/shared`) has **zero** interlock knowledge, so the client's local
   tape recompute always offers the advance out of a gated stage offline.

A filter cleaned start-to-finish offline simply completes; on sync no approvals
are created and nothing is gated.

## 5. The online→offline boundary (fixed 2026-06-22)

### The bug
If an operator was **online at the gate** — the server created the PENDING and
cached an action tape with the advance *stripped* (only `TERMINATE_CYCLE`
survives, since terminate is always available) — and *then* went offline, the
tablet trusted that stale stripped tape and the operator was **stuck**: only
"Terminate", no advance. On the tablet this path is common (unreliable Android
online detection + the self-heal recreating approvals on any online poll). The
desktop page was unaffected because it rebuilds offline state without a tape and
recomputes locally.

### The fix — two parts
**Tablet client** (`apps/web/src/routes/mobile/mobile-operations.tsx`, 3 sites):
offline, at an interlock-gated stage, **drop the stale stripped server tape** so
`getCurrentActions()` recomputes the interlock-free tape locally and the advance
is offered again. Guarded on `!online`, so the live online interlock is
untouched. Sites: `buildOfflineState()`, and the two `getCurrentActions(...)`
calls in `handleSubmitQueue` (item submit + downstream checklist grouping).

**Server stale-orphan guard** (`apps/api/src/modules/stage-approvals/service.ts`,
`assertFilterStillAtGate`, called from `approve()` and `reject()`): the client
fix lets a filter advance past the gate offline while its PENDING approval still
exists. Without a guard, an approver clicking **Reject** later would yank an
already-progressed filter back to WASH_IN/DRY_IN and clear its dryer state —
state corruption. The guard refuses (`409 APPROVAL_STALE`) when the filter is no
longer parked at the approval's stage/cycle. The normal online flow passes it
(the filter is still at the gate when its approver acts).

### Why an orphan can exist
1. Online entry into the gate (or self-heal on an online poll) → PENDING created,
   filter at the gate, cycle IN_PROGRESS.
2. Operator advances past the gate **offline** → replay's leave-gate is exempt →
   filter moves on, cycle still IN_PROGRESS, approval still PENDING.
3. The PENDING is now orphaned. The guard makes it **un-actionable** (safe), but
   it still **sits in the approver inbox** (cosmetic).

## 6. Known open item

Orphaned PENDING approvals are **safe** but still clutter the approver inbox.
Cleaning them up properly means auto-resolving the PENDING when the filter
advances past the gate offline, which needs a status decision: add a
`CANCELLED`/`SUPERSEDED` enum value (cleanest, needs a migration), reuse an
existing status, or leave them visible-but-blocked. **Deferred — product/
compliance decision.**

## 7. File map

| Concern | File |
|---------|------|
| Engine, config, gate primitives, snapshot | `apps/api/src/modules/filter-operations/stage-interlock.ts` |
| Online entry + leave-gate + offline exemption | `apps/api/src/modules/filter-operations/cycle-write/advance.ts` |
| Display state, action-stripping, self-heal | `apps/api/src/modules/filter-operations/current-state.ts` |
| Approver service (approve/reject/queue/list + stale guard) | `apps/api/src/modules/stage-approvals/service.ts` |
| Approver routes (reauth signature) | `apps/api/src/modules/stage-approvals/routes.ts` |
| Approver UI + bulk approve/reject | `apps/web/src/routes/stage-approvals/index.tsx` |
| Tablet operator UI + offline fix | `apps/web/src/routes/mobile/mobile-operations.tsx` |
| Reauth actions (`APPROVE_/REJECT_CLEANING_STAGE`) | `packages/shared/src/types/reauth-actions.ts` |
| Permissions (`STAGE_APPROVAL_VIEW/_DECIDE`) | `packages/shared/src/types/permissions.ts` |
| Audit actions/templates | `packages/shared/src/types/audit-{actions,templates}.ts` |
| Original plan | `tasks/STAGE-INTERLOCK-PLAN.md` |
