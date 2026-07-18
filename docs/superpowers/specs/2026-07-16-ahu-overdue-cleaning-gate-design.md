# AHU Overdue-Replacement Cleaning Gate — Design

**Date:** 2026-07-16
**Branch:** RFID
**Status:** IMPLEMENTED 2026-07-16 (commits `60f2c55`..`a236bd7`) — device verification pending

> **Implemented.** Server helpers + `/blocked-filters` endpoint + `start-cycle`
> gate (replay-exempt, via dynamic import to avoid a circular dependency) +
> `validateOfflineGate.replacementBlocked` + tablet cache/wiring + APK. Full API
> suite 1204/0, web 600/0. Two disclosed limitations carried from implementation:
> online single-scan start relies on the server gate (the client gate there is
> nested under `if (!online)`); desktop offline starts are unblocked (desktop uses
> its own inline gate, not the shared `validateOfflineGate`; desktop-online is
> server-covered). Both consistent with "server is authoritative online; offline
> gate is the tablet's job." Plan: `docs/superpowers/plans/2026-07-16-ahu-overdue-cleaning-gate.md`.
>
> **Third limitation (final-review finding, ratified by the user 2026-07-16 — exempt + document):**
> the admin **"Edit Filter Status"** manual cycle-start (`instance.service.ts` →
> `startManualCycleTx`, the back-dated `-M` path) creates a cleaning cycle
> WITHOUT going through `startCycleImpl`, so the overdue gate does **not** fire
> there — even online. This is intentional: it is a permission-gated admin
> correction surface in the same class as the manual-record-create tool (which
> already overrides §11 audit by decision), not the operator scan-and-clean flow
> the gate targets. The gate covers the scan-and-clean start paths (direct
> start-cycle, start-and-advance, start-and-advance-with-checklist,
> bulk-operate). Left ungated by decision, not oversight.
**Author:** pairing session

## Problem

When an AHU's filter-replacement task is **overdue**, the filters under that AHU
must not be started on a new cleaning cycle — they are due for physical
replacement, so cleaning them is wasted work on hardware that is supposed to be
swapped out. Once a filter is actually replaced, the new filter may be cleaned
normally. This must hold **both online and offline** (the tablet is offline for
much of a shift).

## Rule (exact, approved with the user)

A filter is **blocked from STARTING a new cleaning cycle** when BOTH hold:

1. Its AHU has an **APPROVED** `ReplacementScheduleEntry` in **overdue** status —
   the existing `MISSED` status from `deriveTaskStatus` (`service.ts`): today is
   past the entry's `windowEnd` (UTC date-only compare) and the entry is not
   fully replaced (`remaining > 0`).
2. That specific filter has **not** been replaced under that entry — i.e. its
   `assetInstance.id` is **not** in the entry's set of replacement `newFilterId`s.

### Explicitly decided behaviours

- **Scope of "corresponding filters": ALL active filters under the AHU** (every
  active, non-retired FILTER-kind `assetInstance` whose `parentId` is the AHU),
  regardless of micron/size. This matches how the replacement task already counts
  progress today (`activeFilterIdsByAhu` ignores micron/size), so the gate and the
  task's "replaced X of Y" count stay consistent.
- **In-flight cycles finish.** The gate is on **starting** a new cycle only. A
  cycle already `IN_PROGRESS` when the AHU tips into overdue advances and
  completes normally. This is why the gate does **not** touch advance / checklist
  / the atomic advance-with-checklist ops.
- **Per-filter unblock, immediately.** The moment a specific filter is replaced,
  the new filter is cleanable, even while un-replaced siblings under the same AHU
  stay blocked. Falls out for free: replaced filters are the entry's
  `newFilterId`s, which are subtracted from the blocked set. The old (retired)
  filter drops out of `activeFilterIdsByAhu` on retirement.
- **Non-overdue entries never block.** A merely `DUE` / `PENDING` / `IN_PROGRESS`
  (within-window) entry does not gate cleaning. Only `MISSED`.
- **Offline replay is EXEMPT** (see Enforcement → Server).

## Approach (chosen: A — cached blocked-filter-ID list)

One server helper computes the exact set of blocked filter IDs. A small endpoint
returns it. The tablet caches it (mirroring the existing `checklist-profiles`
cache) and both online and offline test membership before allowing a cycle start.
The server re-checks authoritatively inside `start-cycle`.

Rejected alternatives:
- **B (cache overdue-AHU list, compute membership client-side):** requires the
  client to resolve filter→AHU and reconcile offline-local replacements itself —
  more moving parts, no gain.
- **C (reuse `/tasks`):** returns AHU-level aggregates, not the per-filter blocked
  set; the tablet would have to reconstruct data it doesn't hold.

## Components & data flow

### 1. Server — the computation (single source of truth)

New helper in `apps/api/src/modules/replacement-schedule/service.ts`:

```
blockedFilterIdsForCleaning(): Promise<Set<string>>
```

- Loads APPROVED entries (as `listTaskEntries` does).
- Reuses `activeFilterIdsByAhu` + the executions→`newFilterId` map already built
  in `listTaskEntries`.
- For each entry whose `deriveTaskStatus(...) === 'MISSED'`, add
  `ahuFilterIds \ replacedNewFilterIds` to the result set.
- Returns the union across all overdue entries.

Refactor note: `listTaskEntries` already computes exactly these pieces per entry
(`ahuFilterIds`, `newIds`, `computedStatus`). Extract the per-entry
"blocked filter ids for this entry" into a small internal function both
`listTaskEntries` and `blockedFilterIdsForCleaning` call, so the two cannot drift.
This is a targeted improvement in the file being touched, not unrelated refactor.

A single-filter convenience wrapper for the hot start-cycle path (avoids building
the whole set when we only care about one filter):

```
isFilterBlockedForCleaning(filterId): Promise<boolean>
```

Implementation: resolve the filter's `parentId` (AHU), find APPROVED+MISSED
entries for that AHU, and check the filter isn't in their replaced set. (Same
logic, scoped to one AHU — cheaper than the full sweep.)

### 2. Server — the endpoint

`GET /api/replacement-schedules/blocked-filters` → `{ filterIds: string[] }`

- Auth: **any authenticated role** (same open-to-any posture as `/due` and
  `/tasks` — operators need it to run cleaning; it exposes only filter IDs).
- Returns `blockedFilterIdsForCleaning()` as an array.

### 3. Server — the enforcement point

`apps/api/src/modules/filter-operations/cycle-write/start-cycle.ts`, immediately
after the existing `CYCLE_ACTIVE` check (~line 95), before cycle creation:

```
if (!ctx.isOfflineReplay && await isFilterBlockedForCleaning(filterId)) {
  throw new AppError(409, 'AHU_REPLACEMENT_OVERDUE',
    'This filter’s AHU has an overdue replacement. Replace the filter before starting a cleaning cycle.');
}
```

- **Offline replay is EXEMPT** (`!ctx.isOfflineReplay`), mirroring
  `validateBlockChange`'s auto-pass on replay. Rationale: the offline client is
  the enforcement point for offline-initiated work; re-checking on replay could
  reject a start the operator legitimately performed (and the tablet legitimately
  allowed) at scan time — stranding the rest of that cycle's queued ops. The
  online start is fully gated; the offline path is gated at scan time (below).
- Placed in `start-cycle` only. `start-and-advance` / `start-and-advance-with-
  checklist` both call `startCycle` first, so they inherit the gate automatically.

### 4. Tablet + desktop — the cache

Mirror the `checklist-profiles` SWR→IDB pattern in
`routes/mobile/mobile-operations.tsx` (and the equivalent on the desktop page if
it maintains its own caches):

- `useSWR(online ? '/api/replacement-schedules/blocked-filters' : null, ...)`
  with the standard refresh cadence used by the other operational caches.
- On data, `cache('blocked-filter-ids', filterIds, 24h)` to IDB.
- At handler entry, read the cached list once into a `Set<string>`
  (`blockedFilterIds`) for O(1) membership.

### 5. Client — the gate

Extend `apps/web/src/lib/filter-ops/validate-offline-gate.ts`:

- Add `replacementBlocked?: boolean` to `GateInput`.
- Gate it ONLY for a cycle **start** (`!g.cycleInProgress`), so an in-flight
  cycle is never frozen:

```
if (!g.cycleInProgress && g.replacementBlocked) {
  return { ok: false, reason: 'AHU replacement overdue — replace this filter before cleaning' };
}
```

- Both mobile call sites (`mobile-operations.tsx` ~962 batch, ~1730 single) pass
  `replacementBlocked: blockedFilterIds.has(item.filterId)`. Desktop passes the
  same from its own cached set.
- This gates offline (cached set) AND gives an instant message online before the
  round-trip; the server 409 is the authoritative backstop.

## Error handling

- Server: `409 AHU_REPLACEMENT_OVERDUE` with an operator-readable message. The
  existing api-client `details`→`connectionInfo` mapping surfaces it; the pages'
  start-cycle catch shows it as an error toast (same path as `CYCLE_ACTIVE`).
- Client gate: `{ ok: false, reason }` flows into the existing
  `failed.push(...)` (batch) / `setError(gate.reason)` (single) — no new UI.
- Cache miss / never-synced tablet: `blockedFilterIds` is empty → the client does
  NOT block (fail-open on the client), but the **server still blocks online**. A
  fully-offline tablet that never synced the list can't know — acceptable and
  consistent with every other offline cache; the server catches it on reconnect.

## Testing

- **Server unit** (`replacement-schedule` tests): `blockedFilterIdsForCleaning`
  returns AHU filters minus replaced for a MISSED entry; returns empty for
  DUE/PENDING/COMPLETED; a replaced filter is excluded; multiple overdue entries
  union correctly.
- **Server e2e** (`filter-operations` tests): start-cycle on a blocked filter →
  409 `AHU_REPLACEMENT_OVERDUE`; on a replaced (new) filter under the same
  overdue AHU → 201; offline-replay start on a blocked filter → **passes**
  (exemption); an in-progress cycle's advance is unaffected.
- **Client unit** (`validate-offline-gate` tests): `replacementBlocked && !cycleInProgress`
  → refuse; `replacementBlocked && cycleInProgress` → not refused by this rule.
- **No-regression:** full API + web suites against the current baselines
  (API 1196/115, web 597/44).

## Touch points (test all after change)

- `apps/api/src/modules/replacement-schedule/service.ts` — new helpers + extract
  shared per-entry blocked-ids fn.
- `apps/api/src/modules/replacement-schedule/routes.ts` — new endpoint.
- `apps/api/src/modules/filter-operations/cycle-write/start-cycle.ts` — the gate.
- `apps/web/src/lib/filter-ops/validate-offline-gate.ts` — `replacementBlocked`.
- `apps/web/src/routes/mobile/mobile-operations.tsx` — SWR + IDB cache + pass the
  flag at both gate call sites.
- `apps/web/src/routes/filter-management/filter-operations.tsx` — desktop cache +
  gate flag (if it starts cycles; confirm during implementation).
- APK rebuild (tablet is the primary surface) + on-device verification.

## Out of scope / deliberately not done

- No change to advance / checklist / atomic ops (running cycles finish).
- No new permission (endpoint is open-to-any like `/due`, `/tasks`; the gate is a
  business rule, not an authorization boundary).
- No micron/size-specific matching (blocked scope is the whole AHU, by decision).
- Phase-2-style hard server rejection of offline replays (exempted by decision).

## Risks

- **Offline staleness:** a filter replaced by another operator won't unblock on a
  disconnected tablet until it re-syncs. Same class as every offline cache here;
  server is authoritative on reconnect. Documented, accepted.
- **`start-and-advance` inheritance:** relies on those compound ops calling
  `startCycle` first. Verified true in the current code
  (`bulk-operate` + the atomic ops); re-confirm during implementation so a future
  refactor doesn't bypass the gate.
