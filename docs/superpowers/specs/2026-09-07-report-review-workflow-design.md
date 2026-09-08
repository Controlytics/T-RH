# Report review workflow — design (2026-09-07)

Operator: *"when ever user click on download then directly pdf should not
download, as per requested time period data should go per review once review
completed and approved then user and approved user can get that approved data
in side bar new option there user can download reports, who ever requested and
approved users electronic signatures should come if report was downloaded"*.

Four decisions put to the operator and taken as recommended: **one approver**
(not reviewer-then-approver); the approver is **a user or a role** chosen at
request time; **every PDF download** goes through review; the approver sees **a
DRAFT PDF of the exact report** before signing.

## Context

- This workflow existed as `modules/report-reviews/` + `ReportReview` (a
  two-stage review → approve flow) and was removed in the 2026-07-18 Phase 0
  strip. Survivors: `apps/web/src/lib/report-review.ts` (submit / fetch /
  download-with-signatures helpers), `components/SendForReviewButton.tsx`
  (mounted on the Audit page — **it posts to `/api/report-reviews`, which does
  not exist, so it fails on click today**), `renderSnapshotToPdf` in
  `lib/pdf-report.ts`, and the `NotificationType` values
  `REPORT_REVIEW_REQUESTED / APPROVED / REJECTED`. The old module's
  party-scoping (`canViewReportReview`) and its concurrency guard are worth
  taking; its second stage is not.
- Every report today is built in the browser and saved directly after a
  governed dialog (period, interval, remarks) and a `DOWNLOAD_REPORT`
  password re-auth, with one `REPORT_GENERATED` audit row written BEFORE the
  file (`lib/report-export-log.ts`). Eight triggers: Data Report page card;
  trend page header, Time Series card, Temperature chart, Humidity chart,
  alarms widget; Alarms page; Audit Trail PDF export.

## What changes for the user

1. Pressing any PDF download opens the same dialog plus **Send to** (a user or
   a role), then the password re-auth. Nothing saves. A **report request** is
   recorded and the assignee is notified in-app.
2. **Reports** appears in the sidebar (`/reports`) with three lists: *For my
   approval*, *My requests*, *Approved*.
3. The approver opens the request, views the **DRAFT** PDF (watermarked
   `DRAFT — NOT APPROVED`, no signatures), and **approves** or **rejects** with
   remarks and password. The requester is notified.
4. Once approved, the requester, the approver and SUPER_ADMIN can download the
   report. The PDF carries two signature lines — Requested By and Approved By —
   each with name, user ID and the date-time of the password-verified action.
   Each download writes an audit row.
5. Rejected requests stay visible to their parties with the reason. Nothing is
   deleted, ever.
6. The Audit page's Excel export is not a PDF and stays direct. The broken
   "Send for Review" button is removed.

## The record is the frozen document

The request stores the **exact rendered report** as a snapshot, not the
parameters to rebuild it. What the approver reviewed must be byte-for-byte what
is later downloaded, apart from the signature block and the DRAFT watermark;
rebuilding from parameters after approval could pick up late-arriving
telemetry or a renamed alarm type and produce a document nobody signed.

`ReportSnapshot` (`lib/pdf-report.ts`) is extended to carry everything a report
draws today. Current shape: `{ reportType?, title, subtitle?, orientation?,
sections: (table | key-value)[] }`. New shape:

```
ReportSnapshot {
  version: 2;
  reportType: string;            // the audit reportType, e.g. 'Instrument Time Series'
  title: string; subtitle?: string;
  orientation?: 'portrait' | 'landscape';
  config: { legend?; typography?; showAppName? };   // ReportConfig minus formatDateTime/signatures
  sections: (
    | { kind: 'table';  title?; head: string[]; body: TableCell[][]; columnStyles?; bold?: boolean[][] }
    | { kind: 'pairs';  title?; pairs: [string,string][]; columns? }
    | { kind: 'title';  text }                       // addSectionTitle with no table after it
    | { kind: 'note';   text; color: 'red'|'muted' } // trend-report's addNote paragraphs
    | { kind: 'image';  dataUrl; widthMm; heightMm } // chart rasters
    | { kind: 'page-break' }
  )[];
}
```

`createReport()` records every drawing call into the snapshot (it records
tables and titles today; notes, images and page breaks are added — `addNote`
moves from `trend-report.ts` into `ReportDoc` so it can be recorded).
`renderSnapshotToPdf(snapshot, { signatures?, draft? })` replays it through the
same `ReportDoc` methods, so there is ONE renderer. Version 1 snapshots do not
exist in this database (the table they lived in is gone), so no migration of
snapshot shape is needed; `normaliseSnapshot` still refuses anything but
`version: 2`.

Size: a chart raster is ~50–200 KB base64; a Data Report of 2,000 rows is
~150 KB of JSON. Stored as JSONB; no cap beyond Fastify's body limit (raise
that route's `bodyLimit` to 8 MB).

## Data model

New model `ReportReview` (table `report_reviews`), new enum
`ReportReviewStatus { PENDING, APPROVED, REJECTED }`. Models 35 → 36, enums
12 → 13. Two hand-authored migrations (enum first — Postgres refuses a new enum
value in the transaction that created it — then the table), applied to BOTH
databases.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| report_type | varchar(100) | the audit `reportType` string |
| title, subtitle | varchar(500), varchar(1000)? | as printed |
| request_meta | jsonb | `{ period:{from,to,label}, intervalMs?, instrumentCodes?: string[], search? }` — what the row LISTS say; the snapshot is the record |
| data_snapshot | jsonb | the frozen document above |
| status | report_review_status | PENDING → APPROVED \| REJECTED, one transition only |
| requested_by (uuid), requested_by_name (username), requested_at, request_remarks (text) | | the requester's e-signature event |
| assignee_user_id (uuid?), assignee_role (varchar 50?) | | exactly one set |
| decided_by (uuid?), decided_by_name, decided_at, decision_remarks (text) | | approver or rejecter; `status` says which |
| created_at, updated_at | | |

Indexes: `(status, assignee_user_id)`, `(status, assignee_role)`,
`(requested_by, created_at)`. Prisma `@@map("report_reviews")`.

**Nothing deletes rows.** No DELETE route; an approved or rejected request is a
§11 record.

## API — module `report-reviews` (24 → 25 modules), prefix `/api/report-reviews`

Registered in `app.ts` AND `e2e/test-helper.ts` in the same commit.

| route | gate | body / behaviour |
|---|---|---|
| `POST /` | `REPORT_REVIEW_READ` + re-auth `DOWNLOAD_REPORT` | `{ reportType, title, subtitle?, requestMeta, dataSnapshot, remarks (1..500, required), assigneeUserId? \| assigneeRole? (exactly one), password }`. Creates PENDING. Audit `REPORT_REVIEW_REQUESTED` (signature meaning names the title and the assignee). Notification `REPORT_REVIEW_REQUESTED` to the user, or to every holder of the role. Returns the summary. The assignee user must be active; the role must exist. |
| `GET /?list=queue\|mine\|approved&page&pageSize` | `REPORT_REVIEW_READ` | `queue`: PENDING and assigned to me (user id) or my role. `mine`: requested by me, any status. `approved`: APPROVED and I am a party. SUPER_ADMIN: `queue` = all PENDING, `approved` = all. Summaries only (no snapshot), newest first, paged with `total`. |
| `GET /:id` | `REPORT_REVIEW_READ` | Full row with snapshot, **404 unless the caller is a party** (requester, current assignee by user or role, decider) or SUPER_ADMIN — 404, never 403, so a non-party cannot confirm the id exists. |
| `POST /:id/approve` | `REPORT_REVIEW_APPROVE` + re-auth `APPROVE_REPORT` | `{ remarks (required), password }`. Caller must be the assignee (user, or holder of the role) or SUPER_ADMIN. `updateMany({ where: { id, status: 'PENDING' } })` — 0 rows → 409 `ALREADY_DECIDED`, so two approvers cannot both sign. **Separation of duties: the requester cannot approve their own request** (403 `SELF_APPROVAL`), SUPER_ADMIN included. Audit `REPORT_REVIEW_APPROVED`; notification to the requester. |
| `POST /:id/reject` | `REPORT_REVIEW_APPROVE` + re-auth `REJECT_REPORT` | Same guards; status REJECTED; audit `REPORT_REVIEW_REJECTED`; notification. |
| `POST /:id/download-log` | `REPORT_REVIEW_READ` | Party-scoped like `GET /:id`; only for APPROVED. Audit `REPORT_DOWNLOADED` (target = the review id, `afterValue` carries the two signatures printed). Called by the browser BEFORE `save()`, fail-closed — the same order as today's `report-export-log`. No re-auth: downloading a signed record is not itself a signature event. |

The DRAFT is rendered in the browser from `GET /:id`; no server render.

`POST /api/audit/report-export-log` is no longer called by any PDF path once
the eight triggers are converted; it stays for the Audit page's Excel export.

## Permissions, re-auth, audit, notifications

- **Permissions** (42 → 44): `REPORT_REVIEW_READ` (see the Reports page, raise
  requests, download approved reports one is a party to) and
  `REPORT_REVIEW_APPROVE`. Raising a request is gated on `REPORT_REVIEW_READ`
  rather than a third permission: whoever can see the Reports page can ask for
  a report; whether they can download the DATA at all is still each source
  page's own gate (`INSTRUMENT_READ`, `ALARM_READ`, `AUDIT_READ`) plus the
  per-role Export Options surface.
- **Permission tree**: group `reports` (sidebar `reports`, label *Reports*,
  icon 📑), nodes `reports.view` (gate `REPORT_REVIEW_READ`) and
  `reports.approve` (gate `REPORT_REVIEW_APPROVE`, reauth `APPROVE_REPORT`),
  both configurable. Groups 12 → 13, nodes 53 → 55, feature privileges 41 → 43;
  the frozen `legacy-maps-snapshot.ts` is extended by appending.
- **Re-auth actions** (48 → 50): `APPROVE_REPORT`, `REJECT_REPORT`, category
  *Reports* (categories stay 8). `DOWNLOAD_REPORT` keeps gating the request —
  its label already reads "Download / Generate a Report".
- **Audit actions** (98 → 102) and templates (92 → 96): `REPORT_REVIEW_REQUESTED`,
  `REPORT_REVIEW_APPROVED`, `REPORT_REVIEW_REJECTED`, `REPORT_DOWNLOADED`, in
  the existing *Reports* audit category. `signature_meaning` is VarChar(255):
  titles are clamped to 80 chars in the sentence (the `codeLabel()` precedent).
- **Notifications**: the three existing `NotificationType` values, in-app
  only, via `createNotification` (`forUserId` = username, or `forRole`). The
  email/SMS notification RULES are keyed on `NotificationEventType`, which has
  no report events; adding them is out of scope and said so.

## Web

- **`ReportDownloadDialog`** gains an assignee picker (`Send to`: a user list
  from `GET /api/users?limit=ALL` filtered to active, or a role from
  `GET /api/roles/active`; one radio pair) and its confirm button reads
  *Request approval*. `ReportDownloadRequest` gains `assignee`. Every one of
  the eight triggers replaces `logReportExport` + `report.save()` with
  `submitReportForReview({ snapshot: report.getSnapshot(), reportType, title,
  subtitle, requestMeta, remarks, assignee, password })` inside the same
  `reauth.executeWithResult('DOWNLOAD_REPORT', …)`. Success toast: *Sent to
  <name> for approval — see Reports.*
- **`lib/report-review.ts`** is rewritten to the new API (submit, list,
  fetch, approve, reject, downloadApproved, openDraft) and
  `SendForReviewButton` is deleted with the Audit page's mount of it.
- **`/reports` page** (`routes/reports/index.tsx`, sidebar item `reports`,
  route gated `REPORT_REVIEW_READ`): three tabs backed by `?list=`. Columns:
  Report, Period, Requested by / at, Send to, Status, Decided by / at. Row
  actions: *View draft* (any party; opens the DRAFT PDF in a new tab via a blob
  URL), *Approve* / *Reject* (assignee with `reports.approve`; dialog with
  remarks + `SignaturePasswordInput`; `postWithReauth`), *Download* (APPROVED,
  party). Canonical `<Pagination>`; a failed request renders an error, never
  "no reports".
- **Signatures on the PDF**: `createReport`'s `signatures` lines become
  `Requested By: <name> (<user id>) — <date-time>` and `Approved By: …`, from
  the review row, formatted with the administered date-time format. The DRAFT
  passes `draft: true`: no signature lines, and `DRAFT — NOT APPROVED` drawn
  diagonally in light grey on every page. The block appears on the last page
  as today; the page footer is unchanged.
- **Export Options** gating stays exactly as is (surface → may raise a request).

## Counts that move

models 35 → 36 · enums 12 → 13 · API modules 24 → 25 · permissions 42 → 44 ·
reauth actions 48 → 50 (categories 8) · audit actions 98 → 102, templates
92 → 96 (categories 7) · sidebar items 13 → 14 · routes 51 → 52 · tree groups
12 → 13, nodes 53 → 55, feature privileges 41 → 43. No config def, no page under
`routes/config/`, no worker task.

## Testing

- API e2e (`src/e2e/report-reviews.e2e.test.ts`): submit (user and role
  assignee; missing assignee 400; blank remarks 400; bad password 401); queue /
  mine / approved scoping incl. SUPER_ADMIN; `GET /:id` 404 for a non-party;
  approve and reject by user assignee, by role holder, refused for a
  non-assignee (403) and for the requester (403 SELF_APPROVAL — **SUPER_ADMIN
  exempt since 2026-09-08**, see CHANGELOG); second decision
  409; download-log only when APPROVED and only for a party; every action's
  audit row and notification. Runs against `compliance_core_db_test`, which
  must be migrated first.
- Shared: permission-tree and legacy-map snapshot tests re-pinned; reauth and
  audit registry counts.
- Web: dialog test (assignee required, request sent with the snapshot, nothing
  saved); one test per trigger asserting `submitReportForReview` is called and
  `save` is NOT (`trend-downloads.test.tsx`, card, alarms page, audit page);
  snapshot round-trip test — every section kind replays through
  `renderSnapshotToPdf` to the same autotable cells, notes, images and page
  count as the original (`lastAutoTable`, `getNumberOfPages`, the image spy);
  DRAFT watermark present / signatures absent, and the reverse for approved;
  Reports page mounted for real (three lists, actions by party and status,
  error state); sidebar parity and route-guard tests.
- Mutation checks: remove the `status: 'PENDING'` guard (409 test fails);
  remove the self-approval check; drop `draft` from the watermark; skip the
  download-log call before `save`.
- Sample DRAFT and APPROVED PDFs rendered to the scratchpad and read back
  before claiming the layout.

## Addendum (same day): approver roles are administered

Operator: *"that approval role should be configurable which role user should be
approved that role will set by super admin in configurations"*. Config def
`report-approvers` (SUPER_ADMIN, dynamic config page, one multiselect of active
roles via `dynamicOptionsSource`). `coerceApproverRoles()` in `@digilog/shared`
is the one reader. The server refuses a request to a role outside the list, to a
user whose role is outside it, and — with the list empty — every request, with a
message naming the fix. The Send-to picker offers only the configured roles and
the enabled users holding one, reading `GET /api/config/report-approvers/current`.
Ships empty and fails closed: nothing can be requested until a super admin sets a
role once. The list governs who a request may be SENT to; deciding still needs
`REPORT_REVIEW_APPROVE` and the assignment. Defs 30 → 31; nothing else moves.

## Out of scope, stated

Email/SMS for report events; a second review stage; editing or withdrawing a
request; expiring stale requests; the Excel export.
