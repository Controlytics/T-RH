# Alarm Webhook Annunciator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an alarm is raised, cleared or acknowledged, POST a configurable body to an operator-defined HTTP(S) URL — an IP hooter — for every instrument in that target's assigned scope.

**Architecture:** A sibling subsystem to notifications, keyed off the **instrument** rather than the alarm rule (`Alarm.ruleId` is nullable; instrument-limit alarms have no rule row). Two new Prisma models: `AlarmWebhookTarget` (URL, method, headers, body template, scope, fire-on flags) and `AlarmWebhookDelivery` (the §11 receipt). The alarm evaluator enqueues a graphile-worker job; the worker resolves matching targets, renders a JSON-safe body, POSTs with a bounded 3-attempt retry, and writes a delivery row per attempt.

**Tech Stack:** Fastify 5, Prisma 6, PostgreSQL 18, graphile-worker, zod, React 19 + Vite + Tailwind v4 + SWR, vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-alarm-webhook-annunciator-design.md` — read it before Task 1. This plan argues from it; where they disagree, the spec wins and the plan is wrong.

## Global Constraints

- **Branch:** `data-injection`. Never commit to `final-user-management` (frozen backup).
- **No new Prisma enums.** `method`, `event`, `status` are validated strings — same precedent as `FloorplanRoom.grade`. Enum count stays at **13**.
- **No new permissions.** Reuse `ALARM_RULE_READ` / `ALARM_RULE_MANAGE`. Permission count stays at **42**.
- **Empty scope matches nothing.** `scopeLocationIds: []` and `scopeInstrumentIds: []` ⇒ zero instruments. Never "all".
- **Cooldown throttles `RAISED` only.** `CLEARED` and `ACKNOWLEDGED` are silence signals and are never suppressed.
- **`enqueueAlarmWebhook` never throws.** The alarm is the committed regulated record.
- **Every field returned must be in the Fastify `response` schema in the same edit.** Fastify silently strips undeclared fields.
- **Register the new module in BOTH `apps/api/src/app.ts` and `apps/api/src/e2e/test-helper.ts`** in the same commit, or every e2e 404s.
- **Migrations apply to `compliance_core_db` AND `compliance_core_db_test`.** Two commands, not one.
- **Never pipe `prisma migrate diff` into a migration file** — it emits three destructive statements in this repo (see Task 2).
- **Free-text `reason` is exempt from `sanitizeStrings`** — pass it in the skipKeys array explicitly.
- **Clamp audit signature lines** with `clampSignature()` — `audit_trail.signature_meaning` is `VarChar(255)` and the overflow throws *after* the action commits.
- **Run test suites PER PACKAGE**, never combined: `npx vitest run <path> --pool=forks --poolOptions.forks.singleFork=true`. A combined run manufactures ~129 false failures. Known-failing baseline is **zero**.
- **`vitest` does not typecheck.** Run `npx tsc --noEmit -p apps/api/tsconfig.json` and the web equivalent explicitly.
- **Stop the API (`stop-app.bat`) before `prisma generate`** — `tsx watch` holds `query_engine-windows.dll.node` open and the failure is silent.
- **UI cannot be verified by the implementing agent** — Playwright cannot authenticate against the mkcert cert here. Hand the visual check to the operator and say plainly it has not been seen.

---

### Task 1: Shared types and the variable contract

**Files:**
- Create: `packages/shared/src/types/alarm-webhook.ts`
- Modify: `packages/shared/src/index.ts` (add the export)
- Test: `packages/shared/src/types/__tests__/alarm-webhook.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ALARM_WEBHOOK_EVENTS`, `type AlarmWebhookEvent`, `ALARM_WEBHOOK_METHODS`, `type AlarmWebhookMethod`, `ALARM_WEBHOOK_VARIABLES`, `DEFAULT_WEBHOOK_BODY_TEMPLATE`, `type AlarmWebhookScope`, `type AlarmWebhookTargetShape`.

This lives in `@digilog/shared` because both the API (rendering, validation) and the web page (the placeholder picker) must read the *same* variable list. `alarms/notify.ts` carries a comment explaining that an event type is described in five hand-written places and a variable missing from one renders as an empty cell in the record an inspector reads. One exported constant is the fix.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/types/__tests__/alarm-webhook.test.ts
import { describe, it, expect } from 'vitest';
import {
  ALARM_WEBHOOK_EVENTS,
  ALARM_WEBHOOK_VARIABLES,
  DEFAULT_WEBHOOK_BODY_TEMPLATE,
} from '../alarm-webhook.js';

describe('alarm webhook contract', () => {
  it('offers exactly the four events', () => {
    expect([...ALARM_WEBHOOK_EVENTS]).toEqual(['RAISED', 'CLEARED', 'ACKNOWLEDGED', 'TEST']);
  });

  it('promises the common variables for every event', () => {
    for (const event of ['RAISED', 'CLEARED', 'ACKNOWLEDGED'] as const) {
      expect(ALARM_WEBHOOK_VARIABLES[event]).toEqual(
        expect.arrayContaining(['event', 'alarmId', 'instrument', 'metric', 'value', 'severity', 'timestamp']),
      );
    }
  });

  it('promises the event-specific variables', () => {
    expect(ALARM_WEBHOOK_VARIABLES.CLEARED).toContain('duration');
    expect(ALARM_WEBHOOK_VARIABLES.CLEARED).toContain('raisedAt');
    expect(ALARM_WEBHOOK_VARIABLES.ACKNOWLEDGED).toContain('acknowledgedBy');
    expect(ALARM_WEBHOOK_VARIABLES.ACKNOWLEDGED).toContain('acknowledgeReason');
    expect(ALARM_WEBHOOK_VARIABLES.RAISED).not.toContain('duration');
  });

  // The default template must not advertise a placeholder the renderer never fills,
  // or a freshly created target ships a body with a literal ${...} in it.
  it('uses only variables RAISED actually promises', () => {
    const used = [...DEFAULT_WEBHOOK_BODY_TEMPLATE.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
    expect(used.length).toBeGreaterThan(0);
    for (const v of used) expect(ALARM_WEBHOOK_VARIABLES.RAISED).toContain(v);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run packages/shared/src/types/__tests__/alarm-webhook.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — `Failed to resolve import "../alarm-webhook.js"`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/types/alarm-webhook.ts
/**
 * The alarm-webhook (hooter) contract shared by the API and the config page.
 *
 * Design: docs/superpowers/specs/2026-08-27-alarm-webhook-annunciator-design.md
 *
 * ONE source for the variable list. The config page renders its placeholder picker
 * FROM this constant and the worker builds its variables against it, so the UI
 * cannot advertise a placeholder the renderer does not produce — the failure mode
 * `alarms/notify.ts` documents for notification templates.
 */

export const ALARM_WEBHOOK_EVENTS = ['RAISED', 'CLEARED', 'ACKNOWLEDGED', 'TEST'] as const;
export type AlarmWebhookEvent = (typeof ALARM_WEBHOOK_EVENTS)[number];

/** GET is offered because some cheap hooters only accept a query-string trigger. */
export const ALARM_WEBHOOK_METHODS = ['POST', 'PUT', 'GET'] as const;
export type AlarmWebhookMethod = (typeof ALARM_WEBHOOK_METHODS)[number];

export const ALARM_WEBHOOK_DELIVERY_STATUSES = ['SENT', 'FAILED'] as const;
export type AlarmWebhookDeliveryStatus = (typeof ALARM_WEBHOOK_DELIVERY_STATUSES)[number];

const COMMON = [
  'event',
  'alarmId',
  'instrument',
  'instrumentName',
  'instrumentId',
  'metric',
  'value',
  'severity',
  'condition',
  'ruleName',
  'timestamp',
] as const;

export const ALARM_WEBHOOK_VARIABLES: Record<AlarmWebhookEvent, readonly string[]> = {
  RAISED: COMMON,
  CLEARED: [...COMMON, 'raisedAt', 'duration'],
  ACKNOWLEDGED: [...COMMON, 'raisedAt', 'acknowledgedBy', 'acknowledgeReason'],
  TEST: COMMON,
};

/**
 * Shipped on a new target. Kept to variables RAISED promises, so a target created and
 * never edited renders a complete body. Whitespace inside a JSON string literal is
 * insignificant, so the line breaks here are safe.
 */
export const DEFAULT_WEBHOOK_BODY_TEMPLATE = `{"event":"\${event}","instrument":"\${instrument}","metric":"\${metric}","value":"\${value}","severity":"\${severity}","condition":"\${condition}","alarmId":"\${alarmId}","timestamp":"\${timestamp}"}`;

/** Both lists empty means the target matches NOTHING. Never "all". */
export interface AlarmWebhookScope {
  scopeLocationIds: string[];
  scopeInstrumentIds: string[];
}

/**
 * The subset of a target the pure matcher needs. Structural on purpose so
 * `target-scope.ts` can be unit-tested without a Prisma client or a database.
 */
export interface AlarmWebhookTargetShape extends AlarmWebhookScope {
  id: string;
  isActive: boolean;
  fireOnRaised: boolean;
  fireOnCleared: boolean;
  fireOnAcknowledged: boolean;
  /** null = every severity. */
  severities: string[] | null;
}
```

- [ ] **Step 4: Export it from the package index**

`packages/shared/src/index.ts` uses **named** re-exports, not `export *` — match that:

```ts
export {
  ALARM_WEBHOOK_EVENTS,
  ALARM_WEBHOOK_METHODS,
  ALARM_WEBHOOK_DELIVERY_STATUSES,
  ALARM_WEBHOOK_VARIABLES,
  DEFAULT_WEBHOOK_BODY_TEMPLATE,
} from './types/alarm-webhook.js';
export type {
  AlarmWebhookEvent,
  AlarmWebhookMethod,
  AlarmWebhookDeliveryStatus,
  AlarmWebhookScope,
  AlarmWebhookTargetShape,
} from './types/alarm-webhook.js';
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npx vitest run packages/shared/src/types/__tests__/alarm-webhook.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS, 4 tests.

- [ ] **Step 6: Build the shared package and typecheck**

```bash
npm run build -w @digilog/shared
```
Expected: exits 0. The API and web packages import the built output, so skipping this makes every later task fail to resolve the import.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/alarm-webhook.ts packages/shared/src/types/__tests__/alarm-webhook.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): alarm webhook variable contract and event vocabulary"
```

---

### Task 2: Prisma models and the hand-written migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (append after the `Alarm` model)
- Create: `apps/api/prisma/migrations/20260827120000_alarm_webhooks/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `prisma.alarmWebhookTarget`, `prisma.alarmWebhookDelivery` on the generated client.

**Why the SQL is hand-written:** `prisma migrate diff` in this repo emits three destructive statements every time — `DROP TABLE instrument_telemetry_history` (Prisma cannot express `PARTITION BY`, so it reads the partitioned table as stray), `ALTER audit_trail.chain_position DROP NOT NULL` (the §11 hash-chain position, backed by a manual sequence), and a needless drop/recreate of the `instrument_credentials` FK. Read the header of `apps/api/prisma/migrations/20260811120000_instrument_floorplans/migration.sql` for the full account. You may run the diff to *read* it; never pipe it into a file.

- [ ] **Step 1: Add the models to the schema**

Append to `apps/api/prisma/schema.prisma`, after the `Alarm` model:

```prisma
/// An IP hooter (or any HTTP endpoint) that is POSTed to when an alarm changes state.
/// Scoped to instruments the same way role_configs.instrument_scope is — functional
/// locations with Blocks expanding to their Areas, PLUS explicit instruments — so this
/// introduces no fourth grouping concept.
model AlarmWebhookTarget {
  id          String  @id @default(uuid())
  name        String  @db.VarChar(200)
  description String? @db.VarChar(500)

  /// Operator-typed. NO allowlist: a hooter lives on the operator's LAN and any
  /// allowlist would have to contain it. Guards are the timeout, redirect:'error',
  /// and the delivery log — see the design's "Outbound-request stance".
  url    String @db.Text
  /// POST | PUT | GET. A validated string, not an enum, so the vocabulary can grow
  /// without a migration — same precedent as FloorplanRoom.grade.
  method String @default("POST") @db.VarChar(10)

  headers     Json   @default("{}") @map("headers") @db.JsonB
  contentType String @default("application/json") @map("content_type") @db.VarChar(100)
  /// ${...} placeholders. Rendered by render-body.ts, NOT by the notification
  /// template engine, which HTML-escapes and would corrupt JSON.
  bodyTemplate String @map("body_template") @db.Text

  /// When set, the response body MUST match this for the send to count as delivered,
  /// and it OVERRIDES the status code. Cheap hardware returns HTTP 200 on failure —
  /// the same lesson as SmsConfig.httpGatewaySuccessRegex (#sms-2xx).
  successRegex String? @map("success_regex") @db.Text
  timeoutMs    Int     @default(5000) @map("timeout_ms")

  fireOnRaised       Boolean @default(true) @map("fire_on_raised")
  fireOnCleared      Boolean @default(true) @map("fire_on_cleared")
  fireOnAcknowledged Boolean @default(true) @map("fire_on_acknowledged")

  /// NULL = every severity. ["CRITICAL","MAJOR"] narrows.
  severities Json? @db.JsonB
  /// Throttles RAISED ONLY. CLEARED and ACKNOWLEDGED are silence signals and are
  /// never suppressed — rate-limiting the off switch leaves a buzzer sounding for a
  /// condition that has already gone away.
  cooldownSeconds Int     @default(0) @map("cooldown_seconds")
  isActive        Boolean @default(true) @map("is_active")

  /// NOT NULL with a [] default, deliberately unlike role_configs.instrument_scope
  /// where NULL means "inherit". There is nothing to inherit from here, and [] must
  /// unambiguously mean NOTHING rather than being confusable with "unrestricted".
  scopeLocationIds   Json @default("[]") @map("scope_location_ids") @db.JsonB
  scopeInstrumentIds Json @default("[]") @map("scope_instrument_ids") @db.JsonB

  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  createdBy String?  @map("created_by")
  updatedBy String?  @map("updated_by")

  deliveries AlarmWebhookDelivery[]

  @@index([isActive])
  @@map("alarm_webhook_targets")
}

/// One delivery attempt. The §11 evidence that the system did — or did not —
/// annunciate a specific excursion. Never edited, never deleted.
model AlarmWebhookDelivery {
  id       String  @id @default(uuid())
  targetId String  @map("target_id")
  /// NULL for a TEST fire, which has no alarm behind it.
  alarmId  String? @map("alarm_id")

  /// RAISED | CLEARED | ACKNOWLEDGED | TEST.
  event String @db.VarChar(20)
  /// Copied at send time: the target's URL may be edited afterwards, and this row
  /// must keep saying which URL was actually hit.
  url String @db.Text
  /// Stored verbatim. Small, and the only honest answer to "why didn't it fire" —
  /// re-rendering it later from a since-edited template would be a fabrication.
  requestBody     String  @map("request_body") @db.Text
  httpStatus      Int?    @map("http_status")
  responseSnippet String? @map("response_snippet") @db.VarChar(1000)
  attempt         Int
  /// SENT | FAILED.
  status String @db.VarChar(10)
  error  String? @db.Text

  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  sentAt    DateTime? @map("sent_at") @db.Timestamptz(3)

  /// RESTRICT on both: a delivery row is evidence about a regulated event, so
  /// deleting a target or an alarm must not erase the record of what it did.
  target AlarmWebhookTarget @relation(fields: [targetId], references: [id], onDelete: Restrict)
  alarm  Alarm?             @relation(fields: [alarmId], references: [id], onDelete: Restrict)

  @@index([targetId, createdAt(sort: Desc)])
  @@index([alarmId])
  @@index([status])
  @@map("alarm_webhook_deliveries")
}
```

- [ ] **Step 2: Add the back-relation to `Alarm`**

Prisma requires both sides. In the existing `Alarm` model, beside `rule` and `instrument`:

```prisma
  webhookDeliveries AlarmWebhookDelivery[]
```

- [ ] **Step 3: Write the migration SQL by hand**

Create `apps/api/prisma/migrations/20260827120000_alarm_webhooks/migration.sql`:

```sql
-- Alarm webhook annunciator (2026-08-27).
-- Design: docs/superpowers/specs/2026-08-27-alarm-webhook-annunciator-design.md
--
-- HAND-WRITTEN. `prisma migrate diff` in this repo emits three DESTRUCTIVE statements
-- that are NOT part of this change and must never be committed:
--   1. DROP TABLE instrument_telemetry_history  (partitioned; Prisma reads it as stray)
--   2. ALTER audit_trail.chain_position DROP NOT NULL  (the §11 hash-chain position)
--   3. drop/recreate of an unchanged instrument_credentials FK
-- See 20260811120000_instrument_floorplans/migration.sql for the full account.

CREATE TABLE "alarm_webhook_targets" (
  "id"                   TEXT NOT NULL,
  "name"                 VARCHAR(200) NOT NULL,
  "description"          VARCHAR(500),
  "url"                  TEXT NOT NULL,
  "method"               VARCHAR(10) NOT NULL DEFAULT 'POST',
  "headers"              JSONB NOT NULL DEFAULT '{}',
  "content_type"         VARCHAR(100) NOT NULL DEFAULT 'application/json',
  "body_template"        TEXT NOT NULL,
  "success_regex"        TEXT,
  "timeout_ms"           INTEGER NOT NULL DEFAULT 5000,
  "fire_on_raised"       BOOLEAN NOT NULL DEFAULT true,
  "fire_on_cleared"      BOOLEAN NOT NULL DEFAULT true,
  "fire_on_acknowledged" BOOLEAN NOT NULL DEFAULT true,
  "severities"           JSONB,
  "cooldown_seconds"     INTEGER NOT NULL DEFAULT 0,
  "is_active"            BOOLEAN NOT NULL DEFAULT true,
  "scope_location_ids"   JSONB NOT NULL DEFAULT '[]',
  "scope_instrument_ids" JSONB NOT NULL DEFAULT '[]',
  "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMPTZ(3) NOT NULL,
  "created_by"           TEXT,
  "updated_by"           TEXT,
  CONSTRAINT "alarm_webhook_targets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "alarm_webhook_targets_is_active_idx" ON "alarm_webhook_targets"("is_active");

CREATE TABLE "alarm_webhook_deliveries" (
  "id"               TEXT NOT NULL,
  "target_id"        TEXT NOT NULL,
  "alarm_id"         TEXT,
  "event"            VARCHAR(20) NOT NULL,
  "url"              TEXT NOT NULL,
  "request_body"     TEXT NOT NULL,
  "http_status"      INTEGER,
  "response_snippet" VARCHAR(1000),
  "attempt"          INTEGER NOT NULL,
  "status"           VARCHAR(10) NOT NULL,
  "error"            TEXT,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at"          TIMESTAMPTZ(3),
  CONSTRAINT "alarm_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "alarm_webhook_deliveries_target_id_created_at_idx"
  ON "alarm_webhook_deliveries"("target_id", "created_at" DESC);
CREATE INDEX "alarm_webhook_deliveries_alarm_id_idx" ON "alarm_webhook_deliveries"("alarm_id");
CREATE INDEX "alarm_webhook_deliveries_status_idx" ON "alarm_webhook_deliveries"("status");

ALTER TABLE "alarm_webhook_deliveries"
  ADD CONSTRAINT "alarm_webhook_deliveries_target_id_fkey"
  FOREIGN KEY ("target_id") REFERENCES "alarm_webhook_targets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "alarm_webhook_deliveries"
  ADD CONSTRAINT "alarm_webhook_deliveries_alarm_id_fkey"
  FOREIGN KEY ("alarm_id") REFERENCES "alarms"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
```

Confirm the referenced table name is `alarms` before running:
```bash
grep -n '@@map("alarms")' apps/api/prisma/schema.prisma
```
If the `Alarm` model maps to a different name, fix the FK to match.

- [ ] **Step 4: Stop the API, then apply to BOTH databases**

The API must be stopped or `prisma generate` EPERMs on `query_engine-windows.dll.node`, leaving a stale client whose looser types hide real errors.

```bash
./stop-app.bat
cd apps/api
npx prisma migrate deploy
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/compliance_core_db_test" npx prisma migrate deploy
npx prisma generate
```

Take the real `DATABASE_URL` from `apps/api/.env` and swap only the database name — do not invent credentials.

- [ ] **Step 5: Verify both databases have the tables**

```bash
psql "$DATABASE_URL" -c "\d alarm_webhook_targets" | head -5
psql "${DATABASE_URL/compliance_core_db/compliance_core_db_test}" -c "\d alarm_webhook_deliveries" | head -5
npx prisma migrate status
```
Expected: both tables described; `migrate status` reports up to date apart from the known pre-existing `chain_position` drift.

- [ ] **Step 6: Run the drift guard**

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-migrations.ps1
```
Expected: PASS. (`npm run db:verify-migrations` fails on the execution policy on this box — that is the tooling, not the guard.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260827120000_alarm_webhooks/
git commit -m "feat(db): alarm webhook target and delivery models"
```

---

### Task 3: The JSON-safe body renderer

**Files:**
- Create: `apps/api/src/modules/alarm-webhooks/render-body.ts`
- Test: `apps/api/src/modules/alarm-webhooks/__tests__/render-body.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `renderWebhookBody(template: string, variables: Record<string, string>, contentType: string): string`

**Why this exists rather than reusing `template-engine.ts`:** `resolveTemplate()` HTML-escapes every substituted value — `"` → `&quot;`, `&` → `&amp;`. Correct for an email body, wrong for JSON. Instrument codes in this fork are deliberately unrestricted free text (the charset rule was replaced by UUID-addressed MQTT topics on 2026-08-07), so an instrument named `Chiller "A" & B` would render an unparseable body — intermittently, for one instrument, looking like a network fault.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/alarm-webhooks/__tests__/render-body.test.ts
import { describe, it, expect } from 'vitest';
import { renderWebhookBody } from '../render-body.js';

describe('renderWebhookBody', () => {
  it('substitutes plain values', () => {
    const out = renderWebhookBody('{"i":"${instrument}"}', { instrument: 'DEMO-TH-361' }, 'application/json');
    expect(out).toBe('{"i":"DEMO-TH-361"}');
    expect(JSON.parse(out).i).toBe('DEMO-TH-361');
  });

  // The whole reason this module exists instead of reusing resolveTemplate().
  it('JSON-escapes a value containing quotes and ampersands', () => {
    const out = renderWebhookBody('{"i":"${instrument}"}', { instrument: 'Chiller "A" & B' }, 'application/json');
    expect(out).not.toContain('&quot;');
    expect(out).not.toContain('&amp;');
    expect(JSON.parse(out).i).toBe('Chiller "A" & B');
  });

  it('JSON-escapes backslashes and newlines', () => {
    const out = renderWebhookBody('{"r":"${reason}"}', { reason: 'line1\nline2 C:\\temp' }, 'application/json');
    expect(JSON.parse(out).r).toBe('line1\nline2 C:\\temp');
  });

  it('inserts raw for a non-JSON content type', () => {
    const out = renderWebhookBody('msg=${instrument}', { instrument: 'A "B" & C' }, 'text/plain');
    expect(out).toBe('msg=A "B" & C');
  });

  // A typo must be visible in the delivery log, not silently rendered as "".
  it('leaves an unknown placeholder literal', () => {
    const out = renderWebhookBody('{"x":"${nope}"}', { instrument: 'A' }, 'application/json');
    expect(out).toBe('{"x":"${nope}"}');
  });

  it('substitutes every occurrence of a repeated placeholder', () => {
    const out = renderWebhookBody('${a}|${a}', { a: 'x' }, 'text/plain');
    expect(out).toBe('x|x');
  });

  it('treats an application/json content type with a charset suffix as JSON', () => {
    const out = renderWebhookBody('{"i":"${i}"}', { i: 'a"b' }, 'application/json; charset=utf-8');
    expect(JSON.parse(out).i).toBe('a"b');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run apps/api/src/modules/alarm-webhooks/__tests__/render-body.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `../render-body.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/alarm-webhooks/render-body.ts
/**
 * Renders a webhook body template.
 *
 * DELIBERATELY NOT notification-delivery/template-engine.ts:resolveTemplate(). That
 * function HTML-escapes every substituted value (`"` -> `&quot;`, `&` -> `&amp;`),
 * which is right for an email body and wrong for a JSON payload. Instrument codes
 * here are unrestricted free text by design, so an instrument named
 * `Chiller "A" & B` would produce a body the hooter rejects as malformed —
 * intermittently, for one instrument, looking exactly like a network fault.
 */

const VARIABLE_REGEX = /\$\{([^}]+)\}/g;

function isJson(contentType: string): boolean {
  return contentType.toLowerCase().includes('json');
}

/** Escapes for insertion INSIDE a JSON string literal (no surrounding quotes). */
function jsonInner(value: string): string {
  const quoted = JSON.stringify(value);
  return quoted.slice(1, -1);
}

export function renderWebhookBody(
  template: string,
  variables: Record<string, string>,
  contentType: string,
): string {
  const escape = isJson(contentType) ? jsonInner : (v: string) => v;
  return template.replace(VARIABLE_REGEX, (match, key: string) => {
    const value = variables[key.trim()];
    // An unknown placeholder stays literal — matching resolveTemplate's behaviour —
    // so a typo shows up in the stored requestBody instead of becoming "".
    if (value === undefined) return match;
    return escape(String(value));
  });
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run apps/api/src/modules/alarm-webhooks/__tests__/render-body.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/alarm-webhooks/render-body.ts apps/api/src/modules/alarm-webhooks/__tests__/render-body.test.ts
git commit -m "feat(api): JSON-safe webhook body renderer"
```

---

### Task 4: Scope resolution

**Files:**
- Create: `apps/api/src/modules/alarm-webhooks/target-scope.ts`
- Test: `apps/api/src/modules/alarm-webhooks/__tests__/target-scope.test.ts`

**Interfaces:**
- Consumes: `AlarmWebhookTargetShape`, `AlarmWebhookEvent` (Task 1); `resolveLocationIds(id, all)` from `../functional-locations/tree.js`.
- Produces:
  - `expandLocations(scopeLocationIds: string[], nodes: FlNode[]): Set<string>`
  - `targetMatches(target: AlarmWebhookTargetShape, ctx: MatchContext): boolean`
  - `interface MatchContext { event: AlarmWebhookEvent; severity: string; instrumentId: string; functionalLocationId: string | null; locations: Set<string> }`

Pure over already-loaded data, so it is testable with no database. The DB query lives in the worker (Task 6).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/alarm-webhooks/__tests__/target-scope.test.ts
import { describe, it, expect } from 'vitest';
import { expandLocations, targetMatches } from '../target-scope.js';
import type { AlarmWebhookTargetShape } from '@digilog/shared';

// BLOCK-1 has two areas; AREA-3 belongs to another block.
const NODES = [
  { id: 'BLOCK-1', parentId: null, type: 'BLOCK' as const, name: 'CWH' },
  { id: 'AREA-1', parentId: 'BLOCK-1', type: 'AREA' as const, name: 'QC-3' },
  { id: 'AREA-2', parentId: 'BLOCK-1', type: 'AREA' as const, name: 'Stability' },
  { id: 'BLOCK-2', parentId: null, type: 'BLOCK' as const, name: 'Module E' },
  { id: 'AREA-3', parentId: 'BLOCK-2', type: 'AREA' as const, name: 'Cold room' },
];

const target = (over: Partial<AlarmWebhookTargetShape> = {}): AlarmWebhookTargetShape => ({
  id: 'T1',
  isActive: true,
  fireOnRaised: true,
  fireOnCleared: true,
  fireOnAcknowledged: true,
  severities: null,
  scopeLocationIds: [],
  scopeInstrumentIds: [],
  ...over,
});

const ctx = (over: Partial<Parameters<typeof targetMatches>[1]> = {}) => ({
  event: 'RAISED' as const,
  severity: 'MAJOR',
  instrumentId: 'INST-1',
  functionalLocationId: 'AREA-1',
  locations: new Set<string>(),
  ...over,
});

describe('expandLocations', () => {
  it('expands a Block to itself plus its Areas', () => {
    expect([...expandLocations(['BLOCK-1'], NODES)].sort()).toEqual(['AREA-1', 'AREA-2', 'BLOCK-1']);
  });

  it('leaves an Area as itself', () => {
    expect([...expandLocations(['AREA-3'], NODES)]).toEqual(['AREA-3']);
  });

  it('ignores an id that is not in the tree', () => {
    expect([...expandLocations(['GONE'], NODES)]).toEqual([]);
  });

  it('is empty for an empty scope', () => {
    expect(expandLocations([], NODES).size).toBe(0);
  });
});

describe('targetMatches', () => {
  // THE most important assertion in this file.
  it('matches NOTHING when both scope lists are empty', () => {
    expect(targetMatches(target(), ctx())).toBe(false);
  });

  it('matches an explicitly listed instrument', () => {
    expect(targetMatches(target({ scopeInstrumentIds: ['INST-1'] }), ctx())).toBe(true);
  });

  it('matches an instrument inside a scoped Block', () => {
    const t = target({ scopeLocationIds: ['BLOCK-1'] });
    const locations = expandLocations(t.scopeLocationIds, NODES);
    expect(targetMatches(t, ctx({ locations }))).toBe(true);
  });

  it('does not match an instrument in a different block', () => {
    const t = target({ scopeLocationIds: ['BLOCK-2'] });
    const locations = expandLocations(t.scopeLocationIds, NODES);
    expect(targetMatches(t, ctx({ locations }))).toBe(false);
  });

  it('unions the two lists', () => {
    const t = target({ scopeLocationIds: ['BLOCK-2'], scopeInstrumentIds: ['INST-1'] });
    const locations = expandLocations(t.scopeLocationIds, NODES);
    expect(targetMatches(t, ctx({ locations }))).toBe(true);
  });

  it('reaches an unassigned instrument only through the explicit list', () => {
    const t = target({ scopeLocationIds: ['BLOCK-1'] });
    const locations = expandLocations(t.scopeLocationIds, NODES);
    expect(targetMatches(t, ctx({ functionalLocationId: null, locations }))).toBe(false);
    expect(targetMatches(target({ scopeInstrumentIds: ['INST-1'] }), ctx({ functionalLocationId: null }))).toBe(true);
  });

  it('respects isActive', () => {
    expect(targetMatches(target({ isActive: false, scopeInstrumentIds: ['INST-1'] }), ctx())).toBe(false);
  });

  it('respects the per-event fire flags', () => {
    const t = target({ scopeInstrumentIds: ['INST-1'], fireOnCleared: false });
    expect(targetMatches(t, ctx({ event: 'RAISED' }))).toBe(true);
    expect(targetMatches(t, ctx({ event: 'CLEARED' }))).toBe(false);
  });

  it('a TEST fire ignores the fire flags and the scope', () => {
    const t = target({ fireOnRaised: false, fireOnCleared: false, fireOnAcknowledged: false });
    expect(targetMatches(t, ctx({ event: 'TEST' }))).toBe(true);
  });

  it('narrows by severity when severities is set, and allows all when null', () => {
    const t = target({ scopeInstrumentIds: ['INST-1'], severities: ['CRITICAL'] });
    expect(targetMatches(t, ctx({ severity: 'CRITICAL' }))).toBe(true);
    expect(targetMatches(t, ctx({ severity: 'MAJOR' }))).toBe(false);
    expect(targetMatches(target({ scopeInstrumentIds: ['INST-1'] }), ctx({ severity: 'MINOR' }))).toBe(true);
  });

  it('treats an empty severities array as matching nothing, not everything', () => {
    const t = target({ scopeInstrumentIds: ['INST-1'], severities: [] });
    expect(targetMatches(t, ctx({ severity: 'CRITICAL' }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run apps/api/src/modules/alarm-webhooks/__tests__/target-scope.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `../target-scope.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/alarm-webhooks/target-scope.ts
/**
 * Which webhook targets an alarm on a given instrument should fire.
 *
 * Pure over already-loaded data so it is testable without a database. The query
 * lives in the worker.
 *
 * Scope is modelled on role_configs.instrument_scope: functional locations, with a
 * Block expanding to its Areas via resolveLocationIds(), UNIONED with an explicit
 * instrument list. No fourth grouping concept — CLAUDE.md is explicit that there are
 * three (FunctionalLocation = logical, roomId = geometry, profileId = device type).
 */

import { resolveLocationIds, type FlNode } from '../functional-locations/tree.js';
import type { AlarmWebhookEvent, AlarmWebhookTargetShape } from '@digilog/shared';

export interface MatchContext {
  event: AlarmWebhookEvent;
  severity: string;
  instrumentId: string;
  functionalLocationId: string | null;
  /** Pre-expanded from the target's scopeLocationIds — see expandLocations. */
  locations: Set<string>;
}

/** A Block yields itself plus its Areas; an Area yields itself; an unknown id, nothing. */
export function expandLocations(scopeLocationIds: string[], nodes: FlNode[]): Set<string> {
  const out = new Set<string>();
  for (const id of scopeLocationIds) {
    for (const resolved of resolveLocationIds(id, nodes)) out.add(resolved);
  }
  return out;
}

function firesOn(t: AlarmWebhookTargetShape, event: AlarmWebhookEvent): boolean {
  if (event === 'RAISED') return t.fireOnRaised;
  if (event === 'CLEARED') return t.fireOnCleared;
  if (event === 'ACKNOWLEDGED') return t.fireOnAcknowledged;
  // TEST is an operator pressing a button on this specific target. It deliberately
  // ignores the fire flags and the scope — commissioning a hooter must not require
  // first configuring the conditions you are trying to test.
  return true;
}

export function targetMatches(t: AlarmWebhookTargetShape, ctx: MatchContext): boolean {
  if (!t.isActive) return false;
  if (!firesOn(t, ctx.event)) return false;
  if (ctx.event === 'TEST') return true;

  // NULL severities = every severity. An EMPTY ARRAY is a deliberate "none" — the same
  // asymmetry as the scope lists below, and for the same reason.
  if (t.severities !== null && !t.severities.includes(ctx.severity)) return false;

  // BOTH LISTS EMPTY MATCHES NOTHING. Never everything. A silent target is a bug
  // someone finds and fixes; a target that buzzes every hooter in the plant gets the
  // feature switched off at the panel and never switched back on.
  if (t.scopeInstrumentIds.includes(ctx.instrumentId)) return true;
  if (ctx.functionalLocationId && ctx.locations.has(ctx.functionalLocationId)) return true;
  return false;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run apps/api/src/modules/alarm-webhooks/__tests__/target-scope.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS, 16 tests.

`FlNode` is a real exported interface in `functional-locations/tree.ts`
(`{ id, name, type: FlType, parentId: string | null }`) — import it by name, as the
code above does. Do not re-declare it.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: exits 0. vitest runs through esbuild and never typechecks — this is the only step that catches a type error here.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/alarm-webhooks/target-scope.ts apps/api/src/modules/alarm-webhooks/__tests__/target-scope.test.ts
git commit -m "feat(api): resolve which webhook targets an instrument's alarm fires"
```

---

### Task 5: One delivery attempt

**Files:**
- Create: `apps/api/src/modules/alarm-webhooks/deliver.ts`
- Test: `apps/api/src/modules/alarm-webhooks/__tests__/deliver.test.ts`

**Interfaces:**
- Consumes: nothing (takes a plain request descriptor).
- Produces:
  - `interface WebhookRequest { url: string; method: string; headers: Record<string, string>; contentType: string; body: string; timeoutMs: number; successRegex: string | null }`
  - `interface AttemptResult { ok: boolean; httpStatus: number | null; responseSnippet: string | null; error: string | null }`
  - `attemptDelivery(req: WebhookRequest): Promise<AttemptResult>`
  - `decideSuccess(status: number, body: string, successRegex: string | null): boolean`

`decideSuccess` is split out so the 200-with-failure-body rule is unit-testable without a socket.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/alarm-webhooks/__tests__/deliver.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { attemptDelivery, decideSuccess } from '../deliver.js';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '/';
      if (url === '/ok') { res.writeHead(200); res.end('{"result":"ok"}'); return; }
      if (url === '/fail-200') { res.writeHead(200); res.end('{"status":"error"}'); return; }
      if (url === '/500') { res.writeHead(500); res.end('boom'); return; }
      if (url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('late'); }, 500); return; }
      if (url === '/echo') { res.writeHead(200); res.end(Buffer.concat(chunks).toString()); return; }
      if (url === '/big') { res.writeHead(200); res.end('x'.repeat(5000)); return; }
      res.writeHead(404); res.end('nope');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const req = (over: Partial<Parameters<typeof attemptDelivery>[0]>) => ({
  url: `${base}/ok`,
  method: 'POST',
  headers: {} as Record<string, string>,
  contentType: 'application/json',
  body: '{"event":"RAISED"}',
  timeoutMs: 2000,
  successRegex: null as string | null,
  ...over,
});

describe('decideSuccess', () => {
  it('accepts 2xx with no regex', () => {
    expect(decideSuccess(200, 'anything', null)).toBe(true);
    expect(decideSuccess(204, '', null)).toBe(true);
  });

  it('rejects non-2xx', () => {
    expect(decideSuccess(500, 'ok', null)).toBe(false);
    expect(decideSuccess(404, '', null)).toBe(false);
  });

  // The #sms-2xx lesson: cheap hardware returns HTTP 200 on failure.
  it('lets the regex override a 200', () => {
    expect(decideSuccess(200, '{"status":"error"}', '"status"\\s*:\\s*"success"')).toBe(false);
    expect(decideSuccess(200, '{"status":"success"}', '"status"\\s*:\\s*"success"')).toBe(true);
  });

  it('still requires 2xx when a regex matches a non-2xx body', () => {
    expect(decideSuccess(500, '{"status":"success"}', '"status"\\s*:\\s*"success"')).toBe(false);
  });

  // An unparseable regex must not throw inside the worker.
  it('treats an invalid regex as a failure rather than throwing', () => {
    expect(() => decideSuccess(200, 'ok', '([')).not.toThrow();
    expect(decideSuccess(200, 'ok', '([')).toBe(false);
  });
});

describe('attemptDelivery', () => {
  it('succeeds on 200', async () => {
    const r = await attemptDelivery(req({}));
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(r.responseSnippet).toContain('ok');
    expect(r.error).toBeNull();
  });

  it('fails on 500 and records the status', async () => {
    const r = await attemptDelivery(req({ url: `${base}/500` }));
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(500);
  });

  it('fails a 200 whose body does not match the success regex', async () => {
    const r = await attemptDelivery(req({ url: `${base}/fail-200`, successRegex: '"status"\\s*:\\s*"success"' }));
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(200);
  });

  it('times out with no status and an error', async () => {
    const r = await attemptDelivery(req({ url: `${base}/slow`, timeoutMs: 100 }));
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBeNull();
    expect(r.error).toBeTruthy();
  });

  it('reports a connection refusal as an error, not a throw', async () => {
    const r = await attemptDelivery(req({ url: 'http://127.0.0.1:1/none', timeoutMs: 500 }));
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBeNull();
    expect(r.error).toBeTruthy();
  });

  it('sends the body and the content type', async () => {
    const r = await attemptDelivery(req({ url: `${base}/echo`, body: '{"a":1}' }));
    expect(r.responseSnippet).toBe('{"a":1}');
  });

  it('sends no body on GET', async () => {
    const r = await attemptDelivery(req({ url: `${base}/echo`, method: 'GET' }));
    expect(r.ok).toBe(true);
    expect(r.responseSnippet).toBe('');
  });

  it('truncates the response snippet to 1000 chars for the VARCHAR(1000) column', async () => {
    const r = await attemptDelivery(req({ url: `${base}/big` }));
    expect(r.responseSnippet!.length).toBeLessThanOrEqual(1000);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run apps/api/src/modules/alarm-webhooks/__tests__/deliver.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `../deliver.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/api/src/modules/alarm-webhooks/deliver.ts
/**
 * One HTTP attempt at a webhook target. No retry, no database — the worker owns both.
 *
 * OUTBOUND-REQUEST STANCE (design doc, "Outbound-request stance"): the URL is
 * operator-typed and there is deliberately NO allowlist, because a hooter lives on the
 * operator's LAN and any allowlist would have to contain it. The guards are the hard
 * timeout, redirect:'error' (a hooter does not redirect, and following one is how an
 * internal-IP POST becomes an external one), no credentials/cookies, and the delivery
 * log recording the exact URL, body and response.
 */

/** VARCHAR(1000) on alarm_webhook_deliveries.response_snippet. */
const SNIPPET_MAX = 1000;

export interface WebhookRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  contentType: string;
  body: string;
  timeoutMs: number;
  successRegex: string | null;
}

export interface AttemptResult {
  ok: boolean;
  httpStatus: number | null;
  responseSnippet: string | null;
  error: string | null;
}

/**
 * When a success regex is set it is AUTHORITATIVE over the body — cheap hardware
 * returns HTTP 200 on failure, the lesson already recorded at
 * SmsConfig.httpGatewaySuccessRegex (#sms-2xx). A non-2xx status still fails
 * regardless: a matching string in a 500 body is not a delivery.
 */
export function decideSuccess(status: number, body: string, successRegex: string | null): boolean {
  if (status < 200 || status >= 300) return false;
  if (!successRegex) return true;
  try {
    return new RegExp(successRegex).test(body);
  } catch {
    // An unparseable regex must fail closed rather than throw inside the worker.
    // The operator sees a FAILED row with the response body and can fix the pattern.
    return false;
  }
}

export async function attemptDelivery(req: WebhookRequest): Promise<AttemptResult> {
  const method = req.method.toUpperCase();
  const sendsBody = method !== 'GET' && method !== 'HEAD';
  try {
    const res = await fetch(req.url, {
      method,
      headers: sendsBody ? { 'Content-Type': req.contentType, ...req.headers } : { ...req.headers },
      body: sendsBody ? req.body : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    const text = await res.text();
    const snippet = text.slice(0, SNIPPET_MAX);
    return {
      ok: decideSuccess(res.status, text, req.successRegex),
      httpStatus: res.status,
      responseSnippet: snippet,
      error: null,
    };
  } catch (e) {
    // Timeout, DNS failure, connection refused, or a refused redirect. No status
    // exists, and that absence is itself the diagnostic.
    return {
      ok: false,
      httpStatus: null,
      responseSnippet: null,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run apps/api/src/modules/alarm-webhooks/__tests__/deliver.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/alarm-webhooks/deliver.ts apps/api/src/modules/alarm-webhooks/__tests__/deliver.test.ts
git commit -m "feat(api): single webhook delivery attempt with regex success rule"
```

---

### Task 6: The worker, its queue schema, and the cooldown

**Files:**
- Create: `apps/api/src/workers/alarm-webhook.worker.ts`
- Modify: `packages/queue/src/schemas.ts` (add `alarmWebhookJobSchema`)
- Modify: `apps/api/src/app.ts` (add `alarm_webhook` to `taskList`, ~line 479)
- Test: `apps/api/src/modules/alarm-webhooks/__tests__/cooldown.test.ts`

**Interfaces:**
- Consumes: `targetMatches`, `expandLocations` (Task 4); `renderWebhookBody` (Task 3); `attemptDelivery` (Task 5); `ALARM_WEBHOOK_EVENTS` (Task 1).
- Produces:
  - `alarmWebhookTask` — the graphile-worker handler.
  - `runAlarmWebhookJob(payload): Promise<{ targets: number; sent: number; failed: number }>`
  - `shouldFire(event, targetId, cooldownSeconds, now): boolean` and `resetCooldowns()` from `cooldown.ts`.

Split the cooldown into its own tiny module so it can be tested deterministically with an injected clock. `Date.now()` inside a test is how flaky suites are born.

- [ ] **Step 1: Write the failing cooldown test**

```ts
// apps/api/src/modules/alarm-webhooks/__tests__/cooldown.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { shouldFire, resetCooldowns } from '../cooldown.js';

describe('cooldown', () => {
  beforeEach(() => resetCooldowns());

  it('always fires when the cooldown is zero', () => {
    expect(shouldFire('RAISED', 'T1', 0, 1000)).toBe(true);
    expect(shouldFire('RAISED', 'T1', 0, 1001)).toBe(true);
  });

  it('suppresses a second RAISED inside the window', () => {
    expect(shouldFire('RAISED', 'T1', 60, 0)).toBe(true);
    expect(shouldFire('RAISED', 'T1', 60, 30_000)).toBe(false);
    expect(shouldFire('RAISED', 'T1', 60, 60_000)).toBe(true);
  });

  it('tracks targets independently', () => {
    expect(shouldFire('RAISED', 'T1', 60, 0)).toBe(true);
    expect(shouldFire('RAISED', 'T2', 60, 0)).toBe(true);
  });

  // The rule the design calls out by name: never rate-limit the off switch.
  it('never suppresses CLEARED or ACKNOWLEDGED', () => {
    expect(shouldFire('RAISED', 'T1', 3600, 0)).toBe(true);
    expect(shouldFire('CLEARED', 'T1', 3600, 1)).toBe(true);
    expect(shouldFire('ACKNOWLEDGED', 'T1', 3600, 2)).toBe(true);
    expect(shouldFire('CLEARED', 'T1', 3600, 3)).toBe(true);
  });

  it('does not let CLEARED reset the RAISED window', () => {
    expect(shouldFire('RAISED', 'T1', 60, 0)).toBe(true);
    expect(shouldFire('CLEARED', 'T1', 60, 10_000)).toBe(true);
    expect(shouldFire('RAISED', 'T1', 60, 20_000)).toBe(false);
  });

  it('never suppresses a TEST fire', () => {
    expect(shouldFire('RAISED', 'T1', 3600, 0)).toBe(true);
    expect(shouldFire('TEST', 'T1', 3600, 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run apps/api/src/modules/alarm-webhooks/__tests__/cooldown.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `../cooldown.js`.

- [ ] **Step 3: Write the cooldown module**

```ts
// apps/api/src/modules/alarm-webhooks/cooldown.ts
/**
 * Per-target RAISED throttle.
 *
 * In-memory, single-instance — the same approach and the same caveat as
 * notification-dispatcher.ts's cooldownMap. Recorded rather than inherited silently:
 * on a restart the map is empty and the next raise fires immediately, which is the
 * correct failure direction for an annunciator.
 *
 * THROTTLES `RAISED` ONLY. CLEARED and ACKNOWLEDGED are silence signals: suppressing
 * one leaves a buzzer sounding for a condition that has already gone away, and the
 * operator's only remedy is to unplug the hooter — the exact outcome the cooldown
 * exists to prevent. Never rate-limit the off switch.
 */

import type { AlarmWebhookEvent } from '@digilog/shared';

const lastRaised = new Map<string, number>();

/** `now` is injected so tests are deterministic. */
export function shouldFire(
  event: AlarmWebhookEvent,
  targetId: string,
  cooldownSeconds: number,
  now: number,
): boolean {
  if (event !== 'RAISED') return true;
  if (cooldownSeconds <= 0) return true;
  const last = lastRaised.get(targetId);
  if (last !== undefined && now - last < cooldownSeconds * 1000) return false;
  lastRaised.set(targetId, now);
  return true;
}

/** Test seam only. */
export function resetCooldowns(): void {
  lastRaised.clear();
}
```

- [ ] **Step 4: Run it and verify it passes**

Run: `npx vitest run apps/api/src/modules/alarm-webhooks/__tests__/cooldown.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the queue payload schema**

Append to `packages/queue/src/schemas.ts`:

```ts
/**
 * Alarm webhook (hooter) job — what the evaluator and the acknowledge route enqueue.
 *
 * Enqueued with maxAttempts: 1 on purpose. Retry is BOUNDED INSIDE the job (3 attempts,
 * ~2s apart) because graphile-worker's exponential backoff could otherwise sound a
 * buzzer twenty minutes after the excursion cleared — announcing a condition that no
 * longer exists, which is worse than not announcing at all.
 */
export const alarmWebhookJobSchema = z.object({
  event: z.enum(['RAISED', 'CLEARED', 'ACKNOWLEDGED']),
  alarmId: z.string().min(1),
  instrumentId: z.string().min(1),
  severity: z.string().min(1),
  /** Template variables. Strings only — the renderer does no coercion. */
  variables: z.record(z.string()).default({}),
});
export type AlarmWebhookJob = z.infer<typeof alarmWebhookJobSchema>;
```

Then export it from `packages/queue/src/index.ts` alongside the other schema exports (follow the existing `export { … } from './schemas.js'` block), and rebuild:

```bash
npm run build -w @digilog/queue
```

- [ ] **Step 6: Write the worker**

```ts
// apps/api/src/workers/alarm-webhook.worker.ts
/**
 * Alarm webhook annunciator. graphile-worker task, registered as `alarm_webhook`.
 *
 * Design: docs/superpowers/specs/2026-08-27-alarm-webhook-annunciator-design.md
 *
 * NOT scheduled — there is no crontab entry. This task is enqueued by the alarm
 * evaluator and by the acknowledge route. (packages/queue/crontab.txt warns that a
 * cron identifier with no handler leaks jobs forever; the converse is fine — a handler
 * with no cron entry is exactly what an event-driven task looks like.)
 */

import { prisma } from '../lib/prisma.js';
import { alarmWebhookJobSchema, type AlarmWebhookJob } from '@digilog/queue';
import type { AlarmWebhookTargetShape } from '@digilog/shared';
import { expandLocations, targetMatches } from '../modules/alarm-webhooks/target-scope.js';
import { renderWebhookBody } from '../modules/alarm-webhooks/render-body.js';
import { attemptDelivery } from '../modules/alarm-webhooks/deliver.js';
import { shouldFire } from '../modules/alarm-webhooks/cooldown.js';

/** 3 attempts total, ~2s apart, all inside this job. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends to one target, retrying up to MAX_ATTEMPTS, writing a delivery row per attempt.
 * Returns true if any attempt succeeded.
 */
export async function deliverToTarget(
  target: {
    id: string; url: string; method: string; headers: unknown; contentType: string;
    bodyTemplate: string; successRegex: string | null; timeoutMs: number;
  },
  event: string,
  alarmId: string | null,
  variables: Record<string, string>,
): Promise<boolean> {
  const body = renderWebhookBody(target.bodyTemplate, variables, target.contentType);
  const headers =
    target.headers && typeof target.headers === 'object' && !Array.isArray(target.headers)
      ? (target.headers as Record<string, string>)
      : {};

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await attemptDelivery({
      url: target.url,
      method: target.method,
      headers,
      contentType: target.contentType,
      body,
      timeoutMs: target.timeoutMs,
      successRegex: target.successRegex,
    });

    // A row PER ATTEMPT, success or failure. An annunciation this system claims it
    // made needs evidence, and so does one it failed to make.
    await prisma.alarmWebhookDelivery.create({
      data: {
        targetId: target.id,
        alarmId,
        event,
        url: target.url,
        requestBody: body,
        httpStatus: result.httpStatus,
        responseSnippet: result.responseSnippet,
        attempt,
        status: result.ok ? 'SENT' : 'FAILED',
        error: result.error,
        sentAt: result.ok ? new Date() : null,
      },
    });

    if (result.ok) return true;
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  return false;
}

export async function runAlarmWebhookJob(
  payload: AlarmWebhookJob,
  now: number = Date.now(),
): Promise<{ targets: number; sent: number; failed: number }> {
  const { event, alarmId, instrumentId, severity, variables } = payload;

  const [instrument, targets, nodes] = await Promise.all([
    prisma.instrument.findUnique({ where: { id: instrumentId }, select: { functionalLocationId: true } }),
    prisma.alarmWebhookTarget.findMany({ where: { isActive: true } }),
    // Exactly the four fields FlNode declares, so the result is structurally an FlNode[]
    // and needs no cast.
    prisma.functionalLocation.findMany({ select: { id: true, name: true, type: true, parentId: true } }),
  ]);

  let sent = 0;
  let failed = 0;
  let matched = 0;

  for (const t of targets) {
    const shape: AlarmWebhookTargetShape = {
      id: t.id,
      isActive: t.isActive,
      fireOnRaised: t.fireOnRaised,
      fireOnCleared: t.fireOnCleared,
      fireOnAcknowledged: t.fireOnAcknowledged,
      severities: t.severities === null ? null : asStringArray(t.severities),
      scopeLocationIds: asStringArray(t.scopeLocationIds),
      scopeInstrumentIds: asStringArray(t.scopeInstrumentIds),
    };

    const locations = expandLocations(shape.scopeLocationIds, nodes);
    if (!targetMatches(shape, {
      event,
      severity,
      instrumentId,
      functionalLocationId: instrument?.functionalLocationId ?? null,
      locations,
    })) continue;

    matched++;
    if (!shouldFire(event, t.id, t.cooldownSeconds, now)) continue;

    const ok = await deliverToTarget(t, event, alarmId, variables);
    if (ok) sent++; else failed++;
  }

  return { targets: matched, sent, failed };
}

/** graphile-worker task. Registered as `alarm_webhook`. */
export const alarmWebhookTask = async (
  payload: unknown,
  helpers?: { logger?: { info: (m: string) => void; error?: (m: string) => void } },
) => {
  const parsed = alarmWebhookJobSchema.safeParse(payload);
  if (!parsed.success) {
    // Do not throw: a malformed job would retry forever against a payload that can
    // never become valid. Log it and let the job complete.
    helpers?.logger?.error?.(`[alarm-webhook] discarding malformed job: ${parsed.error.message}`);
    return;
  }
  const res = await runAlarmWebhookJob(parsed.data);
  if (res.targets > 0) {
    helpers?.logger?.info(
      `[alarm-webhook] ${parsed.data.event} ${parsed.data.alarmId}: ${res.targets} target(s), sent ${res.sent}, failed ${res.failed}`,
    );
  }
};
```

- [ ] **Step 7: Register the task in `app.ts`**

In `apps/api/src/app.ts`, add the import beside the other worker imports, then add to the `taskList` object (around line 479, after `alarm_evaluation`):

```ts
        // Alarm webhook annunciator — event-driven, NOT cron. Enqueued by the alarm
        // evaluator and the acknowledge route. Retry is bounded inside the task, so
        // this is enqueued with maxAttempts: 1: a buzzer that sounds twenty minutes
        // late announces a condition that no longer exists.
        alarm_webhook: alarmWebhookTask,
```

- [ ] **Step 8: Typecheck and run the module's suites**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
npx vitest run apps/api/src/modules/alarm-webhooks --pool=forks --poolOptions.forks.singleFork=true
```
Expected: tsc exits 0; all alarm-webhooks tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/workers/alarm-webhook.worker.ts apps/api/src/modules/alarm-webhooks/cooldown.ts apps/api/src/modules/alarm-webhooks/__tests__/cooldown.test.ts packages/queue/src/schemas.ts packages/queue/src/index.ts apps/api/src/app.ts
git commit -m "feat(api): alarm webhook worker with bounded retry and raise-only cooldown"
```

---

### Task 7: Enqueue, and wire it into the evaluator and the acknowledge route

**Files:**
- Create: `apps/api/src/modules/alarm-webhooks/enqueue.ts`
- Create: `apps/api/src/modules/alarm-webhooks/build-variables.ts`
- Modify: `apps/api/src/workers/alarm-evaluation.worker.ts` (4 sites: ~239, ~260, ~379, ~438)
- Modify: `apps/api/src/modules/alarms/routes.ts` (`POST /:id/acknowledge`, after the atomic claim)
- Test: `apps/api/src/modules/alarm-webhooks/__tests__/build-variables.test.ts`

**Interfaces:**
- Consumes: `ALARM_WEBHOOK_VARIABLES` (Task 1); `formatDecimals`, `TELEMETRY_DECIMALS_FALLBACK` from `@digilog/shared`; `formatDuration` from `../alarms/notify.js`.
- Produces:
  - `buildWebhookVariables(event, input): Record<string, string>`
  - `enqueueAlarmWebhook(event, input, log?): Promise<boolean>`
  - `interface WebhookAlarmInput` — same field set as `AlarmNotificationInput` plus `acknowledgedBy?`, `acknowledgeReason?`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/alarm-webhooks/__tests__/build-variables.test.ts
import { describe, it, expect } from 'vitest';
import { buildWebhookVariables } from '../build-variables.js';
import { ALARM_WEBHOOK_VARIABLES } from '@digilog/shared';

const base = {
  alarmId: 'A1',
  instrumentId: 'I1',
  instrumentCode: 'DEMO-TH-361',
  instrumentName: 'Stability chamber',
  metric: 'TEMPERATURE',
  severity: 'CRITICAL',
  ruleName: 'High temperature limit',
  condition: 'above 25',
  triggeredValue: 26.456,
  decimals: 2,
  raisedAt: new Date('2026-08-27T10:00:00.000Z'),
};

describe('buildWebhookVariables', () => {
  it('produces every variable RAISED promises', () => {
    const v = buildWebhookVariables('RAISED', base);
    for (const key of ALARM_WEBHOOK_VARIABLES.RAISED) expect(v).toHaveProperty(key);
  });

  it('produces every variable CLEARED promises', () => {
    const v = buildWebhookVariables('CLEARED', { ...base, clearedAt: new Date('2026-08-27T11:30:00.000Z') });
    for (const key of ALARM_WEBHOOK_VARIABLES.CLEARED) expect(v).toHaveProperty(key);
    expect(v.duration).toBe('1 h 30 min');
  });

  it('produces every variable ACKNOWLEDGED promises', () => {
    const v = buildWebhookVariables('ACKNOWLEDGED', { ...base, acknowledgedBy: 'jdoe', acknowledgeReason: 'door left open' });
    for (const key of ALARM_WEBHOOK_VARIABLES.ACKNOWLEDGED) expect(v).toHaveProperty(key);
    expect(v.acknowledgedBy).toBe('jdoe');
    expect(v.acknowledgeReason).toBe('door left open');
  });

  // Precision must match the dashboard and the email — one excursion, one number.
  it('formats the value to the instrument decimals', () => {
    expect(buildWebhookVariables('RAISED', base).value).toBe('26.46');
    expect(buildWebhookVariables('RAISED', { ...base, decimals: 0 }).value).toBe('26');
  });

  it('renders a missing value as an em dash, but keeps a real zero', () => {
    expect(buildWebhookVariables('RAISED', { ...base, triggeredValue: null }).value).toBe('—');
    expect(buildWebhookVariables('RAISED', { ...base, triggeredValue: 0, decimals: 1 }).value).toBe('0.0');
  });

  it('falls back to the instrument id when there is no code', () => {
    expect(buildWebhookVariables('RAISED', { ...base, instrumentCode: null }).instrument).toBe('I1');
  });

  it('every value is a string', () => {
    const v = buildWebhookVariables('RAISED', base);
    for (const val of Object.values(v)) expect(typeof val).toBe('string');
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run apps/api/src/modules/alarm-webhooks/__tests__/build-variables.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `../build-variables.js`.

- [ ] **Step 3: Write the variable builder**

```ts
// apps/api/src/modules/alarm-webhooks/build-variables.ts
/**
 * Builds the placeholder values for a webhook body.
 *
 * Mirrors alarms/notify.ts's formatting decisions — notably formatDecimals against the
 * INSTRUMENT's own precision — so the hooter payload, the email and the dashboard all
 * quote one excursion identically.
 */

import { formatDecimals, TELEMETRY_DECIMALS_FALLBACK, type AlarmWebhookEvent } from '@digilog/shared';
import { formatDuration } from '../alarms/notify.js';

export interface WebhookAlarmInput {
  alarmId: string;
  instrumentId: string;
  instrumentCode: string | null;
  instrumentName?: string | null;
  metric: string;
  severity: string;
  ruleName: string;
  condition: string;
  triggeredValue: number | null;
  decimals?: number | null;
  raisedAt: Date;
  clearedAt?: Date | null;
  acknowledgedBy?: string | null;
  acknowledgeReason?: string | null;
}

export function buildWebhookVariables(
  event: AlarmWebhookEvent,
  a: WebhookAlarmInput,
): Record<string, string> {
  const instrument = a.instrumentCode || a.instrumentId;
  // A reading of 0 is real; only a genuinely absent value (OFFLINE has none) is '—'.
  const value = formatDecimals(a.triggeredValue, a.decimals ?? TELEMETRY_DECIMALS_FALLBACK) ?? '—';
  const endAt = a.clearedAt ?? a.raisedAt;

  const vars: Record<string, string> = {
    event,
    alarmId: a.alarmId,
    instrument,
    instrumentName: a.instrumentName || instrument,
    instrumentId: a.instrumentId,
    metric: a.metric,
    value,
    severity: a.severity,
    condition: a.condition,
    ruleName: a.ruleName,
    timestamp: (event === 'CLEARED' ? endAt : new Date()).toISOString(),
  };

  if (event === 'CLEARED') {
    vars.raisedAt = a.raisedAt.toISOString();
    vars.duration = formatDuration(a.raisedAt, endAt);
  }
  if (event === 'ACKNOWLEDGED') {
    vars.raisedAt = a.raisedAt.toISOString();
    vars.acknowledgedBy = a.acknowledgedBy ?? '';
    vars.acknowledgeReason = a.acknowledgeReason ?? '';
  }
  return vars;
}
```

If `formatDuration` is not exported from `alarms/notify.ts`, add `export` to it there — it is already a standalone function.

- [ ] **Step 4: Run it and verify it passes**

Run: `npx vitest run apps/api/src/modules/alarm-webhooks/__tests__/build-variables.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the enqueue helper**

```ts
// apps/api/src/modules/alarm-webhooks/enqueue.ts
import { getProducer } from '@digilog/queue';
import { buildWebhookVariables, type WebhookAlarmInput } from './build-variables.js';

/**
 * Enqueues an alarm webhook job.
 *
 * NEVER THROWS — the same contract as alarms/enqueue-notification.ts, for the same
 * reason. The alarm is the regulated record and is already committed by the time this
 * runs. A queue outage, or a hooter that is unplugged, must cost an annunciation and
 * never the detection of every other excursion in the same evaluation pass.
 *
 * maxAttempts: 1 on purpose. Retry is bounded INSIDE the task (3 attempts, ~2s apart);
 * graphile-worker's exponential backoff would otherwise sound a buzzer long after the
 * excursion cleared.
 */
export async function enqueueAlarmWebhook(
  event: 'RAISED' | 'CLEARED' | 'ACKNOWLEDGED',
  input: WebhookAlarmInput,
  log: (msg: string) => void = (m) => console.error(m),
): Promise<boolean> {
  try {
    const producer = await getProducer();
    await producer.addJob(
      'alarm_webhook',
      {
        event,
        alarmId: input.alarmId,
        instrumentId: input.instrumentId,
        severity: input.severity,
        variables: buildWebhookVariables(event, input),
      },
      { maxAttempts: 1 },
    );
    return true;
  } catch (e) {
    log(`[alarm-webhook] could not enqueue ${event} for alarm ${input.alarmId}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
```

- [ ] **Step 6: Wire the four evaluator call sites**

In `apps/api/src/workers/alarm-evaluation.worker.ts`, add the import:

```ts
import { enqueueAlarmWebhook } from '../modules/alarm-webhooks/enqueue.js';
```

Then beside **each** of the four existing `await enqueueAlarmNotification(...)` calls, add a matching webhook enqueue with the **same argument object**. For the two `'raised'` sites:

```ts
        await enqueueAlarmWebhook('RAISED', { /* same object literal as the enqueueAlarmNotification call above */ });
```

and for the two `'cleared'` sites:

```ts
        await enqueueAlarmWebhook('CLEARED', { /* same object literal as the enqueueAlarmNotification call above */ });
```

Find them with:
```bash
grep -n "enqueueAlarmNotification" apps/api/src/workers/alarm-evaluation.worker.ts
```
All four must be paired. Two are the rule-alarm path and two the instrument-limit path — **the instrument-limit pair is the one that actually fires on this database**, so missing it produces a feature that tests green and never buzzes.

- [ ] **Step 7: Wire the acknowledge route**

In `apps/api/src/modules/alarms/routes.ts`, inside `POST /:id/acknowledge`, **after** the `auditLog(...)` call and before the `return`:

```ts
    // AFTER the atomic claim (updateMany with acknowledgedAt: null in the WHERE), so
    // the loser of two simultaneous acknowledgements fires nothing. Never throws.
    await enqueueAlarmWebhook('ACKNOWLEDGED', {
      alarmId: id,
      instrumentId: updated.instrumentId,
      instrumentCode: updated.instrument?.code ?? null,
      metric: updated.metric,
      severity: updated.severity,
      ruleName: (updated.ruleSnapshot as { name?: string } | null)?.name ?? '',
      condition: describeRule(updated.ruleSnapshot as never),
      triggeredValue: updated.triggeredValue,
      decimals: (updated.ruleSnapshot as { decimals?: number } | null)?.decimals ?? null,
      raisedAt: updated.raisedAt,
      clearedAt: updated.clearedAt,
      acknowledgedBy: updated.acknowledgedBy,
      acknowledgeReason: updated.acknowledgeReason,
    });
```

Add the import at the top of the file. If `describeRule` cannot take a snapshot directly, pass the snapshot's own `description` field instead — read `alarms/decide.ts:ruleSnapshot()` to see which fields the snapshot carries and use one that exists. **Do not invent a field name.**

- [ ] **Step 8: Typecheck and run the alarms + alarm-webhooks suites**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
npx vitest run apps/api/src/modules/alarms apps/api/src/modules/alarm-webhooks --pool=forks --poolOptions.forks.singleFork=true
```
Expected: tsc exits 0; all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/alarm-webhooks/ apps/api/src/workers/alarm-evaluation.worker.ts apps/api/src/modules/alarms/routes.ts
git commit -m "feat(api): fire alarm webhooks on raise, clear and acknowledge"
```

---

### Task 8: Registries — reauth action, audit actions, templates, permission tree

**Files:**
- Modify: `packages/shared/src/types/reauth-actions.ts`
- Modify: `packages/shared/src/types/audit-actions.ts`
- Modify: `packages/shared/src/types/audit-templates.ts`
- Modify: `packages/shared/src/types/permission-tree.ts`
- Modify: `apps/web/src/routes/audit/audit-helpers.ts` (badge colours)

**Interfaces:**
- Produces: `REAUTH_ACTIONS.MANAGE_ALARM_WEBHOOK`; audit actions `ALARM_WEBHOOK_CREATED` / `_UPDATED` / `_DELETED` / `_TESTED`; permission-tree nodes `alarm_webhooks.view` and `alarm_webhooks.manage`.

**On templates:** `audit-helpers.ts` substitutes `{targetName}` and `{actor}` generically from `afterValue.name`, so a template using only those two placeholders needs **no** matching substitution edit. It does need a badge colour, and `template-placeholders.test.ts` is the check that a placeholder has a substitution. Run that test.

- [ ] **Step 1: Add the reauth action**

In `packages/shared/src/types/reauth-actions.ts`, after `ACKNOWLEDGE_ALARM`:

```ts
  // Disabling or re-pointing a target silences a plant-floor buzzer, and a test fire
  // sounds a real one. Both are signed acts, not preference toggles.
  MANAGE_ALARM_WEBHOOK: { label: 'Create / Update / Delete / Test Alarm Webhook', category: 'Configuration' },
```

- [ ] **Step 2: Add the audit actions**

In `packages/shared/src/types/audit-actions.ts`, after the `ALARM_*` block:

```ts
  ALARM_WEBHOOK_CREATED: 'ALARM_WEBHOOK_CREATED',
  ALARM_WEBHOOK_UPDATED: 'ALARM_WEBHOOK_UPDATED',
  ALARM_WEBHOOK_DELETED: 'ALARM_WEBHOOK_DELETED',
  ALARM_WEBHOOK_TESTED: 'ALARM_WEBHOOK_TESTED',
```

- [ ] **Step 3: Add the audit templates**

In `packages/shared/src/types/audit-templates.ts`, in the `Instruments` category beside `ALARM_ACKNOWLEDGED`:

```ts
  ALARM_WEBHOOK_CREATED: {
    label: 'Alarm Webhook Created',
    category: 'Instruments',
    template: 'Alarm webhook "{targetName}" created by {actor}',
  },
  ALARM_WEBHOOK_UPDATED: {
    label: 'Alarm Webhook Updated',
    category: 'Instruments',
    template: 'Alarm webhook "{targetName}" updated by {actor}',
  },
  ALARM_WEBHOOK_DELETED: {
    label: 'Alarm Webhook Deleted',
    category: 'Instruments',
    template: 'Alarm webhook "{targetName}" deleted by {actor}',
  },
  ALARM_WEBHOOK_TESTED: {
    label: 'Alarm Webhook Tested',
    category: 'Instruments',
    template: 'Alarm webhook "{targetName}" test-fired by {actor}',
  },
```

Match the surrounding entries' exact object shape — read two neighbours before writing, since a `description` or `fields` key may also be required.

- [ ] **Step 4: Add the badge colours**

In `apps/web/src/routes/audit/audit-helpers.ts`, beside the existing `ALARM_ACKNOWLEDGED` entry in the colour map:

```ts
  ALARM_WEBHOOK_CREATED: 'bg-sky-100 text-sky-700 border-sky-200',
  ALARM_WEBHOOK_UPDATED: 'bg-sky-100 text-sky-700 border-sky-200',
  ALARM_WEBHOOK_DELETED: 'bg-rose-100 text-rose-700 border-rose-200',
  ALARM_WEBHOOK_TESTED: 'bg-sky-100 text-sky-700 border-sky-200',
```

- [ ] **Step 5: Add the permission-tree nodes**

In `packages/shared/src/types/permission-tree.ts`, in the **Configuration** group beside `alarm_rules.view` / `alarm_rules.manage` (around line 221):

```ts
      // Alarm Webhooks is a Configuration PAGE, like Alarm Rules — its nodes belong to
      // this group so granting them does not light up the Alarms sidebar item, which is
      // a different capability. No new PERMISSION: a role that can decide when an alarm
      // fires can already decide where it is announced.
      { id: 'alarm_webhooks.view', label: 'View Alarm Webhooks', sidebarId: 'configuration', page: 'Alarm Webhooks', action: 'View',
        icon: 'bell', category: 'Alarms', permissions: ['ALARM_RULE_READ'], enforce: 'a',
        gate: ['ALARM_RULE_READ'], configurable: true },
      { id: 'alarm_webhooks.manage', label: 'Create / Edit / Delete / Test Alarm Webhooks', sidebarId: 'configuration', page: 'Alarm Webhooks', action: 'Manage',
        icon: 'settings-edit', category: 'Alarms', permissions: ['ALARM_RULE_MANAGE', 'ALARM_RULE_READ'], enforce: 'a',
        gate: ['ALARM_RULE_MANAGE'], reauthAction: 'MANAGE_ALARM_WEBHOOK', configurable: true },
```

- [ ] **Step 6: Rebuild shared and run the registry tests**

```bash
npm run build -w @digilog/shared
npx vitest run packages/shared/src --pool=forks --poolOptions.forks.singleFork=true
npx vitest run apps/web/src/routes/audit --pool=forks --poolOptions.forks.singleFork=true
```
Expected: all pass, including `template-placeholders.test.ts` and the frozen-snapshot permission-tree test.

**If the frozen-snapshot test fails,** read its failure before touching it. It exists to lock zero drift between the tree and the derived maps. A legitimate addition means updating the snapshot; a *shape* error means the node is wrong. Do not update the snapshot to silence a shape error.

- [ ] **Step 7: Verify the new counts**

```bash
grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts    # expect 48
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/audit-actions.ts # expect 97
grep -cE "^\s+\[?[A-Z_]+\]?:" packages/shared/src/types/audit-templates.ts # expect 91
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts  # expect 42, UNCHANGED
```

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/types/ apps/web/src/routes/audit/audit-helpers.ts
git commit -m "feat(shared): alarm webhook reauth action, audit registry entries and tree nodes"
```

---

### Task 9: The API module

**Files:**
- Create: `apps/api/src/modules/alarm-webhooks/validation.ts`
- Create: `apps/api/src/modules/alarm-webhooks/routes.ts`
- Modify: `apps/api/src/app.ts` (import + register at `/api/alarm-webhooks`)
- Modify: `apps/api/src/e2e/test-helper.ts` (**the same register line** — a module registered only in `app.ts` 404s in every e2e)
- Test: `apps/api/src/modules/alarm-webhooks/__tests__/validation.test.ts`
- Test: `apps/api/src/e2e/alarm-webhooks.test.ts`

**Interfaces:**
- Consumes: `targetMatches` / `expandLocations` (Task 4), `deliverToTarget` (Task 6), `buildWebhookVariables` (Task 7), `MANAGE_ALARM_WEBHOOK` (Task 8).
- Produces: the seven routes listed in the spec under **Surface**.

- [ ] **Step 1: Write the failing validation test**

```ts
// apps/api/src/modules/alarm-webhooks/__tests__/validation.test.ts
import { describe, it, expect } from 'vitest';
import { validateTargetDraft } from '../validation.js';

const draft = (over: Record<string, unknown> = {}) => ({
  name: 'QC-3 hooter',
  url: 'http://192.168.1.60/alarm',
  method: 'POST',
  headers: {},
  contentType: 'application/json',
  bodyTemplate: '{"event":"${event}"}',
  successRegex: null,
  timeoutMs: 5000,
  severities: null,
  cooldownSeconds: 0,
  scopeLocationIds: [],
  scopeInstrumentIds: ['I1'],
  ...over,
});

describe('validateTargetDraft', () => {
  it('accepts a well-formed draft', () => {
    expect(validateTargetDraft(draft() as never)).toBeNull();
  });

  it('requires a name', () => {
    expect(validateTargetDraft(draft({ name: '  ' }) as never)?.field).toBe('name');
  });

  it('requires an http or https url', () => {
    expect(validateTargetDraft(draft({ url: 'ftp://x/y' }) as never)?.field).toBe('url');
    expect(validateTargetDraft(draft({ url: 'not a url' }) as never)?.field).toBe('url');
    expect(validateTargetDraft(draft({ url: 'https://192.168.1.60/a' }) as never)).toBeNull();
  });

  it('rejects an unknown method', () => {
    expect(validateTargetDraft(draft({ method: 'DELETE' }) as never)?.field).toBe('method');
  });

  it('rejects an unparseable success regex before it is ever stored', () => {
    expect(validateTargetDraft(draft({ successRegex: '([' }) as never)?.field).toBe('successRegex');
  });

  it('bounds the timeout', () => {
    expect(validateTargetDraft(draft({ timeoutMs: 0 }) as never)?.field).toBe('timeoutMs');
    expect(validateTargetDraft(draft({ timeoutMs: 120_000 }) as never)?.field).toBe('timeoutMs');
  });

  // An empty scope is LEGAL — a target may be configured before its instruments exist.
  // It fires for nothing, and the UI shows the resolved count so that is visible.
  it('allows an empty scope', () => {
    expect(validateTargetDraft(draft({ scopeInstrumentIds: [] }) as never)).toBeNull();
  });

  it('rejects an unknown severity', () => {
    expect(validateTargetDraft(draft({ severities: ['LOUD'] }) as never)?.field).toBe('severities');
    expect(validateTargetDraft(draft({ severities: ['CRITICAL', 'MAJOR'] }) as never)).toBeNull();
  });

  it('rejects a body template naming a variable no event provides', () => {
    expect(validateTargetDraft(draft({ bodyTemplate: '{"x":"${nonsense}"}' }) as never)?.field).toBe('bodyTemplate');
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run apps/api/src/modules/alarm-webhooks/__tests__/validation.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — cannot resolve `../validation.js`.

- [ ] **Step 3: Write the validation module**

```ts
// apps/api/src/modules/alarm-webhooks/validation.ts
import {
  ALARM_WEBHOOK_METHODS,
  ALARM_WEBHOOK_VARIABLES,
  type AlarmWebhookMethod,
} from '@digilog/shared';

export interface TargetFieldError { field: string; message: string }

export interface TargetDraft {
  name: string;
  description?: string | null;
  url: string;
  method: string;
  headers: Record<string, string>;
  contentType: string;
  bodyTemplate: string;
  successRegex: string | null;
  timeoutMs: number;
  severities: string[] | null;
  cooldownSeconds: number;
  scopeLocationIds: string[];
  scopeInstrumentIds: string[];
}

const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR', 'WARNING'];
/** Every variable any event can provide — the union the template may draw from. */
const KNOWN_VARIABLES = new Set(Object.values(ALARM_WEBHOOK_VARIABLES).flatMap((v) => [...v]));

export function validateTargetDraft(d: TargetDraft): TargetFieldError | null {
  if (!d.name?.trim()) return { field: 'name', message: 'Name is required.' };

  // http/https only. NOT an allowlist — a hooter lives on the operator's LAN and any
  // allowlist would have to contain it. This rejects file:/ftp:/gopher: schemes, which
  // no hooter speaks and which fetch would treat very differently.
  let parsed: URL;
  try { parsed = new URL(d.url); } catch { return { field: 'url', message: 'Enter a full URL, e.g. http://192.168.1.60/alarm' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { field: 'url', message: 'URL must start with http:// or https://' };
  }

  if (!ALARM_WEBHOOK_METHODS.includes(d.method as AlarmWebhookMethod)) {
    return { field: 'method', message: `Method must be one of ${ALARM_WEBHOOK_METHODS.join(', ')}.` };
  }

  if (!d.bodyTemplate?.trim()) return { field: 'bodyTemplate', message: 'Body template is required.' };

  // Caught HERE rather than at send time: an unknown placeholder renders literally, so
  // the hooter would receive `${nonsence}` in a regulated payload and nobody would know
  // until an excursion.
  for (const m of d.bodyTemplate.matchAll(/\$\{([^}]+)\}/g)) {
    const key = m[1].trim();
    if (!KNOWN_VARIABLES.has(key)) {
      return { field: 'bodyTemplate', message: `Unknown variable \${${key}}.` };
    }
  }

  // Validated before storage so a bad pattern can never reach the worker, where it
  // would fail every delivery closed with no obvious cause.
  if (d.successRegex) {
    try { new RegExp(d.successRegex); }
    catch { return { field: 'successRegex', message: 'Not a valid regular expression.' }; }
  }

  if (!Number.isInteger(d.timeoutMs) || d.timeoutMs < 100 || d.timeoutMs > 60_000) {
    return { field: 'timeoutMs', message: 'Timeout must be between 100 and 60000 ms.' };
  }
  if (!Number.isInteger(d.cooldownSeconds) || d.cooldownSeconds < 0 || d.cooldownSeconds > 86_400) {
    return { field: 'cooldownSeconds', message: 'Cooldown must be between 0 and 86400 seconds.' };
  }

  if (d.severities !== null) {
    for (const s of d.severities) {
      if (!SEVERITIES.includes(s)) return { field: 'severities', message: `Unknown severity "${s}".` };
    }
  }

  // An empty scope is LEGAL and means the target fires for nothing. Deliberate: a
  // target may be created before its instruments exist. The list route returns a
  // resolved instrument count so an accidental zero is visible on screen.
  return null;
}
```

Confirm the severity vocabulary against the live enum before committing:
```bash
grep -n "enum AlarmSeverity" -A 8 apps/api/prisma/schema.prisma
```
Fix `SEVERITIES` to match exactly. Do not guess.

- [ ] **Step 4: Run it and verify it passes**

Run: `npx vitest run apps/api/src/modules/alarm-webhooks/__tests__/validation.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the routes**

Create `apps/api/src/modules/alarm-webhooks/routes.ts`, following `modules/alarms/routes.ts` exactly for structure — `preHandler: [app.requirePermission(...)]`, an `enforceReauth` call as the first line of every mutating handler, a declared `response` schema on every route, `sanitizeStrings(body, ['reason'])`, and `auditLog` with `afterValue.name` set (that is what the audit trail's `{targetName}` placeholder reads).

```ts
import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { clampSignature } from '../alarms/validation.js';
import { validateTargetDraft, type TargetDraft } from './validation.js';
import { expandLocations, targetMatches } from './target-scope.js';
import { deliverToTarget } from '../../workers/alarm-webhook.worker.js';
import { buildWebhookVariables } from './build-variables.js';
import { DEFAULT_WEBHOOK_BODY_TEMPLATE } from '@digilog/shared';

/**
 * Alarm webhook targets — the IP hooters an alarm is announced to.
 *
 * Design: docs/superpowers/specs/2026-08-27-alarm-webhook-annunciator-design.md
 *
 * Gated on ALARM_RULE_READ / ALARM_RULE_MANAGE deliberately: a role that can decide
 * WHEN an alarm fires can already decide WHERE it is announced, so this adds no
 * permission.
 */

// EVERY field returned must appear here. Fastify silently strips what it does not
// declare — no error, no warning, and a server-side test still passes because the
// value was there before serialisation. This has bitten this repo twice.
const targetProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  description: { type: 'string', nullable: true },
  url: { type: 'string' },
  method: { type: 'string' },
  headers: { type: 'object', additionalProperties: true },
  contentType: { type: 'string' },
  bodyTemplate: { type: 'string' },
  successRegex: { type: 'string', nullable: true },
  timeoutMs: { type: 'integer' },
  fireOnRaised: { type: 'boolean' },
  fireOnCleared: { type: 'boolean' },
  fireOnAcknowledged: { type: 'boolean' },
  severities: { type: 'array', items: { type: 'string' }, nullable: true },
  cooldownSeconds: { type: 'integer' },
  isActive: { type: 'boolean' },
  scopeLocationIds: { type: 'array', items: { type: 'string' } },
  scopeInstrumentIds: { type: 'array', items: { type: 'string' } },
  /** Resolved server-side so an accidentally empty scope is visible on the page. */
  instrumentCount: { type: 'integer' },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
} as const;

const deliveryProps = {
  id: { type: 'string' },
  targetId: { type: 'string' },
  alarmId: { type: 'string', nullable: true },
  event: { type: 'string' },
  url: { type: 'string' },
  requestBody: { type: 'string' },
  httpStatus: { type: 'integer', nullable: true },
  responseSnippet: { type: 'string', nullable: true },
  attempt: { type: 'integer' },
  status: { type: 'string' },
  error: { type: 'string', nullable: true },
  createdAt: { type: 'string' },
  sentAt: { type: 'string', nullable: true },
} as const;

export default async function alarmWebhookRoutes(app: FastifyInstance) {
  // ── POST / — the reference handler. Every other mutating route follows this exact
  // shape: reauth first, validate, write, audit with afterValue.name, return a
  // fully-declared response.
  app.post('/', {
    preHandler: [app.requirePermission('ALARM_RULE_MANAGE')],
    schema: {
      tags: ['Alarm Webhooks'],
      summary: 'Create an alarm webhook target (e-signature: re-authentication)',
      body: {
        type: 'object',
        required: ['name', 'url'],
        properties: {
          name: { type: 'string', maxLength: 200 },
          description: { type: 'string', maxLength: 500, nullable: true },
          url: { type: 'string', maxLength: 2000 },
          method: { type: 'string' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          contentType: { type: 'string', maxLength: 100 },
          bodyTemplate: { type: 'string' },
          successRegex: { type: 'string', nullable: true },
          timeoutMs: { type: 'integer' },
          fireOnRaised: { type: 'boolean' },
          fireOnCleared: { type: 'boolean' },
          fireOnAcknowledged: { type: 'boolean' },
          severities: { type: 'array', items: { type: 'string' }, nullable: true },
          cooldownSeconds: { type: 'integer' },
          isActive: { type: 'boolean' },
          scopeLocationIds: { type: 'array', items: { type: 'string' } },
          scopeInstrumentIds: { type: 'array', items: { type: 'string' } },
        },
      },
      response: { 201: { type: 'object', properties: targetProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('MANAGE_ALARM_WEBHOOK', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    // `description` is operator prose and IS sanitised; there is no free-text reason on
    // create. `url` and `bodyTemplate` are skipped: stripHtml empties anything
    // tag-shaped, and a template is full of `${...}` and braces.
    const body = sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['url', 'bodyTemplate', 'successRegex']);

    const draft: TargetDraft = {
      name: String(body.name ?? ''),
      description: (body.description as string) ?? null,
      url: String(body.url ?? ''),
      method: String(body.method ?? 'POST'),
      headers: (body.headers as Record<string, string>) ?? {},
      contentType: String(body.contentType ?? 'application/json'),
      bodyTemplate: String(body.bodyTemplate ?? DEFAULT_WEBHOOK_BODY_TEMPLATE),
      successRegex: (body.successRegex as string) ?? null,
      timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : 5000,
      severities: (body.severities as string[]) ?? null,
      cooldownSeconds: typeof body.cooldownSeconds === 'number' ? body.cooldownSeconds : 0,
      scopeLocationIds: (body.scopeLocationIds as string[]) ?? [],
      scopeInstrumentIds: (body.scopeInstrumentIds as string[]) ?? [],
    };

    const refusal = validateTargetDraft(draft);
    if (refusal) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: refusal.message, field: refusal.field });
    }

    const created = await prisma.alarmWebhookTarget.create({
      data: {
        ...draft,
        description: draft.description,
        fireOnRaised: body.fireOnRaised !== false,
        fireOnCleared: body.fireOnCleared !== false,
        fireOnAcknowledged: body.fireOnAcknowledged !== false,
        isActive: body.isActive !== false,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'ALARM_WEBHOOK_CREATED',
      targetType: 'AlarmWebhookTarget', targetId: created.id,
      // `name` is what the audit trail's {targetName} placeholder reads.
      afterValue: { name: created.name, url: created.url, method: created.method, isActive: created.isActive },
      signatureMeaning: clampSignature(`Created alarm webhook "${created.name}" -> ${created.url}`),
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return reply.code(201).send({
      ...created,
      instrumentCount: 0, // recomputed on the next list; a new target has no cached count
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    });
  });

  // GET /                list + resolved instrument counts
  // GET /:id             one
  // PUT /:id             update    — as above, plus beforeValue, audit ALARM_WEBHOOK_UPDATED
  // DELETE /:id          delete    — as above, requires `reason`, audit ALARM_WEBHOOK_DELETED,
  //                                  REFUSED 409 while deliveries reference it
  // POST /:id/test       test fire — as above, audit ALARM_WEBHOOK_TESTED
  // GET /:id/deliveries  paged log
}
```

Write the remaining six handlers in that same shape. Specific requirements:

- **`instrumentCount`** is computed by loading the functional-location tree once and counting instruments that `targetMatches` accepts with `event: 'RAISED'`. Compute it once per request for the whole list, not per target with a fresh query.
- **DELETE refuses while deliveries exist.** `const used = await prisma.alarmWebhookDelivery.count({ where: { targetId: id } }); if (used > 0) return reply.code(409).send({ error: 'TARGET_HAS_DELIVERIES', message: \`This target has ${used} delivery record(s) and cannot be deleted. Deactivate it instead.\` });` — a raw FK violation would surface as a 500 that names nothing.
- **DELETE takes `reason` in the BODY**, not a query string: a free-text reason must not land in access logs. Bound it `maxLength: 500` in the body schema — `signature_meaning` is `VarChar(255)` and the overflow throws *inside* `auditLog`, after the delete has committed.
- **Every audit call** sets `afterValue.name` (or `beforeValue.name` on delete) and wraps its signature line in `clampSignature(...)`.
- **`POST /:id/test`** calls `deliverToTarget(target, 'TEST', null, buildWebhookVariables('TEST', {…synthetic…}))` and returns `{ ok, httpStatus, responseSnippet, error }`. It fires regardless of scope and fire flags — commissioning a hooter must not require first configuring the conditions you are testing.
- **New targets** default `bodyTemplate` to `DEFAULT_WEBHOOK_BODY_TEMPLATE` when the body omits it.

- [ ] **Step 6: Register in BOTH app.ts and test-helper.ts**

`apps/api/src/app.ts`, beside the alarm registration (line ~368):
```ts
await app.register(alarmWebhookRoutes, { prefix: '/api/alarm-webhooks' });
```

`apps/api/src/e2e/test-helper.ts`, beside its alarm registration (line ~120):
```ts
  await app.register(alarmWebhookRoutes, { prefix: '/api/alarm-webhooks' });
```

Both, in this commit. A module registered only in `app.ts` 404s on every request in every e2e test, and two modules have already shipped here with HTTP-level coverage that could not be written.

- [ ] **Step 7: Write the e2e test**

Create `apps/api/src/e2e/alarm-webhooks.test.ts`, modelled on the existing `apps/api/src/e2e/` alarm tests (read one first for the auth/reauth helper conventions — do not invent them). Cover:

```
- unauthenticated GET  /api/alarm-webhooks            -> 401
- authenticated  GET   /api/alarm-webhooks            -> 200, array
- POST without reauth                                  -> refused
- POST with reauth                                     -> 201, and EVERY targetProps field
                                                          present in the JSON (the
                                                          response-schema strip check)
- POST with a bad url / unknown ${variable}            -> 400 naming the field
- PUT changes a field and writes ALARM_WEBHOOK_UPDATED with a beforeValue
- DELETE without `reason`                              -> 400
- DELETE with deliveries present                       -> 409 TARGET_HAS_DELIVERIES
- DELETE clean                                         -> 200 and an audit row
- POST /:id/test                                       -> writes ONE delivery row with
                                                          event 'TEST' and alarmId null
- GET /:id/deliveries                                  -> the TEST row, newest first
```

Assert the created row's fields **over HTTP** (`app.inject`), never off a function's return value — that is the only thing that catches a missing `response` schema entry.

- [ ] **Step 8: Run everything for this task**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
npx vitest run apps/api/src/modules/alarm-webhooks --pool=forks --poolOptions.forks.singleFork=true
npx vitest run apps/api/src/e2e/alarm-webhooks.test.ts --pool=forks --poolOptions.forks.singleFork=true
```
Expected: tsc exits 0; all pass.

If the e2e 500s with `column ... does not exist`, the **test database** did not get Task 2's migration. Re-run the `compliance_core_db_test` deploy. It is not your code.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/alarm-webhooks/ apps/api/src/e2e/alarm-webhooks.test.ts apps/api/src/app.ts apps/api/src/e2e/test-helper.ts
git commit -m "feat(api): alarm webhook target CRUD, test fire and delivery log"
```

---

### Task 10: The config page

**Files:**
- Create: `apps/web/src/routes/config/alarm-webhooks.tsx`
- Modify: `apps/web/src/main.tsx` (import + `<Route>`)
- Modify: `apps/web/src/routes/config/index.tsx` (the card)

**Interfaces:**
- Consumes: `/api/alarm-webhooks*` (Task 9); `ALARM_WEBHOOK_VARIABLES`, `ALARM_WEBHOOK_METHODS` (Task 1); `useCan('alarm_webhooks.manage')` (Task 8).
- Produces: the `/config/alarm-webhooks` route.

**Copy discipline:** labels and values only. No helper paragraphs, no "why this matters" notes. The single sentence that stays is the audit notice on the test button, because it is load-bearing for a compliance control.

- [ ] **Step 1: Build the page**

Read `apps/web/src/routes/config/alarm-rules.tsx` first and follow it — SWR fetching, the reauth dialog component, the table/form layout, and the light-theme classes (`bg-white`, `bg-slate-50`, `border-slate-200`).

The page carries:
- **Target list** — name, URL, method, scope summary, resolved instrument count, active toggle, last delivery status.
- **Target form** — name, description, URL, method (from `ALARM_WEBHOOK_METHODS`), headers (key/value rows), content type, body template with a placeholder picker rendered **from `ALARM_WEBHOOK_VARIABLES`**, success regex, timeout, cooldown, severities, the three `fireOn*` switches.
- **Scope picker** — the functional-location tree widget reused from Instrument Scope (Config → Roles & Access) plus an instrument multi-select. Show the resolved instrument count live from the API response; when it is 0, show `0 instruments — this target will not fire`.
- **Send test** — fires and displays the raw HTTP status and response body. Beneath it, exactly one line: `Test fires sound a real hooter and are recorded in the audit trail.`
- **Deliveries tab** — the paged log, filterable by status, showing time, event, status, HTTP status, attempt, and the response snippet.

Gate every mutating control on `useCan('alarm_webhooks.manage')`. Never OR over a node's `permissions` array as an auth check — that set includes read dependencies. Use the node's `gate`.

- [ ] **Step 2: Add the route**

`apps/web/src/main.tsx`, beside the alarm-rules route (line ~117):

```tsx
import { AlarmWebhooksConfigPage } from './routes/config/alarm-webhooks';
```
```tsx
            <Route path="/config/alarm-webhooks" element={<RequireRole permissions={[PERMISSIONS.ALARM_RULE_READ]}><AlarmWebhooksConfigPage /></RequireRole>} />
```

- [ ] **Step 3: Add the config card**

`apps/web/src/routes/config/index.tsx`, beside the Alarm Rules card (line ~126), matching the surrounding card object shape exactly:

```ts
    href: '/config/alarm-webhooks',
```
with a title of `Alarm Webhooks` and a description of `Hooters and HTTP endpoints alarms are announced to, and what body to send`.

- [ ] **Step 4: Typecheck, build, and run the web suite**

```bash
npx tsc --noEmit -p apps/web/tsconfig.json
cd apps/web && npx vite build && cd ../..
npx vitest run apps/web/src --pool=forks --poolOptions.forks.singleFork=true
```
Expected: tsc exits 0, build succeeds, web suite passes.

- [ ] **Step 5: Verify the route count moved**

```bash
grep -cE "<Route" apps/web/src/main.tsx        # expect 50
ls apps/web/src/routes/config/*.tsx | wc -l    # expect 25
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/config/alarm-webhooks.tsx apps/web/src/main.tsx apps/web/src/routes/config/index.tsx
git commit -m "feat(web): alarm webhooks config page"
```

- [ ] **Step 7: Hand the visual check to the operator**

State plainly that the rendering has **not** been seen — Playwright cannot authenticate against the mkcert cert in this repo, so no agent-driven browser check is possible. Give them:

```
https://localhost:5176/config/alarm-webhooks
```

and ask them to check: the card appears on /config; the form saves; the placeholder picker lists only real variables; the scope picker's instrument count updates; Send test shows the raw status; the deliveries tab lists the test row. Ask them to watch the browser console for unexpected responses and to flag any unaligned UI element.

---

### Task 11: Documentation sync and the full verification sweep

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md` (System Stats, Key API Endpoints)
- Modify: `tasks/todo.md` (audit-log entry)
- Modify: `docs/recreation/02-inventory/`, `05-database/`, `06-api/endpoints.md`, `07-ui/` as the "Change → Docs map" in `docs/CONTRIBUTING.md` requires

- [ ] **Step 1: Read the change→docs map**

```bash
sed -n '/Change → Docs map/,/^##/p' docs/CONTRIBUTING.md
```
Follow it. It is the authority on which files a change of this shape touches.

- [ ] **Step 2: Re-derive every count from live code**

```bash
grep -cE "^model " apps/api/prisma/schema.prisma                          # 36
grep -cE "^enum " apps/api/prisma/schema.prisma                           # 13
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts      # 42
grep -cE "^\s+[A-Z_]+:" packages/shared/src/types/reauth-actions.ts       # 48
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/audit-actions.ts    # 97
grep -cE "^\s+\[?[A-Z_]+\]?:" packages/shared/src/types/audit-templates.ts # 91
ls apps/api/src/modules/ | wc -l                                          # 24
ls apps/api/src/modules/config/defs/*.def.ts | wc -l                      # 25 (unchanged)
ls apps/web/src/routes/config/*.tsx | wc -l                               # 25
grep -cE "<Route" apps/web/src/main.tsx                                   # 50
```

**Write down what the commands actually print, not what this plan predicts.** If a number disagrees, the tree is right and the plan is wrong — investigate before editing any doc.

- [ ] **Step 3: Stale-stat sweep**

Build a regex from the **previous** numbers (34 models, 47 reauth, 93 audit actions, 87 templates, 23 modules, 24 config pages, 49 routes, 5 tasks) and grep the active doc set. Every match needs updating.

```bash
grep -rnE "\b(34 (Prisma )?models|47 reauth|93 audit|87 (audit )?templates|23 API modules|49 .?Route|5 worker tasks)\b" \
  README.md CLAUDE.md AGENTS.md CHANGELOG.md PROJECT_SUMMARY.md PROJECT_ARCHITECTURE.md \
  API_REFERENCE.md BACKEND_GUIDE.md FRONTEND_GUIDE.md apps/api/CLAUDE.md apps/web/CLAUDE.md \
  packages/shared/CLAUDE.md docs/ 2>/dev/null
```

- [ ] **Step 4: Update CLAUDE.md**

- System Stats: the counts above, each with the command that produced it.
- Key API Endpoints: add the seven `/api/alarm-webhooks` routes.
- A short bullet in the instrument/alarm section: what the annunciator is, that scope reuses the `instrument_scope` shape, that empty scope means nothing, that cooldown throttles RAISED only, and that the body renderer is deliberately **not** `resolveTemplate`.

- [ ] **Step 5: Update CHANGELOG.md**

One entry describing the feature, the two new models, the new reauth action, the four audit actions, the new worker task, and the migration name. Note explicitly that **no permission and no Prisma enum was added**, so a future reader does not go looking for them.

- [ ] **Step 6: Add the tasks/todo.md audit-log entry**

Required for non-trivial work by the repo's own rule.

- [ ] **Step 7: Full verification sweep**

Per package, individually. A combined invocation manufactures ~129 false failures from e2e database contention.

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
npx vitest run apps/api/src   --pool=forks --poolOptions.forks.singleFork=true
npx vitest run apps/web/src   --pool=forks --poolOptions.forks.singleFork=true
npx vitest run packages/shared/src --pool=forks --poolOptions.forks.singleFork=true
cd packages/queue && npx vitest run && cd ../..
cd apps/web && npx vite build && cd ../..
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-migrations.ps1
```

**Known-failing baseline is ZERO.** Any failure is yours. Do not re-derive a "known failures" allowance. If a full-package run shows a failure, re-run that one file alone before believing it — but do not dismiss it either. Exactly one of the 129 false failures on 2026-08-24 was real.

- [ ] **Step 8: Restart the app and confirm it boots**

```bash
./start-app.bat
curl -sk --ssl-revoke-best-effort -o /dev/null -w "%{http_code}" https://localhost:3001/api/system-health
```
Expected: a status code (401 is a pass — TLS terminated and the route rejected an unauthenticated call). There is no `/health` route.

Then confirm the new task registered, with no orphan jobs accumulating:
```bash
psql "$DATABASE_URL" -c "SELECT task_identifier, count(*) FROM graphile_worker.jobs GROUP BY 1;"
```
Expected: no unbounded growth of `alarm_webhook`. A handler-less identifier leaks jobs forever — that failure once reached 51,798 rows here.

- [ ] **Step 9: Commit**

```bash
git add CHANGELOG.md CLAUDE.md tasks/todo.md docs/
git commit -m "docs: alarm webhook annunciator — counts re-derived from live code"
```

---

## Self-review notes

**Spec coverage:** every spec section maps to a task — data model → 2; scope resolution and empty scope → 4; firing and the three call-site groups → 7; body rendering → 3; delivery, retry and cooldown → 5, 6; governance → 8, 9; outbound stance → 5 (code) and 9 (validation); surface → 9, 10; testing → each task plus 11; migration mechanics → 2; verification limits → 10 step 7; count changes → 11.

**One spec correction found while planning:** the spec says adding an audit template is always two edits (template + a substitution in `audit-helpers.ts`). Verified against live code: `audit-helpers.ts` substitutes `{targetName}` and `{actor}` **generically** from `afterValue.name`, so templates using only those two placeholders need no substitution edit — only a badge colour, which is cosmetic. The two-edit rule applies to templates introducing a *new* placeholder. Task 8 reflects the verified behaviour. Anything using a new placeholder must still add the substitution, and `template-placeholders.test.ts` is the check.

**Deliberate ordering:** the migration is Task 2, before any code that touches the Prisma client, because a stale generated client hides real type errors and the failure is silent on this box.
