# Filter Replacement Schedule — Feature Scope (design only, rev 2 — 2026-06-02)

> **Status: SCOPING ONLY. No code written. No existing functionality changed.**
> Rev 2 replaces the earlier interval-based draft with the user's actual design:
> an **upload-driven** replacement schedule that produces **tablet tasks**.
> Closest existing analog = **PM Schedules / PM My Tasks** (CSV upload → entries
> with tolerance windows → /due tasks → execute). We mirror that pattern.

## 1. Goal
A user uploads a **replacement schedule template**; each row becomes a scheduled
replacement. When a row's window is active, it appears as a **task on the tablet**,
and the operator **performs the replacement from the task** (reusing the existing
scan + replace flow). SUPER_ADMIN controls **which role may upload** schedules.

## 2. Upload template (what the user fills in)
CSV / .xlsx with columns (server-generated template, like the filter bulk-upload one):

| Column | Meaning | Validation |
|---|---|---|
| `S.No` | Row serial (display only) | optional |
| `AHU Name` | Target AHU | must resolve to an existing AHU |
| `Filter Micron` | Micron spec of filters to replace | free text / matches filter micron |
| `Filter Size` | Size spec | free text |
| `Qty` | How many filters to replace in that AHU | integer ≥ 1 |
| `Schedule Date` | Planned replacement date | YYYY-MM-DD; not in the past (mirror PM past-date rule) |
| `Tolerance Days` | ± window around the date | integer ≥ 0 (config default if blank) |

Each row = "replace **Qty** filters of **Micron/Size** in **AHU** around **Schedule Date** (± **Tolerance Days**)." (Rows target an AHU + spec + quantity — **not** specific filter IDs; the operator picks/scans the actual filters at execution time.)

## 3. Data model (NEW tables — additive, mirrors PmSchedule/PmScheduleEntry/PmExecution)
- **`ReplacementSchedule`** (one per upload batch): `id, fileName, uploadedBy, uploadedByName, uploadedAt, status (DRAFT|ACTIVE|ARCHIVED), notes`.
- **`ReplacementScheduleEntry`** (one per row): `id, scheduleId(FK), slNo, ahuId(FK→asset), ahuNameSnapshot, filterMicron, filterSize, qty, qtyReplaced(default 0), scheduleDate(Date), toleranceDays, windowStart(Date), windowEnd(Date), status (PENDING|DUE|IN_PROGRESS|COMPLETED|MISSED), notes`.
- **`ReplacementExecution`** (one per filter actually replaced against an entry — audit + qty tracking): `id, entryId(FK), oldFilterId, newFilterId, performedBy, performedAt, isWithinWindow, remarks`.
- `windowStart = scheduleDate − toleranceDays`, `windowEnd = scheduleDate + toleranceDays` (mirror PM's window fields; final ± vs forward-only is a §8 question).
- Entry `status`: DUE when `today ∈ [windowStart, windowEnd]` and `qtyReplaced < qty`; COMPLETED when `qtyReplaced ≥ qty`; MISSED when past `windowEnd` and incomplete.

## 4. API (new module `replacement-schedule` — additive)
- `GET  /api/replacement-schedules/template.xlsx` — download the upload template (live AHU list note, like filter template).
- `POST /api/replacement-schedules/validate` — dry-run parse + per-cell errors (mirror filter bulk-upload validate).
- `POST /api/replacement-schedules` — create a schedule from the uploaded file (gated by the configurable upload permission — §6).
- `GET  /api/replacement-schedules` — list uploaded schedules + entries (admin/web view).
- `GET  /api/replacement-schedules/due` — entries currently DUE (drives the **tablet tasks** + dashboard counter).
- `POST /api/replacement-schedules/entries/:id/execute` — record one replacement against an entry: calls the **existing** `replace` action for the chosen old filter, then increments `qtyReplaced` + writes a `ReplacementExecution`. **The replace action itself is unchanged** — this wraps it.
- **Existing `POST /api/filters/:id/replace` stays as-is.**

## 5. Frontend
**Web (admin/management):**
- New **Replacement Schedule** page: **Upload** button (dialog mirrors the filter bulk-upload dialog — pick file → dry-run preview with per-cell errors → confirm), plus a list of uploaded schedules and their entries with status chips (Due / Completed / Missed / Pending). Reuses the bounded-scroll + sticky-header table pattern.
- Sidebar item + route guard.

**Tablet (`mobile-wrapper.tsx`) — additive, like the existing tiles/My-Tasks:**
- Due entries appear as **Replacement tasks** (a new tile/section, e.g. "Replacements due", or folded into My Tasks). Each task shows AHU + micron/size + **Qty remaining** + window.
- Tapping a task → a **scoped replace flow**: the AHU/spec is pre-filled; operator **scans the filter to replace** (reuses the scan-to-select we just added) → confirm → `…/entries/:id/execute` → qty decrements; task completes when qty met.
- All additive — the existing Replace Filter tile + cleaning tiles are untouched.

## 6. "Configurable by which role" (SUPER_ADMIN)
- New permission **`REPLACEMENT_SCHEDULE_UPLOAD`** (upload/create), plus **`REPLACEMENT_SCHEDULE_VIEW`** (see schedules/tasks) and **`REPLACEMENT_SCHEDULE_EXECUTE`** (replace from task).
- **SUPER_ADMIN grants `…_UPLOAD` to whichever role(s) they choose via the existing Role Privileges screen** — i.e. upload-ability is configurable per role, controlled by SUPER_ADMIN, using the app's standard RBAC. (Alternative if you prefer an explicit single setting: a config dropdown "Allowed upload role" — but the permission approach is the app's convention.)
- Tolerance-days **default** + window mode live in a small `replacement-schedule` config (SUPER_ADMIN-gated config page).

## 7. Touchpoints (12-touchpoint + config rules)
- Prisma: 3 new models (+ enum for entry status) → migration.
- `packages/shared`: 3 permissions + feature privilege(s) + reauth action(s) for upload/execute; **rebuild shared**.
- Sidebar (BOTH files), seed role arrays, auth `FEATURE_TO_PERMISSION_MAP`.
- Config def `replacement-schedule.def.ts` + `config-discovery.ts` + `config/index.tsx` card + page.
- New API module `replacement-schedule/`.
- `main.tsx` route + guard; new web page + upload dialog; `mobile-wrapper.tsx` task tile (additive).
- Docs: CLAUDE.md counts, CHANGELOG, API_REFERENCE, this file.

## 8. Phasing
1. **Schema + upload + validate + list (web)** + permissions/config + template download.
2. **Tablet tasks** (`/due` → task tile) + **replace-from-task** (scoped scan → execute → qty tracking).
3. Dashboard counter + notifications (graphile-worker job for due/overdue) + MISSED handling.

## 9. Open questions for sign-off
1. **Tolerance window**: ± toleranceDays around the date (recommended), or forward-only (date → date+tolerance)?
2. **Tolerance source**: a column in the template (per row) **and/or** a global default in config? (Recommend: column wins, config default when blank — like the filter bulk-upload default-set.)
3. **Qty fulfillment**: when the operator replaces a filter from a task, do they **scan each filter** (qty decrements per replacement until met) — yes? And can one task be done across multiple operators/sessions until qty is met?
4. **Past-date rows on upload**: reject (like PM), or allow + mark immediately DUE/MISSED?
5. **Upload-role control**: standard permission via Role Privileges (recommended) vs an explicit "allowed role" config dropdown?
6. **Where on the tablet**: a dedicated "Replacements" tile/section, or merged into the existing **My Tasks**?

## 10. Non-goals / guarantees
- **No change to the existing replace flow, filter CRUD, cleaning cycles, PM schedules, or any current screen.** Everything is additive (new module/tables/page/tablet-tile/config/permissions). The execute step *wraps* the existing replace action; it does not modify it.
