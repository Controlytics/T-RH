# PM-Schedule-Driven "My Tasks" System

**Date:** 2026-04-11
**Status:** Approved for implementation
**Author:** Brainstorming session with Claude

## Problem

Operators need a single place that shows which filters are **due for cleaning right now** based on preventive-maintenance schedules. Today the app has:

- A full PM schedule data model (`PmSchedule`, `PmScheduleEntry`, `PmExecution`) with pre-computed `windowStart` / `windowEnd` tolerance windows
- A 43-line placeholder page at `/pm-schedules` that does nothing useful
- No way to bulk-load schedules
- No page that shows "what's due today"

The gap: schedule data can be written via JSON POSTs but there's no bulk intake, no "list due" query, and no operator-facing task list.

## Goals

1. Let a user bulk-upload a CSV or XLSX file of `(AHU name, scheduled date, tolerance days)` rows on the PM Schedules page
2. Add a new **My Tasks** sidebar page that shows every AHU currently in its tolerance window, rendered as an **expandable card** listing each filter with per-filter status (Option C from brainstorming Q1)
3. Each task card has a **Perform** button that navigates to `/filters?ahuId={id}` — the existing filter operations page, pre-filtered to that AHU's filters
4. Visibility mode is configurable via a new Configuration page, syncing all applicable touchpoints from the 12-point config-sync rule

## Non-goals for v1

- Per-user task assignment (config slot exists — only `GLOBAL` mode wired up)
- Role-gated task visibility (same — stub)
- Notification / email / SMS alerts when a task becomes due
- Mobile APK version of My Tasks (desktop only in v1)
- Recurring schedule rules like "every 30 days" (handle by repeated uploads)
- Auto-creating `PmExecution` rows on Perform click (pure navigation)

## Architecture

### Backend additions

All in `apps/api/src/modules/pm-schedules/`:

| Endpoint | Method | Permission | Purpose |
|---|---|---|---|
| `/api/pm-schedules/upload` | POST `multipart/form-data` | `PM_CREATE` | Parse CSV or XLSX, resolve AHU names to UUIDs, upsert `PmSchedule` and `PmScheduleEntry` rows. Returns `{ imported: N, skipped: [{row, reason}] }`. |
| `/api/pm-schedules/template.csv` | GET | `PM_READ` | Download a blank CSV template with 3 columns: `ahu_name,scheduled_date,tolerance_days`. |
| `/api/pm-schedules/due` | GET | `PM_READ` | Return all entries where `now` ∈ [`windowStart`, `windowEnd`], grouped by AHU, each AHU enriched with its child filters and per-filter cleaning status. |

**Service method:** `pmScheduleService.getDueTasks(ctx)` returns:

```ts
Array<{
  ahuId: string;
  ahuName: string;
  plannedDate: Date;
  toleranceDays: number;
  windowStart: Date;
  windowEnd: Date;
  filters: Array<{
    filterId: string;
    filterName: string;
    status: 'pending' | 'cleaned_in_window' | 'in_progress';
    lastCycleCompletedAt: Date | null;
  }>;
  overallStatus: 'pending' | 'in_progress' | 'complete' | 'overdue';
}>
```

**Status computation** (pure read-side — no writes, no hooks into filter-operations):

| Condition | `overallStatus` | Card appearance |
|---|---|---|
| `now < windowStart` | filtered out | hidden |
| `now ∈ window`, no filter has a cleaning cycle whose `completedAt ≥ windowStart` | `pending` | amber badge |
| `now ∈ window`, some filters have a cycle in window | `in_progress` | cyan badge + progress bar |
| `now ∈ window`, all filters have a cycle in window | `complete` | emerald badge (still shown until window ends) |
| `now > windowEnd`, all filters cleaned in window | filtered out | hidden (archived) |
| `now > windowEnd`, not all filters cleaned | `overdue` | rose badge, shown in Overdue section |

**CSV/XLSX parsing:** add `xlsx` (SheetJS community) to `apps/api/package.json`. Handles both formats with one API.

**CSV format (Option C with fallback tolerance):**

```csv
ahu_name,scheduled_date,tolerance_days
AHU-01,2026-04-15,
AHU-02,2026-04-20,5
AHU-03,2026-05-10,3
```

Rows with empty `tolerance_days` use `defaultToleranceDays` from the config page.

**Upload behavior:**
- One row = one `PmScheduleEntry`
- If a `PmSchedule` already exists for `(ahuId, year)`, add the new entry to it
- If not, create the `PmSchedule` first
- Row errors (AHU not found, bad date format, past dates > N days old) are reported in the `skipped` array but don't abort the import
- AHU lookup is by **name** (matches human CSV usage). Name comparison is case-insensitive. Ambiguous matches → error
- Year is inferred from `scheduled_date`

### New config module

`apps/api/src/modules/config/defs/pm-schedule-settings.def.ts` — mirrors the Block Change Approval pattern:

```ts
{
  moduleKey: 'pm-schedule-settings',
  moduleName: 'PM Schedule Settings',
  category: 'filter-management',
  sortOrder: 70,
  requiredRole: 'SUPER_ADMIN',
  settings: [
    {
      key: 'defaultToleranceDays',
      type: 'number',
      label: 'Default Tolerance (days)',
      description: 'Used when a CSV row leaves tolerance_days blank.',
      default: 3,
      min: 0,
      max: 365,
    },
    {
      key: 'taskVisibility',
      type: 'select',
      label: 'Task Visibility',
      description: 'Who sees a task in My Tasks.',
      default: 'GLOBAL',
      options: [
        { value: 'GLOBAL', label: 'Everyone with PM_EXECUTE' },
        { value: 'PER_USER', label: 'Per-user assignment (not yet implemented)' },
        { value: 'ROLE_GATED', label: 'Role-gated (not yet implemented)' },
      ],
    },
    {
      key: 'showOverdueSeparately',
      type: 'boolean',
      label: 'Show Overdue section separately',
      description: 'Render overdue tasks in their own section below the due list.',
      default: true,
    },
  ],
}
```

Registered via `apps/api/src/lib/config-discovery.ts` import.

For v1, only `taskVisibility: 'GLOBAL'` is wired up. `PER_USER` and `ROLE_GATED` return `501 NOT_IMPLEMENTED` with a clear message. This follows the Block Change Approval pattern — slot exists, extension path is clear.

### Frontend additions

**New page — `apps/web/src/routes/my-tasks/index.tsx`** mounted at `/my-tasks`:

- Cyan/teal gradient header icon + "My Tasks" title + subtitle
- 4 stat cards: Due Today / Due This Week / Overdue / Completed This Week
- Search bar (AHU name filter)
- AHU card grid — each card:
  - AHU name, total filters count, planned date, window date range
  - Overall status badge (amber pending / cyan in-progress / emerald complete)
  - Click card → expand to show per-filter chips with individual status
  - **Perform** button → `navigate('/filters?ahuId=' + ahuId)`
- Overdue section below (when `showOverdueSeparately: true`)

**Updated — `apps/web/src/routes/pm-schedules/index.tsx`** (currently 43-line placeholder):

- Keeps the existing year navigator
- Adds **Upload Schedule** button opening a drag-and-drop dialog accepting `.csv` and `.xlsx`
- Adds **Download Template** button hitting `/api/pm-schedules/template.csv`
- Adds a list view of existing schedules for the selected year (AHU name, count of entries, next planned date)
- Cyan/teal professional theme matching the retirement/replacement list redesign

**Filter operations page — single small change** in `apps/web/src/routes/filter-management/filter-operations.tsx`:

- Read `ahuId` from `useSearchParams()`
- If present, client-side filter the displayed filters to show only children of that AHU (via `parentId` check against cached instances)

### Config touchpoints (6 of 12)

| # | Touchpoint | Change | File |
|---|---|---|---|
| 1 | Sidebar items | + `{ id: 'my-tasks', label: 'My Tasks', icon: '📋' }` | `packages/shared/src/types/sidebar-items.ts` |
| 2 | Sidebar privilege map | `my-tasks` → `['pm.view', 'pm.execute']` | `packages/shared/src/types/sidebar-privilege-map.ts` |
| 3 | Frontend routes | `<Route path="my-tasks" …>` with `RequireRole permissions={[PM_READ]}` | `apps/web/src/main.tsx` |
| 4 | Sidebar nav | New entry in `allNavItems` | `apps/web/src/components/layout/sidebar.tsx` |
| 5 | Config discovery | + `import('../modules/config/defs/pm-schedule-settings.def.js')` | `apps/api/src/lib/config-discovery.ts` |
| 6 | Shared rebuild | `cd packages/shared && npx tsc` | build step |

**Not touched** (no new permissions, privileges, seed data, reauth, or auth public paths needed).

## Data Flow

```
┌───────────────┐
│ User uploads  │
│ CSV / XLSX    │
└───────┬───────┘
        │
        ▼
POST /api/pm-schedules/upload
        │
        ▼
┌──────────────────────────────────────┐
│ service.importSchedules(ctx, file):  │
│  1. Parse rows (xlsx lib)            │
│  2. For each row:                    │
│     a. Resolve ahu_name → assetId    │
│     b. Fallback tolerance from config│
│     c. Compute year from date        │
│     d. upsert PmSchedule(ahu, year)  │
│     e. create PmScheduleEntry        │
│        (plannedDate, toleranceDays,  │
│        windowStart, windowEnd)       │
│  3. Return imported/skipped counts   │
└──────────────────────────────────────┘

┌───────────────┐
│ User opens    │
│ My Tasks page │
└───────┬───────┘
        │
        ▼
GET /api/pm-schedules/due
        │
        ▼
┌──────────────────────────────────────┐
│ service.getDueTasks(ctx):            │
│  1. Fetch all PmScheduleEntry rows   │
│     where windowStart ≤ now ≤        │
│     windowEnd + recently-expired     │
│  2. Group by AHU (from PmSchedule)   │
│  3. For each AHU, walk parentId tree │
│     down to child filters            │
│  4. For each filter, query latest    │
│     CleaningCycle.completedAt        │
│  5. Compute per-filter + overall     │
│     status by comparing completedAt  │
│     to windowStart/windowEnd         │
│  6. Return enriched list             │
└──────────────────────────────────────┘

┌───────────────┐
│ User clicks   │
│ Perform on    │
│ AHU-01 card   │
└───────┬───────┘
        │
        ▼
Client: navigate('/filters?ahuId=AHU-01-UUID')
        │
        ▼
FilterOperationsPage:
  - reads ?ahuId from URL
  - client-side filters instances to children of that AHU
  - user proceeds through normal cleaning flow
        │
        ▼
Existing filter-operations flow does its thing
(completedAt gets written to CleaningCycle on advance)
        │
        ▼
Next /due query will see the updated cycles
and move the task toward "complete"
```

## Testing Plan

- **Backend unit tests** (apps/api/src/modules/pm-schedules/__tests__/):
  - Parse CSV with mixed blank + filled tolerance
  - Parse XLSX with same data
  - Reject unknown AHU name
  - Reject bad date format
  - Upsert semantics (same AHU + year adds entries, doesn't replace schedule)
  - getDueTasks happy path (create fixture with 2 AHUs in window, 1 out)
  - getDueTasks status computation (pending / in_progress / complete / overdue)
  - Overdue detection when `now > windowEnd`

- **Frontend smoke test** (manual): upload a 5-row CSV, verify entries appear on PM Schedules page, open My Tasks, verify due tasks appear with correct statuses.

- **E2E verification**: full round-trip — upload CSV → My Tasks shows task → click Perform → land on filters page pre-filtered → complete a cycle → return to My Tasks → see status update.

## Open Questions

None. All Q1–Q4 resolved in brainstorming. The three gut-check items the user was asked at end of design have been defaulted to my recommendations:

1. Tasks hide once window ends AND all filters cleaned
2. CSV is one row per (AHU + planned date); repeat for multiple months
3. Perform button is pure navigation — no backend state mutation on click

## Rollback

Pure additive feature. Rollback = revert the two commits. No DB state at risk — the upload writes to existing tables with existing schemas. If the feature is removed, stale PM schedule entries remain but cause no harm.
