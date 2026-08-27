# Instrument Trend page — separated Temperature and Humidity trends

**Date:** 2026-08-27
**Branch:** `data-injection`
**Surface:** `apps/web/src/routes/instruments/trend.tsx` and its siblings,
`apps/api/src/modules/instruments/routes.ts` (`GET /:id/telemetry`),
`apps/api/src/modules/instruments/telemetry.repository.ts`, and a new pure module
in `packages/shared`.

## The problem

The Trend page charts temperature and humidity together and, when a chart interval
is selected, averages them client-side. The operator wants the opposite emphasis:
**two separate widgets, and the actual telemetry history — every received reading at
its own timestamp — not a computed summary of it.**

Different units and scales (°C, %RH) also mean one chart with two series always
misleads about one of them.

## The central tension, stated plainly

**"Plot every reading" and "Last 30 days" cannot both hold at this data rate.**

Measured on this installation, telemetry lands every **30–90 seconds** per key. So a
30-day window is **28,000–86,000 readings per chart**. Against that:

- `telemetry.repository.ts:getHistory` hard-caps at **1000 rows**
  (`Math.min(opts.limit ?? 100, 1000)`).
- A 1600px-wide chart has 1600 columns to draw into — at 86,000 points, **54
  readings land on every pixel**, so they cannot be distinguished by eye even if
  they were all sent.
- The payload would be tens of MB of JSON and tens of thousands of SVG nodes.

This design resolves the tension without averaging, and without pretending.

## The thesis

**Downsample by SELECTING real readings, never by computing new ones. And when a
chart is showing a subset, say so on screen.**

Every point plotted is a stored reading with its stored timestamp. Nothing is
invented. What varies is *how many* of the stored readings are drawn, and the chart
states that number.

## Why not the alternatives

- **Averaging into buckets** invents values that were never read. A two-second
  excursion disappears entirely — and on a 21 CFR Part 11 system the excursion is
  the thing the record exists to show. The page already had this behaviour behind
  the interval control and it is being demoted to an explicit opt-in, not extended.
- **Raising the 1000 cap and sending everything** is what was literally asked for.
  It stalls or crashes the tab at 30 days, and buys nothing visible, because the
  points are already sub-pixel.
- **Dropping the wide presets** would keep every chart raw and honest, but loses
  long-horizon analysis, which is the reason to have a 30-day button at all.

## 1. Backend — `points` and true aggregates

`GET /api/instruments/:id/telemetry` gains two query parameters:

| Param | Type | Meaning |
|---|---|---|
| `points` | integer, 1..5000 | Target number of points per key. Omitted = current behaviour. |
| `key` | string (already exists) | Unchanged. |

Response gains, per key:

| Field | Meaning |
|---|---|
| `sampled` | `true` when the range held more readings than `points` |
| `total` | How many readings the range actually holds |
| `summary` | `{ count, min, max, avg, first, last }` over **every** reading in range |

**`summary` is computed in SQL over the whole range, never over the returned
subset.** This is the requirement that is easiest to get wrong and worst to get
wrong: if `max` were derived from a downsampled subset, a 34 °C spike that the
sampler did not select would silently vanish from the "Maximum" readout. The
summary would then *understate an excursion* on a regulated record. The aggregate
query is separate from the row query for exactly this reason.

`MAX_SERIES_POINTS` (5000, already in `@digilog/shared`) is the ceiling on `points`.
The existing 1000-row cap in `getHistory` stays for the raw/table path; the charting
path takes its own bounded route.

## 2. Shared — the sampler

New pure module `packages/shared/src/types/telemetry-downsample.ts`:

```ts
export function lttb<T extends { ts: string | Date; value: number }>(
  points: T[], target: number,
): T[]
```

**Largest-Triangle-Three-Buckets.** It divides the series into `target` buckets and
picks, from each, the reading forming the largest triangle with its neighbours —
which is what preserves peaks, troughs and the visual shape a mean destroys.

Invariants, each a test:

- **Returns the input unchanged when `points.length <= target`.** No sampling
  happens on narrow windows; a 1-hour view is always every reading.
- **Always keeps the FIRST and LAST reading.** The range's own endpoints must be
  real, or the chart's x-extent disagrees with the range the operator selected.
- **Never invents a point.** Every returned element is reference-equal to an input
  element — asserted with `toBe`, not `toEqual`, so a "helpful" future refactor
  that builds new objects fails the test.
- **Preserves order** and is stable for `target < 3` (degenerates to first+last).

Also add the missing preset:

```ts
{ value: '12h', label: 'Last 12 hours', ms: 12 * 3_600_000 },
```

The operator asked for 1h / 6h / 12h / 24h / 7d / 30d / Custom. `15m` already
exists and stays — removing a preset someone may be using is not part of this.

## 3. Frontend — two widgets

Layout, top to bottom:

1. **Instrument header** — name, code, current temperature, current humidity,
   status, last-updated timestamp. The existing `BandGauge` components fold in here
   as the current-value display: a bare number cannot answer "how close to the limit
   is it?", which is why they were built.
2. **Time-range control** — the presets plus Custom, plus an **Aggregation** control
   defaulting to **off**.
3. **Temperature Trend** — full width. Y axis °C, per-instrument decimals.
4. **Humidity Trend** — full width. Y axis %RH.
5. Alarms widget, raw paged table, extra-keys picker — all retained below.

**The two charts are never combined.** Different units, different scales; a shared
y-axis misrepresents whichever series it does not fit.

Each chart carries:

- Its own summary strip — **Current / Minimum / Maximum / Average** — read from the
  server's `summary`, over the selected range.
- When `sampled`, one line of plain text: **"Showing 2,000 of 28,431 readings."**
  Not a tooltip and not an icon. A chart that is showing a subset must say so where
  the reader is already looking.
- Loading skeleton, error state with retry, and **"No data available"** when the
  range holds nothing.

### Interaction

**Zoom REFETCHES; it does not magnify.** Drag-selecting a span sets a custom range
and requests it fresh. Zooming into a downsampled 30-day view therefore reveals the
*true raw readings* for that narrower window. Magnifying the existing subset would
draw bigger dots and claim a resolution the client does not have.

Pan, a reset-to-range control, and a fullscreen toggle (a CSS state on the card, not
a new route) come with it. Built by extending the app's own
`routes/dashboard/time-series-chart.tsx`, which already has a nearest-point hover
readout — no charting dependency is added. This repo removed `chartjs-node-canvas`,
`reactflow` and `@monaco-editor/react`; that decision stands.

Tooltip shows the exact timestamp, the value, and the unit (`°C` / `%RH`).

## 4. Theme

Chart colours move from hard-coded hex to CSS variables, so a dark theme is possible
later without touching chart code. **The page ships light only**, matching
`CLAUDE.md`'s app-wide rule. A single dark page in a light product reads as a bug;
the indirection costs nothing and commits to nothing.

Series identity is unchanged and stays fixed: temperature is palette slot 1,
humidity slot 2, across the gauge, the chart and the printed report.

## 5. What this is not

- **Not an averaging feature.** Aggregation exists, defaults off, and is labelled as
  what it is when on.
- **Not a chart library adoption.**
- **Not a dark mode.**
- **Not a rewrite.** The alarms widget, raw table, extra keys, report export and
  band gauges all survive; the page is restructured around the two charts.

## Testing

Unit, in `@digilog/shared`:

- `lttb` — the four invariants above, plus a spike-preservation case: a series with
  one sharp excursion, downsampled hard, must still contain that reading.

Unit, web:

- Summary strip renders the server's aggregates, not the plotted subset — the
  regression that would understate an excursion.
- Empty / loading / error states.

E2E, api:

- `points` omitted → current behaviour, unchanged.
- `points` ≥ total → `sampled: false` and every row returned.
- `points` < total → exactly `points` rows, `sampled: true`, `total` correct, and
  **`summary.max` equal to the true maximum in the range even when that reading is
  not among the returned rows.** That single assertion is the point of the design.
- `points` above `MAX_SERIES_POINTS` → 400 from the schema, not a silent clamp.

## Verification limits

**The rendering cannot be verified by the implementing agent.** Playwright cannot
authenticate against the mkcert certificate in this repo, so the SPA never leaves
the login page. Zoom, pan and fullscreen are interaction behaviours that need a
human at the screen; that check belongs to the operator and must be stated plainly
rather than implied by a green build.

## Count changes

| | before | after |
|---|---|---|
| Prisma models / enums | 36 / 13 | unchanged |
| Permissions / reauth actions | 42 / 48 | unchanged |
| API modules | 24 | unchanged |
| Config defs / pages | 25 / 25 | unchanged |
| Frontend routes | 50 | unchanged |

No migration. One route gains query parameters; one new shared module; one preset
added to an existing list.
