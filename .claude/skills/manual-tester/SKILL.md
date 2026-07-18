---
name: manual-tester
description: This skill should be used when the user asks to "test the app", "run manual tests", "test the filter operations", "test the cleaning pipeline", "test entity pages", "test delete functionality", "verify data in browser", or needs to perform end-to-end manual testing of the DigiLog platform — driving the UI, exercising filter cleaning cycles, and verifying data in the database and browser.
version: 0.2.0
---

# Manual Tester — DigiLog Platform

This skill provides structured workflows for manually testing the DigiLog 21 CFR Part 11 platform. It covers driving the web UI, exercising the Digital Filter Management cleaning pipeline, verifying data in the browser, and testing delete operations.

> **Scope note:** DigiLog's data-ingestion subsystem (MQTT/HTTP telemetry, TimescaleDB, connectivity, alarms, rule chains) was removed in Phase 7 (2026-06). This skill only covers what survives: the filter/entity UI, cleaning cycles, PM schedules, audit trail, and delete operations. There is no telemetry ingestion, no MQTT broker, and no alarm subsystem to test.

## Prerequisites

Before starting any test:

1. **Local dev (Windows only — there is no live server):** Run `start-digilog.bat` from the project root, or start the two processes manually:
   ```bash
   cd apps/api && npx tsx watch src/app.ts     # API on http://localhost:3000
   cd apps/web && npx vite --host              # Frontend on http://localhost:5175
   ```
2. Confirm the API is up:
   ```bash
   curl http://localhost:3000/api/health
   ```
3. Frontend: `http://localhost:5175`. Swagger: `http://localhost:3000/docs`.
4. Default login: `superadmin` / `Admin@123` (forced change on first login).

## Test Workflow 1: Entity / Filter UI Verification

1. Navigate to `http://localhost:5175` → **Filters** (or the entity/hierarchy pages).
2. Confirm the hierarchy tree renders (Block → Area → AHU → Filter).
3. Click a filter and verify its detail panel: name, status, filter profile, current lifecycle state.
4. Check for unstyled UI elements and console errors that return unexpected responses (open DevTools → Console).

## Test Workflow 2: Digital Filter Management (Cleaning Pipeline)

### Filter Operations (API)
```bash
# Start a cleaning cycle
curl -X POST "http://localhost:3000/api/filters/<filterId>/start-cycle" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Scheduled cleaning", "cleaningReasonId": "scheduled"}'

# Advance to next stage
curl -X POST "http://localhost:3000/api/filters/<filterId>/advance" \
  -H "Authorization: Bearer <JWT>"

# Submit checklist answers
curl -X POST "http://localhost:3000/api/filters/<filterId>/submit-checklist" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"checklistId": "<id>", "answers": {"q1": true, "q2": "Clean"}}'

# Get current filter state (full server snapshot)
curl "http://localhost:3000/api/filters/<filterId>/current-state" \
  -H "Authorization: Bearer <JWT>"
```

### UI Verification (Filter Management)
1. Navigate to **Filter Management > Operations** — verify the stage grid with filter counts.
2. Click a filter card → verify current state, stage, and available actions.
3. Start a cycle → verify the stage advances through the pipeline (WASH_IN → WASH_OUT → DRY_IN → DRY_OUT → STORAGE_IN → STORAGE_OUT).
4. Verify checklist gates block advancement until submitted.
5. Navigate to **Cleaning Cycles** — verify completed cycles and the event timeline.
6. Navigate to **PM Schedules** — verify schedule entries and execution tracking.

### Database Verification (Cleaning Pipeline)
```sql
-- Cleaning cycles
SELECT id, status, "startedAt", "completedAt" FROM cleaning_cycles ORDER BY "startedAt" DESC;

-- Filter events
SELECT id, "eventType", "filterId", "createdAt" FROM filter_events ORDER BY "createdAt" DESC;

-- PM executions
SELECT id, status, "completedAt" FROM pm_executions ORDER BY "createdAt" DESC;
```

Local DB connection: `PGPASSWORD=digilog123 psql -h localhost -U digilog -d digilog_db`.

## Test Workflow 3: Delete Operations

DigiLog has several delete surfaces. Test each against its permission gate:

1. **Entity / filter delete** — from the Filters page, confirm delete is gated (SUPER_ADMIN bypasses; other roles need the relevant `FILTER_*` / `ASSET_*` grant). Verify soft-delete entities allow name reuse afterward.
2. **Audit record delete** — `AUDIT_DELETE` permission (off by default). A permanent hard-delete breaks the tamper-evident hash chain on purpose; `GET /api/audit/verify-chain` will report the chain invalid afterward. Prefer **REDACT** (chain-preserving) for normal use.
3. After any delete, verify the row is gone in the DB and the UI reflects the change (no stale rows, no console errors).

## Test Workflow 4: Browser Verification Checklist

For every page touched during a test session:
- No unstyled UI elements (missing Tailwind classes, raw HTML).
- No console logs that return unexpected responses (401/403/500, `Unexpected token '<'`, parse errors).
- Datetimes render via the app's formatter (no raw ISO strings leaking into the UI).
- Permission-gated buttons appear/disappear correctly per role (log out/in after a role grant — perms are baked at login).
