# Instrument trend page and governed report downloads — design

**Date:** 2026-08-24
**Status:** approved, not yet implemented
**Surfaces:** Dashboard → Tabular view (Trend column), a new instrument trend
page, and the Alarms page.

## 1. Problem

The Tabular view's Trend column links to the instrument detail page, which is a
configuration screen. There is nowhere to look at an instrument's history: no
charts against its limits, no list of what was actually received, no view of its
alarms in one place, and no way to take any of it away as a signed record.

Separately, the only page in the product that can produce a PDF is the Audit
Trail, and its download is ungoverned — it produces the file with no
re-authentication, no reason, and no period of record.

## 2. Decomposition

Three sub-projects, each shippable on its own, built in this order because each
depends on the one before:

1. **The export gate** — a reusable "download this as a governed report" flow.
2. **The instrument trend page** — the new route and its widgets.
3. **The Alarms page** — period, search, and its own download.

## 3. What already exists (verified against live code, 2026-08-24)

This is most of the work, and none of it needs rebuilding:

| Capability | Where | State |
|---|---|---|
| PDF with company name, logo, Printed By + user ID, printed date/time, signature and remarks block | `apps/web/src/lib/pdf-report.ts` (`createReport`) | **Complete.** Used by the Audit Trail. Company name comes from the `branding` config, overridable by `report-page-titles`. |
| Per-role gating of which pages may export, and in which formats | `lib/export-surfaces.ts` + `<ExportMenu>` + `config/export-options.tsx` | **Complete.** `EXPORT_SURFACES` currently lists only `audit`. |
| Excel export | `lib/excel-export.ts` | Complete. |
| **Audited export logging** — `POST /api/audit/report-export-log` writes a `REPORT_GENERATED` audit row (report name, format, record count, period, search, start/end date), **fail-closed**: the browser calls it BEFORE saving the file and cancels the download if it fails | `lib/report-export-log.ts` + `modules/audit/routes.ts:304` | **Complete.** Carries no remarks and no re-authentication. |
| Per-instrument history, time-ranged, with a total row count | `telemetry.repository.ts:getHistory()` | **Supports `offset` and returns `total` already.** The HTTP route does not expose `offset`. |
| Readings annotated with their slot (temperature/humidity) and the instrument's own decimal precision | `GET /api/instruments/:id/telemetry` | Complete, and uses the same resolver the dashboard uses. |
| Alarms filtered by instrument | `GET /api/alarms?instrumentId=` | **Complete.** No date range. |
| A dependency-free SVG line chart with a validated palette that already draws an in-spec band from min/max limits | `routes/dashboard/time-series-chart.tsx` (`TimeSeriesChart({ series, unit, min, max, spanMs, title })`) | **Complete and directly reusable for the trend widgets.** |
| Re-authentication flow | `hooks/use-reauth.ts` + `<ReauthDialog>` | Complete. |

**Two consequences.** The trend widgets are a reuse of `TimeSeriesChart`, not a
new charting effort — and this repo has deliberately removed every charting
library it ever carried, so no chart dependency may be introduced. And the PDF
layout the operator described is already what `createReport` emits.

## 4. Sub-project 1 — the export gate

A `<ReportDownloadDialog>` that stands between a download button and the file:

1. **Period** — presets plus a custom from/to. Defaults to the period the page
   is currently showing, because a report of a different window than the one on
   screen is the likeliest way to file the wrong record.
2. **Remarks** — required, non-empty after trimming.
3. **Re-authentication** — password, through the existing `useReauth()`.

Only after all three does `createReport()` run.

**The download is a signed §11 action.** A new reauth action
`DOWNLOAD_REPORT` (46 → **47**) under a new `Reports` category — the category
must be added to `REAUTH_ACTION_CATEGORIES` as well, because both policy editors
iterate that array and an action in a missing category renders nowhere and can
never be configured.

**No new audit action and no new endpoint.** `POST /api/audit/report-export-log`
already writes a `REPORT_GENERATED` row for every download, already carries
period / start / end / search / record count, and is already **fail-closed** —
the browser calls it before saving the file and cancels the download if it
fails. The gate is built by adding two things to that existing endpoint:

- a **required `remarks`** field, carried into the audit `reason`; and
- `enforceReauth('DOWNLOAD_REPORT', …)`, which is the *configurable* form, so an
  administrator can relax the requirement per role rather than it being welded on.

Audit actions therefore stay at **93**.

**Consequence, stated plainly:** this endpoint is shared with the Audit Trail's
existing export. Making `remarks` required breaks that caller unless it is
updated in the same change, so the Audit Trail export moves onto the same dialog.
That is a deliberate widening of scope beyond the two new surfaces: it makes
every report download in the product governed the same way, rather than leaving
the oldest one as the single ungoverned exit. If that is not wanted, the
alternative is a `remarks`-optional endpoint with the requirement enforced per
surface in the browser — weaker, because the browser is then the only thing
insisting on it.

**Accepted limitation, on the record.** The PDF is generated in the browser
(`jspdf`), so the gate records intent — it cannot prevent someone reading data
already on their screen. The operator accepted this on 2026-08-24; server-side
rendering would close it but needs a new dependency and a rewrite of
`pdf-report.ts`. This is the same posture the existing audit export has.

**New export surfaces:** `instrument-trend` and `alarms` join `audit` in
`EXPORT_SURFACES`, so both inherit the existing per-role format gating.

## 5. Sub-project 2 — the instrument trend page

**Route:** `/instruments/:id/trend` (48 → **49** routes).

The Tabular view's Trend icon points here instead of at `/instruments/:id`.

**The icon currently renders only when `r.room` is set** — an instrument not
placed on a floorplan has no trend link at all. That is a defect: an instrument's
history does not depend on whether someone has drawn it on a plan. The icon
becomes unconditional.

### 5.1 Period header

Presets plus a custom range, and an interval selector. **The interval drives the
trend charts only.** The time-series table is always raw — see §5.4. Every
widget on the page reads the same period, so nothing on screen is ever showing a
different window than its neighbour.

### 5.2 Latest-value cards

Two cards, temperature and humidity: the latest received value at that
instrument's own decimal precision, its age, and which limits it is being judged
against (`limitSource`: its own attributes, or its room's).

### 5.3 Trend widgets

One per slot, rendered with the existing `TimeSeriesChart`. The instrument's
**resolved** limits are passed as `min`/`max`, which is what makes the component
draw the in-spec band — so the limit lines are the same numbers the alarm
evaluator uses. **Never re-derive limits in the browser**: a chart that disagrees
with the alarm printed beside it is the failure the shared resolver exists to
prevent.

### 5.4 Time-series widget

Every received value, raw, never averaged — timestamp, temperature, humidity,
plus a column per added key. Paged, with the true total shown, because a 7-day
window on a 10-second probe is tens of thousands of rows and loading them all
would freeze the page. Raw is the operator's explicit choice: a bucketed average
is not a received value and is worthless as a §11 record.

### 5.5 Alarms widget

That instrument's alarms for the period, rendered through
`routes/alarms/alarm-display.ts` so the wording, severity tones and status text
are identical to the Alarms page. A second vocabulary for the same alarm is how
two screens come to describe one event differently.

### 5.6 Additional keys

Ingest stores whatever key a device sends, so an instrument may carry more than
the two administered slots. A picker lists the keys **that instrument has
actually sent** — never a free-text field, which would invite a key that does not
exist. Adding one adds a trend widget and a table column.

The choice is **per user, remembered in the browser** (`localStorage`), with no
config surface, no permission and no admin round-trip. It is a viewing
preference, not governed data. It therefore does not survive a change of browser,
which is acceptable for what it is.

### 5.7 Downloads

Each of the three widgets carries its own download, each through the §4 gate,
each producing a report whose header names the instrument.

## 6. Sub-project 3 — the Alarms page

Adds a period selector and a search box (instrument code or name, alarm type,
severity), and a download of all instruments' alarms through the same gate.

Search and period are applied **server-side**, not by filtering an already-capped
client array — filtering a truncated list silently reports fewer matches than
exist.

## 7. API changes

| Change | Why |
|---|---|
| `GET /api/instruments/:id/telemetry` gains `offset` | The repository already accepts it and already returns `total`; only the route omits it. This is what makes §5.4 pageable. |
| `GET /api/alarms` gains `from` / `to` | No date filter exists today. |
| `GET /api/alarms` gains `q` | Server-side search for §6. |
| New `GET /api/instruments/:id/telemetry-keys` | The distinct keys this instrument has actually sent, for §5.6's picker. |
| `POST /api/audit/report-export-log` gains a required `remarks` and `DOWNLOAD_REPORT` reauth | The gate of §4. Not a new endpoint — the existing fail-closed export logger. |

All additive except the last: requiring `remarks` on `report-export-log` changes
an existing caller (the Audit Trail export), which moves onto the same dialog in
the same change. See §4.

## 8. Counts that move

| Count | From | To |
|---|---|---|
| Reauth actions | 46 | 47 |
| Reauth categories | 8 | 9 (`Reports`) |
| Frontend routes | 48 | 49 |
| Export surfaces | 1 | 3 |

Unchanged: 34 Prisma models, 13 enums, 42 permissions, 23 API modules, 25 config
defs, **93 audit actions** (the existing `REPORT_GENERATED` is reused).

## 9. Risks

- **The gate is advisory, not preventive** (§4). Recorded and accepted.
- **Long periods against a partitioned history table.** `getHistory` caps at
  1000 rows per query and counts with a separate `count(*)`; a multi-month
  window's count may be slow. Measure before adding an index — the table is
  partitioned and a wrong index there is expensive.
- **PDF row caps.** A report over a period holding tens of thousands of readings
  cannot be a complete PDF. The report must state the cap and the period it
  actually covered, on the page — a truncated report that looks complete is
  worse than a refused one.
- **`localStorage` for added keys** (§5.6) does not follow a user between
  browsers, and can be empty or throw in a private window. Every read is guarded
  and the page renders correctly with none stored.
