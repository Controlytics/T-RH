# PM Schedule 3-Step Workflow + QNN + Exports — Plan

Feature: upload → review → approve workflow for PM schedules; one config maps each
action to a role; reject→resubmit loop; QNN (Quality Notification Number) per action
surfaced in Notifications; schedule export to PDF + Excel (uploaded/reviewed/approved
+ ids + timestamps); app-wide "Printed by <user> + date/time" on all PDF reports.

## Locked decisions
- QNN format: `QN-{YYYY}-{000001}` (sequential per year), generated per PM action.
- Granularity: extend existing **per-entry** PM approval (add a Review step). Not a new batch entity.
- Reject → edit & resubmit in place; remarks mandatory.
- Printed-by = full name + username, on every PDF report.
- SUPER_ADMIN bypasses role gates (consistent with existing approval configs).

## Phases
- [x] P1 — Config: DONE. Extended `pm-schedule-approval` → "PM Schedule Workflow" with workflowEnabled + uploadRole + reviewRole + approvalRole (role pickers, SUPER_ADMIN bypass).
- [x] P2 — Schema: DONE. Enum + PENDING_REVIEW/PENDING_APPROVAL; entry cols reviewed_by/_name/_at, review_remarks, rejected_by/_name/_at, rejection_stage; `quality_notifications` table + `qnn_seq` sequence; Prisma client regenerated; perm PM_REVIEW + privilege pm.review + reauth REVIEW_PM_SCHEDULE (reused REJECT_PM_SCHEDULE for review-stage reject). Applied via psql DDL (db push blocked by enum drift). shared rebuilt; API/web tsc clean.
- [x] P3 — Backend workflow: DONE. pm-workflow.ts (config reader + role gate + generateQnn). pm-approval.ts rewritten: reviewEntries (approve→PENDING_APPROVAL / reject→REJECTED stage REVIEW), approveEntries (PENDING_APPROVAL|PENDING→APPROVED), rejectEntries (stage APPROVAL), resubmit/edit → PENDING_REVIEW when workflow ON; QNN minted per action. pm-import: upload→PENDING_REVIEW when ON + 1 QNN/batch. Route POST /entries/review (PM_REVIEW + REVIEW_PM_SCHEDULE reauth). /due unchanged (APPROVED only). **Workflow defaults OFF** (getPmWorkflowConfig + def) so current behavior is preserved until P4 review UI ships. API tsc clean.
- [ ] P4 — Frontend: reviewer (modify/reject) + approver (approve/reject) screens; reject→redo loop; show uploaded/reviewed/approved.
- [x] P4 — Frontend: review/approve/reject UI + new statuses + tabs DONE. Reviewer **inline-modify** DONE: PUT /entries/:id/review-edit (PM_REVIEW + REVIEW_PM_SCHEDULE), modifyReviewEntry keeps PENDING_REVIEW + mints QNN; "Modify" button + Save routing on PENDING_REVIEW rows.
- [x] P5 — Exports: DONE. Backend pm-export.ts + GET /entries/export.xlsx (ExcelJS, full trail). Frontend Export PDF (createReport, pages all entries) + Export Excel buttons. Verified: xlsx 200/PK.
- [x] P6 — QNN notifications: DONE. generateQnn also createNotification(type PM_SCHEDULE_QNN, routed to next-actor role). Enum value added (DB + schema + union). Verified: approve → QN-2026-000001 in quality_notifications + notifications.
- [x] P7 — App-wide print stamp: DONE. pdf-report.ts loadCurrentUser() + "Printed by <user> · <datetime>" centered in the footer of every report.

## Reusable patterns (from exploration)
- Approval state machine: block-change-requests (status + requestedBy/processedBy + role gate via config).
- Config def: `config/defs/*.def.ts` + `config-discovery.ts` import + `config/index.tsx` card; dynamic page renders automatically; `dynamicOptionsSource: '/api/roles/active'` for role selects.
- PDF: `apps/web/src/lib/pdf-report.ts` createReport (header has date/time, NO user yet); report-page-wrapper shows "By: <user>" for HTML.
- Excel: backend ExcelJS (no shared helper; hand-rolled per service, e.g. filter-upload-template.service.ts).
- Notifications: existing Notifications center + notification-rules.
