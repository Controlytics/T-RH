# Instrument trend page — visual design

**Date:** 2026-08-24
**Surface:** `apps/web/src/routes/instruments/trend.tsx` and its components.

## The subject, and the page's one job

A single environmental sensor in a pharma cleanroom. The reader is a QA operator
or plant engineer, either glancing to confirm nothing is wrong or investigating
an excursion after the fact. The page answers one question:

> **What has this sensor been doing, and did it ever leave its limits?**

Everything on the page is judged against that sentence.

## Why the current page reads as basic

It is a vertical stack of white cards — filter card, two value cards, two
charts, a table, an alarms list — which is the default shape of every admin
screen. Nothing on it is specific to instrument monitoring: the same layout
would serve a list of invoices. The current reading is presented as a bare
number, which is precisely the thing a number cannot answer well: **how close to
the limit is it?**

## The thesis

In GMP monitoring, nothing is "a value". Everything is *a value inside a band*.
The band is the subject's central object — it is what the limits define, what an
alarm is a departure from, and what the whole record exists to evidence.

So the page leads with the band, not the number.

## Signature element — the band gauge

The one element this page is remembered by. For each slot, a horizontal track
representing the limit band, with the current reading marked in position:

```
 TEMPERATURE                                   in limit
 22.4 °C
 18.0 ├──────────────●─────────────────┤ 27.0
      └ 4.4 above low          4.6 below high ┘
```

- The track spans low limit → high limit, drawn as the in-limit region.
- A marker sits at the reading's position within it.
- Both **headroom figures** are stated — how far the reading is from each bound.
  That is the thing an operator actually wants and a bare number withholds.
- A reading **outside** the band puts the marker hard against the breached end,
  outside the track, in the breach red — the geometry itself shows the breach.
- **No limits set** collapses the gauge to the number with "no limits set — not
  assessed". An absent band is stated, never implied by an empty track.

This is not a progress bar. A progress bar means "how much of a whole"; this
means "where inside an allowed range", which is a different question and is the
only question this page's subject cares about.

## Tokens

### Colour

Series identity reuses the app's already-validated categorical palette so the
trend page and the dashboard never disagree about which colour means
temperature (`routes/dashboard/time-series-chart.tsx` `SERIES_COLORS`).

| Role | Value | Note |
|---|---|---|
| Temperature | `#2a78d6` | palette slot 1, unchanged |
| Humidity | `#eb6834` | palette slot 2, unchanged |
| In limit | `#15803D` | semantic, fixed |
| Out of limit | `#DC2626` | semantic, fixed |
| Stale / partial | `#D97706` | semantic, fixed |
| No data | `#64748B` | semantic, fixed |
| Page ground | `#F7F8FA` | cooler than the default slate-50 so white cards lift off it |
| Ink | `#0F172A` | |
| Muted ink | `#64748B` | |
| Hairline | `#E2E8F0` | |

**Status colour is never re-tinted and never carries meaning alone** — every
status keeps its word beside it. Series colour identifies a slot; status colour
judges a reading. The two never occupy the same element.

### Type

The page's character comes from the instrument vernacular: a nameplate and a
panel readout.

- **Readings and timestamps:** mono, tabular figures, at a large size for the
  current value (~2.5rem). Numbers that change in place must not reflow, which
  tabular figures guarantee and proportional figures do not.
- **Field labels:** sans, uppercase, `0.09em` tracking, 11px, muted. This is the
  instrument-panel label idiom and it appears ONLY on labels — the tracking is
  what makes it read as a panel rather than as a web form.
- **Instrument code:** mono, bold — it is an identifier, not prose.
- **Everything else:** the app's existing sans at its existing sizes.

### Header

A gradient identity strip using the app's existing convention
(`var(--theme-sidebar-bg)` → `var(--theme-primary-dark)`), the same device the
graphical view's plan header uses. It carries the instrument code, its location
and area, and its live status. This is not a dark theme — it is the one accent
band the house style already sanctions, and it anchors a page that otherwise
floats.

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│ ▓ CWH/RDU/001-00   IT Server Room · Stability · CWH Block  ▓ │  gradient strip
│ ▓ live · updated 12s ago                        [download] ▓ │
├──────────────────────────────────────────────────────────────┤
│ [15m][1h][6h][24h][7d][30d]   from ▢  to ▢   interval ▢      │  one quiet row
├───────────────────────────────┬──────────────────────────────┤
│ TEMPERATURE          in limit │ HUMIDITY            in limit │
│ 22.4 °C                       │ 45.3 %RH                     │
│ 18.0 ├────────●─────────┤ 27.0│ 0 ├─────●──────────┤ 60      │  ← band gauge
│      4.4 above · 4.6 below    │    45.3 above · 14.7 below   │
├───────────────────────────────┴──────────────────────────────┤
│ TEMPERATURE — last 24 hours                    [download]    │
│ ▁▂▄▆█▇▅▃▂▁ chart, in-limit band shaded                       │
├──────────────────────────────────────────────────────────────┤
│ HUMIDITY — last 24 hours                       [download]    │
├───────────────────────────────┬──────────────────────────────┤
│ READINGS (raw)                │ ALARMS IN THIS PERIOD        │
│ paged table                   │ list                         │
└───────────────────────────────┴──────────────────────────────┘
```

Charts go **full width**, one above the other, rather than side by side in a
half-width grid. A trend is read along the time axis; halving that axis to fit
two charts on a row costs the page the very thing it is for.

The readings table and the alarms list sit side by side because they are both
"what happened", read together during an investigation.

## Motion

One page-load moment only: the band gauge markers animate from the low bound to
their position over ~450ms, staggered by 80ms between the two slots. It shows
the band being traversed, which is the page's whole idea, and it happens once.

Everything else is static. Wrapped in `prefers-reduced-motion: reduce`, which
drops the markers straight to position.

## Deliberately not doing

- **No dark mode.** Out of scope, unchanged.
- **No new dependency.** Charts stay the existing hand-rolled SVG component.
- **No sparkline in the band gauge.** The chart below already carries the shape;
  a second miniature of it beside the number is decoration.
- **No animated value counters.** A reading that spins up from zero is a number
  that was never measured, on a page whose job is to evidence measurements.
