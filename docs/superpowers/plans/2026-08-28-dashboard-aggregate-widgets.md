# Dashboard Aggregate Widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dashboard trend card showing min/mean/max across the current drill-down, an alarm list for that same selection, and a staleness column on the Readings table.

**Architecture:** One new server module aggregates telemetry in SQL over the caller's visible instruments, bucketed like `room-history.ts`. The shared `TimeSeriesChart` gains one optional envelope prop. Both widgets arrive as new keys in the existing panel catalogue, so they are assignable per role and per user with no change to Project A.

**Tech Stack:** Fastify + Prisma raw SQL (the telemetry table is partitioned), React 19, vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-dashboard-aggregate-widgets-design.md`

## Global Constraints

- **Every point on the band is DERIVED, not a stored reading**, and the card says so on its face. This repo does not let a computed value look like a recorded one.
- **Limit lines only when every instrument in the selection resolves to the same bound.** Mixed limits (including one instrument having none) means no lines plus a stated reason.
- **`instrumentCount` per bucket ships and is displayed.** A band that narrows because sensors went offline must not read as "conditions stabilised".
- **Visibility is applied to the INSTRUMENT SET, never to the returned rows.** Same rule as `getRoomHistory`: filter what goes into the query, not what comes out.
- **A location filter is ANDed with visibility, never replaces it.**
- **Raw SQL** — `instrument_telemetry_history` is partitioned and Prisma cannot express it.
- **`npx tsc --noEmit` on every project touched.** vitest never typechecks.
- No migration. No new permission, reauth action, audit action, module, config def, page or route.

---

### Task 1: The aggregate endpoint  ← CHECKPOINT AFTER THIS

**Files:**
- Create: `apps/api/src/modules/instruments/telemetry-aggregate.ts`
- Create: `apps/api/src/modules/instruments/__tests__/telemetry-aggregate.test.ts`
- Modify: `apps/api/src/modules/instruments/routes.ts` (register `GET /telemetry-aggregate` beside `/telemetry-overview`)
- Create: `apps/api/src/e2e/telemetry-aggregate.test.ts`

**Interfaces:**
- Consumes: `WINDOW_SPEC` / `HistoryWindow` from `floorplans/room-history.js`; `resolveVisibility` / `withVisibility` / `ScopeWhere` from `./visibility.js`; `resolveLocationIds` from `functional-locations/tree.js`; `slotAliases`, `loadLimitConfig`, `limitsFor`.
- Produces: `limitsAgree(perInstrument)`, `buildAggregate(...)`, `getTelemetryAggregate(opts)`, and the route `GET /api/instruments/telemetry-aggregate`.

- [ ] **Step 1: Write the failing unit test for the pure halves**

```ts
// apps/api/src/modules/instruments/__tests__/telemetry-aggregate.test.ts
import { describe, it, expect } from 'vitest';
import { limitsAgree, shapeBuckets } from '../telemetry-aggregate.js';

describe('limitsAgree', () => {
  it('agrees when every instrument resolves to the same bound', () => {
    expect(limitsAgree([{ min: 2, max: 8 }, { min: 2, max: 8 }])).toEqual({ min: 2, max: 8 });
  });

  it('does NOT agree when one differs', () => {
    // Drawing the first instrument's limits across the rest would be a false
    // claim about every other instrument on the chart.
    expect(limitsAgree([{ min: 2, max: 8 }, { min: 2, max: 25 }])).toBeNull();
  });

  it('does NOT agree when one instrument has no limits at all', () => {
    // "One of them is unbounded" is mixed, not agreement. A line drawn here would
    // assert a bound for an instrument that has none.
    expect(limitsAgree([{ min: 2, max: 8 }, { min: null, max: null }])).toBeNull();
  });

  it('agrees on a half-bounded selection when the half matches', () => {
    // A real case: high limit set, low limit deliberately not.
    expect(limitsAgree([{ min: null, max: 8 }, { min: null, max: 8 }])).toEqual({ min: null, max: 8 });
  });

  it('returns null for an empty selection rather than a bound', () => {
    expect(limitsAgree([])).toBeNull();
  });
});

describe('shapeBuckets', () => {
  const rows = [
    { ts: new Date('2026-08-28T10:00:00Z'), slot: 'temperature', min: 2, avg: 4, max: 6, instrumentCount: 3n },
    { ts: new Date('2026-08-28T10:05:00Z'), slot: 'temperature', min: 3, avg: 3.5, max: 4, instrumentCount: 2n },
    { ts: new Date('2026-08-28T10:00:00Z'), slot: 'humidity', min: 40, avg: 45, max: 50, instrumentCount: 3n },
  ];

  it('splits rows by slot and preserves time order', () => {
    const out = shapeBuckets(rows as never);
    expect(out.temperature.map((p) => p.ts)).toEqual([
      '2026-08-28T10:00:00.000Z', '2026-08-28T10:05:00.000Z',
    ]);
    expect(out.humidity).toHaveLength(1);
  });

  it('carries the per-bucket instrument count as a number', () => {
    // Postgres count() comes back as BigInt through Prisma raw queries and
    // JSON.stringify throws on those — a silent 500 at serialisation time.
    const out = shapeBuckets(rows as never);
    expect(out.temperature[1].instrumentCount).toBe(2);
    expect(typeof out.temperature[1].instrumentCount).toBe('number');
  });

  it('keeps min/mean/max distinct', () => {
    const p = shapeBuckets(rows as never).temperature[0];
    expect([p.min, p.mean, p.max]).toEqual([2, 4, 6]);
  });
});
```

- [ ] **Step 2: Run it — expect module-not-found**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/telemetry-aggregate.test.ts`

- [ ] **Step 3: Write the module**

Mirror `room-history.ts` closely: same window spec, same `NUMERIC_VALUE` cast, same "filter the instrument set, not the rows" rule. The aggregate SQL groups by bucket and slot:

```sql
SELECT to_timestamp(floor(extract(epoch FROM ts) / $bucket) * $bucket) AS ts,
       CASE WHEN lower(key) = ANY($tempKeys) THEN 'temperature' ELSE 'humidity' END AS slot,
       min(<numeric>) AS min, avg(<numeric>) AS avg, max(<numeric>) AS max,
       count(DISTINCT instrument_id) AS "instrumentCount"
FROM instrument_telemetry_history
WHERE instrument_id = ANY($ids) AND lower(key) = ANY($allKeys)
  AND ts >= $from AND ts <= $to AND jsonb_typeof(value) = 'number'
GROUP BY 1, 2 ORDER BY 1 ASC
```

`limitsAgree` takes the per-instrument resolved limits (from `limitsFor`) and returns the shared bound or `null`.

- [ ] **Step 4: Register the route**

Beside `/telemetry-overview` in `instruments/routes.ts`, gated on `INSTRUMENT_READ`, taking `functionalLocationId`, `functionalLocationDirect`, `window`. Response schema must declare every field — Fastify strips undeclared ones silently.

- [ ] **Step 5: Write the e2e**

`src/e2e/telemetry-aggregate.test.ts`, through the seeded OPERATOR:
- an out-of-scope instrument seeded with an extreme value (e.g. 999) contributes NOTHING to `max`;
- a Block selection covers its Areas;
- `instrumentCount` counts only instruments reporting in that bucket;
- unrestricted control returns the wider figures.

- [ ] **Step 6: Verify against live data, then STOP for the checkpoint**

Run the endpoint as `superadmin` and as a scoped user against the real database and show both, plus `limitsAgree`'s verdict for a real selection.

- [ ] **Step 7: Commit**

---

### Task 2: Location filter on the alarms list

**Files:**
- Modify: `apps/api/src/modules/alarms/routes.ts` (the `GET /` handler, ~line 260)
- Modify: `apps/api/src/e2e/panel-access.test.ts`? No — new cases go in `src/e2e/telemetry-aggregate.test.ts` beside the other selection tests.

- [ ] **Step 1: Add the failing e2e case** — a location filter naming a location the caller cannot see returns nothing, not everything.
- [ ] **Step 2: Add `functionalLocationId` to the querystring schema and the filter**, expanded via `resolveLocationIds`, ANDed with `scopedToVisible`.
- [ ] **Step 3: Run, typecheck, commit.**

---

### Task 3: Two new panel keys

**Files:**
- Modify: `packages/shared/src/types/panels.ts`, `packages/shared/src/types/panels.test.ts`

- [ ] **Step 1: Update the frozen-key test** to expect `dashboard_trend` and `dashboard_alarms` at the END of the dashboard group.
- [ ] **Step 2: Add the two entries.** No migration: absence of a key in a stored list already means "not shown", which is the intended default for new capability.
- [ ] **Step 3: Rebuild the shared package, run tests, commit.**

---

### Task 4: `TimeSeriesChart` gains an optional envelope

**Files:**
- Modify: `apps/web/src/routes/dashboard/time-series-chart.tsx`

- [ ] **Step 1:** Add `envelope?: { points: { ts: string; lo: number; hi: number }[]; color: string }` to `Props`.
- [ ] **Step 2:** Render it as a filled path BEFORE the series so lines sit on top; include its `lo`/`hi` in the y-scale so the band is never clipped.
- [ ] **Step 3:** Run the existing chart and trend tests unchanged — the prop is optional, and their staying green is the evidence the trend page is untouched. Typecheck, commit.

---

### Task 5: The dashboard trend card

**Files:**
- Create: `apps/web/src/routes/dashboard/aggregate-trend-card.tsx`
- Create: `apps/web/src/routes/dashboard/__tests__/aggregate-trend-card.test.ts` (pure helpers only)
- Modify: `apps/web/src/routes/dashboard/index.tsx`

- [ ] **Step 1:** Unit-test the two pure helpers: the disclosure sentence's instrument count, and the "mixed limits" message selection.
- [ ] **Step 2:** Build the card — band + mean line + limit lines when they agree, the derived-data disclosure, the per-bucket instrument count, and a link to the per-instrument trend pages.
- [ ] **Step 3:** Render it under `showPanel('dashboard_trend')`, following `?fl=`.
- [ ] **Step 4:** Typecheck, run the web suite, `vite build`, commit.

---

### Task 6: The alarm list widget

**Files:**
- Create: `apps/web/src/routes/dashboard/selection-alarms.tsx`
- Modify: `apps/web/src/routes/dashboard/index.tsx`

- [ ] **Step 1:** Build the list — instrument, metric, value vs limit, raised at, acknowledged state — reading `GET /api/alarms?functionalLocationId=&state=ACTIVE`.
- [ ] **Step 2:** Render under `showPanel('dashboard_alarms')`. Leave the existing top-level count card alone.
- [ ] **Step 3:** Typecheck, web suite, commit.

---

### Task 7: "As of" column on the Readings table

**Files:**
- Modify: `apps/web/src/routes/dashboard/telemetry-table.tsx`
- Create/modify: its `__tests__` for the staleness helper

- [ ] **Step 1:** Unit-test the helper: it returns the OLDER of the two slot timestamps, and handles a slot being absent.
- [ ] **Step 2:** Add the column, relative age with absolute time on hover via `useDatetimeFormat`.
- [ ] **Step 3:** Typecheck, web suite, commit.

---

### Task 8: Docs

- [ ] **Step 1:** Re-derive every count (all should be unchanged; shared type files stay 18).
- [ ] **Step 2:** CHANGELOG entry covering the three decisions the spec argues.
- [ ] **Step 3:** Update `docs/recreation/06-api/endpoints.md` with the new endpoint and the new alarm filter.
- [ ] **Step 4:** Full verification: `npm test` in apps/api, `npx vitest run` in apps/web, `tsc` on all three, `vite build`. Commit.

## Self-review notes

- **Spec coverage:** endpoint → Task 1; derived-data disclosure, limit agreement, instrument count → Tasks 1 and 5; alarm filter → Task 2; alarm widget → Task 6; timestamp column → Task 7; panel keys and the new-keys-off default → Task 3; chart support → Task 4; counts and docs → Task 8.
- **Type consistency:** `limitsAgree` / `shapeBuckets` / `getTelemetryAggregate` / `envelope` are each defined once and referenced by those names.
- **Known risk:** Postgres `count()` returns BigInt through Prisma raw queries and `JSON.stringify` throws on BigInt — a 500 at serialisation, not at query time. Task 1's `shapeBuckets` test pins the conversion.
