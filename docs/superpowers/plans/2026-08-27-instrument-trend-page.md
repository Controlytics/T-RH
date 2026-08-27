# Instrument Trend Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Trend page show the actual telemetry history over any range — every reading on narrow windows, a truthful selected subset on wide ones — with correct range summaries, zoom, and honest empty/error states.

**Architecture:** Wide ranges downsample by SELECTING real readings (LTTB) server-side, never by averaging; the response carries `sampled`/`total` and a `summary` computed in SQL over the WHOLE range. The frontend keeps its two existing charts and gains a "showing N of M" line, server-sourced summaries, and refetch-on-zoom.

**Tech Stack:** Fastify 5, Prisma 6 (raw SQL for telemetry), PostgreSQL 18, React 19 + SWR, hand-rolled SVG charts (no charting dependency), vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-instrument-trend-page-design.md` — read it before Task 1. Where plan and spec disagree, the spec wins.

## Already built — do NOT rebuild

Verified against live code 2026-08-27. The request describes several things that exist:

- **The two separate charts exist.** `trend.tsx:675` renders `title="Temperature" unit="°C"` and `:689` `title="Humidity" unit="%RH"`, each a single-series `TimeSeriesChart`. They are already never combined.
- **Hover readout exists** — `time-series-chart.tsx:108` `hoverX`, `:152-161` nearest-point-per-series.
- **Band gauges, alarms widget, raw paged table, extra-keys picker, report export** all exist and are RETAINED.
- **Aggregation already defaults to off** — `DEFAULT_INTERVAL` is `'raw'` (changed 2026-08-24 for exactly the reason the spec restates).
- **`MAX_SERIES_POINTS = 5_000`** and the period presets exist in `@digilog/shared`.

What is missing is Tasks 1–6 below.

## Global Constraints

- **Branch:** `data-injection`. Never commit to `final-user-management` (frozen backup).
- **Never average to fit a chart.** Downsampling SELECTS stored readings. Every plotted point is a real reading at its real timestamp.
- **Range summaries come from the server, over every reading in range** — never recomputed from the plotted subset.
- **No charting dependency.** This repo removed `chartjs-node-canvas`, `reactflow` and `@monaco-editor/react`. Extend `routes/dashboard/time-series-chart.tsx`.
- **Light theme only** (`CLAUDE.md`). Chart colours move to CSS variables; no dark mode ships.
- **Series identity is fixed:** temperature = palette slot 1, humidity = slot 2, across gauge, chart and printed report.
- **Every field returned must be declared in the Fastify `response` schema in the same edit** — Fastify silently strips undeclared fields.
- Test command, always per package: `npx vitest run <path> --pool=forks --poolOptions.forks.singleFork=true`. **Never a combined multi-package run** — it manufactures ~129 false failures from e2e database contention.
- **Known-failing baseline is ZERO.** Any failure is yours.
- `vitest` does not typecheck — run `npx tsc --noEmit -p apps/api/tsconfig.json` and the web equivalent explicitly.
- The plan's expected test counts are informal aids and have proved off by one before. The test FILE is the requirement.

---

### Task 1: The sampler and the missing preset

**Files:**
- Create: `packages/shared/src/types/telemetry-downsample.ts`
- Test: `packages/shared/src/types/__tests__/telemetry-downsample.test.ts`
- Modify: `packages/shared/src/types/telemetry-period.ts` (add the `12h` preset)
- Modify: `packages/shared/src/index.ts` (named re-exports)

**Interfaces:**
- Consumes: nothing.
- Produces: `lttb<T extends DownsamplePoint>(points: T[], target: number): T[]`, `interface DownsamplePoint { ts: string | Date; value: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/types/__tests__/telemetry-downsample.test.ts
import { describe, it, expect } from 'vitest';
import { lttb } from '../telemetry-downsample.js';
import { PERIOD_PRESETS } from '../telemetry-period.js';

const at = (i: number, value: number) => ({ ts: new Date(1_700_000_000_000 + i * 60_000).toISOString(), value });
const ramp = (n: number) => Array.from({ length: n }, (_, i) => at(i, i));

describe('lttb', () => {
  it('returns the input untouched when it is already small enough', () => {
    const pts = ramp(50);
    expect(lttb(pts, 100)).toBe(pts);
    expect(lttb(pts, 50)).toBe(pts);
  });

  it('returns exactly the requested number of points', () => {
    expect(lttb(ramp(10_000), 500)).toHaveLength(500);
  });

  /**
   * The range's own endpoints must be REAL readings, or the chart's x-extent
   * disagrees with the range the operator selected.
   */
  it('always keeps the first and last reading', () => {
    const pts = ramp(10_000);
    const out = lttb(pts, 250);
    expect(out[0]).toBe(pts[0]);
    expect(out[out.length - 1]).toBe(pts[pts.length - 1]);
  });

  /**
   * THE LOAD-BEARING ASSERTION. `toBe`, not `toEqual`: every returned element must
   * be the SAME OBJECT as an input element. A future refactor that "helpfully"
   * builds new points — averaging, rounding, re-timestamping — fails here. That is
   * the whole difference between this and the bucket-averaging the spec rejects.
   */
  it('never invents a point — every result is reference-equal to an input', () => {
    const pts = ramp(5_000);
    const inputs = new Set<unknown>(pts);
    for (const p of lttb(pts, 300)) expect(inputs.has(p)).toBe(true);
  });

  it('preserves chronological order', () => {
    const out = lttb(ramp(5_000), 400);
    for (let i = 1; i < out.length; i++) {
      expect(new Date(out[i].ts).getTime()).toBeGreaterThan(new Date(out[i - 1].ts).getTime());
    }
  });

  /**
   * The reason to use LTTB rather than "every Nth reading". A brief excursion is
   * the thing a Part 11 record exists to show; naive decimation drops it.
   */
  it('keeps a lone spike that naive every-Nth sampling would drop', () => {
    const pts = ramp(5_000);
    pts[2_501] = at(2_501, 999); // one sharp excursion, deliberately off a round index
    const out = lttb(pts, 200);
    expect(out.some((p) => p.value === 999)).toBe(true);
  });

  it('degenerates safely below three points', () => {
    const pts = ramp(1_000);
    expect(lttb(pts, 2)).toEqual([pts[0], pts[999]]);
    expect(lttb(pts, 1)).toEqual([pts[0], pts[999]]);
    expect(lttb([], 100)).toEqual([]);
  });

  it('accepts Date timestamps as well as ISO strings', () => {
    const pts = Array.from({ length: 500 }, (_, i) => ({ ts: new Date(1_700_000_000_000 + i * 1_000), value: i }));
    expect(lttb(pts, 100)).toHaveLength(100);
  });
});

describe('period presets', () => {
  it('offers 12 hours', () => {
    const p = PERIOD_PRESETS.find((x) => x.value === '12h');
    expect(p).toBeTruthy();
    expect(p!.ms).toBe(12 * 3_600_000);
  });

  it('keeps the presets in ascending order so the control reads left to right', () => {
    const ms = PERIOD_PRESETS.map((p) => p.ms);
    expect([...ms].sort((a, b) => a - b)).toEqual(ms);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run packages/shared/src/types/__tests__/telemetry-downsample.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `../telemetry-downsample.js`.

- [ ] **Step 3: Write the sampler**

```ts
// packages/shared/src/types/telemetry-downsample.ts
/**
 * Downsampling for telemetry charts — by SELECTION, never by computation.
 *
 * Design: docs/superpowers/specs/2026-08-27-instrument-trend-page-design.md
 *
 * At this installation's cadence (a reading every 30-90s) a 30-day range holds
 * 28,000-86,000 readings per key. A 1600px chart has 1600 columns, so those points
 * are already sub-pixel; sending them all costs tens of MB and stalls the tab
 * without showing anything more.
 *
 * The answer is NOT to average. An averaged point is a value that was never read,
 * and a brief excursion — the thing a 21 CFR Part 11 record exists to show —
 * vanishes into its bucket's mean. Largest-Triangle-Three-Buckets instead PICKS
 * which stored readings to draw, so every plotted point is real, keeps its own
 * timestamp, and peaks survive.
 */

export interface DownsamplePoint {
  ts: string | Date;
  value: number;
}

const millis = (ts: string | Date): number => (ts instanceof Date ? ts.getTime() : new Date(ts).getTime());

/**
 * Largest-Triangle-Three-Buckets.
 *
 * Divides the series into `target - 2` buckets between the fixed first and last
 * points and picks, from each, the reading forming the largest triangle with the
 * previously selected point and the next bucket's average position. That area
 * metric is what preserves shape and spikes.
 *
 * Returns the ORIGINAL array (same reference) when no sampling is needed, so a
 * caller can cheaply tell that nothing was dropped.
 */
export function lttb<T extends DownsamplePoint>(points: T[], target: number): T[] {
  if (points.length === 0) return points;
  if (target >= points.length) return points;

  const first = points[0];
  const last = points[points.length - 1];
  if (target <= 2) return [first, last];

  const out: T[] = [first];
  // Buckets span the points BETWEEN the fixed endpoints.
  const bucketSize = (points.length - 2) / (target - 2);
  let selected = 0;

  for (let i = 0; i < target - 2; i++) {
    const rangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, points.length - 1);

    // The NEXT bucket's average position, which the triangle is measured against.
    const nextStart = rangeEnd;
    const nextEnd = Math.min(Math.floor((i + 3) * bucketSize) + 1, points.length);
    const nextCount = Math.max(1, nextEnd - nextStart);
    let avgX = 0;
    let avgY = 0;
    for (let j = nextStart; j < nextEnd; j++) {
      avgX += millis(points[j].ts);
      avgY += points[j].value;
    }
    avgX /= nextCount;
    avgY /= nextCount;

    const aX = millis(points[selected].ts);
    const aY = points[selected].value;

    let bestArea = -1;
    let bestIndex = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs(
        (aX - avgX) * (points[j].value - aY) - (aX - millis(points[j].ts)) * (avgY - aY),
      );
      if (area > bestArea) {
        bestArea = area;
        bestIndex = j;
      }
    }

    out.push(points[bestIndex]);
    selected = bestIndex;
  }

  out.push(last);
  return out;
}
```

- [ ] **Step 4: Add the 12h preset**

In `packages/shared/src/types/telemetry-period.ts`, in `PERIOD_PRESETS`, between `6h` and `24h`:

```ts
  { value: '12h', label: 'Last 12 hours', ms: 12 * 3_600_000 },
```

And add `'12h'` to the `PeriodPreset` union:

```ts
export type PeriodPreset = '15m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d' | 'custom';
```

**`15m` STAYS.** The operator listed 1h/6h/12h/24h/7d/30d, but removing a preset someone may be using is not part of this change.

- [ ] **Step 5: Export from the package index**

`packages/shared/src/index.ts` uses NAMED re-exports, never `export *`. Match that:

```ts
export { lttb } from './types/telemetry-downsample.js';
export type { DownsamplePoint } from './types/telemetry-downsample.js';
```

- [ ] **Step 6: Run the tests and build**

```bash
npx vitest run packages/shared/src/types/__tests__/telemetry-downsample.test.ts --pool=forks --poolOptions.forks.singleFork=true
npx vitest run packages/shared/src --pool=forks --poolOptions.forks.singleFork=true
npm run build -w @digilog/shared
```
Expected: all pass; build exits 0. The API and web packages import the BUILT output, so skipping the build makes every later task fail to resolve the import.

**If `chooseInterval` or another function in `telemetry-period.ts` switches on the preset union, adding `12h` may produce a TypeScript exhaustiveness error.** That is the type system doing its job — handle the new case rather than casting it away, and say in your report what you found.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/telemetry-downsample.ts packages/shared/src/types/__tests__/telemetry-downsample.test.ts packages/shared/src/types/telemetry-period.ts packages/shared/src/index.ts
git commit -m "feat(shared): LTTB telemetry downsampler and the 12h period preset"
```

---

### Task 2: Fix the silent truncation, and serve sampled points with true aggregates

**Files:**
- Modify: `apps/api/src/modules/instruments/telemetry.repository.ts` (`getHistory`, plus a new `getRangeSummary`)
- Modify: `apps/api/src/modules/instruments/routes.ts` (`GET /:id/telemetry`, ~line 636-700)
- Test: `apps/api/src/modules/instruments/__tests__/telemetry-range.test.ts`
- Test: `apps/api/src/e2e/instrument-telemetry-range.test.ts`

**Interfaces:**
- Consumes: `lttb`, `MAX_SERIES_POINTS` from `@digilog/shared`.
- Produces:
  - `getRangeSummary(opts: { instrumentId: string; key: string; from?: Date; to?: Date }): Promise<{ count: number; min: number; max: number; avg: number; first: Date; last: Date } | null>`
  - `GET /:id/telemetry` response gains `historySampled: boolean` and `summaries: Record<string, RangeSummary>`.

**THERE IS A LIVE BUG HERE — this task fixes it.** `use-trend-data.ts:167` requests `limit=MAX_SERIES_POINTS` (5000), but `getHistory` does `Math.min(opts.limit ?? 100, 1000)` with `ORDER BY ts DESC`. So for any range holding more than 1000 readings the server silently returns **only the newest 1000**, with nothing in the response saying so. At a 30-90s cadence that is anything beyond roughly a day: **7-day and 30-day charts today plot about the last day while the axis claims a week, and the Min/Max/Avg strip is computed over that truncated slice.** Do not "fix" it by raising the cap — that is what Task 1's sampler is for.

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/api/src/modules/instruments/__tests__/telemetry-range.test.ts
import { describe, it, expect } from 'vitest';
import { lttb } from '@digilog/shared';

/**
 * Guards the PROPERTY the route depends on, without a database: a sampled series
 * must still be bounded by the true range aggregates, because the summary strip is
 * sourced from those and not from these points.
 */
describe('sampled series vs range summary', () => {
  const rows = Array.from({ length: 4_000 }, (_, i) => ({
    ts: new Date(1_700_000_000_000 + i * 30_000).toISOString(),
    value: i === 1_777 ? 99.9 : 20 + (i % 5) * 0.1,
  }));

  it('the true maximum can be absent from the sampled points', () => {
    // Not a defect — it is why the summary must come from SQL over the whole range.
    // If this ever becomes false the test still passes; the point is that the route
    // must not DEPEND on the spike surviving.
    const sampled = lttb(rows, 50);
    const trueMax = Math.max(...rows.map((r) => r.value));
    expect(trueMax).toBe(99.9);
    expect(sampled.length).toBe(50);
  });

  it('sampling preserves the endpoints the x-axis is drawn from', () => {
    const sampled = lttb(rows, 100);
    expect(sampled[0].ts).toBe(rows[0].ts);
    expect(sampled[sampled.length - 1].ts).toBe(rows[rows.length - 1].ts);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run apps/api/src/modules/instruments/__tests__/telemetry-range.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL until `@digilog/shared` is rebuilt with Task 1 (`lttb` not exported). If Task 1's build ran, this passes immediately — that is fine, it is a guard, not a driver. Say so in your report.

- [ ] **Step 3: Add the range-summary query**

In `apps/api/src/modules/instruments/telemetry.repository.ts`, beside `getHistory`:

```ts
export interface RangeSummary {
  count: number; min: number; max: number; avg: number; first: Date; last: Date;
}

/**
 * Aggregates over EVERY reading in the range, for one key.
 *
 * SEPARATE from the row query on purpose, and this is the point of the whole
 * design: the chart may be showing a SAMPLED subset, and a max computed from that
 * subset would silently understate an excursion — a 34 °C spike the sampler did not
 * pick would simply not appear in "Maximum" on a regulated record. These numbers
 * come from SQL over the full range, always.
 *
 * Casts inside a CASE, never a bare `::float8`: telemetry `value` is jsonb and this
 * database really contains a non-numeric one (a device sent the string "hello").
 * A WHERE on jsonb_typeof is NOT a reliable guard — Postgres does not promise the
 * filter runs before the projection, so the query passes under one plan and fails
 * under another. room-history.ts does the same thing for the same reason.
 */
export async function getRangeSummary(opts: {
  instrumentId: string; key: string; from?: Date; to?: Date;
}): Promise<RangeSummary | null> {
  const rows = await prisma.$queryRaw<{
    count: bigint; min: number | null; max: number | null; avg: number | null;
    first: Date | null; last: Date | null;
  }[]>`
    SELECT count(*)::bigint AS count,
           min(CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::float8 END) AS min,
           max(CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::float8 END) AS max,
           avg(CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::float8 END) AS avg,
           min(ts) AS first,
           max(ts) AS last
    FROM instrument_telemetry_history
    WHERE instrument_id = ${opts.instrumentId}
      AND key = ${opts.key}
      ${opts.from ? Prisma.sql`AND ts >= ${opts.from}` : Prisma.empty}
      ${opts.to ? Prisma.sql`AND ts <= ${opts.to}` : Prisma.empty}`;

  const r = rows[0];
  if (!r || Number(r.count) === 0 || r.min === null || r.max === null || r.avg === null || !r.first || !r.last) {
    return null;
  }
  return { count: Number(r.count), min: r.min, max: r.max, avg: r.avg, first: r.first, last: r.last };
}
```

- [ ] **Step 4: Add a bounded full-range row reader**

Also in `telemetry.repository.ts`. `getHistory` keeps its 1000 cap for the TABLE path; charting takes its own route:

```ts
/**
 * Every reading in the range for one key, ASCENDING, bounded by `hardCap`.
 *
 * ASC, unlike getHistory's DESC: the sampler and the chart both need chronological
 * order, and reversing 30,000 rows in JS to undo a DESC is wasted work.
 *
 * `hardCap` is a backstop against an unbounded fetch, NOT the sampling target —
 * sampling happens after this returns. If the cap is hit the caller is told, so it
 * can never silently plot a truncated window the way the route did before 2026-08-27.
 */
export async function getRangeRows(opts: {
  instrumentId: string; key: string; from?: Date; to?: Date; hardCap: number;
}): Promise<{ rows: TelemetryRow[]; truncated: boolean }> {
  const rows = await prisma.$queryRaw<TelemetryRow[]>`
    SELECT key, value, value_type AS "valueType", ts
    FROM instrument_telemetry_history
    WHERE instrument_id = ${opts.instrumentId}
      AND key = ${opts.key}
      ${opts.from ? Prisma.sql`AND ts >= ${opts.from}` : Prisma.empty}
      ${opts.to ? Prisma.sql`AND ts <= ${opts.to}` : Prisma.empty}
    ORDER BY ts ASC LIMIT ${opts.hardCap + 1}`;

  const truncated = rows.length > opts.hardCap;
  return { rows: truncated ? rows.slice(0, opts.hardCap) : rows, truncated };
}
```

Pick `hardCap` at the call site as `200_000` — far above any real range at this cadence, low enough to bound memory.

- [ ] **Step 5: Extend the route**

In `apps/api/src/modules/instruments/routes.ts`, `GET /:id/telemetry`:

Add to the `querystring` properties:

```ts
          // Target points per key for the CHART path. Omitted = legacy behaviour
          // (the paged `limit`/`offset` table path), so existing callers are
          // unaffected. Enumerated bounds, so an out-of-range value is a 400 from
          // the schema rather than a silent clamp.
          points: { type: 'integer', minimum: 1, maximum: 5000 },
```

Add to the `response` 200 properties — **every one of these must be declared or Fastify strips it silently**:

```ts
            historySampled: { type: 'boolean' },
            summaries: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                properties: {
                  count: { type: 'integer' },
                  min: { type: 'number' }, max: { type: 'number' }, avg: { type: 'number' },
                  first: { type: 'string' }, last: { type: 'string' },
                },
              },
            },
```

In the handler, when `points` is present: for each requested key, call `getRangeRows` then `lttb(rows, points)`, and call `getRangeSummary`. Set `historySampled` true when any key was sampled OR `truncated` was true. Keep the existing behaviour untouched when `points` is absent.

Preserve the route's existing instrument-visibility scoping — it 404s (never 403) for an out-of-scope instrument, and that must not regress.

- [ ] **Step 6: Write the e2e**

Create `apps/api/src/e2e/instrument-telemetry-range.test.ts`. Read an existing file in `apps/api/src/e2e/` first for the auth/fixture conventions — do not invent them. Cover:

```
- points omitted                -> response identical in shape to today (no regression)
- points >= total in range      -> historySampled false, every reading returned
- points <  total in range      -> exactly `points` rows for that key, historySampled true
- summaries.max is the TRUE maximum in the range even when that reading is NOT among
  the returned rows                                    <- THE POINT OF THIS TASK
- summaries absent/null for a key with no readings in range
- points = 5001                 -> 400 from the schema, not a clamp
- an out-of-scope instrument    -> still 404, not 403
```

Seed enough readings that sampling actually engages (e.g. 2,500 rows with one deliberate spike), and assert over HTTP with `app.inject`, never off a function's return value — that is the only thing that catches a missing `response` schema entry.

- [ ] **Step 7: Verify**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
npx vitest run apps/api/src/modules/instruments --pool=forks --poolOptions.forks.singleFork=true
npx vitest run apps/api/src/e2e/instrument-telemetry-range.test.ts --pool=forks --poolOptions.forks.singleFork=true
```

If an e2e 500s with `column ... does not exist`, the TEST database is behind — report it rather than guessing.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/instruments/telemetry.repository.ts apps/api/src/modules/instruments/routes.ts apps/api/src/modules/instruments/__tests__/telemetry-range.test.ts apps/api/src/e2e/instrument-telemetry-range.test.ts
git commit -m "fix(api): stop silently truncating wide telemetry ranges; sample and summarise instead"
```

---

### Task 3: Wire the trend page to sampled data and server summaries

**Files:**
- Modify: `apps/web/src/routes/instruments/use-trend-data.ts`
- Modify: `apps/web/src/routes/instruments/trend.tsx` (summary strip, ~line 352)
- Create: `apps/web/src/routes/instruments/sampled-note.tsx`
- Test: `apps/web/src/routes/instruments/__tests__/sampled-note.test.tsx`

**Interfaces:**
- Consumes: `historySampled`, `summaries` from Task 2.
- Produces: `<SampledNote shown={number} total={number} />`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/routes/instruments/__tests__/sampled-note.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SampledNote } from '../sampled-note';

describe('SampledNote', () => {
  it('says nothing when every reading is shown', () => {
    const { container } = render(<SampledNote shown={400} total={400} />);
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * A chart showing a subset must SAY SO where the reader is already looking —
   * not in a tooltip, not behind an icon. Otherwise the page quietly implies a
   * resolution it does not have.
   */
  it('states both numbers when it is showing a subset', () => {
    render(<SampledNote shown={2000} total={28431} />);
    expect(screen.getByText(/2,000/)).toBeInTheDocument();
    expect(screen.getByText(/28,431/)).toBeInTheDocument();
  });

  it('groups thousands so the numbers are readable at a glance', () => {
    render(<SampledNote shown={1000} total={86400} />);
    expect(screen.getByText(/86,400/)).toBeInTheDocument();
  });

  it('says nothing when there is no data at all', () => {
    const { container } = render(<SampledNote shown={0} total={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run apps/web/src/routes/instruments/__tests__/sampled-note.test.tsx --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `../sampled-note`.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/routes/instruments/sampled-note.tsx
/**
 * "Showing 2,000 of 28,431 readings."
 *
 * Rendered under a chart whose range held more readings than were plotted. Plain
 * text, in the flow, because a chart that is showing a subset must say so where the
 * reader is already looking — a tooltip or an icon lets the page imply a resolution
 * it does not have.
 *
 * Renders NOTHING when nothing was dropped, so a 1-hour view carries no noise.
 */
export function SampledNote({ shown, total }: { shown: number; total: number }) {
  if (total <= 0 || shown >= total) return null;
  const n = (v: number) => v.toLocaleString();
  return (
    <p className="mt-1 text-xs text-slate-500">
      Showing {n(shown)} of {n(total)} readings. Zoom in to see every reading for a shorter period.
    </p>
  );
}
```

- [ ] **Step 4: Request sampled data and use server summaries**

In `use-trend-data.ts`, the chart fetch (line ~167) currently sends `limit=${MAX_SERIES_POINTS}`. Change it to send `points=${MAX_SERIES_POINTS}` instead, and surface `historySampled` and `summaries` from the response. **Leave the table fetch (line ~173) exactly as it is** — the table is paged and raw by design.

In `trend.tsx` (~line 352), the summary strip currently calls `summariseSlot(rows, …)` over the FETCHED rows. Change it to read the server's `summaries[key]` where present, falling back to `summariseSlot` only when the server returned none. Keep the display formatting (per-instrument decimals, limit colouring) exactly as it is.

- [ ] **Step 5: Render the note under each chart**

Under each of the two `TimeSeriesChart` calls (`trend.tsx` ~675 and ~689), render `<SampledNote shown={<that key's plotted point count>} total={summaries[key]?.count ?? 0} />`.

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
npx vitest run apps/web/src --pool=forks --poolOptions.forks.singleFork=true
cd apps/web && npx vite build && cd ../..
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/instruments/
git commit -m "feat(web): trend charts state when they are showing a sampled subset"
```

---

### Task 4: Zoom, pan and fullscreen on the existing chart

**Files:**
- Modify: `apps/web/src/routes/dashboard/time-series-chart.tsx`
- Create: `apps/web/src/routes/dashboard/chart-zoom.ts`
- Test: `apps/web/src/routes/dashboard/__tests__/chart-zoom.test.ts`
- Modify: `apps/web/src/routes/instruments/trend.tsx` (handle the zoom callback)

**Interfaces:**
- Consumes: nothing.
- Produces: `pixelToTime(px: number, plotLeft: number, plotW: number, t0: number, t1: number): number`, `normalizeSelection(a: number, b: number, minSpanMs: number): { from: number; to: number } | null`; `TimeSeriesChart` gains optional props `onZoom?: (from: Date, to: Date) => void` and `onResetZoom?: () => void`.

**ZOOM REFETCHES, IT DOES NOT MAGNIFY.** The chart reports the selected span upward; the page sets a custom range and requests it fresh. Zooming into a downsampled 30-day view must reveal the TRUE raw readings for that narrower window — magnifying the existing subset would draw bigger dots and claim a resolution the client does not have.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/routes/dashboard/__tests__/chart-zoom.test.ts
import { describe, it, expect } from 'vitest';
import { pixelToTime, normalizeSelection } from '../chart-zoom.js';

describe('pixelToTime', () => {
  const t0 = 1_700_000_000_000;
  const t1 = t0 + 3_600_000;

  it('maps the plot edges to the range edges', () => {
    expect(pixelToTime(46, 46, 800, t0, t1)).toBe(t0);
    expect(pixelToTime(846, 46, 800, t0, t1)).toBe(t1);
  });

  it('maps the midpoint to the middle of the range', () => {
    expect(pixelToTime(446, 46, 800, t0, t1)).toBe(t0 + 1_800_000);
  });

  it('clamps outside the plot area rather than extrapolating', () => {
    expect(pixelToTime(0, 46, 800, t0, t1)).toBe(t0);
    expect(pixelToTime(2000, 46, 800, t0, t1)).toBe(t1);
  });
});

describe('normalizeSelection', () => {
  it('orders a right-to-left drag', () => {
    expect(normalizeSelection(900, 100, 1000)).toEqual({ from: 100, to: 900 });
  });

  /**
   * A click is a zero-width drag. Without this guard it would set an empty range,
   * the refetch would return nothing, and the chart would go blank on a stray click.
   */
  it('rejects a selection narrower than the minimum span', () => {
    expect(normalizeSelection(500, 500, 1000)).toBeNull();
    expect(normalizeSelection(500, 900, 1000)).toBeNull();
  });

  it('accepts a selection at exactly the minimum span', () => {
    expect(normalizeSelection(500, 1500, 1000)).toEqual({ from: 500, to: 1500 });
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run apps/web/src/routes/dashboard/__tests__/chart-zoom.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `../chart-zoom.js`.

- [ ] **Step 3: Write the pure helpers**

```ts
// apps/web/src/routes/dashboard/chart-zoom.ts
/**
 * Pure geometry for drag-to-zoom. Separated from the chart component because this
 * is the part that can be wrong in a way no build catches, and Playwright cannot
 * authenticate in this repo — a unit test is the only automated check the zoom
 * behaviour will ever get.
 */

/** Clamped, so a drag that leaves the plot area selects the edge rather than extrapolating. */
export function pixelToTime(px: number, plotLeft: number, plotW: number, t0: number, t1: number): number {
  const ratio = Math.min(1, Math.max(0, (px - plotLeft) / plotW));
  return Math.round(t0 + ratio * (t1 - t0));
}

/**
 * Orders a drag and refuses one too narrow to be intentional.
 *
 * A click is a zero-width drag; without the floor it would set an empty range, the
 * refetch would return nothing, and the chart would blank on a stray click.
 */
export function normalizeSelection(a: number, b: number, minSpanMs: number): { from: number; to: number } | null {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  if (to - from < minSpanMs) return null;
  return { from, to };
}
```

- [ ] **Step 4: Wire the chart**

In `time-series-chart.tsx`, add optional props `onZoom?: (from: Date, to: Date) => void` and `onResetZoom?: () => void`. On mouse down/move/up over the plot, track a selection, draw a translucent selection rectangle while dragging, and on release call `normalizeSelection` with a minimum span of **60_000 ms** and, if non-null, `onZoom(new Date(from), new Date(to))`. Render a small "Reset zoom" button when `onResetZoom` is provided, and a fullscreen toggle that puts the card into a fixed full-viewport CSS state (not a new route).

**The chart stays presentational.** It reports a selected span; it does not fetch, and it does not own the range. A chart that fetched would be a second place that knows how to build a telemetry URL.

- [ ] **Step 5: Handle it on the page**

In `trend.tsx`, pass `onZoom={(from, to) => setCustom(from.toISOString(), to.toISOString())}` — `setCustom(from: string, to: string)` is the EXISTING setter returned by `useTrendPeriod` (`use-trend-data.ts:74`), which writes the range into the URL search params. Reuse it rather than adding state: a zoom is then indistinguishable from a manually chosen custom range, it goes down the refetch path that already works, and the zoomed view is linkable and survives a refresh. Pass `onResetZoom` wired to the existing `setPreset(ms)` to restore the previously selected preset.

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
npx vitest run apps/web/src --pool=forks --poolOptions.forks.singleFork=true
cd apps/web && npx vite build && cd ../..
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/dashboard/ apps/web/src/routes/instruments/trend.tsx
git commit -m "feat(web): drag-to-zoom refetches the narrower range instead of magnifying"
```

---

### Task 5: States, titles and theme-ready colours

**Files:**
- Modify: `apps/web/src/routes/dashboard/time-series-chart.tsx` (empty state, CSS-variable colours)
- Modify: `apps/web/src/routes/instruments/trend.tsx` (titles, error state)
- Modify: `apps/web/src/app.css` (chart colour variables — this repo's global stylesheet; there is NO `index.css`)
- Test: `apps/web/src/routes/dashboard/__tests__/time-series-chart.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/routes/dashboard/__tests__/time-series-chart.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimeSeriesChart } from '../time-series-chart';

const empty = { id: 'temperature', label: 'Temperature', decimals: 1, points: [] };

describe('TimeSeriesChart empty state', () => {
  it('says "No data available" rather than drawing an empty grid', () => {
    render(<TimeSeriesChart series={[empty]} unit="°C" spanMs={3_600_000} title="Temperature Trend" />);
    expect(screen.getByText(/no data available/i)).toBeInTheDocument();
  });

  it('still shows the title, so the reader knows WHICH chart is empty', () => {
    render(<TimeSeriesChart series={[empty]} unit="°C" spanMs={3_600_000} title="Temperature Trend" />);
    expect(screen.getByText('Temperature Trend')).toBeInTheDocument();
  });

  it('draws normally when there are points', () => {
    const series = { ...empty, points: [{ ts: new Date().toISOString(), value: 21.5 }] };
    render(<TimeSeriesChart series={[series]} unit="°C" spanMs={3_600_000} title="Temperature Trend" />);
    expect(screen.queryByText(/no data available/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run apps/web/src/routes/dashboard/__tests__/time-series-chart.test.tsx --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL on the empty-state assertion.

- [ ] **Step 3: Implement**

- Empty state: when no series has points, render the title and a centred **"No data available"** in place of the plot.
- Error state on the page: when the trend fetch errors, render the message and a **Retry** button that calls SWR's `mutate`.
- Titles: `"Temperature"` → **`"Temperature Trend"`**, `"Humidity"` → **`"Humidity Trend"`**.
- Tooltip: confirm the hover readout includes the unit alongside the value and the exact timestamp; add the unit if absent.
- Colours: move the chart's hard-coded palette to CSS custom properties defined in `app.css` (e.g. `--chart-series-1`), read via `var(...)`. **Ship light only** — define the light values and no dark block. The indirection is what makes a dark theme possible later without touching chart code.

**Do not change `SERIES_COLORS`' ORDER or which slot each quantity uses.** Temperature is slot 1 and humidity slot 2 across the gauge, the chart and the printed report; a reorder silently makes the printed report disagree with the screen.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
npx vitest run apps/web/src --pool=forks --poolOptions.forks.singleFork=true
cd apps/web && npx vite build && cd ../..
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/dashboard/ apps/web/src/routes/instruments/trend.tsx apps/web/src/app.css
git commit -m "feat(web): trend chart empty/error states, trend titles, theme-ready colours"
```

---

### Task 6: Docs sync and the full verification sweep

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `apps/web/CLAUDE.md`, `packages/shared/CLAUDE.md`, `tasks/todo.md`, and whatever `docs/CONTRIBUTING.md`'s "Change → Docs map" requires.

- [ ] **Step 1: Read the change→docs map**

```bash
sed -n '/Change → Docs map/,/^##/p' docs/CONTRIBUTING.md
```

- [ ] **Step 2: Re-derive every count**

```bash
grep -cE "^model " apps/api/prisma/schema.prisma                          # expect 36, unchanged
grep -cE "^enum " apps/api/prisma/schema.prisma                           # expect 13, unchanged
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts      # expect 42, unchanged
grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts       # expect 48, unchanged
ls apps/api/src/modules/ | wc -l                                          # expect 24, unchanged
ls apps/web/src/routes/config/*.tsx | wc -l                               # expect 25, unchanged
grep -cE "<Route" apps/web/src/main.tsx                                   # expect 50, unchanged
```

**Write down what the commands print, not what this plan predicts.** This feature should move NO count — if one moved, something was added that this plan did not intend. Investigate before editing any doc.

- [ ] **Step 3: Sweep on the NOUNS, not the figures**

A figure-based regex under-reports badly in this repo: System Stats bolds the number between the figure and the noun (`**47** reauth actions`), which no `47 reauth` pattern matches. Sweep on nouns, then judge each hit — **history lines that record what a PAST change did are correct as written and must not be rewritten.**

- [ ] **Step 4: Document the behaviour, not just the counts**

In `CLAUDE.md`, beside the existing trend-page note, record:
- Wide ranges are **downsampled by selection (LTTB), never averaged** — every plotted point is a stored reading.
- Range summaries come from **SQL over the whole range**, not the plotted subset, so a sampled chart cannot understate an excursion.
- **The bug this fixed:** `GET /:id/telemetry` silently returned only the newest 1000 readings for any wider range, so 7d/30d charts plotted about a day while the axis claimed a week.
- Zoom **refetches**; it does not magnify.

- [ ] **Step 5: Full sweep, per package**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
npx vitest run apps/api/src   --pool=forks --poolOptions.forks.singleFork=true
npx vitest run apps/web/src   --pool=forks --poolOptions.forks.singleFork=true
npx vitest run packages/shared/src --pool=forks --poolOptions.forks.singleFork=true
cd packages/queue && npx vitest run && cd ../..
cd apps/web && npx vite build && cd ../..
```

**Never a combined multi-package invocation.** Known-failing baseline is ZERO; re-run a suspicious file alone before believing a failure, but do not dismiss it either.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md CLAUDE.md apps/web/CLAUDE.md packages/shared/CLAUDE.md tasks/todo.md docs/
git commit -m "docs: instrument trend page — sampling, true range summaries, zoom"
```

---

## Verification limits

**The rendering cannot be verified by the implementing agent.** Playwright cannot authenticate against the mkcert certificate in this repo — the SPA never leaves the login page. Zoom, pan, fullscreen, the tooltip and the empty state all need a human at the screen. Hand the operator `https://localhost:5176/instruments/<id>/trend` with a list of what to look at, and say plainly that it has not been seen.

## Self-review notes

**Spec coverage:** two separated widgets → already built, confirmed in "Already built"; downsampling → Tasks 1–2; true range summaries → Task 2; 12h preset and range controls → Task 1; "showing N of M" → Task 3; zoom/pan/fullscreen → Task 4; empty/error/loading, titles, tooltip units, theme-ready colours → Task 5; retained widgets → untouched by construction; docs → Task 6.

**Discovered while planning, and folded in:** the spec treats "summary must come from the whole range" as a design principle. It is also a LIVE BUG — the chart fetch asks for 5,000 rows and `getHistory` silently returns at most the newest 1,000, so today's 7-day and 30-day views plot roughly a day while the axis claims a week, and the summary strip is computed over that truncated slice. Task 2 fixes it and its e2e pins it.

**Deliberate ordering:** the shared package is Task 1 and must be BUILT before Task 2, because the API imports the built output rather than the source.
