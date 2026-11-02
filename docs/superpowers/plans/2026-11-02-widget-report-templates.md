# Widget Report Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every dashboard widget gets a governed "Download report"; what the report prints (columns, headings, header, footer, logo, page) is a template created per instrument profile per widget type under Configuration → Report Templates.

**Architecture:** A `report_templates` table (one row per profile × widget type × name, one default) holding a versioned JSON document validated by a shared zod schema; the server serves the field catalogue and resolves which template a widget's instruments use; the browser builds the PDF with the existing `createReport` engine from the widget's own server data, freezes the chrome into snapshot v3 and hands it to the existing `deliverReport` (Direct / Request per kind).

**Tech Stack:** Fastify 5 + Prisma 6 (Postgres), zod in `@digilog/shared`, React 19 + SWR + Tailwind v4 (UI v3 primitives), jsPDF + jspdf-autotable, ECharts 6.1.0 (`getDataURL`), vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-widget-report-templates-design.md` (§15 lists the controller's calls; the spec is the authority).

## Global Constraints

- Validated strings, never a Postgres enum (`widgetType` = `WIDGET_TYPES`). Migration hand-authored, applied to `compliance_core_db` AND `compliance_core_db_test`; never a DROP of `instrument_telemetry_history`; drift guard (plain commands) empty on both.
- Never reconstruct a server decision in the browser: the catalogue, the resolved template, visibility and the download policy are the server's; the browser prints what the widget already received.
- Template writes: SUPER_ADMIN by ROLE in a `preValidation` hook (the dashboards precedent, `modules/dashboards/routes.ts:64-70`), re-auth `UPDATE_REPORT_TEMPLATE` via `enforceReauth`, audit with the whole document.
- New kinds `widget:<type>` go through `REPORT_KINDS` and `deliverReport` unchanged — no second download path.
- Snapshot v3 freezes the chrome; v2 snapshots still replay (`normaliseSnapshot` accepts 2 and 3).
- Counts (spec §14) re-derived by grep/ls before any doc quotes them. New config page follows CONTRIBUTING's 12-touchpoint list where applicable (no def, no sidebar item, no permission).
- Tests one file per process, by exit code; API single fork on the TEST DB with `DATABASE_URL` explicit; never two vitest processes at once; no `git add -A`; `git commit --only <paths>`; never touch another session's uncommitted files (`git status` first); never open `TCPIP/`.
- UI v3 (`PageHero`, `FormSection`, shared `Table`, `Select`, `Toggle`); render-checked with the built CSS at 1240 px + sidebar (render-check.md in the TCP/IP sdd folder) before hand-over.

## Review Focus

1. A template column id that the profile no longer has (a key removed from the profile) → an empty cell plus a "not available" line, never a crash or a silent drop (Task 3 builder test).
2. A widget whose instruments span two profiles, one with a template, one without → two sections, the second on the built-in, chrome from the first (Task 3).
3. A custom logo that is a PNG uploaded under a `.jpg` name → the data URL's own magic bytes decide the jsPDF format (Task 3, `imageFormatOf`).
4. A `{to}` placeholder on a widget with no time window (value cards) → prints "—", not "undefined" (Task 1 `substitutePlaceholders`).
5. Deleting the default template while a non-default remains → nothing is default; the next download uses the built-in; the list says so (Task 2 e2e + Task 5 list).

---

### Task 1: Shared vocabulary — document schema, catalogue fields, built-ins, kinds, actions

**Files:**
- Create: `packages/shared/src/types/report-templates.ts`, `packages/shared/src/types/__tests__/report-templates.test.ts`
- Modify: `packages/shared/src/index.ts` (export), `packages/shared/src/types/report-downloads.ts:46-55` (`REPORT_KINDS`), `packages/shared/src/types/reauth-actions.ts` (`UPDATE_REPORT_TEMPLATE: { label: 'Update Report Template', category: 'Reports' }`), `packages/shared/src/types/audit-actions.ts` + `audit-templates.ts` (`REPORT_TEMPLATE_CREATED` / `UPDATED` / `DELETED`, category Reports — same category as `REPORT_REVIEW_*`), `apps/web/src/lib/export-surfaces.ts:12` (`{ key: 'dashboard-widgets', label: 'Dashboard widgets' }`)
- Test: the new test file + existing `report-downloads.test.ts`, `reauth-actions` / `audit-actions-registry` / `audit-templates` tests (they pin counts — update the expected numbers).

**Interfaces (Produces):**
```ts
export const REPORT_TEMPLATE_DOCUMENT_VERSION = 1;
export const REPORTABLE_WIDGET_TYPES: readonly WidgetType[]; // the 12 of spec §4
export interface ReportField { id: string; label: string; group: 'builtin' | 'key' | 'attribute'; kind: 'text' | 'number' | 'datetime' | 'status'; unit?: string; measured?: boolean }
export const WIDGET_REPORT_FIELDS: Record<WidgetType, readonly ReportField[]>; // the built-in group per type (text_card/floorplan: [])
export const REPORT_PLACEHOLDERS = ['dashboard','widget','profile','from','to','period','date','user','instrumentCount','selection'] as const;
export interface ReportTemplateDocument { version: 1; header: {...spec §4}; infoBlock: {label; source}[]; columns: {id; heading; show; decimals?; unit?}[]; footer: {...}; page: {...}; notes: {...} }
export const reportTemplateDocumentSchema: z.ZodType<ReportTemplateDocument>; // logo.dataUrl ≤ 1_000_000 chars, data:image/(png|jpeg);base64 only; name-less (the row has the name)
export const reportTemplateCreateSchema = z.object({ profileId: uuid, widgetType: z.enum(WIDGET_TYPES), name: 1..80 trimmed, isDefault: boolean.default(false), document }); export const reportTemplateUpdateSchema = create.pick(name, document).partial();
export function builtinReportTemplate(widgetType: WidgetType): ReportTemplateDocument; // every WIDGET_REPORT_FIELDS[type] column shown, heading = label, title '{widget}', subtitle '{dashboard} · {period}', logo branding, footer page numbers + printed by + printed at, portrait (landscape for timeseries_table/alarm_table/latest_table)
export function substitutePlaceholders(text: string, values: Partial<Record<Placeholder, string>>): string; // unknown/absent → '—'
export function coerceReportTemplateDocument(value: unknown, widgetType: WidgetType): ReportTemplateDocument; // the ONE forgiving reader: a stored doc that fails the schema → builtin (never throws)
export const WIDGET_REPORT_KIND = (t: WidgetType) => `widget:${t}` as const; export function widgetReportType(t: WidgetType): string; // 'Widget: <WIDGET_TYPE_SPECS[t].label>'
```
`REPORT_KINDS` gains 14 entries `{ key: 'widget:<type>', reportType: widgetReportType(type), settingPrefix: 'widget<PascalType>', inheritsFrom: null, label: 'Widget — <label>', hint: 'The Download report on a <label> widget.' }` built by a `flatMap` over `WIDGET_TYPES` (not hand-typed).

- [ ] **Step 1: Write the failing tests** — `report-templates.test.ts`: every reportable type has a builtin whose column ids ⊆ its `WIDGET_REPORT_FIELDS` ids; schema refuses a 1,000,001-char logo, an `svg` data URL, a column with an empty heading, an unknown placeholder source in `infoBlock`; `substitutePlaceholders('{widget} {to}', {widget:'Gauge'})` → `'Gauge —'`; `coerceReportTemplateDocument({}, 'gauge')` equals the builtin; `REPORT_KINDS` has 22 entries and `widget:gauge` maps to `'Widget: Gauge'`.
- [ ] **Step 2: Run, expect failures** (`cd packages/shared && npx vitest run src/types/__tests__/report-templates.test.ts`).
- [ ] **Step 3: Implement** the file and the five modifications; update the pinned counts in the existing tests (reauth 58, audit actions 105, templates 118, kinds 22).
- [ ] **Step 4: Run** the new file and every touched shared test file, each alone, exit 0; `npm run build -w @digilog/shared`; `npx tsc --noEmit -p apps/api` and `-p apps/web` (the web's `EXPORT_SURFACES` change compiles).
- [ ] **Step 5: Commit** `feat(shared): report template documents, widget report fields and kinds`.

### Task 2: API — `report_templates` table and the `report-templates` module

**Files:**
- Create: `apps/api/prisma/migrations/20261102150000_report_templates/migration.sql`, `apps/api/src/modules/report-templates/{routes.ts,service.ts,catalogue.ts}`, `apps/api/src/e2e/report-templates.e2e.test.ts`
- Modify: `apps/api/prisma/schema.prisma` (model `ReportTemplate` per spec §5 + relation on `InstrumentProfile`), `apps/api/src/app.ts` (register at `/api/report-templates` beside `dashboardRoutes`), `apps/api/src/lib/__tests__/audit-actions-registry.test.ts` if it pins the written set.

**Interfaces:**
- Consumes Task 1's schemas, `WIDGET_REPORT_FIELDS`, `coerceReportTemplateDocument`; `coerceProfileMeasurements` / `coerceProfileDisplayKeys` / `attributeKeys` for the catalogue; the attribute-labels reader the API already has (`attribute-labels` row) for attribute labels; `resolveVisibleInstrumentIds`-style scoping used by `GET /api/instruments`.
- Produces routes (spec §10) with these bodies/responses:
  - `GET /api/report-templates?profileId&widgetType` → `{ data: ReportTemplateRow[] }`, `ReportTemplateRow = { id, profileId, widgetType, name, isDefault, document, createdAt, updatedAt, updatedBy }`.
  - `GET /catalogue?profileId&widgetType` → `{ fields: ReportField[] }` = built-in ∪ `key:<k>` (measurement slot keys + telemetry displayKeys; `measured: true` for slot keys; unit from the measurement) ∪ `attr:<k>` (profile `attributeKeys`, label from Attribute Display Names).
  - `GET /resolve?widgetType&instrumentIds=a,b` → `{ sections: [{ profileId, profileName, instrumentIds, template: ReportTemplateRow | null }] }` in the order of first appearance of each profile in `instrumentIds`; ids out of the caller's view are dropped silently (the widget never had them).
  - `POST /` 201 row; `PUT /:id` row; `DELETE /:id` 204; `PUT /:id/default` row (clears the others in one transaction). Errors: 400 `VALIDATION_ERROR`, 404 `TEMPLATE_NOT_FOUND` / profile out of view, 409 `TEMPLATE_NAME_IN_USE`, 403 `REPORT_TEMPLATES_SUPER_ADMIN_ONLY`.
  - Audit: `REPORT_TEMPLATE_CREATED/UPDATED/DELETED`, `entityType 'report_template'`, `afterValue { profileId, widgetType, name, isDefault, document }`, `beforeValue` on update/delete.

- [ ] **Step 1: Migration + schema** (`CREATE TABLE report_templates …`, FK cascade, unique `(profile_id, widget_type, lower(name))` as a unique INDEX on `lower(name)` — Prisma cannot express it; the `@@unique` in the model is the plain one, and the migration adds the lower() index by hand, documented in the model comment); apply to both DBs; `prisma generate` (EPERM on the engine DLL while the dev API runs is expected — verify `index.d.ts` has `ReportTemplate`); drift guard empty on both.
- [ ] **Step 2: Write the failing e2e** — create (201 + audit row), duplicate name ignoring case → 409, non-SUPER_ADMIN → 403 before validation, `widgetType 'nope'` → 400, set default clears the other, delete the default → the other is NOT promoted and `resolve` returns `template: null`, profile delete cascades, catalogue for a T&RH profile lists `key:<temperature key>` with `measured: true` and `attr:Location`, resolve groups two profiles in instrument order and drops an out-of-view id, `GET` list for `INSTRUMENT_READ` role works. Use the fixtures the `dashboards-module.e2e.test.ts` uses for roles.
- [ ] **Step 3: Run, expect failures.**
- [ ] **Step 4: Implement** service (Prisma), catalogue, routes (`preValidation: [superAdminOnly]` for writes, `enforceReauth('UPDATE_REPORT_TEMPLATE')`, `requirePermission('INSTRUMENT_READ')` for reads), register in `app.ts`.
- [ ] **Step 5: Run** the e2e alone + `audit-actions-registry.test.ts` + `tsc -p apps/api`, exit 0. Mutation-check: drop the lower() uniqueness → 409 test fails; drop the cascade → cascade test fails.
- [ ] **Step 6: Commit** `feat(api): report templates per profile and widget type — CRUD, catalogue, resolve`.

### Task 3: Web lib — snapshot v3 chrome and the widget report builder

**Files:**
- Modify: `apps/web/src/lib/pdf-report.ts` (`ReportConfig.chrome?: ReportChrome`; `ReportSnapshot.version: 2 | 3`, `chrome?` on v3; `createReport` draws from `chrome` when given and never fetches; `getSnapshot()` writes v3 with the chrome it drew; `renderSnapshotToPdf` passes a v3 snapshot's chrome; `imageFormatOf(dataUrl): 'PNG' | 'JPEG'` by magic bytes replaces the hard-coded `'JPEG'`), `apps/web/src/lib/__tests__/pdf-report-snapshot.test.ts`
- Create: `apps/web/src/lib/widget-report.ts`, `apps/web/src/lib/__tests__/widget-report.test.ts`

**Interfaces:**
```ts
export interface ReportChrome { companyName: string; appName: string; showAppName: boolean; logoDataUrl: string | null; accentColor?: string; footer: ReportTemplateDocument['footer']; orientation: 'portrait' | 'landscape' }
export async function loadReportChrome(doc: ReportTemplateDocument): Promise<ReportChrome>; // branding/report-page-titles + the template's overrides; logo mode branding → the branding logo as a data URL (fetched once), custom → doc.header.logo.dataUrl, none → null
export interface WidgetReportSection { profileId: string; profileName: string; document: ReportTemplateDocument; rows: Record<string, string | number | null>[]; /* field id → value, already formatted by the caller's datetime hook */ imageDataUrl?: string; imageSize?: { wMm: number; hMm: number } }
export interface WidgetReportInput { widgetType: WidgetType; values: Partial<Record<Placeholder, string>>; sections: WidgetReportSection[]; available: Set<string> /* catalogue ids per section → pass per section: `availableIds: string[]` on the section */; formatDateTime: (iso: string) => string }
export async function buildWidgetReport(input: WidgetReportInput): Promise<{ report: ReportDoc; title: string; subtitle?: string; recordCount: number }>;
```
Rules: title/subtitle = `substitutePlaceholders` over the FIRST section's document; chrome = `loadReportChrome(first.document)`; per section (a `addSectionTitle('Profile: <name>')` only when `sections.length > 1`): the info block as `addKeyValue`, the image (charts) if any, then `addTable` with the shown columns in document order, headings from the document, `decimals` applied to numbers, `unit` appended to numeric headings when set; a shown column whose id ∉ `availableIds` → empty cells and ONE `addNote('Not available for this profile: <headings>', 'muted')`; `page.typography 'data-report'` → `DATA_REPORT_TYPOGRAPHY`.

- [ ] **Step 1: Failing tests** — snapshot: a v3 snapshot with `logoDataUrl` replays with `fetch` stubbed to THROW (mutation: re-fetching fails the test); a v2 snapshot still replays; `imageFormatOf('data:image/png;base64,iVBOR…')` → `'PNG'`. Builder: columns in document order with the document's headings; a hidden column absent; an unavailable id → the note; two sections → `Profile:` titles and chrome from the first; `{to}` absent → `—`; `recordCount` = total rows.
- [ ] **Step 2: Run, expect failures.** **Step 3: Implement.** **Step 4: Run** both files alone, plus `pdf-report-snapshot.test.ts`'s siblings (`trend-downloads`, `generate-report-card`, `alarms-page` replay the snapshot — must stay green), `tsc -p apps/web`.
- [ ] **Step 5: Commit** `feat(web): report snapshot v3 freezes the chrome; the widget report builder`.

### Task 4: Web — Download report on every widget

**Files:**
- Create: `apps/web/src/routes/dashboard/widgets/widget-report-dialog.tsx`, `apps/web/src/routes/dashboard/widgets/widget-report-data.ts`, `apps/web/src/routes/dashboard/widgets/__tests__/widget-report-dialog.test.tsx`, `__tests__/widget-report-data.test.ts`
- Modify: `apps/web/src/routes/dashboard/widgets/widget-panel.tsx:73-120` (a `Download report` icon button in `menu` — shown ALWAYS, not only while editing; gated by `useExportOptions('dashboard-widgets').pdf`), `apps/web/src/routes/dashboard/widgets/charts/echart.tsx` (an optional `onReady?: (inst: ECharts) => void` prop; `lazy-echart.tsx` forwards it), the chart widgets (`trend_chart`, `bar_chart`, `comparison_bar`, `pie_chart`, `gauge`) register their instance in a `WidgetChartRegistry` context keyed by widget id so the dialog can `getDataURL({ pixelRatio: 2, backgroundColor: '#fff' })`.

**Interfaces:**
- `widget-report-data.ts`: `useWidgetReportRows(widget, selection, period): { sections: WidgetReportSection[] (rows per profile, field ids = WIDGET_REPORT_FIELDS + key:/attr:), values: Partial<Record<Placeholder,string>>, loading, error }` — reuses `useWidgetOverview`, `useLatestValues`, `useWidgetHistory`, `useWidgetTimeseries`, `useTelemetryBuckets`, `useAlarmCounts` and the alarm list query the alarm table uses, `GET /api/report-templates/resolve` for the sections, and the catalogue per section. One pure helper per widget type `rowsFor<Type>(data, instruments)` → rows, tested with fixtures; `text_card` → one row `{ text }`; `floorplan` → the panel's SVG rasterised (reuse `chart-image.ts`'s SVG → PNG) as `imageDataUrl`.
- `WidgetReportDialog({ open, widget, selection, dashboardTitle, onClose })`: shows "Template: <name> (profile)" per section or "Built-in", a per-section picker when a profile has > 1 template (from the list route), SUPER_ADMIN link `/config/report-templates?profileId=&widgetType=`; wraps `ReportDownloadDialog` with `kind = WIDGET_REPORT_KIND(widget.type)`, `showPeriod` only for types whose spec has a window (`trend_chart`, `timeseries_table`, `bar_chart`, `alarm_table`); on confirm: `buildWidgetReport` → `deliverReport({ kind, req, report, reportType: widgetReportType(type), title, subtitle, requestMeta: { recordCount, period, search: widget.title }, instrumentIds })` → `deliveryToast`.

- [ ] **Step 1: Failing tests** — panel shows the icon when the surface is PDF and hides it on `NONE` (mutation: drop the gate); dialog posts `reportKind 'widget:gauge'` through `deliverReport` (mocked) with the resolved template's headings; a picker appears only when a profile has two templates; `rowsForLatestTable` maps `reading.value` with the server's `display`, never re-formats; `rowsForAlarmTable` field ids match `WIDGET_REPORT_FIELDS.alarm_table`.
- [ ] **Step 2: Run, expect failures.** **Step 3: Implement.** **Step 4: Run** each touched/new test file alone (`widget-panel`, `dashboard-widget-controls`, the dashboards page tests), `tsc -p apps/web`, `vite build`; render check: `/` with one gauge + one latest table widget, the icon in the header, the dialog open (built CSS, 1240 px + sidebar) → `docs/superpowers/concepts/2026-11-02-widget-reports/built-*.png`; open the produced PDF of a latest table and a trend chart with PyMuPDF and screenshot page 1 of each into the same folder.
- [ ] **Step 5: Commit** `feat(web): Download report on every dashboard widget`.

### Task 5: Web — Configuration → Report Templates

**Files:**
- Create: `apps/web/src/routes/config/report-templates.tsx`, `apps/web/src/routes/config/report-templates/{template-list.tsx,template-editor.tsx,template-preview.tsx,sample-rows.ts}`, `apps/web/src/routes/config/__tests__/report-templates.test.tsx`
- Modify: `apps/web/src/main.tsx` (`<Route path="/config/report-templates">`, `RequireRole` SUPER_ADMIN like `/config/alarm-webhooks`'s pattern), `apps/web/src/routes/config/index.tsx:165` (`superAdminCards` entry "Report Templates", icon `FileText`, href `/config/report-templates`), `apps/web/src/routes/config/instrument-attributes.tsx` (a "Report templates →" link beside the profile picker carrying `?profileId=`).

**Interfaces:** consumes Task 2's routes and Task 3's `buildWidgetReport` for the preview (`sample-rows.ts`: `sampleRowsFor(fields): rows` — three rows of placeholder values typed by `field.kind`); `?profileId=&widgetType=` preselect.

- [ ] **Step 1: Failing tests** — list per tab from `GET /api/report-templates?profileId&widgetType`; "+ New template" opens the editor seeded from `builtinReportTemplate`; Save → `POST` with `{profileId, widgetType, name, isDefault, document}` under `reauth.execute('UPDATE_REPORT_TEMPLATE', …)` with the three outcomes; a column's Show toggle and heading edit land in the PUT body (mutation: drop the heading edit → fails); Set as default → `PUT /:id/default`; Delete confirms and says "the built-in will be used" when it was the default; the logo Upload refuses a 1.1 MB file in the browser with the shared message and sends a `data:image/png;base64` URL for a PNG; the preview iframe `src` changes after an edit (debounced; `buildWidgetReport` mocked).
- [ ] **Step 2: Run, expect failures.** **Step 3: Implement** (`PageHero` + profile picker (`SearchableSelect` over `/api/instrument-profiles`) | 14 tabs | shared `Table` list | editor as `FormSection`s with the preview sticky at lg; placeholder picker inserts `{name}` at the caret; drag-reorder with the existing `use-row-keys` + up/down buttons (no new dependency)).
- [ ] **Step 4: Run** the test alone, `config/__tests__/pages-hero.test.tsx`, `tsc`, `vite build`; render check: the page with the editor open and the preview beside it → the concept folder.
- [ ] **Step 5: Commit** `feat(web): Configuration → Report Templates — per profile, per widget type, with a live preview`.

### Task 6: Docs and counts

**Files:** `docs/feature-notes.md` (new note "WIDGET REPORTS AND REPORT TEMPLATES"), `CHANGELOG.md`, root `CLAUDE.md` System Stats (models 40, modules 27, reauth 58, audit 105/118, config pages 24, routes 57, type files 40 — each re-derived by the listed commands), `apps/api/CLAUDE.md`, `apps/web/CLAUDE.md` (Key Features count + a short section), `docs/recreation/06-api/endpoints.md` (the five routes), `packages/shared/CLAUDE.md` if it lists type files. Files dirty with another session's hunks go through the anchored-blob procedure.

- [ ] **Step 1:** run the live-count verification block; **Step 2:** write; **Step 3:** stale-stat sweep on the previous numbers; **Step 4:** commit `docs: widget reports and report templates`.

## Execution

Task 1 first (the contract). Then Tasks 2, 3→4, and 5 in PARALLEL (three implementers; 5 may start against Task 1's schemas and mock the API until Task 2 lands; 4 depends on 3). Then one whole-branch review, one fix wave, one scoped re-review, the full gate (API single fork, shared, web one file per process), Task 6.
