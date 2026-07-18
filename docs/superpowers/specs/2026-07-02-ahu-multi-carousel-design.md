# AHU interlock — multi-AHU carousel dialog (2026-07-02, Approach A)

## Problem
The pre-checklist AHU gate checks only the primary filter's AHU and shows one AHU. When a
submitted batch spans multiple AHUs, the operator should see **every** AHU involved and each
AHU's filter status, navigable as cards.

## Decisions (user)
- Show a card for **every AHU** represented in the batch (incl. fully-completed ones).
- **Block only the pending ones** — ready-AHU filters complete, pending-AHU filters are blocked.
  Enforced server-side per filter (Approach A); the carousel is the heads-up.

## A. Backend — batch status
`ahu-completion-gate.ts` gains `computeAhuBatchStatus(filterIds: string[])`:
- Resolve each filter's AHU (`resolveAhuId`); collect distinct AHU ids (skip filters with none).
- For each AHU: `computeAhuCompletionStatus(ahuId, '')` (exclude none — a filter at its terminal
  checklist is already `reachedFinal`, so co-batched siblings don't false-block).
- Return `{ ahus: [{ ahuId, ahuName, filters, allAtFinal }] }`, pending AHUs first, then by name.

`routes.ts`: `POST /api/filters/ahu-completion-status/batch` (ASSET_READ), body `{ filterIds: string[] }`
→ `computeAhuBatchStatus`. The existing `GET /ahu/:id/completion-status` stays (422-detail shape).

## B. Frontend gate — multi-AHU aware
`ahu-completion-check.ts`: `checkAhuCompletionBatch(mode, filterIds, online)` → POSTs the batch
endpoint, returns `{ ahus }` (empty on NONE / INTERLOCK-offline / error).

`gateAhuBeforeChecklist(filterIds: string[])` (was single id) in `filter-operations.tsx` (desktop)
and `mobile-operations.tsx` (tablet):
- `ahuMode==='NONE'` or primary not `isTerminalChecklist` → proceed.
- Call the batch endpoint. `pending = ahus.filter(a => !a.allAtFinal)`.
- `pending.length === 0` → proceed (no dialog).
- Otherwise show the dialog with all `ahus`. Return proceed on Continue, blocked on Close/Cancel.
  On proceed, the dispatch site opens the checklist for the **whole batch** (unchanged); the server
  completes ready-AHU filters and 422-blocks pending-AHU ones (partial submission). Batch loops
  already report per-filter failures.

Dispatch sites pass the batch: single-filter sites → `[filterId]`; batch sites → all batch member ids.

## C. Dialog — carousel (`remaining-filters-dialog.tsx`)
Props switch to `{ mode, ahus: [{ ahuName, filters, allAtFinal }], currentFilterIds: string[],
onContinue?, onCancel, error? }`.
- `ahus.length === 1` → one card, no arrows (today's look).
- `> 1` → carousel: ◀ ▶ arrows, "AHU X of N" + dots, one AHU per card; pending cards flagged "blocking".
- Each card: AHU-name sub-header, its filters (✓ Completed / highlighted stage), batch filters
  (`id ∈ currentFilterIds`) tagged "(this filter)", "N/M completed".
- Footer: **POPUP** → Cancel + "Continue anyway". **INTERLOCK** → "Close"; plus "Complete ready
  filters" (Continue) ONLY when `ahus.some(a => a.allAtFinal)` (something can proceed). All-pending
  (incl. the single-AHU case) → Close only = hard block (unchanged behavior).

Single-filter gate + the 422 safety-net pass a one-element `ahus` array.

## Testing
- Backend e2e: `computeAhuBatchStatus` over 2 AHUs (one ready, one pending) returns both with
  correct `allAtFinal`.
- Manual UI: batch across 2 AHUs → carousel with arrows; INTERLOCK Continue completes ready-AHU
  filters, blocks pending; single AHU unchanged.
- APK rebuild (tablet FE change).
