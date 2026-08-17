# Instrument-Limit Alarms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise alarms from each instrument's own High/Low Temperature and Humidity Limit attributes, show the raise/clear values and the frozen limit on the Alarms page, and put the attribute-key mapping plus four configurable status texts in one super-admin config.

**Architecture:** A new pure decision module (`limit-decide.ts`) beside the existing `decide.ts`; a second pass in the existing `alarm-evaluation.worker.ts` that reuses `buildTelemetryOverview()` so telemetry-key resolution cannot drift; a new `alarm-limits` config def following the `telemetry-slots` pattern exactly; and shared parsing in `@digilog/shared` so the API and web app agree. `Alarm.ruleId` becomes nullable with a `source` discriminator, because an attribute-driven alarm has no rule row.

**Tech Stack:** TypeScript, Fastify, Prisma/PostgreSQL 18, graphile-worker, React 19 + Vite + Tailwind, vitest.

**Spec:** `docs/superpowers/specs/2026-08-17-instrument-limit-alarms-design.md`

## Global Constraints

- **Boundaries are IN spec.** A reading exactly at a limit is NOT a breach. This holds in `decide.ts` (`OUTSIDE_RANGE`), `telemetry-slots.ts` (`breaches()`), and must hold here.
- **A missing or non-numeric limit NEVER fires.** Never coerce to 0. `Number("")` is 0 — do not use bare `Number()`.
- **A missing reading is NOT a breach.** That is the `OFFLINE` metric's concern.
- **Migrations are HAND-AUTHORED.** `prisma migrate diff` emits three destructive statements here (DROP TABLE `instrument_telemetry_history`, `audit_trail.chain_position` DROP NOT NULL, and an FK drop/recreate). Never include them. Read the header of `20260811120000_instrument_floorplans` first.
- **Apply every migration to `compliance_core_db_test` too.** It migrates separately; being behind makes every instrument-touching e2e return 500.
- **No new permissions, privileges, reauth actions or sidebar items.** Reuses `ALARM_READ`, `ALARM_ACKNOWLEDGE`, `CONFIG_READ`/`CONFIG_UPDATE`. Those four counts in CLAUDE.md stay put; the ENUM and CONFIG-DEF counts do move (Task 9) and must be re-derived, not assumed.
- **Acknowledgement fields are never touched by clearing.** A cleared-but-unacknowledged alarm must stay visibly outstanding.
- **`tsc --noEmit` after every task.** vitest never typechecks; green tests do not mean it compiles.
- **Two checkouts on this machine.** Always pass `DATABASE_URL` explicitly; this repo is `compliance_core_db` on port 3001/5176.
- **Visual verification is the operator's.** Chrome here cannot reach loopback through the automation extension. Never claim a rendered check.

---

### Task 1: Shared limit parsing (`@digilog/shared`)

**Files:**
- Create: `packages/shared/src/types/alarm-limits.ts`
- Create: `packages/shared/src/types/alarm-limits.test.ts`
- Modify: `packages/shared/src/index.ts` (export block after the `telemetry-slots` block, ~line 48)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `type LimitBound = 'temperatureHigh' | 'temperatureLow' | 'humidityHigh' | 'humidityLow'`
  - `const ALARM_LIMIT_KEYS_DEFAULT: Record<LimitBound, string>`
  - `const ALARM_STATUS_TEXT_DEFAULT: { activeUnack: string; activeAck: string; clearedUnack: string; clearedAck: string }`
  - `function parseLimitKeys(raw: string | null | undefined): string[]`
  - `function parseLimitValue(raw: string | null | undefined): number | null`
  - `function resolveLimit(keys: string[], attributes: { key: string; value: string }[]): { key: string; value: number } | null`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/types/alarm-limits.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseLimitKeys,
  parseLimitValue,
  resolveLimit,
  ALARM_LIMIT_KEYS_DEFAULT,
  ALARM_STATUS_TEXT_DEFAULT,
} from './alarm-limits.js';

describe('parseLimitKeys', () => {
  it('splits on newlines, trims, drops blanks, lowercases', () => {
    expect(parseLimitKeys('High Temperature Limit\n  High Temperature \n\n')).toEqual([
      'high temperature limit',
      'high temperature',
    ]);
  });

  it('de-duplicates keeping first, because order is precedence', () => {
    expect(parseLimitKeys('A\nB\nA')).toEqual(['a', 'b']);
  });

  it('returns [] for null, undefined and blank', () => {
    expect(parseLimitKeys(null)).toEqual([]);
    expect(parseLimitKeys(undefined)).toEqual([]);
    expect(parseLimitKeys('   ')).toEqual([]);
  });

  it('ships defaults that parse to the documented lists', () => {
    expect(parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.temperatureHigh)).toEqual([
      'high temperature limit',
      'high temperature',
      'temp high',
    ]);
  });
});

describe('parseLimitValue', () => {
  it('parses plain and decimal numbers, including negatives and zero', () => {
    expect(parseLimitValue('25')).toBe(25);
    expect(parseLimitValue(' 25.0 ')).toBe(25);
    expect(parseLimitValue('-5.5')).toBe(-5.5);
    expect(parseLimitValue('0')).toBe(0);
  });

  it('returns null for blank rather than 0 — Number("") is 0 and would alarm forever', () => {
    expect(parseLimitValue('')).toBeNull();
    expect(parseLimitValue('   ')).toBeNull();
    expect(parseLimitValue(null)).toBeNull();
    expect(parseLimitValue(undefined)).toBeNull();
  });

  it('rejects text and values carrying units', () => {
    expect(parseLimitValue('twenty five')).toBeNull();
    expect(parseLimitValue('25 C')).toBeNull();
    expect(parseLimitValue('n/a')).toBeNull();
    expect(parseLimitValue('NaN')).toBeNull();
    expect(parseLimitValue('Infinity')).toBeNull();
  });
});

describe('resolveLimit', () => {
  const keys = ['high temperature limit', 'high temperature'];

  it('matches case-insensitively on operator-typed keys', () => {
    expect(resolveLimit(keys, [{ key: 'HIGH TEMPERATURE', value: '25' }]))
      .toEqual({ key: 'HIGH TEMPERATURE', value: 25 });
  });

  it('prefers the earlier key when an instrument holds both', () => {
    // This is the live drift case: the database has both spellings today.
    const attrs = [
      { key: 'High Temperature', value: '30' },
      { key: 'High Temperature Limit', value: '25' },
    ];
    expect(resolveLimit(keys, attrs)).toEqual({ key: 'High Temperature Limit', value: 25 });
  });

  it('returns null when no key matches', () => {
    expect(resolveLimit(keys, [{ key: 'Slave ID', value: '3' }])).toBeNull();
  });

  it('returns null when the matched attribute is not numeric', () => {
    expect(resolveLimit(keys, [{ key: 'High Temperature', value: 'warm' }])).toBeNull();
  });

  it('does not fall through to a later key when an earlier one is non-numeric', () => {
    // Deliberate: a mistyped value on the preferred key must be visible as
    // "no limit", not silently replaced by a different attribute's value.
    const attrs = [
      { key: 'High Temperature Limit', value: 'warm' },
      { key: 'High Temperature', value: '25' },
    ];
    expect(resolveLimit(keys, attrs)).toBeNull();
  });
});

describe('ALARM_STATUS_TEXT_DEFAULT', () => {
  it('keeps cleared-unacknowledged distinct from cleared', () => {
    expect(ALARM_STATUS_TEXT_DEFAULT.clearedUnack).not.toBe(ALARM_STATUS_TEXT_DEFAULT.clearedAck);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/types/alarm-limits.test.ts`
Expected: FAIL — "Failed to resolve import ./alarm-limits.js"

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/types/alarm-limits.ts`:

```ts
/**
 * Turning an instrument's free-text attributes into the four limits the alarm
 * evaluator checks.
 *
 * Lives in @digilog/shared because BOTH sides need it: the API evaluates limits,
 * the web app labels alarms with them. Two implementations would drift, and the
 * drift would show as an alarm whose stated limit contradicts the one that fired it.
 *
 * Keys are an ORDERED ALIAS LIST rather than one fixed name because the live
 * database already holds `High Temperature`, `Low Temperature` and
 * `Low Temperature Limit` as three separate operator-typed keys. An unmatched key
 * means no alarm AND no warning, which is the worst failure this feature can have.
 *
 * Design: docs/superpowers/specs/2026-08-17-instrument-limit-alarms-design.md
 */

export type LimitBound = 'temperatureHigh' | 'temperatureLow' | 'humidityHigh' | 'humidityLow';

export const LIMIT_BOUNDS: readonly LimitBound[] = [
  'temperatureHigh', 'temperatureLow', 'humidityHigh', 'humidityLow',
] as const;

/** Newline-separated, most-preferred first — same wire format as telemetry aliases. */
export const ALARM_LIMIT_KEYS_DEFAULT: Record<LimitBound, string> = {
  temperatureHigh: 'High Temperature Limit\nHigh Temperature\nTemp High',
  temperatureLow: 'Low Temperature Limit\nLow Temperature\nTemp Low',
  humidityHigh: 'High Humidity Limit\nHigh Humidity\nRH High',
  humidityLow: 'Low Humidity Limit\nLow Humidity\nRH Low',
};

export const ALARM_STATUS_TEXT_DEFAULT = {
  activeUnack: 'Still pending Unacknowledged',
  activeAck: 'Active — Acknowledged',
  clearedUnack: 'Cleared — Unacknowledged',
  clearedAck: 'Cleared',
} as const;

/** Trim, lowercase, drop blanks, de-duplicate keeping FIRST (order is precedence). */
export function parseLimitKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const v = line.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * A limit value, or null when there is not one.
 *
 * NOT `Number(raw)`: `Number("")` is 0, so a blank attribute would become a 0 °C
 * limit that breaches on every reading forever. An explicit numeric-string test
 * also rejects `"25 C"`, which a bare parseFloat would happily read as 25.
 */
export function parseLimitValue(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * First KEY that any attribute matches wins — not first attribute matching any key.
 * Only the key order can make precedence deterministic when an instrument carries
 * both spellings, which live data shows it does.
 *
 * A matched-but-unparseable value resolves to null rather than falling through to
 * the next key: a typo on the preferred key must read as "no limit", never be
 * silently replaced by a different attribute's number.
 */
export function resolveLimit(
  keys: string[],
  attributes: { key: string; value: string }[],
): { key: string; value: number } | null {
  for (const k of keys) {
    const hit = attributes.find((a) => a.key.trim().toLowerCase() === k);
    if (!hit) continue;
    const value = parseLimitValue(hit.value);
    return value === null ? null : { key: hit.key, value };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/types/alarm-limits.test.ts`
Expected: PASS, 13 tests

- [ ] **Step 5: Export from the package index**

In `packages/shared/src/index.ts`, immediately after the `telemetry-slots.js` export block:

```ts
export {
  LIMIT_BOUNDS,
  ALARM_LIMIT_KEYS_DEFAULT,
  ALARM_STATUS_TEXT_DEFAULT,
  parseLimitKeys,
  parseLimitValue,
  resolveLimit,
} from './types/alarm-limits.js';
export type { LimitBound } from './types/alarm-limits.js';
```

- [ ] **Step 6: Build the package and typecheck**

Run: `npm run build -w @digilog/shared && npx tsc --noEmit -p packages/shared/tsconfig.json`
Expected: both exit 0

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/alarm-limits.ts packages/shared/src/types/alarm-limits.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): parse instrument limit attributes into alarm bounds

An ordered alias list, not one fixed key: the live database already holds
'High Temperature', 'Low Temperature' and 'Low Temperature Limit' as three
separate operator-typed keys, and an unmatched key means no alarm and no warning.

parseLimitValue rejects '' rather than reading it as 0 — Number('') is 0, and a
0 C limit breaches on every reading forever."
```

---

### Task 2: The `alarm-limits` config def

**Files:**
- Create: `apps/api/src/modules/config/defs/alarm-limits.def.ts`
- Modify: `apps/api/src/lib/config-discovery.ts` (add one import above the `─── Add new module configs below this line ───` marker)
- Modify: `apps/web/src/routes/config/index.tsx` (add a card after the `Telemetry Keys` card, ~line 108)

**Interfaces:**
- Consumes: `ALARM_LIMIT_KEYS_DEFAULT`, `ALARM_STATUS_TEXT_DEFAULT` from Task 1.
- Produces: `system_config` row with key `alarm-limits` holding settings
  `temperatureHighKeys`, `temperatureLowKeys`, `humidityHighKeys`, `humidityLowKeys`,
  `severity`, `enabled`, `statusActiveUnack`, `statusActiveAck`, `statusClearedUnack`,
  `statusClearedAck`. Reachable at `/config/dynamic/alarm-limits`.

- [ ] **Step 1: Write the config def**

Create `apps/api/src/modules/config/defs/alarm-limits.def.ts`:

```ts
import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { ALARM_LIMIT_KEYS_DEFAULT, ALARM_STATUS_TEXT_DEFAULT } from '@digilog/shared';

/**
 * Which instrument attributes carry the four limits, and what the alarm status
 * column says.
 *
 * Attribute keys are operator-typed free text and have already drifted in this
 * install (`High Temperature` vs `High Temperature Limit` vs `Low Temperature`).
 * An ordered alias list per bound resolves both spellings without anyone
 * re-keying existing instruments; the first listed key that an instrument has
 * wins, deterministically.
 *
 * Room limits (floorplan_rooms.temp_min/…) are a SEPARATE thing and raise
 * nothing — they colour the dashboard. Do not wire them in here.
 *
 * Design: docs/superpowers/specs/2026-08-17-instrument-limit-alarms-design.md
 */
export const alarmLimitsDef: ModuleConfigDefinition = {
  moduleKey: 'alarm-limits',
  moduleName: 'Instrument Limit Alarms',
  description: 'Which instrument attributes hold the temperature and humidity limits, and the wording of each alarm status.',
  icon: 'bell',
  category: 'system',
  sortOrder: 17,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'enabled',
      type: 'boolean',
      label: 'Raise alarms from instrument limits',
      description: 'When off, no limit alarms are raised. Alarm rules are unaffected. Alarms already raised are left exactly as they are — they are regulated records.',
      default: true,
      group: 'Limit Alarms',
    },
    {
      key: 'severity',
      type: 'select',
      label: 'Severity',
      description: 'Severity carried by every instrument-limit alarm.',
      default: 'CRITICAL',
      options: [
        { value: 'CRITICAL', label: 'Critical' },
        { value: 'MAJOR', label: 'Major' },
        { value: 'MINOR', label: 'Minor' },
      ],
      group: 'Limit Alarms',
    },
    {
      key: 'temperatureHighKeys',
      type: 'textarea',
      label: 'High temperature limit — attribute keys',
      description: 'One attribute key per line, most preferred first. The first key an instrument actually has wins.',
      default: ALARM_LIMIT_KEYS_DEFAULT.temperatureHigh,
      maxLength: 500,
      group: 'Attribute Keys',
    },
    {
      key: 'temperatureLowKeys',
      type: 'textarea',
      label: 'Low temperature limit — attribute keys',
      description: 'One attribute key per line, most preferred first.',
      default: ALARM_LIMIT_KEYS_DEFAULT.temperatureLow,
      maxLength: 500,
      group: 'Attribute Keys',
    },
    {
      key: 'humidityHighKeys',
      type: 'textarea',
      label: 'High humidity limit — attribute keys',
      description: 'One attribute key per line, most preferred first.',
      default: ALARM_LIMIT_KEYS_DEFAULT.humidityHigh,
      maxLength: 500,
      group: 'Attribute Keys',
    },
    {
      key: 'humidityLowKeys',
      type: 'textarea',
      label: 'Low humidity limit — attribute keys',
      description: 'One attribute key per line, most preferred first.',
      default: ALARM_LIMIT_KEYS_DEFAULT.humidityLow,
      maxLength: 500,
      group: 'Attribute Keys',
    },
    {
      key: 'statusActiveUnack',
      type: 'string',
      label: 'Status — still breaching, not acknowledged',
      description: 'Shown while the condition is still met and nobody has signed for it.',
      default: ALARM_STATUS_TEXT_DEFAULT.activeUnack,
      maxLength: 60,
      group: 'Status Wording',
    },
    {
      key: 'statusActiveAck',
      type: 'string',
      label: 'Status — still breaching, acknowledged',
      description: 'The condition is still met, but someone has signed for it.',
      default: ALARM_STATUS_TEXT_DEFAULT.activeAck,
      maxLength: 60,
      group: 'Status Wording',
    },
    {
      key: 'statusClearedUnack',
      type: 'string',
      label: 'Status — cleared, not acknowledged',
      description: 'The condition ended but nobody has signed for it. Keep this distinct from the cleared wording: it is the overnight excursion still owed an answer.',
      default: ALARM_STATUS_TEXT_DEFAULT.clearedUnack,
      maxLength: 60,
      group: 'Status Wording',
    },
    {
      key: 'statusClearedAck',
      type: 'string',
      label: 'Status — cleared and acknowledged',
      description: 'The condition ended and it has been signed for. Finished.',
      default: ALARM_STATUS_TEXT_DEFAULT.clearedAck,
      maxLength: 60,
      group: 'Status Wording',
    },
  ],
};
```

- [ ] **Step 2: Register it for discovery**

In `apps/api/src/lib/config-discovery.ts`, add above the `// ─── Add new module configs below this line ───` marker:

```ts
    import('../modules/config/defs/alarm-limits.def.js'),
```

- [ ] **Step 3: Add the config card**

In `apps/web/src/routes/config/index.tsx`, immediately after the `Telemetry Keys` card object:

```tsx
  {
    title: 'Instrument Limit Alarms',
    description: 'Which attributes hold the temperature and humidity limits, and each alarm status wording',
    href: '/config/dynamic/alarm-limits',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
    ),
    gradient: 'from-rose-500 to-orange-600',
    shadowColor: 'shadow-rose-500/25',
  },
```

- [ ] **Step 4: Typecheck and verify the def registers and seeds**

Run:
```bash
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
```
Expected: both exit 0.

Then restart the API (`cd apps/api && npx tsx watch src/app.ts`) and confirm the row seeded:
```bash
PGPASSWORD=digilog123 psql -U digilog -h localhost -d compliance_core_db \
  -c "SELECT config_key, jsonb_object_keys(config_value) FROM system_config WHERE config_key='alarm-limits';"
```
Expected: 10 rows — the ten setting keys listed in the Interfaces block above.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/config/defs/alarm-limits.def.ts apps/api/src/lib/config-discovery.ts apps/web/src/routes/config/index.tsx
git commit -m "feat(config): alarm-limits — attribute key mapping and status wording

Follows the telemetry-slots pattern: an administered mapping rather than a
hardcoded key name, because instrument attribute keys are operator-typed and
have already drifted in this install."
```

---

### Task 3: Schema — nullable ruleId, source, limitKind, clearedValue

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (model `Alarm`, ~line 859; new enums near `AlarmState`, ~line 914)
- Create: `apps/api/prisma/migrations/20260817090000_instrument_limit_alarms/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `Alarm.ruleId: String?`, `Alarm.source: AlarmSource`, `Alarm.limitKind: AlarmLimitKind?`, `Alarm.clearedValue: Float?`; enums `AlarmSource { RULE, INSTRUMENT_LIMIT }` and `AlarmLimitKind { HIGH, LOW }`.

- [ ] **Step 1: Edit the schema**

In `apps/api/prisma/schema.prisma`, model `Alarm` — change `ruleId` and add three fields:

```prisma
  /// NULL for an instrument-limit alarm: it is raised from the instrument's own
  /// attributes and has no rule row. Inventing a synthetic rule would put an
  /// editable row on the Alarm Rules page that silently disagrees with the
  /// attribute it came from.
  ruleId String? @map("rule_id")

  /// What raised this. RULE alarms come from alarm_rules; INSTRUMENT_LIMIT alarms
  /// from the instrument's own limit attributes.
  source AlarmSource @default(RULE)

  /// Which bound was breached. NULL for rule alarms, which describe themselves
  /// through their snapshot instead.
  limitKind AlarmLimitKind? @map("limit_kind")

  /// The reading that brought it back in spec. NULL while still active, and for
  /// OFFLINE which has no value.
  clearedValue Float? @map("cleared_value")
```

Change the relation to optional:

```prisma
  rule       AlarmRule? @relation(fields: [ruleId], references: [id], onDelete: Restrict)
```

Add an index for the limit-alarm identity lookup, beside the existing `@@index` lines:

```prisma
  @@index([source, instrumentId, metric, limitKind, state])
```

Add the two enums after `enum AlarmState`:

```prisma
enum AlarmSource {
  RULE
  INSTRUMENT_LIMIT
}

enum AlarmLimitKind {
  HIGH
  LOW
}
```

- [ ] **Step 2: Hand-author the migration**

Create `apps/api/prisma/migrations/20260817090000_instrument_limit_alarms/migration.sql`:

```sql
-- Instrument-limit alarms.
--
-- Alarms raised from an instrument's own High/Low Temperature and Humidity Limit
-- attributes have NO rule row, so `rule_id` becomes nullable and a `source`
-- discriminator says which kind a row is. `cleared_value` records the reading that
-- brought the condition back in spec — nothing captured that before.
--
-- SAFE AT THIS MOMENT: `alarms` holds 0 rows and `alarm_rules` 0 rows (verified
-- 2026-08-17). Dropping NOT NULL is widening and would be safe regardless; the
-- backfill below is therefore a no-op but is written so the migration is correct
-- against a populated database too.
--
-- HAND-AUTHORED. `prisma migrate diff` emits three further statements, ALL
-- deliberately omitted — the same three it has emitted since 20260811120000:
--
--   DROP TABLE "instrument_telemetry_history"
--     — partitioned, invisible to the datamodel, holds live telemetry.
--   ALTER TABLE "audit_trail" ALTER COLUMN "chain_position" DROP NOT NULL
--     — the 21 CFR §11 hash-chain position, sequence-backed outside Prisma.
--   DROP/ADD CONSTRAINT "instrument_credentials_instrument_id_fkey"
--     — unchanged; a drop-and-recreate of an identical FK.
--
-- Read the header of 20260811120000_instrument_floorplans before regenerating.

CREATE TYPE "AlarmSource" AS ENUM ('RULE', 'INSTRUMENT_LIMIT');
CREATE TYPE "AlarmLimitKind" AS ENUM ('HIGH', 'LOW');

ALTER TABLE "alarms" ALTER COLUMN "rule_id" DROP NOT NULL;

ALTER TABLE "alarms" ADD COLUMN "source" "AlarmSource" NOT NULL DEFAULT 'RULE';
ALTER TABLE "alarms" ADD COLUMN "limit_kind" "AlarmLimitKind";
ALTER TABLE "alarms" ADD COLUMN "cleared_value" DOUBLE PRECISION;

-- Every pre-existing alarm came from a rule. Explicit rather than relying on the
-- column default, so the intent survives a future default change.
UPDATE "alarms" SET "source" = 'RULE' WHERE "rule_id" IS NOT NULL;

CREATE INDEX "alarms_source_instrument_id_metric_limit_kind_state_idx"
  ON "alarms" ("source", "instrument_id", "metric", "limit_kind", "state");
```

- [ ] **Step 3: Apply to BOTH databases**

```bash
cd apps/api
DATABASE_URL="postgresql://digilog:digilog123@localhost:5432/compliance_core_db?schema=public" npx prisma migrate deploy
DATABASE_URL="postgresql://digilog:digilog123@localhost:5432/compliance_core_db_test?schema=public" npx prisma migrate deploy
```
Expected: both report the migration applied. Skipping the test database makes every instrument-touching e2e return 500.

- [ ] **Step 4: Regenerate the client and run the drift guard**

```bash
# `prisma generate` EPERMs while `tsx watch` holds the DLL — stop the API first.
cd apps/api && npx prisma generate
cd ../.. && powershell -ExecutionPolicy Bypass -File scripts/verify-migrations.ps1
```
Expected: generate succeeds; drift guard reports PASS.

- [ ] **Step 5: Verify the columns landed**

```bash
PGPASSWORD=digilog123 psql -U digilog -h localhost -d compliance_core_db -c "\d alarms" | grep -E "rule_id|source|limit_kind|cleared_value"
```
Expected: `rule_id` shown WITHOUT `not null`; `source`, `limit_kind`, `cleared_value` present.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260817090000_instrument_limit_alarms/
git commit -m "feat(db): alarms gain source, limitKind, clearedValue; ruleId nullable

An instrument-limit alarm has no rule row. A synthetic rule would appear on the
Alarm Rules page and could be edited into disagreeing with the attribute it came
from. Safe now: 0 alarms and 0 rules exist.

Hand-authored; the three destructive statements migrate diff emits here are
deliberately omitted."
```

---

### Task 4: Pure limit-decision module

**Files:**
- Create: `apps/api/src/modules/alarms/limit-decide.ts`
- Create: `apps/api/src/modules/alarms/__tests__/limit-decide.test.ts`

**Interfaces:**
- Consumes: `parseLimitValue`, `resolveLimit`, `LimitBound` from Task 1.
- Produces:
  - `interface InstrumentLimits { temperatureHigh: number | null; temperatureLow: number | null; humidityHigh: number | null; humidityLow: number | null }`
  - `interface LimitCheck { metric: 'TEMPERATURE' | 'HUMIDITY'; limitKind: 'HIGH' | 'LOW'; limit: number; breaching: boolean }`
  - `function limitsInverted(high: number | null, low: number | null): boolean`
  - `function checkLimits(limits: InstrumentLimits, reading: { temperature: number | null; humidity: number | null }): LimitCheck[]`
  - `function describeLimit(c: Pick<LimitCheck, 'metric' | 'limitKind' | 'limit'>): string`
  - `function limitSnapshot(input: { metric: string; limitKind: string; limit: number; attributeKey: string | null; snapshotAt: string }): Record<string, unknown>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/alarms/__tests__/limit-decide.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  checkLimits,
  limitsInverted,
  describeLimit,
  type InstrumentLimits,
} from '../limit-decide.js';

const none: InstrumentLimits = {
  temperatureHigh: null, temperatureLow: null, humidityHigh: null, humidityLow: null,
};
const temp: InstrumentLimits = { ...none, temperatureHigh: 25, temperatureLow: 18 };

describe('checkLimits', () => {
  it('raises HIGH above the high limit', () => {
    const out = checkLimits(temp, { temperature: 26.4, humidity: null });
    expect(out).toEqual([
      { metric: 'TEMPERATURE', limitKind: 'HIGH', limit: 25, breaching: true },
      { metric: 'TEMPERATURE', limitKind: 'LOW', limit: 18, breaching: false },
    ]);
  });

  it('raises LOW below the low limit', () => {
    const out = checkLimits(temp, { temperature: 17.2, humidity: null });
    expect(out.find((c) => c.limitKind === 'LOW')?.breaching).toBe(true);
    expect(out.find((c) => c.limitKind === 'HIGH')?.breaching).toBe(false);
  });

  it('treats a reading EXACTLY at either limit as in spec', () => {
    // Boundaries are in spec everywhere else in this system (decide.ts
    // OUTSIDE_RANGE, telemetry-slots breaches). This must not be the exception.
    expect(checkLimits(temp, { temperature: 25, humidity: null }).every((c) => !c.breaching)).toBe(true);
    expect(checkLimits(temp, { temperature: 18, humidity: null }).every((c) => !c.breaching)).toBe(true);
  });

  it('never checks a bound that has no limit', () => {
    const highOnly: InstrumentLimits = { ...none, temperatureHigh: 25 };
    const out = checkLimits(highOnly, { temperature: -40, humidity: null });
    expect(out).toEqual([{ metric: 'TEMPERATURE', limitKind: 'HIGH', limit: 25, breaching: false }]);
  });

  it('returns nothing when the instrument has no limits at all', () => {
    expect(checkLimits(none, { temperature: 99, humidity: 99 })).toEqual([]);
  });

  it('treats a missing reading as NOT breaching — that is the OFFLINE concern', () => {
    expect(checkLimits(temp, { temperature: null, humidity: null }).every((c) => !c.breaching)).toBe(true);
  });

  it('checks temperature and humidity independently', () => {
    const both: InstrumentLimits = { temperatureHigh: 25, temperatureLow: 18, humidityHigh: 60, humidityLow: 40 };
    const out = checkLimits(both, { temperature: 26, humidity: 30 });
    expect(out.filter((c) => c.breaching)).toEqual([
      { metric: 'TEMPERATURE', limitKind: 'HIGH', limit: 25, breaching: true },
      { metric: 'HUMIDITY', limitKind: 'LOW', limit: 40, breaching: true },
    ]);
  });

  it('skips BOTH bounds of an inverted pair rather than alarming forever', () => {
    const inverted: InstrumentLimits = { ...none, temperatureHigh: 20, temperatureLow: 30 };
    expect(checkLimits(inverted, { temperature: 25, humidity: null })).toEqual([]);
  });
});

describe('limitsInverted', () => {
  it('is true only when both are set and low is above high', () => {
    expect(limitsInverted(20, 30)).toBe(true);
    expect(limitsInverted(30, 20)).toBe(false);
    expect(limitsInverted(25, 25)).toBe(false);
    expect(limitsInverted(null, 30)).toBe(false);
    expect(limitsInverted(20, null)).toBe(false);
  });
});

describe('describeLimit', () => {
  it('reads as the condition that fired', () => {
    expect(describeLimit({ metric: 'TEMPERATURE', limitKind: 'HIGH', limit: 25 }))
      .toBe('temperature above 25');
    expect(describeLimit({ metric: 'HUMIDITY', limitKind: 'LOW', limit: 40 }))
      .toBe('humidity below 40');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/alarms/__tests__/limit-decide.test.ts`
Expected: FAIL — cannot resolve `../limit-decide.js`

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/alarms/limit-decide.ts`:

```ts
/**
 * Instrument-limit alarm decisions: does this reading breach the instrument's own
 * limit attributes?
 *
 * PURE on purpose, exactly like decide.ts beside it. The worker does only I/O.
 * This is the part that decides whether a regulated excursion is recorded, and the
 * only part a machine can check — a wrong comparison here is silent, because an
 * alarm that never fires looks exactly like a plant running normally.
 *
 * Design: docs/superpowers/specs/2026-08-17-instrument-limit-alarms-design.md
 */

export type LimitMetric = 'TEMPERATURE' | 'HUMIDITY';
export type LimitKind = 'HIGH' | 'LOW';

export interface InstrumentLimits {
  temperatureHigh: number | null;
  temperatureLow: number | null;
  humidityHigh: number | null;
  humidityLow: number | null;
}

export interface LimitCheck {
  metric: LimitMetric;
  limitKind: LimitKind;
  limit: number;
  breaching: boolean;
}

/**
 * A low limit ABOVE its high limit is a misconfiguration, not a permanent breach.
 * Every reading would breach one bound or the other forever, which trains
 * operators to ignore alarms — the same alarm-fatigue reasoning decide.ts applies
 * to a missing threshold.
 */
export function limitsInverted(high: number | null, low: number | null): boolean {
  return high !== null && low !== null && low > high;
}

function checkPair(
  metric: LimitMetric,
  high: number | null,
  low: number | null,
  value: number | null,
): LimitCheck[] {
  if (limitsInverted(high, low)) return [];
  const out: LimitCheck[] = [];
  // Boundaries are IN spec: strictly greater / strictly less, matching
  // isBreaching() for OUTSIDE_RANGE and breaches() for room limits.
  // A null reading is NOT a breach — "the probe went quiet" is the OFFLINE
  // metric's concern, and conflating them would make an excursion and a dead
  // probe indistinguishable in a regulated record.
  if (high !== null) {
    out.push({ metric, limitKind: 'HIGH', limit: high, breaching: value !== null && value > high });
  }
  if (low !== null) {
    out.push({ metric, limitKind: 'LOW', limit: low, breaching: value !== null && value < low });
  }
  return out;
}

/** Every bound this instrument actually declares, and whether each is breaching now. */
export function checkLimits(
  limits: InstrumentLimits,
  reading: { temperature: number | null; humidity: number | null },
): LimitCheck[] {
  return [
    ...checkPair('TEMPERATURE', limits.temperatureHigh, limits.temperatureLow, reading.temperature),
    ...checkPair('HUMIDITY', limits.humidityHigh, limits.humidityLow, reading.humidity),
  ];
}

/** Human-readable condition, e.g. `temperature above 25`. Mirrors describeRule(). */
export function describeLimit(c: Pick<LimitCheck, 'metric' | 'limitKind' | 'limit'>): string {
  return `${c.metric.toLowerCase()} ${c.limitKind === 'HIGH' ? 'above' : 'below'} ${c.limit}`;
}

/**
 * The limit as it will be FROZEN onto the alarm.
 *
 * Changing an instrument's limit attribute later must not change what a historical
 * alarm says about itself — an inspector asking "why did this fire at 24.0 when the
 * attribute says 26?" is answered from here, never from the live attribute.
 */
export function limitSnapshot(input: {
  metric: string;
  limitKind: string;
  limit: number;
  attributeKey: string | null;
  snapshotAt: string;
}): Record<string, unknown> {
  return {
    source: 'INSTRUMENT_LIMIT',
    ruleId: null,
    name: `${input.metric} ${input.limitKind} limit`,
    metric: input.metric,
    limitKind: input.limitKind,
    limit: input.limit,
    attributeKey: input.attributeKey,
    description: describeLimit({
      metric: input.metric as LimitMetric,
      limitKind: input.limitKind as LimitKind,
      limit: input.limit,
    }),
    snapshotAt: input.snapshotAt,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/alarms/__tests__/limit-decide.test.ts`
Expected: PASS, 11 tests (10 from the brief + the non-finite guard test added in review)

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/modules/alarms/limit-decide.ts apps/api/src/modules/alarms/__tests__/limit-decide.test.ts
git commit -m "feat(alarms): pure instrument-limit decision module

Boundaries are IN spec, a missing reading is not a breach, a bound with no limit
is never checked, and an inverted pair fires nothing rather than alarming on
every reading forever."
```

---

### Task 5: Worker — the instrument-limit pass

**Files:**
- Create: `apps/api/src/modules/alarms/load-limits.ts`
- Modify: `apps/api/src/workers/alarm-evaluation.worker.ts` (add the pass after the rule loop, before the `return`)
- Create: `apps/api/src/modules/alarms/__tests__/load-limits.test.ts`

**Interfaces:**
- Consumes: `checkLimits`, `limitSnapshot`, `describeLimit`, `InstrumentLimits` (Task 4); `parseLimitKeys`, `resolveLimit`, `ALARM_LIMIT_KEYS_DEFAULT` (Task 1); `Alarm.source`/`limitKind`/`clearedValue` (Task 3).
- Produces:
  - `interface LimitConfig { enabled: boolean; severity: 'CRITICAL' | 'MAJOR' | 'MINOR'; keys: Record<LimitBound, string[]> }`
  - `async function loadLimitConfig(): Promise<LimitConfig>`
  - `function limitsFor(keys: LimitConfig['keys'], attributes: { key: string; value: string }[]): { limits: InstrumentLimits; attributeKeys: Record<string, string | null> }`
  - `evaluateAlarms()` result gains no new fields; the pass increments the existing `raised` / `cleared` counters.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/alarms/__tests__/load-limits.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { limitsFor } from '../load-limits.js';
import { parseLimitKeys, ALARM_LIMIT_KEYS_DEFAULT } from '@digilog/shared';

const keys = {
  temperatureHigh: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.temperatureHigh),
  temperatureLow: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.temperatureLow),
  humidityHigh: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.humidityHigh),
  humidityLow: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.humidityLow),
};

describe('limitsFor', () => {
  it('reads all four limits from attributes', () => {
    const { limits } = limitsFor(keys, [
      { key: 'High Temperature Limit', value: '25' },
      { key: 'Low Temperature Limit', value: '18' },
      { key: 'High Humidity Limit', value: '60' },
      { key: 'Low Humidity Limit', value: '40' },
    ]);
    expect(limits).toEqual({
      temperatureHigh: 25, temperatureLow: 18, humidityHigh: 60, humidityLow: 40,
    });
  });

  it('resolves the alias spelling that exists in the live database', () => {
    const { limits } = limitsFor(keys, [{ key: 'Low Temperature', value: '18' }]);
    expect(limits.temperatureLow).toBe(18);
  });

  it('leaves a bound null when the attribute is absent or unparseable', () => {
    const { limits } = limitsFor(keys, [
      { key: 'High Temperature Limit', value: 'warm' },
      { key: 'Slave ID', value: '3' },
    ]);
    expect(limits.temperatureHigh).toBeNull();
    expect(limits.temperatureLow).toBeNull();
  });

  it('reports which attribute key each limit came from, for the snapshot', () => {
    const { attributeKeys } = limitsFor(keys, [{ key: 'High Temperature', value: '25' }]);
    expect(attributeKeys.temperatureHigh).toBe('High Temperature');
    expect(attributeKeys.temperatureLow).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/alarms/__tests__/load-limits.test.ts`
Expected: FAIL — cannot resolve `../load-limits.js`

- [ ] **Step 3: Write the config loader**

Create `apps/api/src/modules/alarms/load-limits.ts`:

```ts
import { prisma } from '../../lib/prisma.js';
import {
  parseLimitKeys,
  resolveLimit,
  ALARM_LIMIT_KEYS_DEFAULT,
  type LimitBound,
} from '@digilog/shared';
import type { InstrumentLimits } from './limit-decide.js';

/**
 * The administered attribute-key mapping, read from the `alarm-limits` config.
 *
 * Loaded the same way telemetry-overview.ts loads `telemetry-slots`: one row, with
 * the shipped defaults as the fallback so a missing config never means "no alarms".
 */
export interface LimitConfig {
  enabled: boolean;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  keys: Record<LimitBound, string[]>;
}

const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'] as const;

export async function loadLimitConfig(): Promise<LimitConfig> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'alarm-limits' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;

  const list = (key: string, fallback: string) =>
    parseLimitKeys(typeof cfg[key] === 'string' ? (cfg[key] as string) : fallback);

  const severity = SEVERITIES.includes(cfg.severity as never)
    ? (cfg.severity as LimitConfig['severity'])
    : 'CRITICAL';

  return {
    // Absent config means enabled: the feature ships on, and a half-seeded row
    // must not silently stop every limit alarm.
    enabled: cfg.enabled !== false,
    severity,
    keys: {
      temperatureHigh: list('temperatureHighKeys', ALARM_LIMIT_KEYS_DEFAULT.temperatureHigh),
      temperatureLow: list('temperatureLowKeys', ALARM_LIMIT_KEYS_DEFAULT.temperatureLow),
      humidityHigh: list('humidityHighKeys', ALARM_LIMIT_KEYS_DEFAULT.humidityHigh),
      humidityLow: list('humidityLowKeys', ALARM_LIMIT_KEYS_DEFAULT.humidityLow),
    },
  };
}

/**
 * One instrument's four limits, plus which attribute key each came from.
 *
 * The key is kept so it can be frozen onto the alarm snapshot: "this fired against
 * `High Temperature` = 25" is answerable later even after the attribute is renamed
 * or deleted.
 */
export function limitsFor(
  keys: LimitConfig['keys'],
  attributes: { key: string; value: string }[],
): { limits: InstrumentLimits; attributeKeys: Record<LimitBound, string | null> } {
  const hit = (bound: LimitBound) => resolveLimit(keys[bound], attributes);
  const th = hit('temperatureHigh');
  const tl = hit('temperatureLow');
  const hh = hit('humidityHigh');
  const hl = hit('humidityLow');
  return {
    limits: {
      temperatureHigh: th?.value ?? null,
      temperatureLow: tl?.value ?? null,
      humidityHigh: hh?.value ?? null,
      humidityLow: hl?.value ?? null,
    },
    attributeKeys: {
      temperatureHigh: th?.key ?? null,
      temperatureLow: tl?.key ?? null,
      humidityHigh: hh?.key ?? null,
      humidityLow: hl?.key ?? null,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/alarms/__tests__/load-limits.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Add the pass to the worker**

In `apps/api/src/workers/alarm-evaluation.worker.ts`, add to the imports:

```ts
import { checkLimits, limitSnapshot, describeLimit } from '../modules/alarms/limit-decide.js';
import { loadLimitConfig, limitsFor } from '../modules/alarms/load-limits.js';
import type { LimitBound } from '@digilog/shared';
```

Then, inside `evaluateAlarms()`, replace the final `return { rulesEvaluated: rules.length, raised, cleared };` with the pass below. Note the early `overview` reference: it is already loaded at the top of the function, so this adds no telemetry query.

```ts
  // ─── Instrument-limit pass ────────────────────────────────────────────────
  //
  // Separate from the rule pass and additive to it: an instrument can hold a rule
  // alarm and a limit alarm at once, and neither clears the other. Identity here is
  // (instrument, metric, limitKind) rather than (rule, instrument), because these
  // alarms have no rule.
  const limitCfg = await loadLimitConfig();
  if (limitCfg.enabled) {
    const attrRows = await prisma.instrumentAttribute.findMany({
      select: { instrumentId: true, key: true, value: true },
    });
    const attrsByInstrument = new Map<string, { key: string; value: string }[]>();
    for (const a of attrRows) {
      const list = attrsByInstrument.get(a.instrumentId) ?? [];
      list.push({ key: a.key, value: a.value });
      attrsByInstrument.set(a.instrumentId, list);
    }

    const openLimitAlarms = await prisma.alarm.findMany({
      where: { source: 'INSTRUMENT_LIMIT', state: 'ACTIVE' },
      select: { id: true, instrumentId: true, metric: true, limitKind: true },
    });
    const openKey = (instrumentId: string, metric: string, kind: string) =>
      `${instrumentId}:${metric}:${kind}`;
    const openMap = new Map(
      openLimitAlarms.map((a) => [openKey(a.instrumentId, a.metric, a.limitKind ?? ''), a.id]),
    );

    for (const row of overview) {
      const attributes = attrsByInstrument.get(row.instrumentId) ?? [];
      if (attributes.length === 0) continue;

      const { limits, attributeKeys } = limitsFor(limitCfg.keys, attributes);
      const reading = {
        temperature: row.temperature?.value ?? null,
        humidity: row.humidity?.value ?? null,
      };

      for (const check of checkLimits(limits, reading)) {
        const key = openKey(row.instrumentId, check.metric, check.limitKind);
        const existingId = openMap.get(key);

        if (check.breaching && !existingId) {
          const bound = `${check.metric === 'TEMPERATURE' ? 'temperature' : 'humidity'}${
            check.limitKind === 'HIGH' ? 'High' : 'Low'
          }` as LimitBound;
          const created = await prisma.alarm.create({
            data: {
              ruleId: null,
              source: 'INSTRUMENT_LIMIT',
              limitKind: check.limitKind,
              // Frozen here: changing the attribute later must not change what
              // this alarm says about itself.
              ruleSnapshot: limitSnapshot({
                metric: check.metric,
                limitKind: check.limitKind,
                limit: check.limit,
                attributeKey: attributeKeys[bound],
                snapshotAt: now.toISOString(),
              }),
              instrumentId: row.instrumentId,
              metric: check.metric,
              triggeredValue: check.metric === 'TEMPERATURE' ? reading.temperature : reading.humidity,
              severity: limitCfg.severity,
              state: 'ACTIVE',
              raisedAt: now,
            },
          });
          raised += 1;
          await enqueueAlarmNotification('raised', {
            alarmId: created.id,
            instrumentId: row.instrumentId,
            instrumentCode: row.code,
            instrumentName: row.name,
            metric: check.metric,
            severity: limitCfg.severity,
            ruleName: `${check.metric} ${check.limitKind} limit`,
            condition: describeLimit(check),
            triggeredValue: created.triggeredValue,
            raisedAt: created.raisedAt,
          });
        } else if (!check.breaching && existingId) {
          const value = check.metric === 'TEMPERATURE' ? reading.temperature : reading.humidity;
          // Acknowledgement fields untouched: a cleared-but-unacknowledged alarm
          // is the overnight excursion someone must still answer for.
          const closed = await prisma.alarm.update({
            where: { id: existingId },
            data: { state: 'CLEARED', clearedAt: now, clearedValue: value },
          });
          cleared += 1;
          await enqueueAlarmNotification('cleared', {
            alarmId: closed.id,
            instrumentId: row.instrumentId,
            instrumentCode: row.code,
            instrumentName: row.name,
            metric: closed.metric,
            severity: closed.severity,
            ruleName: `${check.metric} ${check.limitKind} limit`,
            condition: describeLimit(check),
            triggeredValue: closed.triggeredValue,
            raisedAt: closed.raisedAt,
            clearedAt: closed.clearedAt,
          });
        }
      }
    }
  }

  return { rulesEvaluated: rules.length, raised, cleared };
```

Also remove the early return at the top of `evaluateAlarms()` — currently `if (rules.length === 0) return { rulesEvaluated: 0, raised: 0, cleared: 0 };`. With this pass added, zero rules must NOT skip evaluation; limit alarms have no rules at all. Replace it with nothing (the rule loop over an empty array is already a no-op).

**THIS IS THE HIGHEST-RISK LINE IN THE TASK.** A site with zero alarm rules — which is
this install today, and the exact configuration where instrument-limit alarms are the
only alarms anyone has — would otherwise get a feature that silently never runs. Verify
after the change that `evaluateAlarms()` reaches the limit pass with `alarm_rules` empty.

**Two consequences of removing it, both required:**

1. The rule-alarm query immediately below now runs with a possibly-empty rule list. Make
   its intent explicit by adding `source: 'RULE'` to the `where`, so the ACTIVE-alarm Map
   provably excludes limit alarms rather than relying on `NULL IN (...)` never matching:

```ts
  const active = await prisma.alarm.findMany({
    // `source: 'RULE'` is not redundant with the ruleId filter — it states the intent at
    // the query, so a later widening of this where clause cannot silently pull
    // instrument-limit alarms into a Map keyed on ruleId.
    where: { state: 'ACTIVE', source: 'RULE', ruleId: { in: rules.map((r) => r.id) } },
    select: { id: true, ruleId: true, instrumentId: true },
  });
```

2. `AlarmEvaluationResult` (the interface near the top of the file) reports only
   `rulesEvaluated / raised / cleared`. Leave those three meaning what they already mean
   and ADD a fourth, `instrumentsEvaluated: number`, set to the number of overview rows
   the limit pass examined. Without it, a run that raised nothing is indistinguishable
   from a run where the pass never executed — the exact failure this step exists to
   prevent. Return it from both the early-exit path (`0`) and the normal path.

- [ ] **Step 6: Verify the whole api suite and typecheck**

Run:
```bash
cd apps/api && npx vitest run src/modules/alarms src/workers && npx tsc --noEmit -p tsconfig.json
```
Expected: all alarm + worker tests pass; tsc exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/alarms/load-limits.ts apps/api/src/modules/alarms/__tests__/load-limits.test.ts apps/api/src/workers/alarm-evaluation.worker.ts
git commit -m "feat(alarms): raise alarms from instrument limit attributes

A second pass in the existing worker, reusing buildTelemetryOverview so
temperature-key resolution cannot drift from the dashboard. Identity is
(instrument, metric, limitKind) since these alarms have no rule.

Removes the zero-rules early return: limit alarms have no rules at all, so
skipping on rules.length === 0 would disable the whole feature."
```

---

### Task 6: API — expose the new fields and the no-limits count

**Files:**
- Modify: `apps/api/src/modules/alarms/routes.ts` (`alarmProps` ~line 40; list mapper ~line 272; `/summary` ~line 377)
- Create: `apps/api/src/modules/alarms/__tests__/without-limits.test.ts`

**Interfaces:**
- Consumes: `limitsFor`, `loadLimitConfig` (Task 5); `checkLimits` (Task 4).
- Produces:
  - `GET /api/alarms` rows gain `source`, `limitKind`, `clearedValue`, and `ruleId` becomes nullable in the schema.
  - `GET /api/alarms/summary` gains `instrumentsWithoutLimits: number` and `instrumentsWithoutLimitsCodes: string[]` (capped at 50).
  - `function countWithoutLimits(instruments, keys): { count: number; codes: string[] }` exported from `load-limits.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/alarms/__tests__/without-limits.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { countWithoutLimits } from '../load-limits.js';
import { parseLimitKeys, ALARM_LIMIT_KEYS_DEFAULT } from '@digilog/shared';

const keys = {
  temperatureHigh: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.temperatureHigh),
  temperatureLow: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.temperatureLow),
  humidityHigh: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.humidityHigh),
  humidityLow: parseLimitKeys(ALARM_LIMIT_KEYS_DEFAULT.humidityLow),
};

describe('countWithoutLimits', () => {
  it('counts an instrument with no usable limit at all', () => {
    const out = countWithoutLimits(
      [{ code: 'CWH-01', attributes: [{ key: 'Slave ID', value: '3' }] }],
      keys,
    );
    expect(out).toEqual({ count: 1, codes: ['CWH-01'] });
  });

  it('does not count an instrument with even one usable limit', () => {
    const out = countWithoutLimits(
      [{ code: 'CWH-02', attributes: [{ key: 'High Temperature Limit', value: '25' }] }],
      keys,
    );
    expect(out).toEqual({ count: 0, codes: [] });
  });

  it('counts an instrument whose only limit is unparseable', () => {
    // The dangerous case: the operator believes it is configured.
    const out = countWithoutLimits(
      [{ code: 'CWH-03', attributes: [{ key: 'High Temperature Limit', value: 'warm' }] }],
      keys,
    );
    expect(out.count).toBe(1);
  });

  it('counts an instrument whose limits are inverted', () => {
    const out = countWithoutLimits(
      [{
        code: 'CWH-04',
        attributes: [
          { key: 'High Temperature Limit', value: '20' },
          { key: 'Low Temperature Limit', value: '30' },
        ],
      }],
      keys,
    );
    expect(out.count).toBe(1);
  });

  it('caps the code list at 50 while keeping the true count', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ code: `I-${i}`, attributes: [] }));
    const out = countWithoutLimits(many, keys);
    expect(out.count).toBe(60);
    expect(out.codes).toHaveLength(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/alarms/__tests__/without-limits.test.ts`
Expected: FAIL — `countWithoutLimits` is not exported

- [ ] **Step 3: Implement `countWithoutLimits`**

Append to `apps/api/src/modules/alarms/load-limits.ts`:

```ts
import { limitsInverted } from './limit-decide.js';

/** How many codes the summary will name before it just gives a number. */
const CODE_CAP = 50;

/**
 * Instruments no limit alarm can ever fire for.
 *
 * Exists so an empty Alarms page cannot mean both "everything is in spec" and
 * "nothing is being watched". Counts the three ways an instrument ends up
 * unwatched — no limit attribute, an unparseable value, and an inverted pair —
 * because all three look identical to an operator who believes it is configured.
 */
export function countWithoutLimits(
  instruments: { code: string; attributes: { key: string; value: string }[] }[],
  keys: LimitConfig['keys'],
): { count: number; codes: string[] } {
  const codes: string[] = [];
  let count = 0;
  for (const inst of instruments) {
    const { limits } = limitsFor(keys, inst.attributes);
    const tempUsable = !limitsInverted(limits.temperatureHigh, limits.temperatureLow)
      && (limits.temperatureHigh !== null || limits.temperatureLow !== null);
    const rhUsable = !limitsInverted(limits.humidityHigh, limits.humidityLow)
      && (limits.humidityHigh !== null || limits.humidityLow !== null);
    if (tempUsable || rhUsable) continue;
    count += 1;
    if (codes.length < CODE_CAP) codes.push(inst.code);
  }
  return { count, codes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/alarms/__tests__/without-limits.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Widen the route schemas**

In `apps/api/src/modules/alarms/routes.ts`, in `alarmProps`, change `ruleId` and add three properties:

```ts
  ruleId: { type: 'string', nullable: true },
  source: { type: 'string' },
  limitKind: { type: 'string', nullable: true },
  clearedValue: { type: 'number', nullable: true },
```

Fastify strips response properties not declared in the schema, so omitting these would silently drop them from the payload and the page would render blank cells with nothing to explain why.

In the `/summary` route, add to the response schema properties:

```ts
            instrumentsWithoutLimits: { type: 'integer' },
            instrumentsWithoutLimitsCodes: { type: 'array', items: { type: 'string' } },
```

and extend the handler body, after the existing `Promise.all`:

```ts
    // Same visibility filter as the counts above, so the page cannot name an
    // instrument the caller is not allowed to see.
    const cfg = await loadLimitConfig();
    const visibleInstruments = await prisma.instrument.findMany({
      where: visibility ?? {},
      select: { code: true, attributes: { select: { key: true, value: true } } },
    });
    const without = countWithoutLimits(
      visibleInstruments.map((i) => ({ code: i.code, attributes: i.attributes })),
      cfg.keys,
    );

    return {
      active, unacknowledged, critical,
      instrumentsWithoutLimits: without.count,
      instrumentsWithoutLimitsCodes: without.codes,
    };
```

Add the import at the top of the file:

```ts
import { loadLimitConfig, countWithoutLimits } from './load-limits.js';
```

- [ ] **Step 6: Verify end to end against the live database**

Restart the API, then:

```bash
# Set limits on a real instrument and confirm the summary notices.
PGPASSWORD=digilog123 psql -U digilog -h localhost -d compliance_core_db -c \
  "SELECT count(*) FROM instruments;"
curl -sk --ssl-revoke-best-effort https://localhost:3001/api/alarms/summary \
  -H "Authorization: Bearer $TOKEN" | python -m json.tool
```
Expected: JSON containing `instrumentsWithoutLimits` with a number matching the count of instruments lacking usable limits (20 instruments exist; most have no limit attributes).

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/modules/alarms/routes.ts apps/api/src/modules/alarms/load-limits.ts apps/api/src/modules/alarms/__tests__/without-limits.test.ts
git commit -m "feat(api): expose alarm source/limitKind/clearedValue and the no-limits count

Fastify strips undeclared response properties, so the schema had to be widened or
the new columns would arrive as blank cells with nothing explaining why.

instrumentsWithoutLimits stops an empty alarms page meaning both 'all in spec'
and 'nothing is being watched'."
```

---

### Task 7: Web — status texts, new columns, no-limits banner

**Files:**
- Modify: `apps/web/src/routes/alarms/alarm-display.ts`
- Modify: `apps/web/src/routes/alarms/index.tsx`
- Modify: `apps/web/src/routes/alarms/__tests__/alarm-display.test.ts`

**Interfaces:**
- Consumes: `ALARM_STATUS_TEXT_DEFAULT` (Task 1); the API fields from Task 6.
- Produces:
  - `interface AlarmStatusTexts { activeUnack: string; activeAck: string; clearedUnack: string; clearedAck: string }`
  - `function statusText(a: Pick<AlarmRow, 'state' | 'acknowledgedAt'>, texts?: Partial<AlarmStatusTexts>): string`
  - `function alarmTypeText(a: AlarmRow): string`
  - `function limitText(a: AlarmRow): string`
  - `AlarmRow` gains `source?: string`, `limitKind?: string | null`, `clearedValue?: number | null`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/routes/alarms/__tests__/alarm-display.test.ts`:

```ts
import { statusText, alarmTypeText, limitText, type AlarmRow } from '../alarm-display';

const base: AlarmRow = {
  id: 'a1', instrumentCode: 'CWH-01', instrumentId: 'i1',
  metric: 'TEMPERATURE', triggeredValue: 26.4, severity: 'CRITICAL',
  state: 'ACTIVE', raisedAt: '2026-08-17T09:00:00Z', clearedAt: null,
  acknowledgedAt: null, acknowledgedBy: null, acknowledgeReason: null,
  source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH', clearedValue: null,
  ruleSnapshot: { limit: 25, metric: 'TEMPERATURE', limitKind: 'HIGH', description: 'temperature above 25' },
};

describe('statusText', () => {
  it('covers all four combinations of condition and signature', () => {
    expect(statusText({ state: 'ACTIVE', acknowledgedAt: null })).toBe('Still pending Unacknowledged');
    expect(statusText({ state: 'ACTIVE', acknowledgedAt: '2026-08-17T10:00:00Z' })).toBe('Active — Acknowledged');
    expect(statusText({ state: 'CLEARED', acknowledgedAt: null })).toBe('Cleared — Unacknowledged');
    expect(statusText({ state: 'CLEARED', acknowledgedAt: '2026-08-17T10:00:00Z' })).toBe('Cleared');
  });

  it('never lets cleared-unacknowledged read as finished', () => {
    // The overnight excursion nobody answered for must not look like Cleared.
    expect(statusText({ state: 'CLEARED', acknowledgedAt: null }))
      .not.toBe(statusText({ state: 'CLEARED', acknowledgedAt: 'x' }));
  });

  it('uses the configured wording when provided', () => {
    expect(statusText({ state: 'ACTIVE', acknowledgedAt: null }, { activeUnack: 'OPEN' })).toBe('OPEN');
  });

  it('falls back to the default when a configured text is blank', () => {
    // A blank setting must not render an empty status cell.
    expect(statusText({ state: 'ACTIVE', acknowledgedAt: null }, { activeUnack: '   ' }))
      .toBe('Still pending Unacknowledged');
  });
});

describe('alarmTypeText', () => {
  it('names the bound for a limit alarm', () => {
    expect(alarmTypeText(base)).toBe('High Temperature');
    expect(alarmTypeText({ ...base, metric: 'HUMIDITY', limitKind: 'LOW' })).toBe('Low Humidity');
  });

  it('falls back to the rule name for a rule alarm', () => {
    expect(alarmTypeText({ ...base, source: 'RULE', limitKind: null, ruleSnapshot: { name: 'Cold room' } }))
      .toBe('Cold room');
  });
});

describe('limitText', () => {
  it('reads the FROZEN limit, never the live attribute', () => {
    expect(limitText(base)).toBe('> 25');
    expect(limitText({ ...base, limitKind: 'LOW', ruleSnapshot: { limit: 18 } })).toBe('< 18');
  });

  it('renders an em dash when the snapshot carries no limit', () => {
    expect(limitText({ ...base, ruleSnapshot: {} })).toBe('—');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/routes/alarms/__tests__/alarm-display.test.ts`
Expected: FAIL — `statusText` is not exported

- [ ] **Step 3: Implement the display helpers**

In `apps/web/src/routes/alarms/alarm-display.ts`, extend `AlarmRow`:

```ts
  source?: string;
  limitKind?: string | null;
  clearedValue?: number | null;
```

and widen the `ruleSnapshot` type to `{ name?: string; description?: string; limit?: number; metric?: string; limitKind?: string } | null`.

Then append:

```ts
import { ALARM_STATUS_TEXT_DEFAULT } from '@digilog/shared';

export interface AlarmStatusTexts {
  activeUnack: string;
  activeAck: string;
  clearedUnack: string;
  clearedAck: string;
}

/**
 * The status cell.
 *
 * Two INDEPENDENT axes: the condition (still breaching / ended) and the signature
 * (signed / not). Four combinations, each separately worded, because
 * "Cleared — Unacknowledged" must never collapse into "Cleared" — that is the
 * overnight excursion nobody answered for, and it is not finished.
 *
 * A blank configured text falls back to the default rather than rendering an empty
 * cell: an admin clearing a field must not be able to make a status invisible.
 */
export function statusText(
  a: Pick<AlarmRow, 'state' | 'acknowledgedAt'>,
  texts?: Partial<AlarmStatusTexts>,
): string {
  const pick = (configured: string | undefined, fallback: string) =>
    configured && configured.trim() ? configured.trim() : fallback;

  const acked = Boolean(a.acknowledgedAt);
  if (a.state === 'ACTIVE') {
    return acked
      ? pick(texts?.activeAck, ALARM_STATUS_TEXT_DEFAULT.activeAck)
      : pick(texts?.activeUnack, ALARM_STATUS_TEXT_DEFAULT.activeUnack);
  }
  return acked
    ? pick(texts?.clearedAck, ALARM_STATUS_TEXT_DEFAULT.clearedAck)
    : pick(texts?.clearedUnack, ALARM_STATUS_TEXT_DEFAULT.clearedUnack);
}

const METRIC_WORD: Record<string, string> = { TEMPERATURE: 'Temperature', HUMIDITY: 'Humidity' };

/** `High Temperature` for a limit alarm; the rule's name for a rule alarm. */
export function alarmTypeText(a: AlarmRow): string {
  if (a.source === 'INSTRUMENT_LIMIT' && a.limitKind) {
    const kind = a.limitKind === 'HIGH' ? 'High' : 'Low';
    return `${kind} ${METRIC_WORD[a.metric] ?? a.metric}`;
  }
  return a.ruleSnapshot?.name || conditionText(a);
}

/**
 * The limit this alarm fired against, from the FROZEN snapshot.
 *
 * Never the live attribute: changing an instrument's limit today must not rewrite
 * what a historical alarm says it breached.
 */
export function limitText(a: AlarmRow): string {
  const limit = a.ruleSnapshot?.limit;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return '—';
  const kind = a.limitKind ?? a.ruleSnapshot?.limitKind;
  return `${kind === 'LOW' ? '<' : '>'} ${limit}`;
}

/** The reading that brought it back in spec. 0 is a real reading. */
export function clearedText(a: AlarmRow): string {
  return typeof a.clearedValue === 'number' && Number.isFinite(a.clearedValue)
    ? String(a.clearedValue)
    : '—';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/routes/alarms/__tests__/alarm-display.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the page**

In `apps/web/src/routes/alarms/index.tsx`:

Add to the imports from `./alarm-display`: `statusText, alarmTypeText, limitText, clearedText, type AlarmStatusTexts`.

Fetch the configured texts beside the existing SWR calls:

```tsx
  // `/api/config/dynamic/<key>` returns a FLAT settings object — the same endpoint
  // and shape `use-telemetry.ts:41` reads for telemetry-slots. There is NO generic
  // `/current` route; those are hand-registered per module and alarm-limits has none.
  const { data: limitCfg } = useSWR<Record<string, string | number | boolean>>(
    '/api/config/dynamic/alarm-limits',
  );
  const asText = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const statusTexts: Partial<AlarmStatusTexts> = {
    activeUnack: asText(limitCfg?.statusActiveUnack),
    activeAck: asText(limitCfg?.statusActiveAck),
    clearedUnack: asText(limitCfg?.statusClearedUnack),
    clearedAck: asText(limitCfg?.statusClearedAck),
  };
```

Replace the `<thead>` row with the requested column order:

```tsx
            <tr>
              <th className="px-4 py-3">Instrument</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Raised</th>
              <th className="px-4 py-3">Value</th>
              <th className="px-4 py-3">Limit</th>
              <th className="px-4 py-3">Cleared</th>
              <th className="px-4 py-3">Cleared value</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Acknowledged</th>
              <th className="px-4 py-3" />
            </tr>
```

Replace the body row with:

```tsx
              <tr key={a.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-900">{instrumentLabel(a)}</td>
                <td className="px-4 py-3 text-slate-700">{alarmTypeText(a)}</td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-600">{formatDateTime(a.raisedAt)}</td>
                <td className="px-4 py-3 tabular-nums text-slate-900">{triggeredText(a)}</td>
                <td className="px-4 py-3 tabular-nums text-slate-600">{limitText(a)}</td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                  {a.clearedAt ? formatDateTime(a.clearedAt) : <span className="font-medium text-amber-700">—</span>}
                </td>
                <td className="px-4 py-3 tabular-nums text-slate-600">{clearedText(a)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${severityTone(a.severity)}`}>
                    {statusText(a, statusTexts)}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {a.acknowledgedAt ? (
                    <span title={a.acknowledgeReason ?? undefined} className="text-slate-700">
                      {a.acknowledgedBy} · {formatDateTime(a.acknowledgedAt)}
                    </span>
                  ) : (
                    <span className="font-medium text-red-700">Awaiting</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {needsAcknowledgement(a) && can('alarms.acknowledge') && (
                    <Button size="sm" variant="outline" onClick={() => { setDialogError(''); setTarget(a); }}>
                      Acknowledge
                    </Button>
                  )}
                </td>
              </tr>
```

Update BOTH `colSpan={8}` occurrences (loading row and empty row) to `colSpan={10}`.

Add the no-limits banner immediately above the table container:

```tsx
      {(summary?.instrumentsWithoutLimits ?? 0) > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>{summary?.instrumentsWithoutLimits}</strong> instrument
          {summary?.instrumentsWithoutLimits === 1 ? ' has' : 's have'} no usable limits set — no
          limit alarm can be raised for {summary?.instrumentsWithoutLimits === 1 ? 'it' : 'them'}.
          <span className="ml-1 text-amber-800">
            {(summary?.instrumentsWithoutLimitsCodes ?? []).join(', ')}
          </span>
        </div>
      )}
```

**`limitAlarmsEnabled` (added in Task 6 review).** The count and the master switch are
two different facts and the banner must not conflate them. When
`limitAlarmsEnabled === false`, say that limit alarms are turned off and link to
Configuration → Instrument Limit Alarms — do NOT report every instrument as unwatched,
which would send the operator to set limits when the actual fix is a switch. When it is
true, the existing no-limits sentence applies. Both states are real and distinct:

```tsx
      {limitAlarmsEnabled === false && (
        <div className="mb-3 rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Limit alarms are turned off, so no instrument limits are being checked.
          Turn them on in Configuration → Instrument Limit Alarms.
        </div>
      )}
```

Extend the summary SWR type to include the new fields (`instrumentsWithoutLimits`,
`instrumentsWithoutLimitsCodes`, `limitAlarmsEnabled`):

```tsx
  const { data: summary, mutate: mutateSummary } = useSWR<{
    active: number; unacknowledged: number; critical: number;
    instrumentsWithoutLimits?: number; instrumentsWithoutLimitsCodes?: string[];
  }>('/api/alarms/summary');
```

- [ ] **Step 6: Verify the config endpoint shape before trusting it**

Confirm the payload rather than assuming it:

```bash
curl -sk --ssl-revoke-best-effort https://localhost:3001/api/config/dynamic/alarm-limits \
  -H "Authorization: Bearer $TOKEN" | python -m json.tool
```
Expected: a FLAT object of the ten setting keys, e.g. `{"enabled": true, "severity": "CRITICAL", "statusActiveUnack": "Still pending Unacknowledged", ...}`. **If it differs, fix the accessor in Step 5 to match the real payload** — do not leave a guess in the code.

- [ ] **Step 7: Full verification**

```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vite build
cd ../.. && npm test -w apps/web
```
Expected: tsc exits 0; build succeeds; all web tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/routes/alarms/
git commit -m "feat(web): alarm columns for limit, cleared value, configurable status

Status is the product of two independent axes — condition and signature — so all
four wordings are separately configurable. A blank setting falls back to the
default rather than rendering an empty cell.

The limit column reads the FROZEN snapshot, never the live attribute."
```

---

### Task 8: End-to-end proof

**Files:**
- Create: `apps/api/src/e2e/instrument-limit-alarms.e2e.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the e2e test**

Create `apps/api/src/e2e/instrument-limit-alarms.e2e.test.ts`, following the structure of the existing `alarm-rules.e2e.test.ts` (read it first for the `buildApp` / `loginAs` helpers):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { evaluateAlarms } from '../workers/alarm-evaluation.worker.js';

describe('instrument-limit alarms (e2e)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  let instrumentId: string;
  const code = `LIMIT-E2E-${Date.now()}`;

  beforeAll(async () => {
    app = await buildApp();
    token = await loginAs(app, 'superadmin');

    const profile = await prisma.instrumentProfile.findFirst();
    const inst = await prisma.instrument.create({
      data: { code, name: 'Limit e2e probe', profileId: profile!.id, isActive: true },
    });
    instrumentId = inst.id;

    await prisma.instrumentAttribute.createMany({
      data: [
        { instrumentId, key: 'High Temperature Limit', value: '25' },
        { instrumentId, key: 'Low Temperature Limit', value: '18' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.alarm.deleteMany({ where: { instrumentId } });
    await prisma.instrumentAttribute.deleteMany({ where: { instrumentId } });
    await prisma.instrument.delete({ where: { id: instrumentId } });
    await app.close();
  });

  async function pushReading(value: number) {
    await prisma.instrumentTelemetryLatest.upsert({
      where: { instrumentId_key: { instrumentId, key: 'temperature' } },
      // `valueType` is REQUIRED and `value` is Json — omitting valueType fails the
      // insert, and a non-numeric Json value is ignored by asNumber() downstream.
      create: { instrumentId, key: 'temperature', value, valueType: 'number', ts: new Date() },
      update: { value, valueType: 'number', ts: new Date() },
    });
    await prisma.instrument.update({ where: { id: instrumentId }, data: { lastSeenAt: new Date() } });
  }

  it('raises exactly one HIGH alarm with the frozen limit', async () => {
    await pushReading(26.4);
    await evaluateAlarms();

    const alarms = await prisma.alarm.findMany({ where: { instrumentId } });
    expect(alarms).toHaveLength(1);
    expect(alarms[0].source).toBe('INSTRUMENT_LIMIT');
    expect(alarms[0].limitKind).toBe('HIGH');
    expect(alarms[0].ruleId).toBeNull();
    expect(alarms[0].triggeredValue).toBe(26.4);
    expect((alarms[0].ruleSnapshot as Record<string, unknown>).limit).toBe(25);
  });

  it('does not raise a second alarm while still breaching', async () => {
    await pushReading(27.0);
    await evaluateAlarms();
    expect(await prisma.alarm.count({ where: { instrumentId } })).toBe(1);
  });

  it('clears with the value that brought it back in spec, leaving acknowledgement alone', async () => {
    await pushReading(22.0);
    await evaluateAlarms();

    const alarm = await prisma.alarm.findFirstOrThrow({ where: { instrumentId } });
    expect(alarm.state).toBe('CLEARED');
    expect(alarm.clearedValue).toBe(22.0);
    expect(alarm.acknowledgedAt).toBeNull();
  });

  it('reports the frozen limit through the API even after the attribute changes', async () => {
    await prisma.instrumentAttribute.updateMany({
      where: { instrumentId, key: 'High Temperature Limit' },
      data: { value: '99' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/alarms?instrumentId=${instrumentId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().data[0];
    // The snapshot answers "why did this fire at 25?", not the live attribute.
    expect(row.ruleSnapshot.limit).toBe(25);
    expect(row.limitKind).toBe('HIGH');
    expect(row.clearedValue).toBe(22.0);
  });
});
```

- [ ] **Step 2: Run it**

Run:
```bash
cd apps/api && DATABASE_URL="postgresql://digilog:digilog123@localhost:5432/compliance_core_db_test?schema=public" npx vitest run src/e2e/instrument-limit-alarms.e2e.test.ts
```
Expected: 4 tests pass. A 500 here means the migration was not applied to the test database — go back to Task 3 Step 3.

- [ ] **Step 3: Run the FULL suite**

```bash
npm test -w apps/api && npm test -w apps/web && npm test -w @digilog/shared
npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/web/tsconfig.json
```
Expected: everything passes; both typechecks exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/e2e/instrument-limit-alarms.e2e.test.ts
git commit -m "test(e2e): instrument-limit alarms raise, hold, clear and stay frozen

The last case is the one that matters for 21 CFR: changing the attribute to 99
must not change what the historical alarm says it breached."
```

---

### Task 9: Documentation sync

**Files:**
- Modify: `CHANGELOG.md` (new entry at the top)
- Modify: `CLAUDE.md` (System Stats — Prisma enums 11 → 13; Config defs 24 → 25)
- Modify: `apps/web/CLAUDE.md` (config files count in `routes/config/`)
- Modify: `packages/shared/CLAUDE.md` (line 19, `types/` file count)
- Modify: `apps/api/CLAUDE.md` (line 48 — see the correction below)
- Modify: `tasks/todo.md` (audit-log entry)

**Interfaces:** none.

- [ ] **Step 1: Re-derive every count from live code**

Never copy the numbers below on trust — CLAUDE.md's hard rule is that every numerical claim is backed by a command run at the moment the doc is touched:

```bash
grep -cE "^model " apps/api/prisma/schema.prisma
grep -cE "^enum "  apps/api/prisma/schema.prisma
ls apps/api/src/modules/config/defs/*.def.ts | wc -l
grep -cE "^\s+[A-Z_]+:\s*'" packages/shared/src/types/permissions.ts
grep -cE "<Route" apps/web/src/main.tsx
ls packages/shared/src/types/*.ts | grep -v test | wc -l
```
Expected: models unchanged (34), enums 11 → **13**, config defs 24 → **25**, permissions unchanged (42), routes unchanged (49), shared type files → **13**.

**`apps/api/CLAUDE.md:48` is FACTUALLY WRONG and must be corrected.** It says the
baseline `migration.sql` "includes ... a partial unique index that `schema.prisma`
cannot express". It does not: `grep -c "CREATE UNIQUE INDEX.*WHERE"` on that file
returns **0**, and `pg_indexes` shows no partial unique index in either database
before 2026-08-17. The first partial unique index in this repo is
`alarms_active_instrument_limit_unique`, added by
`20260817120000_alarm_limit_unique_active`. Rewrite line 48 to drop the false claim
and cite the real index instead — the sentence's actual point (do not regenerate the
baseline; it carries triggers, functions and sequences the datamodel cannot express)
stands on its remaining examples.

**`packages/shared/CLAUDE.md:19` says "11 files" and was ALREADY WRONG before this
plan** — the real count was 12 when Task 1 started and is 13 now. Correct it to the
verified number and note the prior figure was stale rather than implying this plan
added two files.

- [ ] **Step 2: Run the stale-stat sweep**

Derive a regex from the PREVIOUS numbers and grep the active doc set:

```bash
grep -rnE "11 enums|24 definitions|\b24\b config" --include=*.md . --exclude-dir=node_modules --exclude-dir=old
```
Every match needs updating.

- [ ] **Step 3: Write the CHANGELOG entry**

At the top of `CHANGELOG.md`:

```markdown
## [Unreleased] - Instrument-limit alarms (2026-08-17)

Alarms raised from each instrument's own High/Low Temperature and Humidity Limit
attributes, in addition to the existing rule-driven alarms.

- **`alarm-limits` config** (super admin) — an ORDERED ALIAS LIST per bound saying
  which attribute keys carry the limits, because this install's keys have already
  drifted (`High Temperature`, `Low Temperature` and `Low Temperature Limit` all
  exist). Plus severity, a master switch, and the four status wordings.
- **Schema** — `Alarm.ruleId` nullable, `source` (RULE | INSTRUMENT_LIMIT),
  `limitKind` (HIGH | LOW), `clearedValue`. Enums 11 → 13. Migration
  `20260817090000_instrument_limit_alarms`, hand-authored, drift guard PASS,
  applied to `compliance_core_db_test` as well.
- **Worker** — a second pass in `alarm-evaluation.worker.ts`, reusing
  `buildTelemetryOverview()` so telemetry-key resolution cannot drift from the
  dashboard. Identity is `(instrument, metric, limitKind)`.
- **Alarms page** — Instrument, Type, Raised, Value, Limit, Cleared, Cleared value,
  Status, Acknowledged. The Limit column reads the FROZEN snapshot, never the live
  attribute. A banner names instruments with no usable limits, so an empty page
  cannot mean both "all in spec" and "nothing is being watched".

**Deliberate decisions:** boundaries are IN spec; a blank or non-numeric limit is
NOT zero; an inverted pair fires nothing; room limits still colour the dashboard
and raise nothing.

**No permission, privilege, reauth or sidebar change.**
```

- [ ] **Step 4: Update CLAUDE.md System Stats**

Change the enum count from 11 to 13 naming `AlarmSource` and `AlarmLimitKind`, and the config-def count from 24 to 25 naming `alarm-limits.def.ts`. Both with the 2026-08-17 verification date.

- [ ] **Step 5: Append the todo.md audit entry**

```markdown
## 2026-08-17 — Instrument-limit alarms

Spec `docs/superpowers/specs/2026-08-17-instrument-limit-alarms-design.md`, plan
`docs/superpowers/plans/2026-08-17-instrument-limit-alarms.md`. Shared parsing,
`alarm-limits` config, schema (enums 11 → 13), worker pass, API fields, page
columns, e2e.

Verified: unit + e2e green, `tsc --noEmit` clean on api and web, `vite build`
clean, drift guard PASS, migration applied to BOTH databases.

**NOT visually verified** — Chrome on this machine cannot reach loopback or LAN
through the automation extension (MDM policy `LocalNetworkAccessAllowedForUrls`
allowlists only two SharePoint origins; plain HTTP on 127.0.0.1 fails the same
way, so it is not the mkcert cert). The rendered check is the operator's.
```

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md CLAUDE.md apps/web/CLAUDE.md tasks/todo.md
git commit -m "docs: instrument-limit alarms

Counts re-derived from live code: enums 11 -> 13, config defs 24 -> 25; models,
permissions and routes unchanged."
```

---

## Post-implementation: operator verification

The implementer must NOT claim the UI works. Hand the operator this list:

1. **Configuration → Instrument Limit Alarms** — the four key lists, severity, master switch and four status wordings are present and save.
2. Set `High Temperature Limit` = a value just below the current reading on a live instrument; within a minute the alarm appears on **Alarms** with the right Type, Value and Limit.
3. The **Status** column reads `Still pending Unacknowledged`; change that wording in the config and confirm the column follows.
4. Acknowledge it — status becomes `Active — Acknowledged`, and the audit trail carries the signature.
5. Raise the limit back above the reading — the row moves to History with a Cleared time and Cleared value, and the status reads `Cleared` (or `Cleared — Unacknowledged` if never signed).
6. Confirm the amber banner names instruments with no limits.
7. Check the browser console for unexpected responses and look for unstyled elements.
