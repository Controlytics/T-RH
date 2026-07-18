# AHU Completion — pre-checklist gate + richer dialog (2026-07-02)

## Problem
With AHU Completion Process = INTERLOCK, the block popup appears only **after** the
operator fills and submits the terminal checklist (the server 422 is caught in
`handleChecklistSubmit`). Operators want to be stopped **before** filling the checklist.
The dialog also only lists the *pending* filters with no AHU context.

## Decisions (user, 2026-07-02)
- Move the check to **before the terminal checklist opens** for **both** POPUP and INTERLOCK.
- Show **names/codes** (AHU name + filter names), not UUIDs.
- List **all** filters under the AHU with status — completed marked ✓, in-progress highlighted.

## A. Backend — `apps/api/src/modules/filter-operations/ahu-completion-gate.ts`
`computeAhuCompletionStatus(ahuId, excludeFilterId)` return shape gains two fields
(additive, backward-compatible):
- `ahuName: string` — `AssetInstance.name` of the AHU.
- `filters: { id, name, stage, done }[]` — **all** counted filters (active, non-Retired,
  `templateKind='FILTER'` children — the predicate fixed earlier today), including the
  current one. `done = reachedFinal(f)`. `stage = currentLifecycleState ?? 'Not started'`.
- `allAtFinal` + `pending` unchanged (block decision still excludes the current filter).

`finalStageByFilter` is now computed over **all** counted filters (was `others`) so `done`
is correct for every row; `loadLocalContext` is only called for active-cycle filters and
resolves via the frozen `cycle.profileId` (safe — no null-binding 500). Route
`GET /ahu/:ahuId/completion-status` response schema gains `ahuName` + `filters`.

## B. Frontend gate — before the terminal checklist opens
`apps/web/src/lib/filter-ops/ahu-completion-check.ts`: `checkAhuCompletion(...)` returns
`{ block, warn, ahuName, filters, pending }` (`warn = POPUP && pending>0`).

Both `filter-operations.tsx` (desktop) and `mobile-operations.tsx` (tablet): at each point
a checklist is about to open (`dispatch({type:'open_checklist'})`), if `ahuMode !== 'NONE'`
AND `isTerminalChecklist(cachedState.currentState, cachedState.stageLookup)`, run the check
first:
- **INTERLOCK + pending** → show dialog in block mode; do **not** open the checklist.
- **POPUP + pending** → show dialog in warn mode; Continue opens the checklist, Cancel aborts.
- else → open normally.

`isTerminalChecklist` gating means intermediate checklists are never affected — this also
dissolves the original "two filters deadlock" reservation (which only applied to firing on
every checklist). The old submit-time POPUP pre-flight in `handleChecklistSubmit` is removed;
the server 422 (INTERLOCK) stays as a safety net for the open→submit window / offline.

## C. Dialog — `apps/web/src/routes/filter-management/components/remaining-filters-dialog.tsx`
Props: `{ mode, ahuName, filters: {id,name,stage,done}[], currentFilterId?, onContinue?, onCancel, error? }`.
- Header: AHU name.
- Body: mode message, then all filters — `done` → green ✓ + "Completed"; else highlighted
  with prettified stage; `currentFilterId` tagged "(this filter)".
- Footer: INTERLOCK → single "Close"; POPUP → "Cancel" / "Continue anyway".

## Testing
- Extend `ahu-completion-gate.e2e.test.ts` (Task 9) to assert `ahuName` + `filters[].done`.
- Manual UI: desktop + tablet — advance to terminal stage with pending siblings → dialog
  appears before the checklist; INTERLOCK blocks, POPUP Continue opens the checklist.
- Rebuild APK (tablet frontend change).
