# Replacement Tasks — "all AHU filters" scope + status tabs (2026-06-15)

Per user: a replacement task should cover ALL active filters under the AHU
(ignore the uploaded Qty), complete only when every filter is replaced. Add
Pending/Completed views on the tablet page and show full filter details.

## Model
`replace()` retires the old filter + creates a NEW active filter under the same
AHU (tag carried over) → AHU active-filter count is invariant.
- newFilterIds(entry) = ReplacementExecution.newFilterId for that entry
- total   = active FILTER instances under entry.ahuId  (= original count)
- remaining = total filters whose id is NOT a newFilterId (originals not yet replaced)
- replaced = total - remaining
- COMPLETED ⟺ total > 0 && remaining === 0

## Backend (apps/api/src/modules/replacement-schedule/)
- [ ] service.ts: `deriveTaskStatus(entry, remaining, total, today)` (COMPLETED/MISSED/IN_PROGRESS/DUE/PENDING)
- [ ] service.ts: `listTaskEntries()` — ALL approved entries, batched AHU-filter + execution lookups, returns total/remaining/replaced/replacedNewFilterIds + computedStatus; alias qty=total, qtyRemaining=remaining for FE compat
- [ ] service.ts: `executeReplacement` — drop qty-based ALREADY_COMPLETE + COMPLETED; block when AHU remaining===0; mark COMPLETED when remaining hits 0 post-replace
- [ ] routes.ts: `GET /tasks` (any role, mirrors /due auth) → listTaskEntries()

## Frontend (apps/web/src/routes/mobile/mobile-wrapper.tsx)
- [ ] Switch replDue fetch to /tasks
- [ ] Tabs: Pending (not completed) | Completed
- [ ] Task detail: "remaining of total still to replace"; pick-list excludes replacedNewFilterIds; show full filter details per row
- [ ] Completed tab: read-only list (replaced/total + last date)

## Verify
- [ ] tsc api clean; browser test at tablet viewport; rebuild APK
