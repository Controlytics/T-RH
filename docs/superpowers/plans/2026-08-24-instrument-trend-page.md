# Instrument Trend Page + Export Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every instrument a trend page — limit-lined charts, raw paged history, its alarms, latest-value cards — and put every report download behind a period + remarks + re-authentication gate.

**Architecture:** Almost nothing here is new machinery. `createReport()` already emits the required §11 PDF, `getHistory()` already pages and counts, `TimeSeriesChart` already draws an in-spec band from limits, and `POST /api/audit/report-export-log` already writes a fail-closed `REPORT_GENERATED` audit row. The work is: add `remarks` + `DOWNLOAD_REPORT` reauth to that existing endpoint, wrap it in one reusable dialog, expose `offset` on the telemetry route, add a distinct-keys endpoint, and build one new page out of existing components.

**Tech Stack:** Fastify + Prisma + Postgres (API), React + Vite + SWR + hand-rolled SVG (web), zod, jspdf (already present), vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-instrument-trend-and-reports-design.md`

**Scope note:** this plan covers **sub-projects 1 and 2** of that spec (the export gate, and the trend page). **Sub-project 3 (the Alarms page's period, search and download) gets its own plan** — it is independently shippable and depends only on the gate built here.

## Global Constraints

- **Windows box.** PowerShell has no `&&`; the Bash tool takes POSIX syntax. Do not start or stop the operator's dev servers.
- **No new dependencies.** This repo has deliberately removed every chart and canvas library it ever carried. Charts are built on the existing `TimeSeriesChart`. `jspdf` is already present and is the only PDF path.
- **Light theme only** (`bg-white`, `bg-slate-50`, `border-slate-200`, gradient dialog headers OK).
- **Never re-derive limits or decimals in the browser.** Both are resolved server-side (`modules/instruments/decimals.ts`, the limits resolver behind `limits` / `limitSource`) and ride on the payload. A second derivation is how a chart comes to contradict the alarm printed beside it.
- **Status is never colour alone** — every coloured indicator keeps a glyph or a word.
- **Export logging is fail-closed** and must stay that way: the log write is awaited BEFORE the file is saved, and a failure cancels the download.
- **Vitest does not typecheck here.** Run `npx tsc -p <project> --noEmit` explicitly.
- **Playwright cannot get past login on this machine.** No task may claim a page has been seen rendering. The visual check goes to the operator in Task 9.
- **Counts after this plan:** reauth actions **46 → 47**, reauth categories **8 → 9**, frontend routes **48 → 49**, export surfaces **1 → 3**. Unchanged: 34 models, 13 enums, 42 permissions, 23 API modules, 25 config defs, **93 audit actions**. If a step would move anything else, stop — the design has been misread.

---

### Task 1: `DOWNLOAD_REPORT` reauth action

**Files:**
- Modify: `packages/shared/src/types/reauth-actions.ts`
- Test: `packages/shared/src/types/permission-tree.test.ts` (existing — must still pass)

**Interfaces:**
- Produces: the reauth action key `DOWNLOAD_REPORT` and the category `Reports`.

- [ ] **Step 1: Add the action and its category**

In `packages/shared/src/types/reauth-actions.ts`, add to the `REAUTH_ACTIONS` object:

```ts
  DOWNLOAD_REPORT: { label: 'Download / Generate a Report', category: 'Reports' },
```

and add `'Reports'` to the `REAUTH_ACTION_CATEGORIES` array, with this comment above it:

```ts
  // Downloading a report is a §11 record-producing act: it asks for a reason and
  // a signature. The category must exist HERE or the policy renders nowhere —
  // config/action-reauth.tsx and roles-components/reauth-tab.tsx both build
  // their lists by iterating this array, so an action in a missing category can
  // never have its policy set.
  'Reports',
```

- [ ] **Step 2: Verify the count moved by exactly one and nothing else did**

```bash
grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts
```

Expected: **47** and **42**.

- [ ] **Step 3: Run the shared tests and typecheck**

```bash
npx vitest run packages/shared/src
npm run build -w @digilog/shared
```

Expected: PASS. `permission-tree.test.ts` asserts every node's `reauthAction` exists in `REAUTH_ACTIONS` — adding an action is safe in that direction, but run it rather than assume.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/reauth-actions.ts
git commit -m "feat(shared): DOWNLOAD_REPORT reauth action under a Reports category"
```

---

### Task 2: Gate the export log with remarks + reauth

**Files:**
- Modify: `apps/api/src/modules/audit/routes.ts:304-348` (`POST /report-export-log`)
- Modify: `apps/web/src/lib/report-export-log.ts`

**Interfaces:**
- Consumes: `DOWNLOAD_REPORT` from Task 1.
- Produces: `logReportExport(input)` gains required `remarks: string` and optional `password?: string`; the endpoint 400s without remarks and 401s (`REAUTH_REQUIRED`) when the role's policy demands re-authentication.

- [ ] **Step 1: Require remarks and re-authentication on the endpoint**

In `apps/api/src/modules/audit/routes.ts`, in the `/report-export-log` route: add `'remarks'` to the body's `required` array and this property:

```ts
          remarks: { type: 'string', minLength: 1, maxLength: 500, description: 'Why this report was generated. Required — a §11 record states its reason.' },
```

Add re-authentication as the first thing in the handler, before the audit write:

```ts
    // Configurable, not welded on: enforceReauth consults the per-role policy,
    // so an administrator can relax this for a role that downloads routinely
    // without the requirement disappearing from the registry.
    const { ok } = await enforceReauth('DOWNLOAD_REPORT', req, reply);
    if (!ok) return;
```

Carry the remarks into the audit row — replace the existing `reason` line with:

```ts
      reason: `Report generated: ${reportType} (${recordCount} record(s)) as ${format} — ${remarks}`,
```

and add `remarks` to `afterValue`. Destructure `remarks` alongside the other body fields.

Confirm `enforceReauth` is already imported in this file; if not, add `import { enforceReauth } from '../../lib/reauth-check.js';`.

- [ ] **Step 2: Send remarks and the password from the browser**

In `apps/web/src/lib/report-export-log.ts`, add `remarks: string;` (required) and `password?: string;` to `ReportExportLogInput`, and pass both through. The password rides the reauth path the rest of the app uses — post with `apiClient.postWithReauth('/api/audit/report-export-log', body, password)` when a password is supplied, and the plain `post` when it is not (the role's policy may not require one).

Update the doc comment to say the call now also carries the operator's reason and their signature.

- [ ] **Step 3: Typecheck both projects**

```bash
npx tsc -p apps/api/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
```

Expected: the web typecheck FAILS on `apps/web/src/routes/audit/index.tsx`, because its two `logExport` calls now lack the required `remarks`. That is the expected breakage — Task 3 fixes it. Do not paper over it with a default value: a defaulted reason is not a reason.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/audit/routes.ts apps/web/src/lib/report-export-log.ts
git commit -m "feat(audit): require remarks and re-authentication to generate a report"
```

---

### Task 3: The `ReportDownloadDialog`, and the Audit Trail moved onto it

**Files:**
- Create: `apps/web/src/components/report-download-dialog.tsx`
- Create: `apps/web/src/components/__tests__/report-download-dialog.test.tsx`
- Modify: `apps/web/src/routes/audit/index.tsx` (`exportPdf` ~line 329, `exportExcel` ~line 363, `logExport` ~line 319)
- Modify: `apps/web/src/lib/export-surfaces.ts`

**Interfaces:**
- Consumes: `logReportExport` from Task 2.
- Produces:

```tsx
export interface ReportPeriod { from: string; to: string; label: string }
export interface ReportDownloadRequest { period: ReportPeriod; remarks: string; password?: string }
export function ReportDownloadDialog(props: {
  open: boolean;
  reportName: string;
  /** Seeded from the period the page is currently showing. */
  initialPeriod: ReportPeriod;
  /** Hidden when the surface has no period (e.g. a full-list export). */
  showPeriod?: boolean;
  onCancel: () => void;
  onConfirm: (req: ReportDownloadRequest) => Promise<void>;
}): JSX.Element | null
```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/__tests__/report-download-dialog.test.tsx`. Model the render/act setup on the existing `apps/web/src/components/ui/__tests__/confirm-dialog.test.tsx` — read it first and follow its conventions rather than inventing a second style.

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReportDownloadDialog } from '../report-download-dialog';

const period = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z', label: 'Last 24 days' };

describe('ReportDownloadDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ReportDownloadDialog open={false} reportName="Audit Trail" initialPeriod={period}
        onCancel={() => {}} onConfirm={async () => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('refuses to confirm with empty remarks — a report must state its reason', async () => {
    const onConfirm = vi.fn();
    render(
      <ReportDownloadDialog open reportName="Audit Trail" initialPeriod={period}
        onCancel={() => {}} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(onConfirm).not.toHaveBeenCalled());
  });

  it('refuses whitespace-only remarks', async () => {
    const onConfirm = vi.fn();
    render(
      <ReportDownloadDialog open reportName="Audit Trail" initialPeriod={period}
        onCancel={() => {}} onConfirm={onConfirm} />,
    );
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(onConfirm).not.toHaveBeenCalled());
  });

  it('passes the trimmed remarks and the period through on confirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ReportDownloadDialog open reportName="Audit Trail" initialPeriod={period}
        onCancel={() => {}} onConfirm={onConfirm} />,
    );
    fireEvent.change(screen.getByLabelText(/remarks/i), { target: { value: '  monthly review  ' } });
    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ remarks: 'monthly review', period: expect.objectContaining({ from: period.from }) }),
    ));
  });

  it('hides the period fields when showPeriod is false', () => {
    render(
      <ReportDownloadDialog open reportName="Alarms" initialPeriod={period} showPeriod={false}
        onCancel={() => {}} onConfirm={async () => {}} />,
    );
    expect(screen.queryByLabelText(/from/i)).toBeNull();
  });

  it('calls onCancel without confirming', () => {
    const onCancel = vi.fn(); const onConfirm = vi.fn();
    render(
      <ReportDownloadDialog open reportName="Audit Trail" initialPeriod={period}
        onCancel={onCancel} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/web/src/components/__tests__/report-download-dialog.test.tsx`
Expected: FAIL — the module does not resolve.

- [ ] **Step 3: Build the dialog**

Create `apps/web/src/components/report-download-dialog.tsx`. Requirements, in order of what the operator sees:

1. A period section (from / to as `datetime-local` inputs plus the same preset choices the page offers), seeded from `initialPeriod`, hidden entirely when `showPeriod === false`.
2. A **required** remarks textarea, labelled "Remarks", with the requirement stated in the label — not only enforced on submit. Trim before validating and before passing on; block submit when empty after trimming and show why.
3. Confirm calls `onConfirm({ period, remarks, password })`. **The dialog does not itself call the reauth prompt** — the caller runs `reauth.execute('DOWNLOAD_REPORT', …)` around `onConfirm`, exactly as every other reauth-guarded action in this codebase does, so there is one reauth pattern and not two.
4. Disable the confirm button while `onConfirm` is in flight, and surface a thrown error in the dialog rather than closing it — a download that failed its audit write must not look like it succeeded.

Follow the existing dialog conventions (`components/ui/confirm-dialog.tsx`) for markup, focus handling and the gradient header.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/web/src/components/__tests__/report-download-dialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Move the Audit Trail export onto the dialog**

In `apps/web/src/routes/audit/index.tsx`:

- Add dialog state, and have `<ExportMenu>`'s `onExportPdf` / `onExportExcel` open the dialog with the pending format instead of exporting immediately.
- On confirm, run the existing export body inside `reauth.execute('DOWNLOAD_REPORT', async (password) => { … })`, passing `remarks` and `password` into `logExport`, and keeping the existing fail-closed order: **await the log write, then save the file**.
- `logExport(format, recordCount)` grows `remarks` and `password` parameters.

This is the breakage Task 2 Step 3 predicted; it is now fixed properly rather than defaulted.

- [ ] **Step 6: Register the two new export surfaces**

In `apps/web/src/lib/export-surfaces.ts`:

```ts
export const EXPORT_SURFACES: ExportSurface[] = [
  { key: 'audit', label: 'Audit Trail' },
  { key: 'instrument-trend', label: 'Instrument Trend' },
  { key: 'alarms', label: 'Alarms' },
];
```

The file's header comment says to keep this list in sync with the pages that render an `<ExportMenu>` — `instrument-trend` is rendered in Task 8, and `alarms` by the separate Alarms plan. Registering both here is deliberate: the config page must be able to set a role's policy before the surface ships, not after.

- [ ] **Step 7: Typecheck, build, and run the web suite**

```bash
npx tsc -p apps/web/tsconfig.json --noEmit
npx vitest run apps/web/src
cd apps/web; npx vite build
```

Expected: all pass, and the audit page's `logExport` type error from Task 2 is gone.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/report-download-dialog.tsx apps/web/src/components/__tests__/report-download-dialog.test.tsx apps/web/src/routes/audit/index.tsx apps/web/src/lib/export-surfaces.ts
git commit -m "feat(reports): governed download dialog, and move the audit export onto it"
```

---

### Task 4: API — paged history and the instrument's telemetry keys

**Files:**
- Modify: `apps/api/src/modules/instruments/routes.ts:633-700` (`GET /:id/telemetry`)
- Modify: `apps/api/src/modules/instruments/telemetry.repository.ts` (add `getDistinctKeys`)
- Test: `apps/api/src/modules/instruments/__tests__/` (add a test file if the module has none for the repository; otherwise extend)

**Interfaces:**
- Produces:
  - `GET /api/instruments/:id/telemetry?from=&to=&limit=&offset=&key=` — `offset` newly accepted; response unchanged (`{ latest, history, historyTotal }`).
  - `GET /api/instruments/:id/telemetry-keys` → `{ data: { key: string; slot: 'temperature' | 'humidity' | null; lastSeen: string }[] }`
  - `export async function getDistinctKeys(instrumentId: string): Promise<{ key: string; lastSeen: Date }[]>`

- [ ] **Step 1: Expose `offset` on the telemetry route**

`getHistory` already accepts `offset` and already returns `total` — only the route omits it. Add to the route's `querystring.properties`:

```ts
          offset: { type: 'integer', default: 0, minimum: 0 },
```

read it in the handler (`const offset = Math.max(Number(q.offset ?? 0), 0);`) and pass `offset` into the `getHistory` call. Leave the existing `limit` clamp alone.

- [ ] **Step 2: Add `getDistinctKeys` to the repository**

```ts
/**
 * The keys this instrument has ACTUALLY sent, newest activity first.
 *
 * The trend page's "add a key" picker offers these and nothing else: ingest
 * stores whatever key a device sends, so a free-text field would invite a key
 * that has never existed and a widget that can never draw.
 */
export async function getDistinctKeys(instrumentId: string): Promise<{ key: string; lastSeen: Date }[]> {
  return prisma.$queryRaw<{ key: string; lastSeen: Date }[]>`
    SELECT key, max(ts) AS "lastSeen"
    FROM instrument_telemetry_history
    WHERE instrument_id = ${instrumentId}
    GROUP BY key
    ORDER BY max(ts) DESC`;
}
```

- [ ] **Step 3: Add the route**

Add `GET /:id/telemetry-keys` next to the telemetry route, gated on `INSTRUMENT_READ` like its neighbour, 404ing on an unknown instrument the same way. Annotate each key with its slot using the SAME alias resolution the telemetry route uses — read the `annotate` helper in that handler and reuse `loadAliases()` rather than re-deriving the mapping, so the picker and the charts agree about which key is "temperature".

**Instrument visibility applies.** Check how the existing `GET /:id/telemetry` handles an instrument the caller may not see and do exactly the same — this route must not become a way to confirm the existence of an instrument outside the caller's scope.

- [ ] **Step 4: Test the repository function**

Write a test asserting `getDistinctKeys` returns one row per key with the newest `ts`, ordered by recency. If this module has no existing DB-backed test harness, say so in the report and instead assert what is reachable — do not invent a mock that asserts nothing.

- [ ] **Step 5: Typecheck and test**

```bash
npx tsc -p apps/api/tsconfig.json --noEmit
npx vitest run apps/api/src/modules/instruments
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/instruments/routes.ts apps/api/src/modules/instruments/telemetry.repository.ts apps/api/src/modules/instruments/__tests__
git commit -m "feat(instruments): paged telemetry history and a distinct-keys endpoint"
```

---

### Task 5: The trend page shell — route, period header, latest-value cards

**Files:**
- Create: `apps/web/src/routes/instruments/trend.tsx`
- Create: `apps/web/src/routes/instruments/use-trend-data.ts`
- Modify: `apps/web/src/main.tsx` (add one `<Route>`)

**Interfaces:**
- Consumes: Task 4's endpoints.
- Produces:

```ts
export interface TrendPeriod { from: string; to: string; label: string; intervalMs: number | null }
export const TREND_PRESETS: { label: string; ms: number }[]
export function useTrendPeriod(): { period: TrendPeriod; setPreset: (ms: number) => void; setCustom: (from: string, to: string) => void; setInterval: (ms: number | null) => void }
export function useInstrumentTrend(id: string, period: TrendPeriod, page: number, extraKeys: string[]): { … }
```

- [ ] **Step 1: Add the route**

In `apps/web/src/main.tsx`, beside the existing instrument routes:

```tsx
<Route path="/instruments/:id/trend" element={<InstrumentTrend />} />
```

Follow the file's existing lazy-import and layout-wrapping convention exactly — read the neighbouring instrument routes first.

Verify: `grep -cE "<Route" apps/web/src/main.tsx` → **49**.

- [ ] **Step 2: Build the period header**

Presets (15m, 1h, 6h, 24h, 7d, 30d) plus custom from/to, and an interval selector (Raw, 1m, 5m, 15m, 1h). State lives in the URL query string, not only in React state, so a trend view can be linked to and reloaded — an operator sending a colleague "look at this excursion" must be able to send the window with it.

**The interval applies to the charts only.** Label it so on screen ("Chart interval"), because a control that silently does nothing to the table below it reads as broken.

- [ ] **Step 3: Build the two latest-value cards**

Temperature and humidity: the latest value at that instrument's own decimals, its age, and the limits it is judged against with their source ("from this instrument" / "from room CWH-I/142"). Use the same `statusClasses`/`readingAge` helpers the dashboard uses (`routes/dashboard/status.ts`) — do not write a second set of status words.

- [ ] **Step 4: Typecheck and build**

```bash
npx tsc -p apps/web/tsconfig.json --noEmit
cd apps/web; npx vite build
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/instruments/trend.tsx apps/web/src/routes/instruments/use-trend-data.ts apps/web/src/main.tsx
git commit -m "feat(instruments): trend page shell with period header and latest-value cards"
```

---

### Task 6: Trend charts and the raw paged time-series

**Files:**
- Modify: `apps/web/src/routes/instruments/trend.tsx`
- Create: `apps/web/src/routes/instruments/trend-series.ts`
- Test: `apps/web/src/routes/instruments/__tests__/trend-series.test.ts`

**Interfaces:**
- Produces: `export function toChartSeries(rows, key, decimals, label): ChartSeries` and `export function toTableRows(rows, keys): { ts: string; values: Record<string, number | null> }[]` — pure, testable, no React.

- [ ] **Step 1: Write the failing tests for the pure transforms**

The telemetry endpoint returns readings in LONG format (one row per key per timestamp). Both the charts and the table need them pivoted. That pivot is where this breaks, so it is tested:

```ts
import { describe, it, expect } from 'vitest';
import { toChartSeries, toTableRows } from '../trend-series';

const rows = [
  { key: 'temp', value: 21.5, ts: '2026-08-24T10:00:00.000Z' },
  { key: 'rh',   value: 45,   ts: '2026-08-24T10:00:00.000Z' },
  { key: 'temp', value: 21.7, ts: '2026-08-24T10:00:10.000Z' },
];

describe('toChartSeries', () => {
  it('keeps only the requested key', () => {
    expect(toChartSeries(rows, 'temp', 1, 'Temperature').points).toHaveLength(2);
  });
  it('orders points oldest first, whatever order they arrived in', () => {
    const s = toChartSeries([...rows].reverse(), 'temp', 1, 'Temperature');
    expect(s.points[0].ts < s.points[1].ts).toBe(true);
  });
  it('carries the per-instrument decimals onto the series', () => {
    expect(toChartSeries(rows, 'temp', 2, 'Temperature').decimals).toBe(2);
  });
  it('returns an empty series rather than throwing when the key never appears', () => {
    expect(toChartSeries(rows, 'co2', 1, 'CO2').points).toEqual([]);
  });
});

describe('toTableRows', () => {
  it('pivots one row per timestamp with a column per key', () => {
    const out = toTableRows(rows, ['temp', 'rh']);
    expect(out).toHaveLength(2);
    expect(out[0].values).toEqual({ temp: 21.5, rh: 45 });
  });
  it('leaves a key null at a timestamp that did not carry it — never carries the previous value forward', () => {
    const out = toTableRows(rows, ['temp', 'rh']);
    const second = out.find((r) => r.ts.endsWith('10.000Z'))!;
    expect(second.values.rh).toBeNull();
  });
  it('orders newest first, as a history list reads', () => {
    const out = toTableRows(rows, ['temp']);
    expect(out[0].ts > out[1].ts).toBe(true);
  });
});
```

The "never carries the previous value forward" test is the important one: a pivot that fills gaps invents readings that were never received, which is exactly what a §11 history must not do.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/web/src/routes/instruments/__tests__/trend-series.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the transforms, then the widgets**

Write `trend-series.ts` to satisfy the tests. Then in `trend.tsx`:

- **Trend widgets** — one `<TimeSeriesChart>` per slot, passing `series={[toChartSeries(...)]}`, `unit` (`°C` / `%RH`), and the instrument's resolved `limits.tempMin`/`tempMax` (or `rhMin`/`rhMax`) as `min`/`max`, which is what makes the component draw the in-spec band. `spanMs` is the period's span. **Do not compute limits in the browser** — take them from the payload.
- **Time-series widget** — a table of `toTableRows(...)`, newest first, paged via Task 4's `offset`, showing the true total from `historyTotal`. Every value at its own key's decimals. Raw only: no averaging, no gap filling.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/web/src/routes/instruments`
Expected: PASS.

- [ ] **Step 5: Typecheck and build**

```bash
npx tsc -p apps/web/tsconfig.json --noEmit
cd apps/web; npx vite build
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/instruments/trend.tsx apps/web/src/routes/instruments/trend-series.ts apps/web/src/routes/instruments/__tests__/trend-series.test.ts
git commit -m "feat(instruments): limit-lined trend charts and a raw paged time-series"
```

---

### Task 7: Alarms widget and the additional-keys picker

**Files:**
- Modify: `apps/web/src/routes/instruments/trend.tsx`
- Create: `apps/web/src/routes/instruments/use-extra-keys.ts`
- Test: `apps/web/src/routes/instruments/__tests__/use-extra-keys.test.ts`

**Interfaces:**
- Produces: `export function useExtraKeys(instrumentId: string): { keys: string[]; add: (k: string) => void; remove: (k: string) => void }`

- [ ] **Step 1: Write the failing tests for key persistence**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readExtraKeys, writeExtraKeys } from '../use-extra-keys';

beforeEach(() => localStorage.clear());

describe('extra key persistence', () => {
  it('returns an empty list when nothing is stored', () => {
    expect(readExtraKeys('abc')).toEqual([]);
  });
  it('round-trips keys per instrument', () => {
    writeExtraKeys('abc', ['co2']);
    expect(readExtraKeys('abc')).toEqual(['co2']);
    expect(readExtraKeys('def')).toEqual([]);
  });
  it('returns an empty list rather than throwing on malformed stored JSON', () => {
    localStorage.setItem('digilog.trendKeys.abc', '{not json');
    expect(readExtraKeys('abc')).toEqual([]);
  });
  it('returns an empty list when localStorage itself throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readExtraKeys('abc')).toEqual([]);
    spy.mockRestore();
  });
});
```

The last two matter: a private window or a browser with site data blocked throws on access, and an unguarded read would take the whole page down with it.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/web/src/routes/instruments/__tests__/use-extra-keys.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement, then wire both widgets**

- `use-extra-keys.ts`: `readExtraKeys` / `writeExtraKeys` keyed `digilog.trendKeys.<instrumentId>`, every read and write wrapped in try/catch returning `[]` on any failure, plus the `useExtraKeys` hook over them.
- **The picker** offers only what `GET /api/instruments/:id/telemetry-keys` returns, with the two administered slots already shown and not offerable twice. Adding a key adds a chart and a table column.
- **The alarms widget** lists that instrument's alarms for the period from `GET /api/alarms?instrumentId=…`, rendered through `routes/alarms/alarm-display.ts` (`severityTone`, `triggeredText`, `statusText`, `alarmTypeText`, `limitText`, `clearedText`, `instrumentLabel`). Import those helpers — do not restate the wording. A second vocabulary for one alarm is how two screens come to describe the same event differently.

Note in the code that the alarms endpoint has no date filter yet (it is added in the Alarms plan), so the period is applied client-side here for now, and say so in the report.

- [ ] **Step 4: Run the tests, typecheck, build**

```bash
npx vitest run apps/web/src/routes/instruments
npx tsc -p apps/web/tsconfig.json --noEmit
cd apps/web; npx vite build
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/instruments
git commit -m "feat(instruments): alarms widget and per-user additional trend keys"
```

---

### Task 8: Widget downloads, and point the Trend icon at the page

**Files:**
- Modify: `apps/web/src/routes/instruments/trend.tsx`
- Create: `apps/web/src/routes/instruments/trend-report.ts`
- Modify: `apps/web/src/routes/dashboard/telemetry-table.tsx:305-326`

**Interfaces:**
- Consumes: `ReportDownloadDialog` (Task 3), `createReport` (`lib/pdf-report.ts`), `logReportExport` (Task 2).

- [ ] **Step 1: Build the three report renderers**

`trend-report.ts` exports one function per widget — `renderTimeSeriesReport`, `renderAlarmsReport`, `renderTrendReport` — each taking its rows plus the instrument and period, and each:

1. calling `createReport({ title, subtitle, reportKey, formatDateTime })` — which supplies company name, logo, Printed By + user ID, printed date/time and the signature block automatically;
2. adding an instrument-details block via `addKeyValue([...])` (code, name, location, the limits in force and their source);
3. adding the data via `addTable({ head, body })`;
4. returning the `ReportDoc` for the caller to `save()`.

**Row cap:** a period holding tens of thousands of readings cannot be a complete PDF. Cap the body, and when capped, state on the page — in the report itself, not only in a toast — how many rows of how many the report contains and what period it actually covers. A truncated report that looks complete is worse than one that refuses.

- [ ] **Step 2: Wire each widget's download through the gate**

Each of the three widgets gets an `<ExportMenu surface="instrument-trend" …>`, which opens `<ReportDownloadDialog>` seeded with the page's current period. On confirm, inside `reauth.execute('DOWNLOAD_REPORT', …)`:

1. fetch the rows for the **dialog's** period (not necessarily the page's — the operator may have changed it);
2. `await logReportExport({ reportType, format: 'PDF', recordCount, remarks, password, startDate, endDate })`;
3. only then `report.save(filename)`.

That order is the fail-closed rule: if the audit write fails, no file is produced.

- [ ] **Step 3: Point the Trend icon at the trend page and always show it**

In `apps/web/src/routes/dashboard/telemetry-table.tsx`, change the trend `<Link>`'s `to` to `/instruments/${r.instrumentId}/trend`, and **remove the `r.room &&` guard**. An instrument's history does not depend on whether anyone has drawn it on a floorplan; the guard meant an unplaced instrument had no trend link at all. Keep the instrument-code link pointing at `/instruments/:id`.

- [ ] **Step 4: Typecheck, test, build**

```bash
npx tsc -p apps/web/tsconfig.json --noEmit
npx vitest run apps/web/src
cd apps/web; npx vite build
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/instruments apps/web/src/routes/dashboard/telemetry-table.tsx
git commit -m "feat(instruments): governed downloads on the trend widgets; trend icon always shown"
```

---

### Task 9: Verification sweep and documentation

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `docs/recreation/`, `tasks/todo.md`

- [ ] **Step 1: Run everything and record the real output**

```bash
npx tsc -p apps/api/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
npm run build -w @digilog/shared
npx vitest run apps/api/src apps/web/src packages/shared/src
cd apps/web; npx vite build
```

All must pass. Fix causes; never loosen a test to get green.

- [ ] **Step 2: Re-derive every count this plan claims**

```bash
grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts   # expect 47
grep -cE "<Route" apps/web/src/main.tsx                                # expect 49
grep -cE "^model " apps/api/prisma/schema.prisma                       # expect 34
grep -cE "^enum " apps/api/prisma/schema.prisma                        # expect 13
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts   # expect 42
```

Any other movement means the design was misread — stop and say so rather than editing docs to match.

- [ ] **Step 3: Hand the visual check to the operator**

Post, in substance:

> The trend page and the governed download are in. I have NOT seen either render — Playwright cannot get past login against the mkcert cert on this machine. Please check: (1) the Trend icon in the Tabular view now opens the trend page, and appears even for instruments not placed on a floorplan; (2) both charts show the limit band and it matches the instrument's limits; (3) changing the period updates every widget together; (4) the time-series table pages, shows the true total, and gaps stay blank rather than repeating the previous value; (5) a download asks for period, remarks and password, and refuses to produce a file if you leave remarks blank; (6) the PDF carries the company name, logo, instrument details, and Printed By with your user ID and the date/time; (7) the Audit Trail export still works and now also asks for remarks. Watch the browser console for errors.

Wait for the answer before marking the plan complete.

- [ ] **Step 4: Update the docs**

- `CHANGELOG.md`: the trend page, the download gate, the reauth action, and the fact that the Audit Trail export is now governed too.
- `CLAUDE.md`: reauth actions 46 → 47, routes 48 → 49, the new endpoints; state explicitly that audit actions stay at 93 because `REPORT_GENERATED` is reused.
- `docs/recreation/`: the new page and endpoints.
- `tasks/todo.md`: an audit-log entry.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md CLAUDE.md docs/recreation tasks/todo.md
git commit -m "docs: record the instrument trend page and governed report downloads"
```

---

## Deferred (NOT in this plan)

- **Sub-project 3 — the Alarms page** (period selector, server-side search, download). Its own plan; depends only on the gate built in Tasks 1–3. Until it lands, the trend page's alarms widget filters the period client-side (Task 7).
- **Server-side PDF rendering.** The operator accepted browser-generated PDFs on 2026-08-24; the gate records intent rather than preventing access to data already on screen.
- **Excel from the trend widgets.** PDF only for now; the surface is registered so Excel can be enabled per role later without a code change.
