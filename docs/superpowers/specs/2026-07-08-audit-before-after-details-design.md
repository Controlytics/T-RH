# Audit Trail — Complete Before/After Details for Every Edit

**Date:** 2026-07-08
**Status:** Approved design — pending spec review
**Branch:** RFID

## Problem

When a user changes a field (e.g. editing a filter in the filter list), the Audit
Trail record does not clearly show the previous value and the updated value. The
user wants, for every entity edit on every page, a clear "previous → updated" view,
with the full record also available.

Investigation found **two independent gaps**:

1. **Capture gap.** The audit schema already supports `beforeValue` + `afterValue`
   (`apps/api/src/lib/audit.ts`), but not every edit path records the "before":
   - **Confirmed primary gap:** the typed filter-edit path
     `apps/api/src/modules/assets/services/filter.service.ts` `update()` logs
     `ASSET_UPDATED` with **only `afterValue`** (line ~114-117). This is the
     filter-list edit the user reported. Live DB confirms `ASSET_UPDATED` has a
     `before_value` in only 35 of 80 rows — the 45 without are this typed path.
   - Most other entity services **already** capture before: users
     (`USER_UPDATED`), roles (`ROLE_UPDATED`, 99/99), cleaning-profiles
     (`UPDATED`), equipment-groups (`EQUIPMENT_GROUP_UPDATED`), PM
     (`pm-schedule-crud`, `pm-ahu-config`), and the generic asset path
     `instance.service.ts` `update()` (which also covers Block/Area/AHU hierarchy
     edits, since those are `AssetInstance`s).
   - **To verify during implementation:** checklist-profile updates — the service
     currently only audits `CREATED` (a versioned entity; may capture "before" as
     the prior version snapshot or may need a before added).

2. **Render gap.** The audit detail modal
   (`apps/web/src/routes/audit/components/audit-detail-modal.tsx`) already has
   "Previous Value" / "New Value" panels, but:
   - They are inside the **`isSuperAdmin`-only** block — non-admin roles never see
     before/after even when it is captured. This is the main reason "complete
     details" appear missing to most users.
   - They render the full before object and full after object as two flat lists —
     there is **no per-field diff** highlighting what actually changed.

## Goals

- Every entity **edit** action captures `beforeValue` + `afterValue` (scope: all
  entity-edit pages — filters, users, roles, config, checklists, cleaning
  profiles, equipment groups, PM schedules, hierarchy/Block/Area/AHU).
- The audit detail view shows a **"Changes" summary** (only the fields that
  differ, `old → new`) plus the **full previous/new record**, collapsible.
- Before/after (and the Changes summary) are visible to **all roles** that can
  open the Audit page, not just SUPER_ADMIN.
- **Sensitive fields are masked** (passwords, hashes, secrets, tokens) — never
  stored in audit, and shown as `••••••` at render as a safety net.

## Non-Goals

- Actions with no natural "before" are not forced to fabricate one. Creates are
  after-only; deletes are before-only; logins / cycle steps / approvals /
  checklist submissions are event records, not field diffs (Scope B, not C).
- No change to the immutable, hash-chained audit storage format, and **no data
  migration**. Only what *new* rows capture changes; historical rows are
  untouched. The Changes diff is computed at render, so it also benefits existing
  rows that already carry before + after.

## Design

### 1. Capture (backend)

- **Shared helper** for edit audits — a small function (e.g.
  `apps/api/src/lib/audit-diff.ts` `sanitizeAuditValue()` / `buildEditAudit()`)
  that:
  - strips sensitive keys (see §3) from a snapshot so secrets are **never
    persisted** in `before_value` / `after_value`;
  - is used by each edit path to pass a clean `beforeValue` + `afterValue`.
- **Touch each edit path that lacks a before-snapshot**, starting with
  `filter.service.ts` `update()`: read the current record before mutating (or
  reuse the already-fetched row) and pass `beforeValue` with the same field set as
  `afterValue`. The existing well-formed services (users, roles, cleaning
  profiles, equipment groups, PM, instance) are reviewed and only adjusted where a
  gap or secret exposure is found.
- Before/after field sets should be **symmetric** (same keys) so the render-time
  diff is meaningful.

### 2. Render (frontend)

In `audit-helpers.ts` (logic) + `audit-detail-modal.tsx` (presentation):

- **`diffAuditValues(before, after)`** helper in `audit-helpers.ts`: returns the
  list of `{ field, from, to }` for keys whose values differ (deep-equal compare;
  UUID-valued keys pruned as today; sensitive keys masked). Unit-tested in
  `audit-helpers.test.ts`.
- **"Changes" section** at the top of the detail modal: renders `Field: old → new`
  for each diff entry. Shown whenever both before and after exist and differ.
- **Full "Previous Value" / "New Value"** panels retained but **collapsed by
  default** (expandable), below the Changes section.
- **Move the before/after + Changes rendering OUT of the `isSuperAdmin` block** so
  all roles see it. (SUPER_ADMIN-only items like IP address / checksum stay gated
  as they are today.)

### 3. Sensitive masking

- A denylist of key names (case-insensitive substring match), e.g.:
  `password`, `passwordHash`, `hash`, `secret`, `token`, `apiKey`, `privateKey`,
  `smtpPassword`, `credential`.
- **Capture:** the sanitize helper removes these keys from snapshots before they
  are written.
- **Render:** any surviving denied key (e.g. in historical rows) renders as
  `••••••` in both the Changes summary and the full panels.

## Data Flow

```
edit request → service.update()
   ├─ read current row  → beforeSnapshot
   ├─ mutate             → afterSnapshot
   └─ auditLog({ action, beforeValue: sanitize(before), afterValue: sanitize(after) })
                         → hash-chained audit_trail row (secrets already stripped)

Audit page → open record → audit-detail-modal
   ├─ diffAuditValues(before, after) → Changes: Field old → new   (all roles)
   ├─ Full Previous / New (collapsed, masked)                     (all roles)
   └─ IP / checksum / role                                        (SUPER_ADMIN)
```

## Compliance & Safety

- **Hash chain / immutability:** unaffected. No existing rows are modified; the
  checksum field set in `audit.ts` already includes `beforeValue`, so newly
  captured befores are inside the tamper-evidence envelope automatically.
- **Sensitive exposure:** making before/after visible to all audit-viewers is an
  intentional decision; the masking denylist (§3) is the control that keeps
  secrets out of view. The Audit page itself remains permission-gated
  (`AUDIT_READ`).

## Testing

- **Backend:** assert the filter edit now writes a `beforeValue` with the pre-edit
  field values (extend the filter e2e area). Assert the sanitize helper drops a
  `password`/`passwordHash` key from a snapshot.
- **Frontend:** unit-test `diffAuditValues` in `audit-helpers.test.ts` — changed-
  only output, `old → new` ordering, sensitive-key masking, no-change → empty.

## Files (approximate)

- `apps/api/src/lib/audit-diff.ts` — new sanitize/edit-audit helper
- `apps/api/src/modules/assets/services/filter.service.ts` — add before to `update()`
- (sweep) other in-scope services where a before is missing or a secret leaks
- `apps/web/src/routes/audit/audit-helpers.ts` — `diffAuditValues` + masking
- `apps/web/src/routes/audit/audit-helpers.test.ts` — diff tests
- `apps/web/src/routes/audit/components/audit-detail-modal.tsx` — Changes section,
  collapsible full panels, un-gate for all roles
- Docs: `CHANGELOG.md`, memory

## Out of Scope

- Non-edit event actions (login/logout, cycle steps, approvals) — Scope C, excluded.
- Any change to audit storage format or a data migration.
