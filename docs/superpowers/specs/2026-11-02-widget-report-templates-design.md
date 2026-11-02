# Widget reports and report templates — per instrument profile, per widget type

**Date:** 2026-11-02 · **Status:** DRAFT — operator skipped the questions ("skip questions and start", "make it
fast"); every choice the operator did not state is marked **[my call]** and is theirs to overturn ·
**Branch:** `data-layer`

## 1. The ask (verbatim)

"whenever i added a new widgets added report download option should be added, in report each and every field or
keys or headers, footers, logos everything should be configurable and for each instrument profile and each widget
report should configurable, give one configuration feature for each instrument profiles- for each widget each report
template should be createable, i need a feature like that for each widget each report template option and for
instrument profile templates should be changed develop as per that"

Four requirements:
- **R1** Every widget on a dashboard (`/` and `/dashboards/:id`) has a **Download report** option.
- **R2** In that report **everything is configurable**: which fields / keys / columns print and what they are
  called, the header, the footer, the logo.
- **R3** Templates are **created per instrument profile, per widget type** — one configuration feature, reached
  per profile, where for each widget type any number of templates can be created.
- **R4** A report follows the template of the profile its instruments belong to; change the profile's template and
  the next download changes.

## 2. What exists today (recon 2026-11-02 at `90632e8f`)

- PDFs are built in the browser by `apps/web/src/lib/pdf-report.ts` (jsPDF): `createReport(config)` draws a fixed
  chrome — accent bar, the branding logo (12 mm, fetched as `'JPEG'` whatever was uploaded), company + app name
  from Config → Report Page Titles / Branding, a title bar, subtitle — then `addTable` / `addKeyValue` / `addNote`
  / `addImage`; the footer is "Page i of N"; the end block is Remarks, legend, "Printed By" / a signature table.
  A `ReportSnapshot` v2 records every drawing call and `renderSnapshotToPdf` replays it; **the logo and the
  company/app name are NOT in the snapshot** — an approved copy re-reads today's branding.
- Download policy is per report KIND (`REPORT_KINDS`, `packages/shared/src/types/report-downloads.ts`): Direct or
  Request (approval), remarks, password; `lib/report-delivery.ts deliverReport()` is the one path; a Direct
  download audits `REPORT_GENERATED`, an approved one `REPORT_DOWNLOADED`. Kinds today: `data-report`,
  `time-series`, `trend-header`, `temperature-trend`, `humidity-trend`, `instrument-alarms`, `alarms`,
  `audit-trail`.
- **No PDF column, heading, footer or title is configurable today**; the Data Report prints a fixed
  Temperature / RH pair, so a pressure-only profile gets dashes.
- Dashboard widgets: 14 types in `WIDGET_TYPE_SPECS` (`packages/shared/src/types/dashboard-widgets.ts`),
  rendered by `routes/dashboard/widgets/*-widget.tsx` inside `WidgetPanel`; **no widget has a download**.
- Per-profile JSON already lives on `instrument_profiles` (`measurements`, `display_keys`); the profile's keys and
  attributes are what a report can print.
- Uploads: `apps/api/src/modules/uploads/routes.ts` (jpeg/png/gif/webp, magic bytes, ≤ 5 MB, served publicly at
  `/uploads/<folder>/`); the branding logo is a ≤ 2 MB data URI in `system_config`.

## 3. Goals, non-goals, anti-goals

**Goals.** R1–R4. A template is a **record**: the report that was produced is replayable from its frozen
snapshot, chrome included. A new widget type gets a download by declaring its report fields in ONE place.

**Non-goals (this build).** Scheduled / e-mailed reports; Excel; editing the built-in Data Report / Alarm Report /
Trend PDFs (they keep their kinds and layouts; a later pass can move them onto templates); templates per
dashboard or per user (templates are per profile, as asked).

**Anti-goals.** A report whose printed figures differ from what the widget shows (the report prints the widget's
own server data); a template that can print a value the viewer cannot see on screen (visibility scope is the
server's, unchanged); a logo or heading that changes under an approved report (frozen in the snapshot).

## 4. Vocabulary

- **Widget type** — one of `WIDGET_TYPES`. **Reportable** types (this build): `value_cards`, `latest_table`,
  `trend_chart`, `timeseries_table`, `alarm_table`, `gauge`, `bar_chart`, `comparison_bar`, `pie_chart`,
  `alarm_counts`, `status_grid`, `instrument_list` (12). `text_card` and `floorplan` get the download too but
  print only what they show (the text; the floor plan as an image) with the chrome — no field catalogue **[my
  call]**.
- **Report template** — a row of `report_templates`: `profileId`, `widgetType`, `name`, `isDefault`, `document`.
- **Template document** (JSON, shared zod `reportTemplateDocumentSchema`, version 1):
  - `header`: `{ title, subtitle?, companyName?, appName?, showAppName, logo: { mode: 'branding' | 'custom' |
    'none', dataUrl? (custom, ≤ 1 MB, png/jpeg) }, accentColor? }` — title/subtitle are TEMPLATES with
    placeholders `{dashboard}`, `{widget}`, `{profile}`, `{from}`, `{to}`, `{period}`, `{date}`, `{user}`.
  - `infoBlock`: ordered `[{ label, source }]` — the key/value pairs under the title (source = a placeholder
    above, `instrumentCount`, `selection`, or a profile attribute key shown for a one-instrument report).
  - `columns`: ordered `[{ id, heading, show, decimals?, unit? }]` — `id` is from the widget type's **field
    catalogue** (§6); `heading` is what it is called.
  - `footer`: `{ text?, showPageNumbers, showPrintedBy, showPrintedAt, signatureLine }`.
  - `page`: `{ orientation: 'portrait' | 'landscape', typography: 'default' | 'data-report' }`.
  - `notes`: `{ remarksLabel?, legend? }`.
- **Built-in template** — the shipped document per widget type (`BUILTIN_REPORT_TEMPLATES` in shared), used when a
  profile has none; it is what today's look would print. It is also what "+ New template" starts from.
- **Field catalogue** — for a widget type × profile, the fields a template may print (§6). Served by the API;
  never re-derived in the browser.

## 5. Data model — `ReportTemplate` (39 → 40 models; enums unchanged)

```
model ReportTemplate {
  id          String   @id @default(uuid())
  profileId   String   @map("profile_id")        // FK instrument_profiles, ON DELETE CASCADE
  widgetType  String   @map("widget_type")       // validated string = WIDGET_TYPES, no enum
  name        String                              // 1..80, unique per (profileId, widgetType) ignoring case
  isDefault   Boolean  @default(false) @map("is_default")
  document    Json                                // reportTemplateDocumentSchema
  createdAt / updatedAt / createdBy / updatedBy
  @@unique([profileId, widgetType, name])  @@index([profileId, widgetType])
}
```
Exactly one default per (profile, widget type) when any exists (setting one clears the others in the same
transaction). Migration `20261102150000_report_templates`, hand-authored, both DBs. **[my call]** own table, not
a JSON column on the profile: templates are many, named, audited one by one, and a profile's deletion cascades.

## 6. The field catalogue (server)

`GET /api/report-templates/catalogue?profileId=&widgetType=` → `{ fields: [{ id, label, group, kind, unit?,
measured }] }`. Groups: **Built-in** (per widget type: e.g. `instrument.code`, `instrument.location`,
`instrument.area`, `reading.ts`, `reading.value`, `reading.unit`, `status`, `alarm.type`, `alarm.raisedAt`, …,
declared in shared `WIDGET_REPORT_FIELDS[type]`), **Keys** (the profile's telemetry keys: its measurements' slot
keys + `displayKeys` of source telemetry — `key:<name>`), **Attributes** (the profile's `attributeKeys` —
`attr:<name>`, labelled by Attribute Display Names). A template column whose `id` is not in the catalogue at
download time prints an empty cell and is listed under the table as "not available for this profile" — never
dropped silently, never invented **[my call]**.

## 7. Which template a download uses

1. The widget's instruments (the selection the widget already resolved from the server) are grouped by profile.
2. For each profile: its **default** template for that widget type, else the built-in template.
3. One report; **one section per profile** (a section title "Profile: <name>" when there is more than one),
   each section's columns from its template; the **chrome (header, logo, footer, page) from the FIRST section's
   template** (profiles in the order of the widget's instrument list) **[my call]**.
4. The download dialog shows which template(s) will be used and, when a profile has several, a picker to use
   another one for this download. SUPER_ADMIN sees a link to edit the template.

## 8. The download (R1)

- Every `WidgetPanel` header gets a download icon (`Download report`) on `/` and `/dashboards/:id`, shown when the
  viewer holds the surface in Config → Export Options (new surface `dashboard-widgets`, labelled "Dashboard
  widgets"; fails open like the others) **[my call]**.
- It opens the existing `ReportDownloadDialog` (period / remarks / password per the kind's policy), kind
  **`widget:<widgetType>`** — 14 new `REPORT_KINDS` entries, each Direct or Request in Config → Report
  Settings → Report Downloads, `reportType` `Widget: <type label>`. Everything then goes through
  `deliverReport` unchanged: Direct = `REPORT_GENERATED` + save; Request = the approval workflow with the frozen
  snapshot.
- The data printed is the widget's own: the builder reuses the widget's data hooks (`use-widget-data.ts`) for the
  widget's selection, keys and window (period from the dialog where the widget has one); charts are rasterised
  from the live ECharts instance (`getDataURL`) / the SVG floor plan and printed above their data table
  **[my call]**.
- **Snapshot v3**: `ReportSnapshot` gains `chrome: { companyName, appName, showAppName, logoDataUrl | null,
  accentColor?, footer, orientation }`; `renderSnapshotToPdf` draws from it and never re-fetches branding. Old
  v2 snapshots replay as before (fetch branding). Today's logo bug (always drawn as `'JPEG'`) is fixed by
  detecting the format from the data URL.

## 9. Configuration feature (R3) — Configuration → Report Templates

Route `/config/report-templates` (`routes/config/report-templates.tsx`, 23 → 24 config pages, 56 → 57 routes),
a SUPER_ADMIN card on the Configuration index (like Layout Designer / Alarm Webhooks) **[my call]**:
- a profile picker (left), the 14 widget types as tabs; each tab lists that profile's templates (name, default
  star, updated by/at, Edit / Duplicate / Delete / Set as default) and **+ New template** (from the built-in).
- the editor: a form (Header: title / subtitle with a placeholder picker, company and app name overrides, logo
  Branding / Upload / None; Fields: the catalogue as rows with a Show toggle, heading text, decimals, drag to
  reorder; Info block rows; Footer; Page) beside a **live preview** (the real `createReport` over sample rows
  built from the catalogue, rendered to an `<iframe>` blob URL, refreshed debounced).
- Writes: `POST /api/report-templates`, `PUT /:id`, `DELETE /:id`, `PUT /:id/default`; SUPER_ADMIN by role
  (`preValidation`, the dashboards precedent), re-auth **`UPDATE_REPORT_TEMPLATE`** (new reauth action under
  the existing `Reports` category, ships OFF; 57 → 58); audit `REPORT_TEMPLATE_CREATED` / `UPDATED` / `DELETED`
  (+ templates; 102 → 105 / 115 → 118), `afterValue` carries the whole document. No new permission, sidebar
  item or tree node (reached from Configuration) **[my call]**.
- Also reachable from Configuration → Instrument Attributes' profile picker ("Report templates →") so "for each
  instrument profile" has a door on the profile's own page.

## 10. API

| Method | Path | Gate | Notes |
|---|---|---|---|
| GET | `/api/report-templates?profileId=&widgetType=` | `INSTRUMENT_READ` | list (any viewer: the download needs it) |
| GET | `/api/report-templates/:id` | `INSTRUMENT_READ` | |
| GET | `/api/report-templates/catalogue?profileId=&widgetType=` | `INSTRUMENT_READ` | §6 |
| GET | `/api/report-templates/resolve?widgetType=&instrumentIds=a,b` | `INSTRUMENT_READ` | §7 steps 1–2 on the server: `[{profileId, profileName, template \| null, builtin: true\|false, instrumentIds}]`, visibility-scoped |
| POST / PUT / DELETE / PUT `:id/default` | as §9 | SUPER_ADMIN role | re-auth `UPDATE_REPORT_TEMPLATE` |

Every body through the shared schemas; a `widgetType` not in `WIDGET_TYPES` is 400; a duplicate name 409
`TEMPLATE_NAME_IN_USE`; the catalogue for a profile out of view is 404.

## 11. Screens (UI v3; render-checked with the built CSS at 1240 px + sidebar before hand-over)

- Widget header icon → `ReportDownloadDialog` (existing) with a "Template" line (§7.4).
- Configuration → Report Templates (§9): `PageHero` + a two-column layout (profile list | tabs + table), the
  editor as a full-width page section with the preview sticky on the right at lg.
- Configuration index: one new SUPER_ADMIN card.

## 12. Security and §11

Templates are display configuration, written by SUPER_ADMIN only, every write audited with the document. A
download prints only data the viewer already received for the widget. A custom logo is a data URI inside the
document (≤ 1 MB, png/jpeg by magic bytes checked server-side) — no new public file path. The snapshot freezes
the chrome, so an approved report cannot change under its signatures. Placeholders are substituted server-side
for nothing: they are pure text replacement in the browser from values the dialog already has; HTML is never
interpreted (jsPDF draws text).

## 13. Tests

Shared: document schema, built-in templates (every reportable type has one and every column id is in its
catalogue), placeholder substitution, resolver grouping. API e2e: CRUD + default uniqueness + cascade on profile
delete + 409 + 400 + SUPER_ADMIN gate + audit rows; catalogue per profile; resolve scoped. Web: the download
icon per surface gate; the dialog's template line; the builder (columns in template order, headings, hidden
columns absent, unavailable column listed, multi-profile sections, chrome from the first); snapshot v3 replay
without a branding fetch (mutation: re-fetch → fail); the config page (list, create from built-in, default star,
delete confirm, editor fields → PUT body, preview refresh). One file per process.

## 14. Touch points and counts

Models 39 → **40**; migration; API modules 26 → **27** (`report-templates`); shared type files 39 → **40**
(`report-templates.ts`); reauth 57 → **58**; audit 102 → **105** / 115 → **118**; config pages 23 → **24**;
routes 56 → **57**; export surfaces 4 → **5**; `REPORT_KINDS` 8 → **22**. Permissions, sidebar items, tree nodes,
defs, enums unchanged. Docs: feature-notes (new note), CHANGELOG, root CLAUDE.md counts, `docs/recreation/06-api/
endpoints.md`, `apps/{api,web}/CLAUDE.md`, memory.

## 15. Calls I made that the operator did not (overturn any)

1. Own table `report_templates`, not JSON on the profile.
2. `text_card` / `floorplan` download what they show, no field catalogue.
3. Multi-profile widget: one section per profile, chrome from the first.
4. Download gated by a new Export Options surface `dashboard-widgets`; policy per kind `widget:<type>`.
5. SUPER_ADMIN-only template writes, one re-auth action, three audit actions; no new permission.
6. Custom logo as a ≤ 1 MB data URI in the document; snapshot v3 freezes the chrome.
7. Config page under Configuration, plus a link from the profile's Instrument Attributes picker.
8. Built-in Data Report / Alarm Report / Trend PDFs untouched in this build.
