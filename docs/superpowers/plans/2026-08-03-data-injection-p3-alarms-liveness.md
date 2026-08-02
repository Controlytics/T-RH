# Data Injection P3 — Alarms & Device Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an out-of-spec telemetry reading produce a latched, e-signed excursion record, and make an instrument that stops reporting produce a device-offline event.

**Architecture:** A pure threshold evaluator and a pure state machine (no database access, following the `fan-out.ts` precedent) are called from `flushNow()` strictly *after* `writeBatch` resolves, so an alarm can never reference a reading that failed to persist. Liveness is a persisted per-instrument state driven by a graphile-worker cron sweep. Both paths emit through the already-production-proven `dispatchNotification()`.

**Tech Stack:** Fastify 5, Prisma 6, PostgreSQL 18, graphile-worker, vitest, React 19 + SWR + Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-03-data-injection-p3-alarms-liveness-design.md`

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Branch is `data-injection`.** Never commit to `final-user-management` — it is a frozen backup.
- **Run every Prisma command from `apps/api`, or pass `DATABASE_URL` explicitly.** The repo-root `.env` resolution has previously targeted the *sibling* `digilog_db`. This repo's database is `compliance_core_db`; tests use `compliance_core_db_test`.
- **`prisma db push` and `prisma migrate dev` auto-generation are FORBIDDEN.** Migrations are hand-authored: edit `schema.prisma` → `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` → review and strip out-of-band noise → hand-author into `prisma/migrations/<UTC-timestamp>_<name>/migration.sql` → `npm run db:verify-migrations` must PASS before commit.
- **All new timestamp columns are `timestamptz`** (`@db.Timestamptz(3)`). P2 shipped a bare `timestamp` that rendered a −19790s age on this IST host while every test passed.
- **`npx tsc --noEmit -p apps/api/tsconfig.json` and the `apps/web` equivalent are part of "done" for every task.** vitest runs through esbuild and strips types without checking them.
- **Run the API suite single-fork:** `cd apps/api && npm test` (wired to `--pool=forks --poolOptions.forks.singleFork=true`). Direct `npx vitest run` produces flaky failures that are not real bugs.
- **Stop the app before `prisma generate`** (`stop-app.bat`). The binary copy fails with EPERM while a dev server holds `query_engine-windows.dll.node`, leaving a stale client whose looser types hide real mismatches.
- **Any test touching alarms, thresholds or liveness creates its own scratch instrument and hierarchy node.** No test mutates shared rows or shared schema.
- **Never swallow exceptions.** `flushNow`'s interval callback already does (`ingestion.service.ts:111`); nothing added in this plan may rely on that path for error visibility.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/api/src/modules/alarms/threshold-evaluator.ts` | Pure. Given a reading and thresholds, decide breach/recovered. No DB. |
| `apps/api/src/modules/alarms/alarm-state.ts` | Pure. Given current state + event, return the next state and field mutations. No DB. |
| `apps/api/src/modules/alarms/alarm.repository.ts` | All database access for alarms, thresholds and liveness. |
| `apps/api/src/modules/alarms/alarm.service.ts` | Orchestration: evaluate a flush's batches, persist transitions, dispatch notifications, write audit. |
| `apps/api/src/modules/alarms/routes.ts` | REST surface: alarm list/get/ack, threshold CRUD. |
| `apps/api/src/workers/liveness-sweep.worker.ts` | The `instrument_liveness_sweep` graphile-worker task. |
| `apps/api/src/workers/task-list.ts` | Extracted `taskList` map so it can be asserted against `crontab.txt`. |
| `apps/web/src/routes/data-injection/alarms.tsx` | Alarm queue page. |
| `apps/web/src/routes/data-injection/alarm-ack-dialog.tsx` | Acknowledgement dialog with mandatory reason + reauth. |
| `apps/web/src/routes/data-injection/instrument-thresholds.tsx` | Threshold management, embedded in instrument detail. |

**Modified**

| File | Change |
|---|---|
| `packages/shared/src/types/reauth-actions.ts` | Add missing `'Data Injection'` category (live P1 bug); add 2 alarm actions. |
| `packages/shared/src/types/permissions.ts` | +3 permission constants. |
| `packages/shared/src/types/permission-tree.ts` | +3 nodes, +1 sidebar group entry. |
| `packages/shared/src/types/sidebar-items.ts` | +1 sidebar item. |
| `packages/shared/src/types/audit-actions.ts` | +6 audit actions. |
| `apps/api/prisma/schema.prisma` | +3 models, +4 enums, +1 column, +2 enum members. |
| `apps/api/src/lib/audit.ts` | Add system-emitted alarm actions to `SYSTEM_AUDIT_ACTIONS`. |
| `apps/api/src/modules/data-injection/ingestion.service.ts` | Call the evaluator after `writeBatch`. |
| `apps/api/src/modules/notification-delivery/notification-dispatcher.ts` | Widen 4 maps. |
| `apps/api/src/modules/notification-rules/routes.ts` | Widen `EVENT_CATALOG`. |
| `apps/api/src/app.ts` | Import `taskList` from the new module; register `alarms` routes. |
| `packages/queue/crontab.txt` | +1 cron line. |
| `apps/web/src/components/layout/sidebar.tsx` | Export `allNavItems`; +1 nav item. |
| `apps/web/src/main.tsx` | +1 route. |
| `apps/web/src/routes/data-injection/instrument-detail.tsx` | Embed thresholds panel + open-alarm strip. |

---

## Task 1: Fix the `REAUTH_ACTION_CATEGORIES` omission (live P1 bug)

**Why this is first:** 12 P1 reauth actions declare `category: 'Data Injection'`, but that string is absent from `REAUTH_ACTION_CATEGORIES`. Both editors build their lists with `REAUTH_ACTION_CATEGORIES.map(...)` (`apps/web/src/routes/config/action-reauth.tsx:67`, `apps/web/src/routes/config/roles-components/reauth-tab.tsx:58`), so **all 12 render nowhere and their reauth policy can never be set.** The file's own comment documents this exact failure for two earlier categories. The alarm actions added in Task 11 would inherit the bug.

**Files:**
- Modify: `packages/shared/src/types/reauth-actions.ts:119-133`
- Test: `packages/shared/src/types/reauth-actions.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `'Data Injection'` present in `REAUTH_ACTION_CATEGORIES`, so Task 11's actions are configurable.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/types/reauth-actions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { REAUTH_ACTIONS, REAUTH_ACTION_CATEGORIES } from './reauth-actions.js';

describe('REAUTH_ACTION_CATEGORIES', () => {
  it('contains every category referenced by an action', () => {
    const declared = new Set<string>(REAUTH_ACTION_CATEGORIES);
    const orphans = Object.entries(REAUTH_ACTIONS)
      .filter(([, def]) => !declared.has(def.category))
      .map(([key, def]) => `${key} (category='${def.category}')`);

    // An action whose category is absent renders in NEITHER reauth editor —
    // action-reauth.tsx:67 and roles-components/reauth-tab.tsx:58 both build
    // their lists by mapping REAUTH_ACTION_CATEGORIES. Its policy can never
    // be set, so the reauth gate silently never applies.
    expect(orphans).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run packages/shared/src/types/reauth-actions.test.ts`
Expected: FAIL, listing the 12 Data Injection actions as orphans.

- [ ] **Step 3: Add the missing category**

In `packages/shared/src/types/reauth-actions.ts`, inside the `REAUTH_ACTION_CATEGORIES` array, after `'Help',`:

```ts
  // Added 2026-08-03 (P3 Task 1). The 12 Data Injection actions added in P1
  // declared category:'Data Injection' but the string was never added here,
  // so none of them rendered in either reauth editor and their policy could
  // never be set. Same failure class as the Notifications / Super Admin
  // omission documented below.
  'Data Injection',
```

- [ ] **Step 4: Run the test and the shared suite**

Run: `npx vitest run packages/shared/src/types/reauth-actions.test.ts`
Expected: PASS.
Run: `npm run build -w @digilog/shared && npx vitest run packages/shared`
Expected: no NEW failures beyond the known-failing baseline of 3.

- [ ] **Step 5: Verify in the browser**

Start the app (`start-app.bat`), log in as `superadmin`, open Configuration → Action Re-auth. A **Data Injection** section must now appear listing all 12 actions. Confirm the same section appears on Configuration → Roles & Access → Re-auth tab.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/reauth-actions.ts packages/shared/src/types/reauth-actions.test.ts
git commit -m "fix: add missing Data Injection reauth category

All 12 P1 Data Injection reauth actions declared category:'Data Injection'
but the string was absent from REAUTH_ACTION_CATEGORIES. Both editors build
their lists by mapping that array, so none of the actions rendered and their
reauth policy could never be set. Test now asserts no action references an
undeclared category."
```

---

## Task 2: Extract `taskList` and guard cron registration

**Why:** `packages/queue/crontab.txt` documents that graphile-worker silently enqueues jobs for identifiers with no handler and never completes them. This repo reached **51,798 orphan rows** that way. Task 10 adds a cron line; this guard must exist before it does. The `taskList` is currently an object literal inline in `app.ts:436-448`, unreachable from a test.

**Files:**
- Create: `apps/api/src/workers/task-list.ts`
- Create: `apps/api/src/workers/__tests__/task-list.test.ts`
- Modify: `apps/api/src/app.ts:436-448`

**Interfaces:**
- Produces: `export const taskList: TaskList` from `apps/api/src/workers/task-list.ts`. Task 10 adds its handler to this map.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/workers/__tests__/task-list.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { taskList } from '../task-list.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRONTAB = path.resolve(__dirname, '../../../../../packages/queue/crontab.txt');

/** Cron line shape: `m h dom mon dow  task_name  ?opts` — 5 time fields then the id. */
function crontabTaskIds(text: string): string[] {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .map(l => l.split(/\s+/)[5])
    .filter((id): id is string => Boolean(id));
}

describe('crontab / taskList registration', () => {
  it('every crontab identifier has a handler', () => {
    const ids = crontabTaskIds(readFileSync(CRONTAB, 'utf8'));
    expect(ids.length).toBeGreaterThan(0);   // guards against a bad parse silently passing

    // graphile-worker does NOT reject an unknown identifier — it enqueues the
    // job and leaves it queued forever. This repo reached 51,798 orphan rows
    // from three such entries. See the header of crontab.txt.
    const unhandled = [...new Set(ids)].filter(id => !(id in taskList));
    expect(unhandled).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd apps/api && npx vitest run src/workers/__tests__/task-list.test.ts`
Expected: FAIL — `Cannot find module '../task-list.js'`.

- [ ] **Step 3: Create the extracted module**

Create `apps/api/src/workers/task-list.ts`:

```ts
/**
 * The single graphile-worker task registry.
 *
 * Extracted from app.ts so `__tests__/task-list.test.ts` can assert that every
 * identifier in packages/queue/crontab.txt has a handler here. graphile-worker
 * silently enqueues jobs for unknown identifiers and never completes them; three
 * such entries once left 51,798 orphan rows in graphile_worker.jobs.
 *
 * Adding a cron line and adding its handler here are ONE change, never two.
 */
import type { TaskList } from 'graphile-worker';
import { notificationTask } from './notification.worker.js';
import { passwordExpiryCheckTask } from './password-expiry.worker.js';
import { sessionSweepTask } from './session-sweep.worker.js';
import { telemetryPartitionTask } from './telemetry-partition.worker.js';

export const taskList: TaskList = {
  // `notification` closes the producer/consumer gap flagged in the 2026-05-12
  // review — before it existed, enqueueNotificationJob posted to a task name
  // with no handler and jobs leaked forever.
  notification: notificationTask,
  password_expiry_check: passwordExpiryCheckTask,
  session_sweep: sessionSweepTask,
  telemetry_partition_maintenance: telemetryPartitionTask,
};
```

- [ ] **Step 4: Run the test**

Run: `cd apps/api && npx vitest run src/workers/__tests__/task-list.test.ts`
Expected: PASS.

- [ ] **Step 5: Point `app.ts` at the extracted map**

In `apps/api/src/app.ts`, remove the four now-unused worker imports (`notificationTask`, `passwordExpiryCheckTask`, `sessionSweepTask`, `telemetryPartitionTask`) and add:

```ts
import { taskList } from './workers/task-list.js';
```

Replace the inline `taskList: { ... }` object in the `startJobRunner({ ... })` call with:

```ts
    await startJobRunner({
      taskList,
      crontabPath,
    });
```

- [ ] **Step 6: Typecheck and confirm the runner still starts**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: no errors (in particular, no unused-import errors).
Run: `start-app.bat`, then check the API log for `graphile-worker job runner started`, and `GET /api/health` reports `jobRunner` healthy.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/workers/task-list.ts apps/api/src/workers/__tests__/task-list.test.ts apps/api/src/app.ts
git commit -m "refactor: extract graphile-worker taskList and guard cron registration

A crontab identifier with no handler enqueues jobs that never complete;
three such entries once left 51,798 orphan rows. taskList moves out of the
app.ts closure so a test can assert every crontab id is handled."
```

---

## Task 3: Sidebar parity test

**Why:** `SIDEBAR_ITEMS` (`packages/shared/src/types/sidebar-items.ts`) drives the Roles & Access config page; `allNavItems` (`apps/web/src/components/layout/sidebar.tsx:~30`) actually renders the nav. They are independent lists. During P1 only the first was updated and the feature shipped with **no navigation link** — every review passed because nothing in any diff was wrong; the omission lived in a file nobody touched. Task 12 adds a sidebar item, so the guard goes in first.

**Files:**
- Modify: `apps/web/src/components/layout/sidebar.tsx` (export `allNavItems`)
- Create: `apps/web/src/components/layout/__tests__/sidebar-parity.test.ts`

**Interfaces:**
- Produces: `export const allNavItems` from `sidebar.tsx`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/layout/__tests__/sidebar-parity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SIDEBAR_ITEMS } from '@digilog/shared';
import { allNavItems } from '../sidebar';

describe('sidebar list parity', () => {
  it('SIDEBAR_ITEMS and allNavItems hold the same ids', () => {
    const configured = SIDEBAR_ITEMS.map(i => i.id).sort();
    const rendered = allNavItems.map(i => i.id).sort();

    // These two lists are independent. SIDEBAR_ITEMS drives the Roles & Access
    // toggles; allNavItems renders the nav. Updating only the first ships a
    // feature that is grantable but has no link; updating only the second
    // ships a link that no role can be granted.
    expect(rendered).toEqual(configured);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `cd apps/web && npx vitest run src/components/layout/__tests__/sidebar-parity.test.ts`
Expected: FAIL — `allNavItems` is not exported.

- [ ] **Step 3: Export the list**

In `apps/web/src/components/layout/sidebar.tsx`, change the declaration:

```ts
// Exported for the parity test — this list and SIDEBAR_ITEMS in
// packages/shared must hold the same ids. See __tests__/sidebar-parity.test.ts.
export const allNavItems: NavItem[] = [
```

- [ ] **Step 4: Run the test**

Run: `cd apps/web && npx vitest run src/components/layout/__tests__/sidebar-parity.test.ts`
Expected: PASS. If it FAILS with a real mismatch, that is a pre-existing bug — fix the omission and note it in the commit message.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/layout/sidebar.tsx apps/web/src/components/layout/__tests__/sidebar-parity.test.ts
git commit -m "test: assert SIDEBAR_ITEMS and allNavItems hold the same ids

The two lists are independent and a P1 feature shipped with no nav link
because only one was updated."
```

---

## Task 4: Schema, enums and the hand-authored migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<UTC-timestamp>_p3_alarms_liveness/migration.sql`

**Interfaces:**
- Produces: Prisma models `AlarmThreshold`, `Alarm`, `InstrumentLiveness`; enums `AlarmState`, `AlarmSeverity`, `ThresholdOperator`, `LivenessState`; `Instrument.expectedIntervalSec`.

- [ ] **Step 1: Add enums to `schema.prisma`**

Place next to the existing `TopicCategory` enum:

```prisma
enum AlarmState {
  ACTIVE
  ACTIVE_ACKED
  RESOLVED_UNACKED
  CLOSED
}

enum AlarmSeverity {
  CRITICAL
  MAJOR
  MINOR
  INFO
}

enum ThresholdOperator {
  GT
  GTE
  LT
  LTE
  EQ
  NEQ
  OUT_OF_RANGE
}

enum LivenessState {
  ONLINE
  OFFLINE
  UNKNOWN
}
```

- [ ] **Step 2: Add the three models**

```prisma
model AlarmThreshold {
  id           String            @id @default(uuid())
  instrumentId String            @map("instrument_id")
  key          String
  operator     ThresholdOperator
  limit        Float?
  limitLow     Float?            @map("limit_low")
  limitHigh    Float?            @map("limit_high")
  hysteresis   Float             @default(0)
  severity     AlarmSeverity
  isActive     Boolean           @default(true) @map("is_active")
  createdAt    DateTime          @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt    DateTime          @updatedAt @map("updated_at") @db.Timestamptz(3)
  createdBy    String?           @map("created_by")

  instrument Instrument @relation(fields: [instrumentId], references: [id], onDelete: Restrict)
  alarms     Alarm[]

  @@unique([instrumentId, key, operator])
  @@index([instrumentId])
  @@map("alarm_thresholds")
}

// An alarm series is (instrument, key, THRESHOLD) — not (instrument, key).
// AlarmThreshold is unique on (instrumentId, key, operator), so one telemetry
// key can carry both a high and a low limit. If the series omitted thresholdId,
// a reading of 105 against `GT 100` + `LT 10` would raise on the GT spec and
// then, in the SAME loop iteration set, satisfy the LT spec's recovery test
// (105 >= 10) and immediately resolve the alarm it had just raised.
//
// Enforced by TWO partial unique indexes created in raw SQL — Prisma can express
// neither, so neither appears as an @@unique here. See
// alarms_one_open_per_threshold_key and alarms_one_open_liveness_key in
// migration <timestamp>_p3_alarms_liveness. Do NOT delete them as "untracked":
// without them two concurrent flushes can both raise for the same series and the
// re-trigger counter silently becomes two rows.
model Alarm {
  id           String        @id @default(uuid())
  instrumentId String        @map("instrument_id")
  key          String
  thresholdId  String?       @map("threshold_id")
  severity     AlarmSeverity
  state        AlarmState    @default(ACTIVE)
  firstBreachAt DateTime     @map("first_breach_at") @db.Timestamptz(3)
  lastBreachAt  DateTime     @map("last_breach_at") @db.Timestamptz(3)
  breachCount   Int          @default(1) @map("breach_count")
  triggerValue  Float?       @map("trigger_value")
  peakValue     Float?       @map("peak_value")
  resolvedAt    DateTime?    @map("resolved_at") @db.Timestamptz(3)
  ackedBy       String?      @map("acked_by")
  ackedAt       DateTime?    @map("acked_at") @db.Timestamptz(3)
  ackReason     String?      @map("ack_reason")
  closedAt      DateTime?    @map("closed_at") @db.Timestamptz(3)
  createdAt     DateTime     @default(now()) @map("created_at") @db.Timestamptz(3)

  instrument Instrument      @relation(fields: [instrumentId], references: [id], onDelete: Restrict)
  threshold  AlarmThreshold? @relation(fields: [thresholdId], references: [id], onDelete: Restrict)
  liveness   InstrumentLiveness[] @relation("OfflineAlarm")

  @@index([state, severity])
  @@index([instrumentId, key])
  @@index([firstBreachAt(sort: Desc)])
  @@map("alarms")
}

model InstrumentLiveness {
  instrumentId   String        @id @map("instrument_id")
  lastSeenAt     DateTime?     @map("last_seen_at") @db.Timestamptz(3)
  state          LivenessState @default(UNKNOWN)
  stateChangedAt DateTime?     @map("state_changed_at") @db.Timestamptz(3)
  offlineAlarmId String?       @map("offline_alarm_id")

  instrument   Instrument @relation(fields: [instrumentId], references: [id], onDelete: Cascade)
  offlineAlarm Alarm?     @relation("OfflineAlarm", fields: [offlineAlarmId], references: [id], onDelete: SetNull)

  @@index([state])
  @@map("instrument_liveness")
}
```

- [ ] **Step 3: Add the `Instrument` column and back-relations**

In `model Instrument`, add the column after `isActive`:

```prisma
  // NULL means "exempt from liveness monitoring". The sweep filters on this
  // column, which is why it is a column and not a key in InstrumentSetting.values.
  expectedIntervalSec Int? @map("expected_interval_sec")
```

and the back-relations alongside `setting` / `topics`:

```prisma
  thresholds AlarmThreshold[]
  alarms     Alarm[]
  liveness   InstrumentLiveness?
```

- [ ] **Step 4: Generate the diff and review it**

Run from `apps/api`:

```bash
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script
```

Read the output. Expected: `CREATE TYPE` ×4, `CREATE TABLE` ×3, `ALTER TABLE instruments ADD COLUMN`, plus indexes. **Discard any `DROP COLUMN "path"` or `ALTER audit_trail chain_position DROP NOT NULL`** — those are known false drift (ltree is `Unsupported`, and chain_position is a manual `BIGSERIAL`). Applying either is destructive.

- [ ] **Step 5: Hand-author the migration**

Create `apps/api/prisma/migrations/<UTC-timestamp>_p3_alarms_liveness/migration.sql` containing the reviewed diff, then append the partial unique index Prisma cannot express:

```sql
-- At most one OPEN alarm per (instrument, key, threshold), enforced in the
-- DATABASE and not only in evaluator logic — two concurrent flushes would
-- otherwise both INSERT and the re-trigger counter would silently become two
-- rows.
--
-- threshold_id is part of the key because one telemetry key can carry several
-- thresholds (a high limit and a low limit). Collapsing them into one series
-- makes a reading that breaches the high limit satisfy the low limit's recovery
-- test in the same pass, resolving the alarm it just raised.
CREATE UNIQUE INDEX alarms_one_open_per_threshold_key
  ON alarms (instrument_id, key, threshold_id)
  WHERE state <> 'CLOSED' AND threshold_id IS NOT NULL;

-- Liveness alarms carry threshold_id = NULL, and PostgreSQL treats NULLs as
-- DISTINCT in a unique index — so the index above gives them no guarantee at
-- all and a device could accumulate one offline alarm per sweep. This second
-- index covers exactly that case: at most one open liveness alarm per
-- instrument.
CREATE UNIQUE INDEX alarms_one_open_liveness_key
  ON alarms (instrument_id)
  WHERE state <> 'CLOSED' AND threshold_id IS NULL;
```

- [ ] **Step 6: Apply and verify no drift**

```bash
cd apps/api
npx prisma migrate deploy
npm run db:verify-migrations
```
Expected: `migrate deploy` applies cleanly; the drift guard **PASSES**. It must pass before commit.

- [ ] **Step 7: Regenerate the client with the app stopped**

```bash
stop-app.bat
cd apps/api && npx prisma generate
npx tsc --noEmit -p tsconfig.json
```
Expected: `generate` reports success with no EPERM, and the typecheck is clean. If EPERM appears, the app is still running — the client silently stays stale and hides type errors.

- [ ] **Step 8: Confirm the live counts moved as projected**

```bash
grep -cE "^model " apps/api/prisma/schema.prisma   # expect 36
grep -cE "^enum "  apps/api/prisma/schema.prisma   # expect 12
```

- [ ] **Step 9: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(db): add alarm, threshold and liveness models

Three models, four enums, one Instrument column. The one-open-alarm-per-series
rule is a partial unique index in raw SQL (Prisma cannot express it) and is
documented on the model so migrate diff does not propose dropping it.
Drift guard passes."
```

---

## Task 5: Pure threshold evaluator

**Files:**
- Create: `apps/api/src/modules/alarms/threshold-evaluator.ts`
- Create: `apps/api/src/modules/alarms/__tests__/threshold-evaluator.test.ts`

**Interfaces:**
- Consumes: `ThresholdOperator` from `@prisma/client`.
- Produces:
  - `export interface ThresholdSpec { id: string; key: string; operator: ThresholdOperator; limit: number | null; limitLow: number | null; limitHigh: number | null; hysteresis: number; severity: AlarmSeverity }`
  - `export type Verdict = 'BREACH' | 'RECOVERED' | 'NEUTRAL'`
  - `export function evaluate(spec: ThresholdSpec, value: number, isOpen: boolean): Verdict`
  - `export function numericValue(value: unknown): number | null`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/alarms/__tests__/threshold-evaluator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluate, numericValue, type ThresholdSpec } from '../threshold-evaluator.js';

const spec = (over: Partial<ThresholdSpec>): ThresholdSpec => ({
  id: 't1', key: 'temp', operator: 'GT',
  limit: 100, limitLow: null, limitHigh: null,
  hysteresis: 0, severity: 'MAJOR', ...over,
});

describe('numericValue', () => {
  it('accepts numbers and numeric strings', () => {
    expect(numericValue(21.5)).toBe(21.5);
    expect(numericValue('21.5')).toBe(21.5);
  });
  it('rejects non-numeric values rather than coercing them', () => {
    // Boolean/null/object readings are real (STATUS payloads), and Number(false)
    // is 0 — which would silently breach any `LT` threshold above zero.
    expect(numericValue(false)).toBeNull();
    expect(numericValue(null)).toBeNull();
    expect(numericValue('warm')).toBeNull();
    expect(numericValue({ v: 1 })).toBeNull();
  });
});

describe('evaluate — operators', () => {
  it('GT breaches strictly above the limit', () => {
    expect(evaluate(spec({}), 101, false)).toBe('BREACH');
    expect(evaluate(spec({}), 100, false)).toBe('NEUTRAL');
  });
  it('GTE breaches at the limit', () => {
    expect(evaluate(spec({ operator: 'GTE' }), 100, false)).toBe('BREACH');
  });
  it('LT breaches strictly below the limit', () => {
    expect(evaluate(spec({ operator: 'LT' }), 99, false)).toBe('BREACH');
    expect(evaluate(spec({ operator: 'LT' }), 100, false)).toBe('NEUTRAL');
  });
  it('LTE breaches at the limit', () => {
    expect(evaluate(spec({ operator: 'LTE' }), 100, false)).toBe('BREACH');
  });
  it('EQ and NEQ compare exactly', () => {
    expect(evaluate(spec({ operator: 'EQ' }), 100, false)).toBe('BREACH');
    expect(evaluate(spec({ operator: 'EQ' }), 99, false)).toBe('NEUTRAL');
    expect(evaluate(spec({ operator: 'NEQ' }), 99, false)).toBe('BREACH');
    expect(evaluate(spec({ operator: 'NEQ' }), 100, false)).toBe('NEUTRAL');
  });
  it('OUT_OF_RANGE breaches outside either bound', () => {
    const s = spec({ operator: 'OUT_OF_RANGE', limit: null, limitLow: 10, limitHigh: 20 });
    expect(evaluate(s, 9, false)).toBe('BREACH');
    expect(evaluate(s, 21, false)).toBe('BREACH');
    expect(evaluate(s, 15, false)).toBe('NEUTRAL');
  });
});

describe('evaluate — recovery and hysteresis', () => {
  it('reports RECOVERED only when an alarm is open', () => {
    expect(evaluate(spec({}), 50, true)).toBe('RECOVERED');
    expect(evaluate(spec({}), 50, false)).toBe('NEUTRAL');
  });
  it('holds an open GT alarm inside the dead-band', () => {
    // limit 100, hysteresis 5 -> must fall to <= 95 to count as recovered.
    const s = spec({ hysteresis: 5 });
    expect(evaluate(s, 97, true)).toBe('NEUTRAL');   // in the band: neither breach nor recovery
    expect(evaluate(s, 95, true)).toBe('RECOVERED');
    expect(evaluate(s, 101, true)).toBe('BREACH');   // re-breach while open
  });
  it('holds an open LT alarm inside the dead-band', () => {
    const s = spec({ operator: 'LT', hysteresis: 5 });
    expect(evaluate(s, 103, true)).toBe('NEUTRAL');
    expect(evaluate(s, 105, true)).toBe('RECOVERED');
  });
  it('applies hysteresis inward from both OUT_OF_RANGE bounds', () => {
    const s = spec({ operator: 'OUT_OF_RANGE', limit: null, limitLow: 10, limitHigh: 20, hysteresis: 2 });
    expect(evaluate(s, 11, true)).toBe('NEUTRAL');     // above low bound but inside the band
    expect(evaluate(s, 12, true)).toBe('RECOVERED');
    expect(evaluate(s, 18, true)).toBe('RECOVERED');
    expect(evaluate(s, 19, true)).toBe('NEUTRAL');
  });
  it('treats hysteresis as zero for EQ and NEQ', () => {
    // A dead-band around an equality test is meaningless; recovery is exact.
    expect(evaluate(spec({ operator: 'EQ', hysteresis: 5 }), 99, true)).toBe('RECOVERED');
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd apps/api && npx vitest run src/modules/alarms/__tests__/threshold-evaluator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/alarms/threshold-evaluator.ts`:

```ts
/**
 * Threshold evaluation — PURE. No database, no clock, no I/O.
 *
 * `isOpen` is injected rather than looked up so this file can be exhaustively
 * unit-tested, exactly like fan-out.ts.
 *
 * Hysteresis is a dead-band applied ONLY on the recovery side. Without it a
 * value oscillating around the limit alternates BREACH/RECOVERED on every
 * message, and with latching that means an operator can never finish reviewing
 * an excursion before it changes state underneath them.
 */
import type { AlarmSeverity, ThresholdOperator } from '@prisma/client';

export interface ThresholdSpec {
  id: string;
  key: string;
  operator: ThresholdOperator;
  limit: number | null;
  limitLow: number | null;
  limitHigh: number | null;
  hysteresis: number;
  severity: AlarmSeverity;
}

export type Verdict = 'BREACH' | 'RECOVERED' | 'NEUTRAL';

/**
 * Coerce a reading to a number, or null when it is not numerically meaningful.
 *
 * Deliberately NOT `Number(value)`: Number(false) === 0 and Number('') === 0,
 * either of which would silently breach any LT threshold above zero. Booleans,
 * null, objects and non-numeric strings are not comparable to a limit and must
 * be skipped, not coerced.
 */
export function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function breaches(spec: ThresholdSpec, v: number): boolean {
  switch (spec.operator) {
    case 'GT':  return spec.limit !== null && v > spec.limit;
    case 'GTE': return spec.limit !== null && v >= spec.limit;
    case 'LT':  return spec.limit !== null && v < spec.limit;
    case 'LTE': return spec.limit !== null && v <= spec.limit;
    case 'EQ':  return spec.limit !== null && v === spec.limit;
    case 'NEQ': return spec.limit !== null && v !== spec.limit;
    case 'OUT_OF_RANGE':
      return spec.limitLow !== null && spec.limitHigh !== null
        && (v < spec.limitLow || v > spec.limitHigh);
    default: return false;
  }
}

/** Has the value returned past the limit by the full dead-band? */
function recovers(spec: ThresholdSpec, v: number): boolean {
  const h = Math.max(0, spec.hysteresis);
  switch (spec.operator) {
    case 'GT':
    case 'GTE': return spec.limit !== null && v <= spec.limit - h;
    case 'LT':
    case 'LTE': return spec.limit !== null && v >= spec.limit + h;
    // A dead-band around an equality test is meaningless — recovery is exact.
    case 'EQ':  return spec.limit !== null && v !== spec.limit;
    case 'NEQ': return spec.limit !== null && v === spec.limit;
    case 'OUT_OF_RANGE':
      return spec.limitLow !== null && spec.limitHigh !== null
        && v >= spec.limitLow + h && v <= spec.limitHigh - h;
    default: return false;
  }
}

export function evaluate(spec: ThresholdSpec, value: number, isOpen: boolean): Verdict {
  if (breaches(spec, value)) return 'BREACH';
  // NEUTRAL rather than RECOVERED when no alarm is open: recovery is a
  // transition, and there is nothing to transition.
  if (isOpen && recovers(spec, value)) return 'RECOVERED';
  return 'NEUTRAL';
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/modules/alarms/__tests__/threshold-evaluator.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/modules/alarms/threshold-evaluator.ts apps/api/src/modules/alarms/__tests__/threshold-evaluator.test.ts
git commit -m "feat(alarms): pure threshold evaluator with hysteresis

No database, no clock. numericValue refuses to coerce booleans and empty
strings, which Number() would turn into 0 and silently breach any LT
threshold above zero."
```

---

## Task 6: Pure alarm state machine

**Files:**
- Create: `apps/api/src/modules/alarms/alarm-state.ts`
- Create: `apps/api/src/modules/alarms/__tests__/alarm-state.test.ts`

**Interfaces:**
- Consumes: `Verdict` from `threshold-evaluator.ts`.
- Produces:
  - `export interface OpenAlarmView { id: string; state: AlarmState; breachCount: number; peakValue: number | null }`
  - `export type Transition = { kind: 'RAISE'; severity: AlarmSeverity; value: number; ts: Date } | { kind: 'REBREACH'; alarmId: string; value: number; ts: Date; backToActive: boolean } | { kind: 'RESOLVE'; alarmId: string; ts: Date; close: boolean } | { kind: 'NONE' }`
  - `export function nextTransition(verdict: Verdict, open: OpenAlarmView | null, severity: AlarmSeverity, value: number, ts: Date): Transition`
  - `export function applyAck(state: AlarmState): AlarmState | null`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/alarms/__tests__/alarm-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { nextTransition, applyAck, type OpenAlarmView } from '../alarm-state.js';
import type { AlarmState } from '@prisma/client';

const TS = new Date('2026-08-03T10:00:00.000Z');
const open = (state: AlarmState, over: Partial<OpenAlarmView> = {}): OpenAlarmView =>
  ({ id: 'a1', state, breachCount: 1, peakValue: 101, ...over });

describe('nextTransition — raising', () => {
  it('raises when a breach arrives with no open alarm', () => {
    expect(nextTransition('BREACH', null, 'MAJOR', 101, TS))
      .toEqual({ kind: 'RAISE', severity: 'MAJOR', value: 101, ts: TS });
  });
  it('does nothing when a neutral reading arrives with no open alarm', () => {
    expect(nextTransition('NEUTRAL', null, 'MAJOR', 50, TS)).toEqual({ kind: 'NONE' });
  });
});

describe('nextTransition — re-breach', () => {
  it('bumps the counter instead of raising a second alarm', () => {
    expect(nextTransition('BREACH', open('ACTIVE'), 'MAJOR', 105, TS))
      .toEqual({ kind: 'REBREACH', alarmId: 'a1', value: 105, ts: TS, backToActive: false });
  });
  it('walks RESOLVED_UNACKED back to ACTIVE', () => {
    // A flapping sensor must not have its excursion closed out from under the
    // operator who is mid-review.
    expect(nextTransition('BREACH', open('RESOLVED_UNACKED'), 'MAJOR', 105, TS))
      .toEqual({ kind: 'REBREACH', alarmId: 'a1', value: 105, ts: TS, backToActive: true });
  });
  it('bumps without state change when already acknowledged', () => {
    expect(nextTransition('BREACH', open('ACTIVE_ACKED'), 'MAJOR', 105, TS))
      .toEqual({ kind: 'REBREACH', alarmId: 'a1', value: 105, ts: TS, backToActive: false });
  });
});

describe('nextTransition — recovery', () => {
  it('moves ACTIVE to RESOLVED_UNACKED without closing', () => {
    expect(nextTransition('RECOVERED', open('ACTIVE'), 'MAJOR', 50, TS))
      .toEqual({ kind: 'RESOLVE', alarmId: 'a1', ts: TS, close: false });
  });
  it('closes an already-acknowledged alarm on recovery', () => {
    expect(nextTransition('RECOVERED', open('ACTIVE_ACKED'), 'MAJOR', 50, TS))
      .toEqual({ kind: 'RESOLVE', alarmId: 'a1', ts: TS, close: true });
  });
  it('does nothing when an already-resolved alarm recovers again', () => {
    expect(nextTransition('RECOVERED', open('RESOLVED_UNACKED'), 'MAJOR', 50, TS))
      .toEqual({ kind: 'NONE' });
  });
});

describe('applyAck', () => {
  it('ACTIVE becomes ACTIVE_ACKED', () => {
    expect(applyAck('ACTIVE')).toBe('ACTIVE_ACKED');
  });
  it('RESOLVED_UNACKED becomes CLOSED', () => {
    expect(applyAck('RESOLVED_UNACKED')).toBe('CLOSED');
  });
  it('refuses to acknowledge an already-acknowledged or closed alarm', () => {
    // null means "reject the request" — the route turns this into a 409 rather
    // than silently re-signing a record.
    expect(applyAck('ACTIVE_ACKED')).toBeNull();
    expect(applyAck('CLOSED')).toBeNull();
  });
});

describe('invariant: CLOSED is only reachable through a human ack', () => {
  it('no verdict-driven transition closes an unacknowledged alarm', () => {
    const states: AlarmState[] = ['ACTIVE', 'RESOLVED_UNACKED'];
    for (const s of states) {
      for (const v of ['BREACH', 'RECOVERED', 'NEUTRAL'] as const) {
        const t = nextTransition(v, open(s), 'MAJOR', 50, TS);
        expect(t.kind === 'RESOLVE' && t.close).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd apps/api && npx vitest run src/modules/alarms/__tests__/alarm-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/alarms/alarm-state.ts`:

```ts
/**
 * Alarm state machine — PURE. Returns an INTENDED transition; it never writes.
 *
 *              breach
 *    (none) ───────────▶ ACTIVE ───── recover ────▶ RESOLVED_UNACKED
 *                          │  ▲                          │      │
 *                     ack  │  └───── re-breach ──────────┘      │ ack
 *                          ▼                                    ▼
 *                    ACTIVE_ACKED ──── recover ──────────▶   CLOSED
 *
 * Two invariants, both asserted in the tests:
 *   1. CLOSED is reachable ONLY through a human acknowledgement. Nothing
 *      self-closes — that is the entire point of latching.
 *   2. A re-breach walks RESOLVED_UNACKED back to ACTIVE, so a flapping sensor
 *      cannot have its excursion closed out from under the reviewing operator.
 */
import type { AlarmSeverity, AlarmState } from '@prisma/client';
import type { Verdict } from './threshold-evaluator.js';

export interface OpenAlarmView {
  id: string;
  state: AlarmState;
  breachCount: number;
  peakValue: number | null;
}

export type Transition =
  | { kind: 'RAISE'; severity: AlarmSeverity; value: number; ts: Date }
  | { kind: 'REBREACH'; alarmId: string; value: number; ts: Date; backToActive: boolean }
  | { kind: 'RESOLVE'; alarmId: string; ts: Date; close: boolean }
  | { kind: 'NONE' };

export function nextTransition(
  verdict: Verdict,
  open: OpenAlarmView | null,
  severity: AlarmSeverity,
  value: number,
  ts: Date,
): Transition {
  if (verdict === 'BREACH') {
    if (!open) return { kind: 'RAISE', severity, value, ts };
    return {
      kind: 'REBREACH', alarmId: open.id, value, ts,
      backToActive: open.state === 'RESOLVED_UNACKED',
    };
  }

  if (verdict === 'RECOVERED' && open) {
    // Only ACTIVE and ACTIVE_ACKED can recover. RESOLVED_UNACKED has already
    // recovered; re-reporting it would rewrite resolvedAt on every message.
    if (open.state === 'ACTIVE') return { kind: 'RESOLVE', alarmId: open.id, ts, close: false };
    if (open.state === 'ACTIVE_ACKED') return { kind: 'RESOLVE', alarmId: open.id, ts, close: true };
  }

  return { kind: 'NONE' };
}

/**
 * The state an acknowledgement produces, or null if the alarm cannot be
 * acknowledged. Null is a rejection (HTTP 409), not a no-op — re-signing an
 * already-signed record would put a second attributable signature on the same
 * event.
 */
export function applyAck(state: AlarmState): AlarmState | null {
  if (state === 'ACTIVE') return 'ACTIVE_ACKED';
  if (state === 'RESOLVED_UNACKED') return 'CLOSED';
  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/modules/alarms/__tests__/alarm-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/modules/alarms/alarm-state.ts apps/api/src/modules/alarms/__tests__/alarm-state.test.ts
git commit -m "feat(alarms): pure latching state machine

CLOSED is reachable only through a human acknowledgement, and a re-breach
walks RESOLVED_UNACKED back to ACTIVE. Both invariants are asserted."
```

---

## Task 7: Audit actions and the `SYSTEM_AUDIT_ACTIONS` allow-list

**Why this is its own task:** `auditLog` **throws** when `userId` is absent unless the action is on the `SYSTEM_AUDIT_ACTIONS` allow-list (`apps/api/src/lib/audit.ts:99-107`). Alarm raise, auto-resolve and the liveness sweep have no user principal. If their actions are not allow-listed, `auditLog` throws inside `flushNow` — whose interval callback swallows errors — and **alarms stop firing while ingestion continues to look healthy.**

**Files:**
- Modify: `packages/shared/src/types/audit-actions.ts`
- Modify: `apps/api/src/lib/audit.ts:35-48`
- Create: `apps/api/src/lib/__tests__/audit-system-actions.test.ts`

**Interfaces:**
- Produces: audit action strings `ALARM_RAISED`, `ALARM_REBREACHED`, `ALARM_RESOLVED`, `ALARM_ACKNOWLEDGED`, `DEVICE_WENT_OFFLINE`, `DEVICE_CAME_ONLINE`. The first three plus the two device ones are system-emitted; `ALARM_ACKNOWLEDGED` always carries a user.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/__tests__/audit-system-actions.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { auditLog } from '../audit.js';

vi.mock('../prisma.js', () => ({
  prisma: {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    auditTrail: { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (fn: any) => (typeof fn === 'function' ? fn({}) : [])),
  },
}));

const SYSTEM_EMITTED = [
  'ALARM_RAISED', 'ALARM_REBREACHED', 'ALARM_RESOLVED',
  'DEVICE_WENT_OFFLINE', 'DEVICE_CAME_ONLINE',
];

describe('system-emitted alarm audit actions', () => {
  it.each(SYSTEM_EMITTED)('%s can be logged without a userId', async (action) => {
    // These are emitted from the ingest flush loop and the liveness cron, where
    // no user principal exists. auditLog throws for a userId-less action that is
    // not allow-listed — and flushNow's interval callback swallows errors, so an
    // un-allow-listed action stops alarms silently while ingestion looks fine.
    await expect(auditLog({ action, targetType: 'Alarm', targetId: 'x' })).resolves.not.toThrow();
  });

  it('ALARM_ACKNOWLEDGED still requires a userId', async () => {
    // The acknowledgement is the e-signature. It must never be attributable to
    // nobody, so it is deliberately NOT on the allow-list.
    await expect(auditLog({ action: 'ALARM_ACKNOWLEDGED', targetType: 'Alarm', targetId: 'x' }))
      .rejects.toThrow(/userId required/);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd apps/api && npx vitest run src/lib/__tests__/audit-system-actions.test.ts`
Expected: FAIL — the five system actions throw `audit.userId required`.

- [ ] **Step 3: Add the audit action constants**

In `packages/shared/src/types/audit-actions.ts`, inside the `AUDIT_ACTIONS` object:

```ts
  // Data Injection P3 — alarms and liveness.
  ALARM_RAISED: 'ALARM_RAISED',
  ALARM_REBREACHED: 'ALARM_REBREACHED',
  ALARM_RESOLVED: 'ALARM_RESOLVED',
  ALARM_ACKNOWLEDGED: 'ALARM_ACKNOWLEDGED',
  DEVICE_WENT_OFFLINE: 'DEVICE_WENT_OFFLINE',
  DEVICE_CAME_ONLINE: 'DEVICE_CAME_ONLINE',
  ALARM_THRESHOLD_CREATED: 'ALARM_THRESHOLD_CREATED',
  ALARM_THRESHOLD_UPDATED: 'ALARM_THRESHOLD_UPDATED',
  ALARM_THRESHOLD_DELETED: 'ALARM_THRESHOLD_DELETED',
```

- [ ] **Step 4: Extend the allow-list**

In `apps/api/src/lib/audit.ts`, inside `SYSTEM_AUDIT_ACTIONS`:

```ts
  // P3 alarms/liveness. Emitted from the ingest flush loop and the liveness
  // cron; neither has a user principal. ALARM_ACKNOWLEDGED is deliberately
  // ABSENT — the acknowledgement is the §11.50 e-signature and must always
  // name the individual responsible.
  'ALARM_RAISED',
  'ALARM_REBREACHED',
  'ALARM_RESOLVED',
  'DEVICE_WENT_OFFLINE',
  'DEVICE_CAME_ONLINE',
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && npx vitest run src/lib/__tests__/audit-system-actions.test.ts`
Expected: PASS, including the `ALARM_ACKNOWLEDGED` rejection case.

- [ ] **Step 6: Build shared, typecheck, commit**

```bash
npm run build -w @digilog/shared
npx tsc --noEmit -p apps/api/tsconfig.json
git add packages/shared/src/types/audit-actions.ts apps/api/src/lib/audit.ts apps/api/src/lib/__tests__/audit-system-actions.test.ts
git commit -m "feat(audit): allow-list system-emitted alarm actions

auditLog throws for a userId-less action that is not allow-listed, and
flushNow swallows errors — an omission here would stop alarms silently
while ingestion kept looking healthy. ALARM_ACKNOWLEDGED stays off the
list because it is the e-signature."
```

---

## Task 8: Alarm repository

**Files:**
- Create: `apps/api/src/modules/alarms/alarm.repository.ts`
- Create: `apps/api/src/modules/alarms/__tests__/alarm.repository.test.ts`

**Interfaces:**
- Consumes: `OpenAlarmView` (Task 6), `ThresholdSpec` (Task 5).
- Produces:
  - `export function seriesKey(instrumentId: string, key: string): string` — `` `${instrumentId}|${key}` ``, for the threshold cache (looked up per reading)
  - `export function alarmKey(instrumentId: string, key: string, thresholdId: string | null): string` — `` `${instrumentId}|${key}|${thresholdId ?? '__liveness__'}` ``, for open alarms
  - `export async function loadThresholdCache(): Promise<Map<string, ThresholdSpec[]>>` — keyed by `seriesKey`
  - `export async function loadOpenAlarms(): Promise<Map<string, OpenAlarmView>>` — keyed by `alarmKey`
  - `export async function raiseAlarm(input: { instrumentId: string; key: string; thresholdId: string | null; severity: AlarmSeverity; value: number | null; ts: Date }): Promise<{ id: string } | null>`
  - `export async function rebreachAlarm(alarmId: string, value: number | null, ts: Date, backToActive: boolean): Promise<void>`
  - `export async function resolveAlarm(alarmId: string, ts: Date, close: boolean): Promise<void>`
  - `export async function touchLiveness(instrumentIds: string[], seenAt: Date): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/alarms/__tests__/alarm.repository.test.ts`. It uses a **scratch** hierarchy node and instrument created in `beforeAll` and removed in `afterAll` — no shared rows:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import {
  loadThresholdCache, loadOpenAlarms, raiseAlarm, rebreachAlarm, resolveAlarm, touchLiveness,
  alarmKey,
} from '../alarm.repository.js';

const TAG = `p3repo-${Date.now()}`;
let instrumentId = '';
let thresholdId = '';

beforeAll(async () => {
  const node = await prisma.hierarchyNode.create({
    data: { level: 'COMPANY', name: TAG, slug: TAG },
  });
  const inst = await prisma.instrument.create({
    data: {
      name: TAG, code: TAG, slug: TAG, instrumentType: 'sensor',
      hierarchyNodeId: node.id, communicationProfileId: null, gatewayId: null,
    },
  });
  instrumentId = inst.id;
  const t = await prisma.alarmThreshold.create({
    data: { instrumentId, key: 'temp', operator: 'GT', limit: 100, severity: 'MAJOR' },
  });
  thresholdId = t.id;
});

afterAll(async () => {
  await prisma.instrumentLiveness.deleteMany({ where: { instrumentId } });
  await prisma.alarm.deleteMany({ where: { instrumentId } });
  await prisma.alarmThreshold.deleteMany({ where: { instrumentId } });
  const inst = await prisma.instrument.findUnique({ where: { id: instrumentId } });
  await prisma.instrument.delete({ where: { id: instrumentId } });
  if (inst) await prisma.hierarchyNode.delete({ where: { id: inst.hierarchyNodeId } });
});

describe('threshold cache', () => {
  it('keys thresholds by instrument and key', async () => {
    const cache = await loadThresholdCache();
    const specs = cache.get(`${instrumentId}|temp`);
    expect(specs?.[0]).toMatchObject({ id: thresholdId, operator: 'GT', limit: 100 });
  });
});

describe('raise / rebreach / resolve', () => {
  it('raises once and refuses a concurrent duplicate', async () => {
    const ts = new Date();
    const first = await raiseAlarm({ instrumentId, key: 'temp', thresholdId, severity: 'MAJOR', value: 101, ts });
    expect(first).not.toBeNull();

    // The partial unique index is the real guard. A second raise for the same
    // open series must return null, not throw and not create a second row.
    const second = await raiseAlarm({ instrumentId, key: 'temp', thresholdId, severity: 'MAJOR', value: 102, ts });
    expect(second).toBeNull();

    const rows = await prisma.alarm.findMany({ where: { instrumentId, key: 'temp' } });
    expect(rows).toHaveLength(1);
  });

  it('rebreach bumps the counter and tracks the peak', async () => {
    const openBefore = (await loadOpenAlarms()).get(alarmKey(instrumentId, 'temp', thresholdId))!;
    await rebreachAlarm(openBefore.id, 150, new Date(), false);
    const row = await prisma.alarm.findUnique({ where: { id: openBefore.id } });
    expect(row?.breachCount).toBe(2);
    expect(row?.peakValue).toBe(150);
  });

  it('rebreach with backToActive returns a resolved alarm to ACTIVE', async () => {
    const open = (await loadOpenAlarms()).get(alarmKey(instrumentId, 'temp', thresholdId))!;
    await resolveAlarm(open.id, new Date(), false);
    expect((await prisma.alarm.findUnique({ where: { id: open.id } }))?.state).toBe('RESOLVED_UNACKED');
    await rebreachAlarm(open.id, 160, new Date(), true);
    expect((await prisma.alarm.findUnique({ where: { id: open.id } }))?.state).toBe('ACTIVE');
  });

  it('loadOpenAlarms excludes CLOSED rows', async () => {
    const open = (await loadOpenAlarms()).get(alarmKey(instrumentId, 'temp', thresholdId))!;
    await prisma.alarm.update({ where: { id: open.id }, data: { state: 'CLOSED', closedAt: new Date() } });
    expect((await loadOpenAlarms()).get(alarmKey(instrumentId, 'temp', thresholdId))).toBeUndefined();
  });
});

describe('touchLiveness', () => {
  it('creates a row on first sight and updates it thereafter', async () => {
    const t1 = new Date('2026-08-03T09:00:00.000Z');
    await touchLiveness([instrumentId], t1);
    expect((await prisma.instrumentLiveness.findUnique({ where: { instrumentId } }))?.lastSeenAt)
      .toEqual(t1);

    const t2 = new Date('2026-08-03T09:05:00.000Z');
    await touchLiveness([instrumentId], t2);
    expect((await prisma.instrumentLiveness.findUnique({ where: { instrumentId } }))?.lastSeenAt)
      .toEqual(t2);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd apps/api && npx vitest run src/modules/alarms/__tests__/alarm.repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/alarms/alarm.repository.ts`:

```ts
/**
 * All database access for alarms, thresholds and liveness.
 *
 * The evaluator and state machine are pure; this file is the only place in the
 * alarm path that touches Postgres. Caches are loaded ONCE PER FLUSH, mirroring
 * how ingestion.service.ts already loads buildResolverCache() and unsSettings()
 * once per flush rather than once per message.
 */
import { Prisma, type AlarmSeverity } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { ThresholdSpec } from './threshold-evaluator.js';
import type { OpenAlarmView } from './alarm-state.js';

/** Threshold-cache key: looked up once per reading, before the threshold is known. */
export const seriesKey = (instrumentId: string, key: string) => `${instrumentId}|${key}`;

/**
 * Open-alarm key. Includes the THRESHOLD because one telemetry key can carry
 * several thresholds, and each is an independent excursion condition with its
 * own severity. Keying on (instrument, key) alone lets a high-limit breach
 * satisfy a low-limit threshold's recovery test and resolve the alarm it just
 * raised. Liveness alarms have no threshold and use a fixed sentinel.
 */
export const alarmKey = (instrumentId: string, key: string, thresholdId: string | null) =>
  `${instrumentId}|${key}|${thresholdId ?? '__liveness__'}`;

export async function loadThresholdCache(): Promise<Map<string, ThresholdSpec[]>> {
  const rows = await prisma.alarmThreshold.findMany({ where: { isActive: true } });
  const map = new Map<string, ThresholdSpec[]>();
  for (const r of rows) {
    const k = seriesKey(r.instrumentId, r.key);
    const list = map.get(k) ?? [];
    list.push({
      id: r.id, key: r.key, operator: r.operator,
      limit: r.limit, limitLow: r.limitLow, limitHigh: r.limitHigh,
      hysteresis: r.hysteresis, severity: r.severity,
    });
    map.set(k, list);
  }
  return map;
}

export async function loadOpenAlarms(): Promise<Map<string, OpenAlarmView>> {
  const rows = await prisma.alarm.findMany({
    where: { state: { not: 'CLOSED' } },
    select: {
      id: true, instrumentId: true, key: true, thresholdId: true,
      state: true, breachCount: true, peakValue: true,
    },
  });
  return new Map(rows.map(r => [
    alarmKey(r.instrumentId, r.key, r.thresholdId),
    { id: r.id, state: r.state, breachCount: r.breachCount, peakValue: r.peakValue },
  ]));
}

/**
 * Returns null when an open alarm for this series already exists.
 *
 * The partial unique index alarms_one_open_per_series_key is the real guard —
 * the in-memory open-alarm cache is loaded once per flush, so two concurrent
 * flushes can both believe the series is clear. A P2002 here is the expected
 * outcome of that race, not an error worth surfacing.
 */
export async function raiseAlarm(input: {
  instrumentId: string; key: string; thresholdId: string | null;
  severity: AlarmSeverity; value: number | null; ts: Date;
}): Promise<{ id: string } | null> {
  try {
    const row = await prisma.alarm.create({
      data: {
        instrumentId: input.instrumentId, key: input.key, thresholdId: input.thresholdId,
        // Copied at raise time so a later edit to the threshold never rewrites
        // the severity of a historical excursion.
        severity: input.severity,
        state: 'ACTIVE',
        firstBreachAt: input.ts, lastBreachAt: input.ts,
        breachCount: 1, triggerValue: input.value, peakValue: input.value,
      },
      select: { id: true },
    });
    return row;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

export async function rebreachAlarm(
  alarmId: string, value: number | null, ts: Date, backToActive: boolean,
): Promise<void> {
  // Raw SQL because peakValue must be `GREATEST(peak_value, $value)` — a
  // read-modify-write in JS would lose a concurrent flush's higher peak.
  await prisma.$executeRaw`
    UPDATE alarms
       SET breach_count = breach_count + 1,
           last_breach_at = ${ts},
           peak_value = CASE
             WHEN ${value}::double precision IS NULL THEN peak_value
             WHEN peak_value IS NULL THEN ${value}::double precision
             ELSE GREATEST(peak_value, ${value}::double precision)
           END,
           state = CASE WHEN ${backToActive} THEN 'ACTIVE'::"AlarmState" ELSE state END,
           resolved_at = CASE WHEN ${backToActive} THEN NULL ELSE resolved_at END
     WHERE id = ${alarmId}::uuid`;
}

export async function resolveAlarm(alarmId: string, ts: Date, close: boolean): Promise<void> {
  await prisma.alarm.update({
    where: { id: alarmId },
    data: close
      ? { state: 'CLOSED', resolvedAt: ts, closedAt: ts }
      : { state: 'RESOLVED_UNACKED', resolvedAt: ts },
  });
}

/** Upsert last-seen for every instrument that produced a reading in this flush. */
export async function touchLiveness(instrumentIds: string[], seenAt: Date): Promise<void> {
  if (instrumentIds.length === 0) return;
  const values = Prisma.join(instrumentIds.map(id => Prisma.sql`(${id}::uuid, ${seenAt}, 'UNKNOWN')`));
  await prisma.$executeRaw`
    INSERT INTO instrument_liveness (instrument_id, last_seen_at, state)
    VALUES ${values}
    ON CONFLICT (instrument_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npm test -- src/modules/alarms/__tests__/alarm.repository.test.ts`
Expected: PASS, all cases, including the duplicate-raise returning null.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/modules/alarms/alarm.repository.ts apps/api/src/modules/alarms/__tests__/alarm.repository.test.ts
git commit -m "feat(alarms): repository with race-safe raise and peak tracking

raiseAlarm returns null on P2002 — the partial unique index is the real
one-open-alarm guard, since the open-alarm cache is per-flush and two
concurrent flushes can both believe a series is clear. peakValue uses
GREATEST in SQL so a concurrent higher peak is not lost."
```

---

## Task 9: Alarm service and the wire into `flushNow`

**Files:**
- Create: `apps/api/src/modules/alarms/alarm.service.ts`
- Create: `apps/api/src/modules/alarms/__tests__/alarm.service.test.ts`
- Modify: `apps/api/src/modules/data-injection/ingestion.service.ts`

**Interfaces:**
- Consumes: everything from Tasks 5, 6, 8.
- Produces: `export async function evaluateFlush(batches: { instrumentId: string; readings: Reading[] }[], receivedAt: Date): Promise<{ raised: number; rebreached: number; resolved: number }>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/alarms/__tests__/alarm.service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const repo = {
  loadThresholdCache: vi.fn(),
  loadOpenAlarms: vi.fn(),
  raiseAlarm: vi.fn(),
  rebreachAlarm: vi.fn(),
  resolveAlarm: vi.fn(),
  touchLiveness: vi.fn(),
};
const dispatch = vi.fn();
const audit = vi.fn();

vi.mock('../alarm.repository.js', () => repo);
vi.mock('../../notification-delivery/notification-dispatcher.js', () => ({
  dispatchNotification: dispatch,
}));
vi.mock('../../../lib/audit.js', () => ({ auditLog: audit }));

const { evaluateFlush } = await import('../alarm.service.js');

const TS = new Date('2026-08-03T10:00:00.000Z');
const reading = (key: string, value: unknown) => ({ key, value, valueType: 'number' as const, ts: TS });

beforeEach(() => {
  vi.clearAllMocks();
  repo.loadOpenAlarms.mockResolvedValue(new Map());
  repo.raiseAlarm.mockResolvedValue({ id: 'a1' });
  repo.touchLiveness.mockResolvedValue(undefined);
  repo.loadThresholdCache.mockResolvedValue(new Map([
    ['i1|temp', [{ id: 't1', key: 'temp', operator: 'GT', limit: 100, limitLow: null, limitHigh: null, hysteresis: 0, severity: 'MAJOR' }]],
  ]));
});

describe('evaluateFlush', () => {
  it('raises an alarm and dispatches ALARM_RAISED', async () => {
    const res = await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', 101)] }], TS);
    expect(res.raised).toBe(1);
    expect(repo.raiseAlarm).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ALARM_RAISED' }));
  });

  it('does not dispatch when the raise lost the unique-index race', async () => {
    repo.raiseAlarm.mockResolvedValue(null);
    const res = await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', 101)] }], TS);
    expect(res.raised).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('skips readings with no threshold without touching the repository', async () => {
    await evaluateFlush([{ instrumentId: 'i1', readings: [reading('humidity', 999)] }], TS);
    expect(repo.raiseAlarm).not.toHaveBeenCalled();
  });

  it('skips non-numeric readings rather than coercing them', async () => {
    await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', false)] }], TS);
    expect(repo.raiseAlarm).not.toHaveBeenCalled();
  });

  it('records last-seen for every instrument in the flush', async () => {
    await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', 5)] }], TS);
    expect(repo.touchLiveness).toHaveBeenCalledWith(['i1'], TS);
  });

  it('raises SEPARATE alarms for a high and a low threshold on the same key', async () => {
    // Regression: with the alarm series keyed on (instrument, key) alone, a
    // reading of 105 raises on the GT spec and then satisfies the LT spec's
    // recovery test (105 >= 10) in the very same pass — resolving the alarm it
    // had just raised. The series must include the threshold.
    repo.loadThresholdCache.mockResolvedValue(new Map([
      ['i1|temp', [
        { id: 't1', key: 'temp', operator: 'GT', limit: 100, limitLow: null, limitHigh: null, hysteresis: 0, severity: 'MAJOR' },
        { id: 't2', key: 'temp', operator: 'LT', limit: 10, limitLow: null, limitHigh: null, hysteresis: 0, severity: 'CRITICAL' },
      ]],
    ]));

    const res = await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', 105)] }], TS);
    expect(res.raised).toBe(1);
    expect(res.resolved).toBe(0);          // the LT spec must NOT resolve the GT alarm
    expect(repo.resolveAlarm).not.toHaveBeenCalled();

    // And a genuine low breach raises its OWN alarm rather than being swallowed.
    repo.raiseAlarm.mockResolvedValue({ id: 'a2' });
    const low = await evaluateFlush([{ instrumentId: 'i1', readings: [reading('temp', 5)] }], TS);
    expect(low.raised).toBe(1);
  });

  it('raises ONE alarm when a flush contains many breaches of the same series', async () => {
    // Within a single flush the cache says "no open alarm" for every reading.
    // Without in-flush bookkeeping this raises N times and N-1 of them lose the
    // unique-index race, producing N-1 pointless round-trips and zero counter bumps.
    await evaluateFlush([{
      instrumentId: 'i1',
      readings: [reading('temp', 101), reading('temp', 102), reading('temp', 103)],
    }], TS);
    expect(repo.raiseAlarm).toHaveBeenCalledOnce();
    expect(repo.rebreachAlarm).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd apps/api && npx vitest run src/modules/alarms/__tests__/alarm.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/alarms/alarm.service.ts`:

```ts
/**
 * Alarm orchestration for one ingest flush.
 *
 * Called from ingestion.service.ts AFTER writeBatch resolves. Ordering is
 * load-bearing: evaluating first would let a failed write leave a latched
 * excursion — one demanding a signed acknowledgement — pointing at a reading
 * that is not in the history table.
 */
import type { Reading } from '../data-injection/payload-parser.js';
import { evaluate, numericValue, type ThresholdSpec } from './threshold-evaluator.js';
import { nextTransition, type OpenAlarmView } from './alarm-state.js';
import {
  loadThresholdCache, loadOpenAlarms, raiseAlarm, rebreachAlarm, resolveAlarm, touchLiveness,
  seriesKey, alarmKey,
} from './alarm.repository.js';
import { dispatchNotification } from '../notification-delivery/notification-dispatcher.js';
import { auditLog } from '../../lib/audit.js';

export async function evaluateFlush(
  batches: { instrumentId: string; readings: Reading[] }[],
  receivedAt: Date,
): Promise<{ raised: number; rebreached: number; resolved: number }> {
  const counts = { raised: 0, rebreached: 0, resolved: 0 };
  if (batches.length === 0) return counts;

  const instrumentIds = [...new Set(batches.map(b => b.instrumentId))];
  const [thresholds, open] = await Promise.all([loadThresholdCache(), loadOpenAlarms()]);
  await touchLiveness(instrumentIds, receivedAt);
  if (thresholds.size === 0) return counts;

  for (const batch of batches) {
    for (const r of batch.readings) {
      const specs: ThresholdSpec[] | undefined = thresholds.get(seriesKey(batch.instrumentId, r.key));
      if (!specs) continue;

      const value = numericValue(r.value);
      if (value === null) continue;   // booleans/strings are not comparable to a limit

      for (const spec of specs) {
        // Keyed PER THRESHOLD. Each threshold on a key is an independent
        // excursion condition; sharing one key across them lets a high-limit
        // breach satisfy a low-limit threshold's recovery test in the same pass.
        const k = alarmKey(batch.instrumentId, r.key, spec.id);
        // `open` is MUTATED as we go. Without that, three breaches of the same
        // series inside one flush would each see "no open alarm" and race the
        // unique index twice for nothing.
        const current: OpenAlarmView | null = open.get(k) ?? null;
        const verdict = evaluate(spec, value, current !== null);
        const t = nextTransition(verdict, current, spec.severity, value, r.ts);

        if (t.kind === 'RAISE') {
          const row = await raiseAlarm({
            instrumentId: batch.instrumentId, key: r.key, thresholdId: spec.id,
            severity: t.severity, value: t.value, ts: t.ts,
          });
          if (!row) continue;   // lost the unique-index race; another flush owns it
          open.set(k, { id: row.id, state: 'ACTIVE', breachCount: 1, peakValue: t.value });
          counts.raised++;
          await auditLog({
            action: 'ALARM_RAISED', targetType: 'Alarm', targetId: row.id,
            afterValue: { instrumentId: batch.instrumentId, key: r.key, value: t.value, severity: t.severity },
          });
          await dispatchNotification({
            eventType: 'ALARM_RAISED',
            context: { severity: t.severity, instrumentId: batch.instrumentId },
            variables: {
              instrumentId: batch.instrumentId, key: r.key,
              value: String(t.value), severity: t.severity,
              limit: String(spec.limit ?? `${spec.limitLow}..${spec.limitHigh}`),
              breachCount: '1', timestamp: t.ts.toISOString(),
            },
          });
        } else if (t.kind === 'REBREACH') {
          await rebreachAlarm(t.alarmId, t.value, t.ts, t.backToActive);
          const prev = open.get(k)!;
          open.set(k, {
            ...prev,
            state: t.backToActive ? 'ACTIVE' : prev.state,
            breachCount: prev.breachCount + 1,
            peakValue: prev.peakValue === null ? t.value : Math.max(prev.peakValue, t.value),
          });
          counts.rebreached++;
          await auditLog({
            action: 'ALARM_REBREACHED', targetType: 'Alarm', targetId: t.alarmId,
            afterValue: { value: t.value, breachCount: prev.breachCount + 1 },
          });
        } else if (t.kind === 'RESOLVE') {
          await resolveAlarm(t.alarmId, t.ts, t.close);
          if (t.close) open.delete(k);
          else open.set(k, { ...open.get(k)!, state: 'RESOLVED_UNACKED' });
          counts.resolved++;
          await auditLog({
            action: 'ALARM_RESOLVED', targetType: 'Alarm', targetId: t.alarmId,
            afterValue: { closed: t.close, value },
          });
        }
      }
    }
  }

  return counts;
}
```

- [ ] **Step 4: Run the service tests**

Run: `cd apps/api && npx vitest run src/modules/alarms/__tests__/alarm.service.test.ts`
Expected: PASS, including the one-raise-per-flush case.

- [ ] **Step 5: Write the ordering test**

Append to `apps/api/src/modules/data-injection/__tests__/ingestion.service.test.ts`:

```ts
it('does not evaluate alarms when the telemetry write fails', async () => {
  // Evaluate-before-write would leave a latched excursion — one demanding a
  // signed acknowledgement — pointing at a reading that is not in the history
  // table. A missed alarm is recoverable; an alarm citing a non-existent
  // record is not.
  const { writeBatch } = await import('../telemetry.repository.js');
  const { evaluateFlush } = await import('../../alarms/alarm.service.js');
  vi.mocked(writeBatch).mockRejectedValueOnce(new Error('db down'));

  await expect(flushNow()).rejects.toThrow('db down');
  expect(vi.mocked(evaluateFlush)).not.toHaveBeenCalled();
});

it('a failing evaluator writes a dead letter instead of failing silently', async () => {
  const { evaluateFlush } = await import('../../alarms/alarm.service.js');
  const { writeDeadLetters } = await import('../telemetry.repository.js');
  vi.mocked(evaluateFlush).mockRejectedValueOnce(new Error('evaluator exploded'));

  await flushNow();
  expect(vi.mocked(writeDeadLetters)).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ reason: 'ALARM_EVALUATION_FAILED' })]),
  );
});
```

Add the mock alongside the file's existing `vi.mock` calls:

```ts
vi.mock('../../alarms/alarm.service.js', () => ({ evaluateFlush: vi.fn().mockResolvedValue({ raised: 0, rebreached: 0, resolved: 0 }) }));
```

- [ ] **Step 6: Run and verify the ordering tests fail**

Run: `cd apps/api && npx vitest run src/modules/data-injection/__tests__/ingestion.service.test.ts`
Expected: FAIL — `evaluateFlush` is not called from `flushNow` yet.

- [ ] **Step 7: Wire it into `flushNow`**

In `apps/api/src/modules/data-injection/ingestion.service.ts`, add the import:

```ts
import { evaluateFlush } from '../alarms/alarm.service.js';
```

and replace the tail of `flushNow` (currently lines 101-106) with:

```ts
  if (allBatches.length > 0) {
    await writeBatch(allBatches, new Date());
    flushed += allBatches.length;

    // STRICTLY after the write. Evaluating first would let a failed write leave
    // a latched excursion pointing at a reading that does not exist.
    try {
      await evaluateFlush(allBatches, new Date());
    } catch (err) {
      // Deliberately NOT rethrown into startFlushLoop's `catch(() => {})` — that
      // would stop alarms silently while ingestion carried on looking healthy.
      // A dead letter is the operator-visible record that evaluation broke.
      deadLetters.push({
        protocolKey: 'internal', topic: 'alarm-evaluation', payload: '',
        reason: 'ALARM_EVALUATION_FAILED', detail: (err as Error).message.slice(0, 500),
      });
    }
  }
  if (deadLetters.length > 0) await writeDeadLetters(deadLetters);
```

- [ ] **Step 8: Run the full data-injection and alarms suites**

Run: `cd apps/api && npm test -- src/modules/data-injection src/modules/alarms`
Expected: PASS, including both new ordering tests.

- [ ] **Step 9: Typecheck and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/modules/alarms apps/api/src/modules/data-injection
git commit -m "feat(alarms): evaluate each flush after the telemetry write lands

Ordering is load-bearing — evaluating before writeBatch would leave a
latched excursion pointing at a reading that failed to persist. Evaluator
failure writes an ALARM_EVALUATION_FAILED dead letter rather than
inheriting the flush loop's silent catch."
```

---

## Task 10: Notification event types

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (enum `NotificationEventType`)
- Create: `apps/api/prisma/migrations/<UTC-timestamp>_p3_alarm_notification_events/migration.sql`
- Modify: `apps/api/src/modules/notification-delivery/notification-dispatcher.ts` (4 maps)
- Modify: `apps/api/src/modules/notification-rules/routes.ts` (`EVENT_CATALOG`)
- Create: `apps/api/src/modules/notification-delivery/__tests__/event-type-coverage.test.ts`

- [ ] **Step 1: Write the failing coverage test**

Create `apps/api/src/modules/notification-delivery/__tests__/event-type-coverage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(__dirname, '../../../../prisma/schema.prisma');
const DISPATCHER = path.resolve(__dirname, '../notification-dispatcher.ts');
const RULES = path.resolve(__dirname, '../../notification-rules/routes.ts');

function enumMembers(): string[] {
  const src = readFileSync(SCHEMA, 'utf8');
  const block = /enum NotificationEventType \{([^}]*)\}/.exec(src)?.[1] ?? '';
  return block.split('\n').map(l => l.trim()).filter(l => /^[A-Z_]+$/.test(l));
}

describe('NotificationEventType coverage', () => {
  const members = enumMembers();

  it('the enum is parsed', () => {
    expect(members.length).toBeGreaterThan(0);
  });

  it.each(['EVENT_LABELS', 'EVENT_FIELDS'])('%s covers every member', (_map) => {
    // Both maps live in notification-dispatcher.ts. A member missing from
    // EVENT_LABELS renders its raw enum name to operators; missing from
    // EVENT_FIELDS renders an email whose only row is "Time".
    const src = readFileSync(DISPATCHER, 'utf8');
    const missing = members.filter(m => !src.includes(`${m}:`));
    expect(missing).toEqual([]);
  });

  it('the rules EVENT_CATALOG covers every member', () => {
    // notification-rules/routes.ts drives the rule-authoring UI. A member absent
    // here can never have a rule created for it, so the event fires and reaches
    // nobody.
    const src = readFileSync(RULES, 'utf8');
    const missing = members.filter(m => !src.includes(`${m}:`));
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — it must PASS before the enum changes**

Run: `cd apps/api && npx vitest run src/modules/notification-delivery/__tests__/event-type-coverage.test.ts`
Expected: PASS against the current 10 members. This proves the test is meaningful before it is used as a guard.

- [ ] **Step 3: Add the two enum members**

In `apps/api/prisma/schema.prisma`, inside `enum NotificationEventType`:

```prisma
  ALARM_RAISED
  ALARM_ACKNOWLEDGED
```

- [ ] **Step 4: Re-run the coverage test and watch it fail**

Run: `cd apps/api && npx vitest run src/modules/notification-delivery/__tests__/event-type-coverage.test.ts`
Expected: FAIL — both new members missing from all three maps.

- [ ] **Step 5: Author and apply the migration**

```bash
cd apps/api
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script
```
Hand-author into `prisma/migrations/<UTC-timestamp>_p3_alarm_notification_events/migration.sql`:

```sql
ALTER TYPE "NotificationEventType" ADD VALUE IF NOT EXISTS 'ALARM_RAISED';
ALTER TYPE "NotificationEventType" ADD VALUE IF NOT EXISTS 'ALARM_ACKNOWLEDGED';
```

Then run the two commands **separately** and read the output of the first before running the second:

```bash
npx prisma migrate deploy
echo "exit=$?"
npm run db:verify-migrations
```

Expected: `migrate deploy` reports the migration applied and exits 0; the drift guard PASSES.

> `ALTER TYPE … ADD VALUE` is restricted inside a transaction block, and Prisma wraps each migration file in one. It is permitted on PostgreSQL 18 provided the new value is not *used* in the same transaction — which this migration does not do, so it should apply. Chaining with `&&` would hide a failure behind the drift guard's own confusing "unexpected state" output, so check the exit code explicitly. If it does fail, split the two `ALTER TYPE` statements into two migration directories.

- [ ] **Step 6: Widen the four dispatcher maps**

In `apps/api/src/modules/notification-delivery/notification-dispatcher.ts`:

`EVENT_LABELS` (~:38):
```ts
    ALARM_RAISED: 'Alarm Raised', ALARM_ACKNOWLEDGED: 'Alarm Acknowledged',
```

`EVENT_FIELDS` (~:45):
```ts
    ALARM_RAISED: [['Instrument','instrumentName'],['Measurement','key'],['Value','value'],['Limit','limit'],['Severity','severity'],['Time','timestamp']],
    ALARM_ACKNOWLEDGED: [['Instrument','instrumentName'],['Measurement','key'],['Severity','severity'],['Acknowledged By','ackedBy'],['Reason','reason'],['Time','timestamp']],
```

Default templates (~:283) — follow the shape of the neighbouring `DEVICE_OFFLINE` entry exactly.

Summary templates (~:403):
```ts
    ALARM_RAISED: 'Alarm on ${instrumentName}: ${key} = ${value} (limit ${limit})',
    ALARM_ACKNOWLEDGED: 'Alarm on ${instrumentName} acknowledged by ${ackedBy}',
```

- [ ] **Step 7: Widen `EVENT_CATALOG`**

In `apps/api/src/modules/notification-rules/routes.ts` (~:13):

```ts
  ALARM_RAISED:         { label: 'Alarm Raised',           module: 'alarms',     variables: ['instrumentName', 'key', 'value', 'limit', 'severity', 'breachCount', 'timestamp'] },
  ALARM_ACKNOWLEDGED:   { label: 'Alarm Acknowledged',     module: 'alarms',     variables: ['instrumentName', 'key', 'severity', 'ackedBy', 'reason', 'timestamp'] },
```

- [ ] **Step 8: Regenerate, run, verify**

```bash
stop-app.bat && cd apps/api && npx prisma generate
npx vitest run src/modules/notification-delivery/__tests__/event-type-coverage.test.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: coverage test PASSES; typecheck clean.

- [ ] **Step 9: Verify in the browser**

Start the app, go to the notification-rules page, create a rule for **Alarm Raised** with condition `{"severity": ["CRITICAL","MAJOR"]}` and an in-app recipient. Confirm it saves and lists.

- [ ] **Step 10: Commit**

```bash
git add apps/api/prisma apps/api/src/modules/notification-delivery apps/api/src/modules/notification-rules
git commit -m "feat(notifications): add ALARM_RAISED and ALARM_ACKNOWLEDGED event types

Both closed-set readers widened in the same commit as the enum, guarded by
a coverage test. A member missing from EVENT_CATALOG can never have a rule
created for it, so the event would fire and reach nobody."
```

---

## Task 11: Liveness sweep worker

**Files:**
- Create: `apps/api/src/workers/liveness-sweep.worker.ts`
- Create: `apps/api/src/workers/__tests__/liveness-sweep.worker.test.ts`
- Create: `apps/api/src/modules/config/defs/liveness.def.ts`
- Modify: `apps/api/src/lib/config-discovery.ts`, `apps/web/src/routes/config/index.tsx`
- Modify: `apps/api/src/workers/task-list.ts`, `packages/queue/crontab.txt`

**Interfaces:**
- Produces: `export const livenessSweepTask`, `export async function sweepLiveness(now: Date): Promise<{ wentOffline: string[] }>`, `export async function livenessSettings(): Promise<{ gracePeriodMultiplier: number }>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/workers/__tests__/liveness-sweep.worker.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import { sweepLiveness } from '../liveness-sweep.worker.js';

const TAG = `p3sweep-${Date.now()}`;
let instrumentId = '';
let nodeId = '';

beforeAll(async () => {
  const node = await prisma.hierarchyNode.create({ data: { level: 'COMPANY', name: TAG, slug: TAG } });
  nodeId = node.id;
  const inst = await prisma.instrument.create({
    data: {
      name: TAG, code: TAG, slug: TAG, instrumentType: 'sensor',
      hierarchyNodeId: nodeId, expectedIntervalSec: 60,
    },
  });
  instrumentId = inst.id;
});

afterAll(async () => {
  await prisma.instrumentLiveness.deleteMany({ where: { instrumentId } });
  await prisma.alarm.deleteMany({ where: { instrumentId } });
  await prisma.instrument.delete({ where: { id: instrumentId } });
  await prisma.hierarchyNode.delete({ where: { id: nodeId } });
});

beforeEach(async () => {
  await prisma.instrumentLiveness.deleteMany({ where: { instrumentId } });
  await prisma.alarm.deleteMany({ where: { instrumentId } });
});

const NOW = new Date('2026-08-03T12:00:00.000Z');
const minutesBefore = (n: number) => new Date(NOW.getTime() - n * 60_000);

describe('sweepLiveness', () => {
  it('marks an instrument offline past the grace window', async () => {
    // 60s interval x2 grace = 120s. Last seen 10 minutes ago is well past.
    await prisma.instrumentLiveness.create({
      data: { instrumentId, lastSeenAt: minutesBefore(10), state: 'ONLINE' },
    });
    const res = await sweepLiveness(NOW);
    expect(res.wentOffline).toContain(instrumentId);
    const row = await prisma.instrumentLiveness.findUnique({ where: { instrumentId } });
    expect(row?.state).toBe('OFFLINE');
    expect(row?.offlineAlarmId).toBeTruthy();
  });

  it('does NOT re-fire on a second sweep', async () => {
    // The whole reason liveness state is persisted. Without it a device dark
    // for a week produces one signed-ack-required excursion every 5 minutes,
    // forever. NotificationRule.cooldownMinutes cannot help — it is an
    // in-memory Map wiped on every restart.
    await prisma.instrumentLiveness.create({
      data: { instrumentId, lastSeenAt: minutesBefore(10), state: 'ONLINE' },
    });
    await sweepLiveness(NOW);
    const second = await sweepLiveness(new Date(NOW.getTime() + 5 * 60_000));
    expect(second.wentOffline).not.toContain(instrumentId);
    expect(await prisma.alarm.count({ where: { instrumentId } })).toBe(1);
  });

  it('leaves an instrument inside the grace window alone', async () => {
    await prisma.instrumentLiveness.create({
      data: { instrumentId, lastSeenAt: minutesBefore(1), state: 'ONLINE' },
    });
    const res = await sweepLiveness(NOW);
    expect(res.wentOffline).not.toContain(instrumentId);
  });

  it('ignores instruments with no expectedIntervalSec', async () => {
    await prisma.instrument.update({ where: { id: instrumentId }, data: { expectedIntervalSec: null } });
    await prisma.instrumentLiveness.create({
      data: { instrumentId, lastSeenAt: minutesBefore(600), state: 'ONLINE' },
    });
    const res = await sweepLiveness(NOW);
    expect(res.wentOffline).not.toContain(instrumentId);
    await prisma.instrument.update({ where: { id: instrumentId }, data: { expectedIntervalSec: 60 } });
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd apps/api && npm test -- src/workers/__tests__/liveness-sweep.worker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the config def**

Create `apps/api/src/modules/config/defs/liveness.def.ts`, following `telemetry-retention.def.ts` exactly in shape, exposing one field:

- `gracePeriodMultiplier` — number, default **2**, min 1, max 10, label "Grace Period Multiplier", help "An instrument is considered offline once its silence exceeds its expected reporting interval multiplied by this value. 2 means a single late message does not raise an alarm."

Register it in `apps/api/src/lib/config-discovery.ts` and add its card to `apps/web/src/routes/config/index.tsx`.

> **Note for the implementer:** `seedDefaults()` only inserts a `system_config` row when it is **absent**. If this default is ever changed later, the change has no effect on any environment that already seeded the old value — that is a code change *plus* a data step.

- [ ] **Step 4: Implement the worker**

Create `apps/api/src/workers/liveness-sweep.worker.ts`:

```ts
/**
 * Instrument liveness sweep.
 *
 * "Stopped reporting" is the failure that matters most and the one a heartbeat
 * cannot see — a device that dies silently never sends anything. So liveness is
 * inferred from silence, not from a heartbeat message.
 *
 * State is PERSISTED in instrument_liveness. Without that, an instrument dark
 * for a week would raise a fresh signed-ack-required excursion on every sweep.
 * NotificationRule.cooldownMinutes cannot substitute: it is an in-memory Map
 * (notification-dispatcher.ts:19) wiped on every restart.
 */
import { prisma } from '../lib/prisma.js';
import { configRepository } from '../modules/config/config.repository.js';
import { auditLog } from '../lib/audit.js';
import { dispatchNotification } from '../modules/notification-delivery/notification-dispatcher.js';

export interface LivenessSettings { gracePeriodMultiplier: number }

/** Must match liveness.def.ts's declared default. */
const DEFAULTS: LivenessSettings = { gracePeriodMultiplier: 2 };

export async function livenessSettings(): Promise<LivenessSettings> {
  const stored = await configRepository.getSystemConfig('liveness');
  const value = (stored?.configValue as Partial<LivenessSettings> | null) ?? {};
  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof LivenessSettings)[]) {
    if (typeof value[key] === typeof DEFAULTS[key]) merged[key] = value[key] as number;
  }
  // Below 1 the grace window is shorter than the reporting interval itself and
  // every instrument alarms constantly. Clamp rather than trust a mis-set value.
  merged.gracePeriodMultiplier = Math.max(1, merged.gracePeriodMultiplier);
  return merged;
}

export async function sweepLiveness(now = new Date()): Promise<{ wentOffline: string[] }> {
  const { gracePeriodMultiplier } = await livenessSettings();

  // Candidates only: monitored, active, seen at least once, and not ALREADY
  // offline. The `state <> 'OFFLINE'` clause is what makes the sweep idempotent.
  const rows = await prisma.$queryRaw<{ instrument_id: string; name: string }[]>`
    SELECT l.instrument_id, i.name
      FROM instrument_liveness l
      JOIN instruments i ON i.id = l.instrument_id
     WHERE i.expected_interval_sec IS NOT NULL
       AND i.is_active = true
       AND l.last_seen_at IS NOT NULL
       AND l.state <> 'OFFLINE'
       -- make_interval rather than string-concatenation + ::interval: the bind
       -- parameter arrives as `unknown` to the planner, and `integer * unknown`
       -- can fail to resolve depending on driver type inference.
       AND l.last_seen_at < ${now}::timestamptz
                          - make_interval(secs => i.expected_interval_sec * ${gracePeriodMultiplier}::int)`;

  const wentOffline: string[] = [];

  for (const row of rows) {
    const alarm = await prisma.alarm.create({
      data: {
        instrumentId: row.instrument_id, key: '__liveness__', thresholdId: null,
        severity: 'MAJOR', state: 'ACTIVE',
        firstBreachAt: now, lastBreachAt: now, breachCount: 1,
      },
      select: { id: true },
    });
    await prisma.instrumentLiveness.update({
      where: { instrumentId: row.instrument_id },
      data: { state: 'OFFLINE', stateChangedAt: now, offlineAlarmId: alarm.id },
    });
    wentOffline.push(row.instrument_id);

    await auditLog({
      action: 'DEVICE_WENT_OFFLINE', targetType: 'Instrument', targetId: row.instrument_id,
      afterValue: { alarmId: alarm.id, detectedAt: now.toISOString() },
    });
    await dispatchNotification({
      eventType: 'DEVICE_OFFLINE',
      context: { severity: 'MAJOR', instrumentId: row.instrument_id },
      variables: {
        deviceName: row.name, unsPath: '', timestamp: now.toISOString(),
      },
    });
  }

  return { wentOffline };
}

/** graphile-worker task. Registered as `instrument_liveness_sweep`. */
export const livenessSweepTask = async (
  _payload: unknown,
  helpers?: { logger?: { info: (m: string) => void; error: (m: string) => void } },
): Promise<void> => {
  try {
    const { wentOffline } = await sweepLiveness();
    if (wentOffline.length > 0) {
      helpers?.logger?.info(`liveness sweep: ${wentOffline.length} instrument(s) went offline`);
    }
  } catch (err) {
    // Loud. A silent failure here means device-offline detection is dead while
    // everything else looks healthy.
    helpers?.logger?.error(`liveness sweep FAILED: ${(err as Error).message}`);
    throw err;
  }
};
```

- [ ] **Step 5: Register the handler AND the cron in one change**

In `apps/api/src/workers/task-list.ts`:
```ts
import { livenessSweepTask } from './liveness-sweep.worker.js';
// … inside taskList:
  instrument_liveness_sweep: livenessSweepTask,
```

In `packages/queue/crontab.txt`, append:
```
# Instrument liveness — every 5 min. Marks an instrument OFFLINE once its
# silence exceeds expected_interval_sec x the configured grace multiplier.
# Idempotent: the query excludes rows already in state OFFLINE, so a device
# dark for a week produces exactly one excursion.
*/5 * * * * instrument_liveness_sweep ?id=instrument_liveness_sweep&max=1&fill=0s
```

- [ ] **Step 6: Run the worker tests and the Task-2 guard**

```bash
cd apps/api && npm test -- src/workers
```
Expected: PASS, including `task-list.test.ts` (the new cron id now has a handler) and the no-re-fire test.

- [ ] **Step 7: Recover path — flip liveness back ONLINE on a reading**

In `apps/api/src/modules/alarms/alarm.repository.ts`, first add the import the appended code needs (the file does not currently import it):

```ts
import { auditLog } from '../../lib/audit.js';
```

Then extend `touchLiveness` so an instrument returning from `OFFLINE` closes its offline alarm. Append to the same function:

```ts
  // A device coming back is not a deviation needing disposition — the THRESHOLD
  // excursions are what latch. This is the single, deliberate exception to
  // "nothing self-closes"; see §8 of the design spec.
  const recovered = await prisma.instrumentLiveness.findMany({
    where: { instrumentId: { in: instrumentIds }, state: 'OFFLINE' },
    select: { instrumentId: true, offlineAlarmId: true },
  });
  for (const r of recovered) {
    if (r.offlineAlarmId) {
      await prisma.alarm.update({
        where: { id: r.offlineAlarmId },
        data: { state: 'CLOSED', resolvedAt: seenAt, closedAt: seenAt },
      });
    }
    await prisma.instrumentLiveness.update({
      where: { instrumentId: r.instrumentId },
      data: { state: 'ONLINE', stateChangedAt: seenAt, offlineAlarmId: null },
    });
    await auditLog({
      action: 'DEVICE_CAME_ONLINE', targetType: 'Instrument', targetId: r.instrumentId,
      afterValue: { recoveredAt: seenAt.toISOString() },
    });
  }
```

Add a test in `alarm.repository.test.ts` asserting an OFFLINE instrument returns to ONLINE and its offline alarm is CLOSED after `touchLiveness`.

- [ ] **Step 8: Typecheck, full suite, commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
cd apps/api && npm test
git add apps/api/src/workers apps/api/src/modules/alarms apps/api/src/modules/config apps/web/src/routes/config/index.tsx apps/api/src/lib/config-discovery.ts packages/queue/crontab.txt
git commit -m "feat(liveness): silence-timeout sweep with persisted state

State is persisted so a device dark for a week produces one excursion, not
one per sweep. Handler and crontab line land together, guarded by the
task-list test. Recovery closes the offline alarm — the single deliberate
exception to 'nothing self-closes'."
```

---

## Task 12: Alarms API module, permissions and reauth

**Files:**
- Create: `apps/api/src/modules/alarms/routes.ts`
- Create: `apps/api/src/e2e/alarms.test.ts`
- Modify: `packages/shared/src/types/permissions.ts`, `reauth-actions.ts`, `permission-tree.ts`
- Modify: `apps/api/src/app.ts` (register routes)

**Interfaces:**
- Produces: `GET /api/alarms`, `GET /api/alarms/:id`, `POST /api/alarms/:id/acknowledge`, `GET /api/instruments/:id/thresholds`, `POST|PUT|DELETE /api/alarm-thresholds`.

- [ ] **Step 1: Add permissions**

In `packages/shared/src/types/permissions.ts`, after the `INSTRUMENT_*` block:

```ts
  ALARM_VIEW: 'ALARM_VIEW',
  ALARM_ACKNOWLEDGE: 'ALARM_ACKNOWLEDGE',
  ALARM_THRESHOLD_MANAGE: 'ALARM_THRESHOLD_MANAGE',
```

- [ ] **Step 2: Add reauth actions**

In `packages/shared/src/types/reauth-actions.ts`, in the Data Injection block:

```ts
  ACKNOWLEDGE_ALARM: { label: 'Acknowledge Alarm', category: 'Data Injection' },
  // One action covers create/update/delete. Per-verb actions that no endpoint
  // discriminates on are theatre — three *_TEMPLATE_KIND actions were removed
  // on 2026-07-04 for exactly that reason.
  MANAGE_ALARM_THRESHOLD: { label: 'Manage Alarm Threshold', category: 'Data Injection' },
```

- [ ] **Step 3: Add permission-tree nodes**

In `packages/shared/src/types/permission-tree.ts`, inside the `data-injection` sidebar group, after the `comm_profiles.*` nodes:

```ts
      { id: 'alarms.view', label: 'View Alarms', sidebarId: 'data-injection', page: 'Alarms', action: 'View',
        icon: 'bell', category: 'Data Injection', permissions: ['ALARM_VIEW', 'INSTRUMENT_VIEW'], enforce: 'a',
        gate: ['ALARM_VIEW'], configurable: true },
      { id: 'alarms.acknowledge', label: 'Acknowledge Alarm', sidebarId: 'data-injection', page: 'Alarms', action: 'Acknowledge',
        icon: 'check', category: 'Data Injection', permissions: ['ALARM_ACKNOWLEDGE', 'ALARM_VIEW'],
        reauthAction: 'ACKNOWLEDGE_ALARM', enforce: 'a', gate: ['ALARM_ACKNOWLEDGE'], configurable: true },
      { id: 'alarms.thresholds', label: 'Manage Alarm Thresholds', sidebarId: 'data-injection', page: 'Alarms', action: 'Configure',
        icon: 'sliders', category: 'Data Injection', permissions: ['ALARM_THRESHOLD_MANAGE', 'ALARM_VIEW', 'INSTRUMENT_VIEW'],
        reauthAction: 'MANAGE_ALARM_THRESHOLD', enforce: 'a', gate: ['ALARM_THRESHOLD_MANAGE'], configurable: true },
```

All three are `configurable: true` — unlike the eight P1 nodes left non-configurable, these ship with UI in Task 13, so each toggle grants a visible capability.

- [ ] **Step 4: Update the frozen-snapshot counts**

Run `npx vitest run packages/shared` and update the frozen-snapshot test's expected feature-privilege count (34 → 37) and permission-constant count (46 → 49) to match. **Do not** loosen the assertions — update the numbers.

- [ ] **Step 5: Write the failing e2e test**

Create `apps/api/src/e2e/alarms.test.ts`. Provision a **unique** SUPER_ADMIN in `beforeAll` (username derived from the file name), not the shared `admin`. Assert:

```
GET  /api/alarms                          -> 200, array
GET  /api/alarms?state=ACTIVE             -> 200, filtered
POST /api/alarms/:id/acknowledge  no pwd  -> 401 REAUTH_REQUIRED
POST /api/alarms/:id/acknowledge  no reason -> 400
POST /api/alarms/:id/acknowledge  valid   -> 200, state ACTIVE_ACKED
POST /api/alarms/:id/acknowledge  twice   -> 409 (applyAck returns null)
POST /api/alarm-thresholds  bad OUT_OF_RANGE (low >= high) -> 400
DELETE /api/alarm-thresholds/:id with alarm history -> 400 (FK Restrict)
```
Plus: after a successful acknowledge, `GET /api/audit?action=ALARM_ACKNOWLEDGED` returns a row naming the acknowledging user and carrying the reason.

- [ ] **Step 6: Run and verify failure**

Run: `cd apps/api && npm test -- src/e2e/alarms.test.ts`
Expected: FAIL — routes not registered.

- [ ] **Step 7: Implement `routes.ts`**

Follow `apps/api/src/modules/instruments/routes.ts` exactly for structure: `app.requirePermission(...)` in `preHandler`, `buildContext(req)`, `stripHtml` on free text, `auditLog(entry, tx)` inside `prisma.$transaction`, `ValidationError` / `NotFoundError` from `lib/errors.js`.

Two deviations from that template, both deliberate:

1. **Acknowledge uses `enforceReauthAlways('ACKNOWLEDGE_ALARM', req, reply)`, not `enforceReauth`.** `enforceReauth` consults the admin-managed action-reauth config and skips the password challenge when the action is not configured for the user's role — an administrator could switch the e-signature off. The acknowledgement *is* the §11.50 signature, so it is intrinsic to the action, not an opt-in policy. That is precisely what `enforceReauthAlways` exists for (`lib/reauth-check.ts:182`).
2. **Threshold CRUD uses `enforceReauth('MANAGE_ALARM_THRESHOLD', req, reply)`** — configuring limits is a policy decision an operator may reasonably choose not to challenge.

The acknowledge handler:

```ts
  app.post('/:id/acknowledge', {
    preHandler: [app.requirePermission('ALARM_ACKNOWLEDGE')],
    schema: {
      tags: ['Data Injection'], summary: 'Acknowledge an alarm',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', additionalProperties: false, required: ['reason'],
        properties: {
          reason: { type: 'string', minLength: 1, maxLength: 1000 },
          _currentPassword: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    // ALWAYS-on: the acknowledgement is the e-signature, so it must not be
    // disableable through the admin-managed action-reauth config.
    if (!(await enforceReauthAlways('ACKNOWLEDGE_ALARM', req, reply)).ok) return reply;

    const { id } = req.params as { id: string };
    const { reason } = req.body as { reason: string };
    const clean = stripHtml(reason).trim();
    if (clean.length === 0) throw new ValidationError('A reason is required to acknowledge an alarm.');

    const ctx = buildContext(req);
    const existing = await prisma.alarm.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Alarm not found.');

    const next = applyAck(existing.state);
    if (next === null) {
      return reply.code(409).send({
        error: 'ALREADY_ACKNOWLEDGED',
        message: `Alarm is ${existing.state} and cannot be acknowledged again.`,
      });
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.alarm.update({
        where: { id },
        data: {
          state: next, ackedBy: ctx.userId, ackedAt: now, ackReason: clean,
          closedAt: next === 'CLOSED' ? now : null,
        },
      });
      await auditLog({
        action: 'ALARM_ACKNOWLEDGED', targetType: 'Alarm', targetId: id,
        beforeValue: { state: existing.state },
        afterValue: { state: next, breachCount: row.breachCount },
        reason: clean,
        signatureMeaning: 'Acknowledged alarm',
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });

    void dispatchNotification({
      eventType: 'ALARM_ACKNOWLEDGED',
      context: { severity: updated.severity, instrumentId: updated.instrumentId },
      variables: {
        key: updated.key, severity: updated.severity,
        ackedBy: ctx.userId ?? 'unknown', reason: clean,
        timestamp: now.toISOString(),
      },
    }).catch(err => app.log.error({ err }, 'alarm-ack notification dispatch failed'));

    return updated;
  });
```

Threshold create must validate before insert:

```ts
    if (b.operator === 'OUT_OF_RANGE') {
      if (b.limitLow === null || b.limitHigh === null) {
        throw new ValidationError('OUT_OF_RANGE requires both limitLow and limitHigh.');
      }
      if (b.limitLow >= b.limitHigh) {
        throw new ValidationError('limitLow must be less than limitHigh.');
      }
    } else if (b.limit === null || b.limit === undefined) {
      throw new ValidationError(`Operator ${b.operator} requires a limit.`);
    }
```

- [ ] **Step 8: Register the module**

In `apps/api/src/app.ts`, alongside the other data-injection registrations:

```ts
  await app.register(alarmRoutes, { prefix: '/api/alarms' });
  await app.register(alarmThresholdRoutes, { prefix: '/api/alarm-thresholds' });
```

- [ ] **Step 9: Run, typecheck, commit**

```bash
npm run build -w @digilog/shared
cd apps/api && npm test -- src/e2e/alarms.test.ts
npx tsc --noEmit -p tsconfig.json
git add packages/shared apps/api/src/modules/alarms apps/api/src/app.ts apps/api/src/e2e/alarms.test.ts
git commit -m "feat(alarms): REST surface with always-on e-signature on acknowledge

Acknowledge uses enforceReauthAlways, not enforceReauth — the latter is
gated on the admin-managed action-reauth config, so an administrator could
switch the §11.50 signature off. Threshold CRUD keeps the configurable
gate. Double-acknowledge returns 409 rather than re-signing a record."
```

---

## Task 13: Frontend — alarm queue, ack dialog, thresholds

**Files:**
- Create: `apps/web/src/routes/data-injection/alarms.tsx`, `alarm-ack-dialog.tsx`, `instrument-thresholds.tsx`
- Modify: `apps/web/src/main.tsx`, `apps/web/src/components/layout/sidebar.tsx`, `packages/shared/src/types/sidebar-items.ts`, `apps/web/src/routes/data-injection/instrument-detail.tsx`

- [ ] **Step 1: Add the sidebar item to BOTH lists**

In `packages/shared/src/types/sidebar-items.ts`:
```ts
  { id: 'alarms', label: 'Alarms', icon: '\u{1F6A8}', description: 'Instrument excursions and device liveness' },
```

In `apps/web/src/components/layout/sidebar.tsx`, add a matching entry to `allNavItems` with `id: 'alarms'`, `href: '/data-injection/alarms'`, and an inline SVG bell icon in the same style as its neighbours.

- [ ] **Step 2: Run the parity test from Task 3**

Run: `cd apps/web && npx vitest run src/components/layout/__tests__/sidebar-parity.test.ts`
Expected: PASS. If it fails, one of the two lists was missed — which is the exact bug this test exists to catch.

- [ ] **Step 3: Add the route**

In `apps/web/src/main.tsx`, next to the other `data-injection` routes:

```tsx
const AlarmsPage = lazy(() => import('./routes/data-injection/alarms'));
// …
<Route path="/data-injection/alarms" element={<RequireRole permissions={[PERMISSIONS.ALARM_VIEW]}><Suspense fallback={<LazyFallback />}><AlarmsPage /></Suspense></RequireRole>} />
```

- [ ] **Step 4: Build the alarm queue page**

`alarms.tsx` — SWR against `/api/alarms`, following `instruments.tsx` for table styling (light theme: `bg-white`, `bg-slate-50`, `border-slate-200`). Requirements:

- Filters: state (default hides `CLOSED`), severity, instrument.
- Severity rendered as a coloured pill; `CRITICAL` must be distinguishable without relying on colour alone (add an icon or text label — colour-only encoding fails accessibility).
- Columns: instrument, measurement key, severity, state, first breach, last breach, breach count, peak value.
- An **Acknowledge** button gated on `useCan('alarms.acknowledge')`.
- Liveness alarms (`key === '__liveness__'`) render as "Device offline" rather than showing the sentinel key.

- [ ] **Step 5: Build the acknowledgement dialog**

`alarm-ack-dialog.tsx`:
- Mandatory reason textarea; the submit button stays disabled until it is non-empty after trimming.
- Password field posted as `_currentPassword` (the shape `enforceReauthAlways` reads).
- Show the alarm's breach count and peak so the operator signs against the facts.
- On 409, surface "This alarm has already been acknowledged" and refresh the list rather than showing a generic error.

- [ ] **Step 6: Build the threshold panel**

`instrument-thresholds.tsx`, embedded in `instrument-detail.tsx`. Add/edit/delete gated on `useCan('alarms.thresholds')`. The form shows `limitLow`/`limitHigh` only when the operator is `OUT_OF_RANGE`, and `limit` otherwise. Also add `expectedIntervalSec` to the instrument detail page with helper text explaining that empty means liveness monitoring is off.

- [ ] **Step 7: Add the open-alarm count to instrument detail**

A strip showing open-alarm count by severity, linking to the queue filtered to that instrument.

- [ ] **Step 8: Verify in a browser**

Start the app and, with the API running against a real EMQX broker:
1. Create a threshold `temp > 100` on a test instrument.
2. Publish `{"temp": 105}` → an alarm appears as ACTIVE within one flush interval.
3. Publish `{"temp": 106}` twice → breach count reaches 3, still **one** row.
4. Publish `{"temp": 20}` → state becomes RESOLVED_UNACKED, not CLOSED.
5. Acknowledge with a reason → state becomes CLOSED; the Audit Trail shows `ALARM_ACKNOWLEDGED` with the reason and the user.
6. Attempt to acknowledge again → 409 handled cleanly.
7. Stop publishing, set `expectedIntervalSec` to 60, wait for the sweep → a device-offline alarm appears **once**; confirm a second sweep adds nothing.
8. Resume publishing → the offline alarm closes automatically and liveness returns to ONLINE.

**Check the browser console throughout.** Report any 404s, unhandled promise rejections, or unexpected responses — CLAUDE.md requires unlinked UI elements and console errors to be treated as defects.

- [ ] **Step 9: Typecheck, full suites, commit**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
cd apps/web && npx vitest run
cd ../api && npm test
git add apps/web packages/shared/src/types/sidebar-items.ts
git commit -m "feat(web): alarm queue, acknowledgement dialog and threshold management

Sidebar item added to BOTH SIDEBAR_ITEMS and allNavItems, asserted by the
parity test. Acknowledge dialog requires a non-empty reason and posts
_currentPassword for the always-on e-signature."
```

---

## Task 14: Verification and documentation sync

- [ ] **Step 1: Full typecheck**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
```
Expected: zero errors. vitest cannot catch these — the API previously sat with two `TS2322` errors across eight consecutive green tasks.

- [ ] **Step 2: Full suites against the known baseline**

```bash
npx vitest run packages/shared     # baseline 3 known failures — must not increase
cd apps/web && npx vitest run      # baseline 6 known failures — must not increase
cd ../api && npm test              # baseline 14 known failures — must not increase
node scripts/ci-test-gate.mjs
```
The gate ratchets **down only**. If a count rose, fix it — do not raise the budget.

- [ ] **Step 3: Re-derive every count and update the docs**

```bash
grep -cE "^model " apps/api/prisma/schema.prisma
grep -cE "^enum "  apps/api/prisma/schema.prisma
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts
grep -cE "^\s+[A-Z_]+:"     packages/shared/src/types/reauth-actions.ts
ls apps/api/src/modules/ | wc -l
grep -cE "<Route" apps/web/src/main.tsx
```
Expected: 36 / 12 / 49 / 53 / 24 / 46. **If any figure differs from the projection, the actual number wins** — update `docs/recreation/02-inventory`, `05-database`, `06-api`, `07-ui`, and `CHANGELOG.md` with the measured values, and run the stale-stat sweep for the previous numbers across the active doc set.

- [ ] **Step 4: Verify the audit chain is still intact**

```bash
curl -sk https://localhost:3001/api/audit/verify-chain -H "Authorization: Bearer <token>"
```
Expected: `intact: true`. P3 only appends audit rows, so any break here is a real defect.

- [ ] **Step 5: Update the plan's own audit log**

Add an entry to `tasks/todo.md` recording P3 completion, the measured counts, and the two P1 bugs fixed en route (the missing `Data Injection` reauth category, and any sidebar-parity mismatch Task 3 surfaced).

- [ ] **Step 6: Commit**

```bash
git add docs CHANGELOG.md tasks/todo.md
git commit -m "docs: sync counts and changelog for Data Injection P3"
```

---

## Self-Review Notes

**Spec coverage.** Every section of the design spec maps to a task: §5 data model → Task 4; §6 state machine → Task 6; §7 evaluation → Tasks 5, 8, 9; §8 liveness → Task 11; §9 Part 11 → Tasks 7 and 12; §10 notifications → Task 10; §12 RBAC/UI → Tasks 12 and 13; §13 testing → distributed, with the two named-but-unwritten guards as Tasks 2 and 3. §11 (deferred items) has no task by design.

**Two things this plan adds beyond the spec**, both discovered while reading source for it:

1. **Task 1 is a live P1 bug**, not P3 work. All 12 Data Injection reauth actions are invisible in both reauth editors because `'Data Injection'` was never added to `REAUTH_ACTION_CATEGORIES`. Task 12's new actions would have inherited it, so it is fixed first. CLAUDE.md's correctness rule requires fixing a bug found in scope even when it is not the task.
2. **Task 7 exists because `auditLog` throws** for a userId-less action not on `SYSTEM_AUDIT_ACTIONS`. Since the alarm path runs inside `flushNow`, whose interval callback swallows errors, omitting this would have stopped alarms silently while ingestion continued to look healthy — a failure this whole phase exists to prevent.

**A design-spec correction made during planning.** The spec's §5.3 declared the alarm series as `(instrument, key)`. That is wrong, and the plan supersedes it. `AlarmThreshold` is unique on `(instrumentId, key, operator)`, so one telemetry key can carry both a high and a low limit — and with a shared series, a reading of 105 against `GT 100` + `LT 10` raises on the GT spec and then satisfies the LT spec's recovery test (`105 >= 10`) in the same pass, **resolving the alarm it had just raised**. The series is therefore `(instrument, key, threshold)`, which required changes in three places that must stay consistent: the two partial unique indexes in Task 4, `alarmKey`/`loadOpenAlarms` in Task 8, and the `open`-map lookup in Task 9. Task 9 carries a regression test for exactly this case. The second partial index exists because liveness alarms have `threshold_id IS NULL` and PostgreSQL treats NULLs as distinct in a unique index, so the first index would give them no guarantee at all.

**One deviation from the spec, flagged for the reviewer.** The spec said acknowledgement is "enforced through the existing `reauth-check.ts`". Reading that file showed two functions with materially different guarantees: `enforceReauth` is gated on the admin-managed action-reauth config and silently skips the challenge when unconfigured; `enforceReauthAlways` cannot be turned off. The plan uses `enforceReauthAlways` for acknowledgement, on the grounds that a §11.50 signature an administrator can disable is not a signature. Threshold CRUD keeps the configurable `enforceReauth`. If you would rather acknowledgement be administratively configurable, that is a one-word change in Task 12 Step 7.
