# Bulk Upload ↔ Single-Create Parity (.xlsx) — Design

**Date:** 2026-05-30
**Branch:** RFID
**Status:** Approved — in implementation

## Problem

The Filter Bulk Upload screen has drifted from the Single Filter Creation
screen. Single-Create renders fields and dropdowns that Bulk Upload omits, the
template is a hardcoded CSV (no dropdowns), and uploaded data is not validated
against live master data with clear per-cell messages.

## The core gap

Single-Create (`CreateFilterDialog` + `FilterFieldOptionsSection`) renders:

- `name`, `filterSet` (A/B)
- **`ahuType`, `filterType`, `micronSize`, `lastCleaningDate`** — the four
  "Filter Details" fields, stored in the `attributes` JSON, sourced from
  `GET /api/filters/field-options` (NOT from the template attributeSchema)
- any FILTER-template `attributeSchema` fields (dynamic)

Bulk Upload today only has `name`, `filterSet`, `filterProfileId`, and
`attributeSchema` fields. It **omits the four field-option fields entirely**.

## Master-data sources (zero hardcoding — req #5)

| Field | Dropdown source |
|---|---|
| filterSet | A / B (static enum) |
| ahuType / filterType / micronSize | `GET /api/filters/field-options` (live config) |
| `attributeSchema` DROPDOWN fields | FILTER-kind template (dynamic) |
| lastCleaningDate | date or `NA` (mirror `encodeLastCleaningDate`) |
| Area / AHU | hierarchy — **dialog-level, not an Excel column** |

The Filter template is resolved by `templateKind === 'FILTER'` (matching
single-create), **not** by `name === 'Filter'` (the current backend service
uses the stale name lookup — fixed here).

## Backend (apps/api) — add `exceljs` dependency

1. **Template generator** (`exceljs`): header =
   `name, filterSet, ahuType, filterType, micronSize, lastCleaningDate,
   filterProfileId(opt)` + attributeSchema columns. Apply Excel **Data
   Validation list** dropdowns (rows 2–1000) on every column that has an
   option list (filterSet, ahuType, filterType, micronSize, each DROPDOWN
   attributeSchema field). Master data fetched fresh per request.
2. **New endpoint** `GET /api/assets/instances/filter-upload-template.xlsx?ahuId=…`
   → streams the workbook (Content-Type
   `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`).
3. **Refactor `bulkUploadFilters`**: read `.xlsx` (via `exceljs`), fix the
   template lookup to `templateKind:'FILTER'`, validate the four field-option
   fields against live master data (net-new) + lastCleaningDate/NA + existing
   attributeSchema validation; emit structured `{ row, column, value, message }`
   errors.
4. **New dry-run endpoint** `POST …/bulk-upload-filters/validate` → parse +
   validate, **no DB write**. The real upload reuses the exact same validation
   path (shared `validateRows()` helper).

## Frontend (apps/web) — no new bundle deps

1. `downloadBulkTemplate` → hits the server endpoint, saves `.xlsx` (delete the
   client CSV string-builder).
2. `handleBulkUploadFileSelect` → POSTs the `.xlsx` to `/validate`; renders
   returned rows + per-cell errors (delete the client `split(',')` parser,
   which is dead on a binary `.xlsx`).
3. `BulkUploadDialog` preview → show validation status with clear row/column/
   value messages (req #6); update the "CSV Columns" hint box to the new
   `.xlsx` columns; results/preview render the field-option columns too.
4. Confirm the dialog Area→AHU→fields cascade matches single-create (req
   #2/#3 — largely present; align bulk's area list to the same block-scoped
   source and verify).

## Validation messages (req #6)

Each invalid cell → `Row {n}, column "{col}", value "{val}": must be one of …`.
Surfaced in the preview (pre-upload, from the dry-run endpoint) and in results.

## Field requiredness

The four field-option fields are **optional-but-validated** — exactly mirroring
single-create, where they carry no `*`. If present, the value must be in the
live master-data list; if absent, the row is still valid.

## Out of scope / non-goals

- No cascading Area→AHU dropdowns **inside** the spreadsheet (one AHU per
  upload; the cascade lives in the dialog). INDIRECT/named-range cascades are
  brittle and unnecessary.
- No change to persistence (still `AssetInstance` + `FilterDetails` +
  relationships) or to the reauth `BULK_UPLOAD_FILTERS` wrap.
- **CSV uploads stop working** (intended — `.xlsx` only). Noted in CHANGELOG.

## Testing

- **API**: template workbook contains expected validations; dry-run returns
  correct row/col/value for each bad-value case; real upload still creates +
  audits; the `templateKind` fix doesn't break other callers (grep first).
- **Web**: `vite build` green; manual verify (downloaded file opens with
  working Excel dropdowns; bad value rejected with a clear message; good file
  uploads and creates filters).

## Touch-points to re-test (per CLAUDE.md correctness rule)

- Single-create unaffected (shared field-options endpoint, `encodeLastCleaningDate`).
- The stale `name:'Filter'` → `templateKind:'FILTER'` fix — grep for other callers.
- reauth `BULK_UPLOAD_FILTERS` still wraps the upload.
- `instance.routes.ts` `defaultFilterSet` plumbing (uncommitted) preserved.
