# Status stage dropdown + cascade-scoped stage counts

**Date:** 2026-07-17
**Branch:** RFID
**Status:** Approved (design), implemented

## Problems

Two, found while scoping the feature:

**1. The stage tile counts are wrong (live bug).** `stageCounts` was computed at
`mobile-wrapper.tsx:542` over `allFilters` — every filter on the site — with no
cascade scoping, while `visibleFilters` (`:1256`) *did* apply Block/Area/AHU/
Filter. Select Block A and the Wash In tile showed the site-wide count while
the list below showed only Block A's. **The tile and the list disagreed.**

Root cause: the counts were computed outside the render block where
`filterAncestors` (`:1209`) is defined, so the cascade was not in scope there.

**2. There is no way to pick a stage from a dropdown**, and most states are
unreachable. Live `filter_details.current_lifecycle_state` on 2026-07-17:

| State | Rows |
|---|---|
| RETIRED | 154 |
| *(null — never cleaned)* | 106 |
| **CLEANING_CYCLE_COMPLETED** | **75** |
| WASH_IN / DRY_IN | 17 / 16 |
| DRY_OUT / WASH_OUT | 3 / 3 |
| STORAGE_OUT | 2 |
| STORAGE_IN | 0 |

`CLEANING_STAGES_MOBILE` lists only the six wash/dry/storage stages, so the
tiles surface just the ~41 filters mid-cleaning. The 75 completed ones have no
tile at all.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Tiles vs dropdown | **Keep tiles, add dropdown** | They do different jobs: tiles answer "what is the state of this block?" (counts at a glance), the dropdown answers "show me these". Replacing tiles with a dropdown would delete the only count display on the tablet. |
| Dropdown options | **All + Completed + the six stages** | Exactly what was asked for. |
| Never-cleaned (106) | **Not added** | Reachable via All. Flagged to the user as invisible-today; deliberately out of scope. |
| Retired (154) | **Never shown** | Already excluded upstream by `f.status !== 'Retired'` (`:539`). **Verified against live data: `status='Retired'` and `current_lifecycle_state='RETIRED'` agree 154/154, no drift.** No code change. |
| Counts vs stage selection | **Counts ignore the stage filter** | Including it would zero every other tile the moment one was picked, making it impossible to switch. |
| Dropdown type | **Native `<select>`** | 8 options need no search box. |
| Placement | **Own full-width row under the 4-up grid** | Five columns at `text-[11px]` gives ~75px each — "Storage Out" will not fit. Stage is also filter *state*, not hierarchy. |

## Design

`apps/web/src/lib/filter-status-scope.ts` (new) holds two pure functions:

- `scopeFiltersToCascade(filters, ancestors, selection)` — narrows to the
  Block/Area/AHU/Filter selection; `ALL` means unconstrained. A filter with
  unknown ancestry is **dropped**, not passed through: it can't be shown to
  belong to the selected scope, and leaking it would put another block's filter
  in front of an operator.
- `countByStage(filters)` — tallies by lifecycle state.

The Status view derives **both** the tiles and the list from one
`cascadeScoped` array. That is the structural fix: the counts and the rows can
no longer disagree, because they are computed from the same source. Patching the
count in place would have fixed the symptom and left the bug class alive.

The dropdown shares the existing `statusStageFilter` state with the tiles, so
they stay in sync with no new state and no sync bug possible. `'all'` maps to
`null`, matching the existing "Show all filters" reset.

`STATUS_STAGE_OPTIONS` in `filter-constants.ts` derives from
`CLEANING_STAGES_MOBILE`, so a stage added there appears in the dropdown
automatically.

## Testing

12 unit tests (`lib/__tests__/filter-status-scope.test.ts`), written test-first:
each cascade level alone, all levels combined, unknown-ancestry drop, no-match,
count tallies, null-state handling, and an explicit **tile/list agreement
guard** reproducing the original bug.

## Known limits

- Completed is reachable from the dropdown but has **no tile** (it is not in
  `CLEANING_STAGES_MOBILE`). Follows from keeping the tiles as-is.
- The tiles remain silent about the 75 completed and 106 never-cleaned filters.
- **Not verified in a browser or on the tablet** — no Playwright locally, jsdom
  has no layout engine. The new row's layout needs a device look.
