# Instrument Gateway Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one instrument act as a gateway that reports telemetry on behalf of the instruments linked to it, and record where each instrument physically sits.

**Architecture:** A self-referencing `gatewayId` on `instruments` IS the authorisation rule — a gateway may write instrument X iff `X.gatewayId = gateway.id`. The batch payload shape (`{"devices": {...}}`) that `parsePayload()` already emits and `ingest-routes.ts` currently refuses becomes the gateway wire format. Decision logic lives in a pure module so its four rejection reasons are testable without a database.

**Tech Stack:** Fastify 5, Prisma 6, PostgreSQL 18, React 19 + Vite + SWR, vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-instrument-gateway-model-design.md`

## Global Constraints

- **Migrations are hand-authored.** `prisma migrate dev` auto-generation and `prisma db push` are FORBIDDEN against a populated DB. Write SQL into `apps/api/prisma/migrations/<UTC-timestamp>_<name>/migration.sql`, then `npm run db:verify-migrations` (must PASS) and `npx prisma migrate resolve --applied <name>` on existing DBs.
- **Always pass `DATABASE_URL` explicitly:** `postgresql://digilog:digilog123@localhost:5432/compliance_core_db?schema=public`. Three `.env` files exist and the repo-root one has historically pointed at a sibling checkout.
- **Run the API suite single-fork only:** `cd apps/api && npm test`. **Baseline: 14 pre-existing failures in 5 files** (`auth-profile-reauth`, `entities`, `replacement-audit-enrichment`, `super-admin-unretire`, `block-change-approval-current`). Do not "fix" those.
- **Rebuild shared after editing it:** `npm run build -w @digilog/shared`.
- **vitest never typechecks.** Every task must also pass `npx tsc -p apps/api/tsconfig.json --noEmit` and, for web changes, `cd apps/web && npx tsc -p tsconfig.json --noEmit`.
- **App runs on port 3001; web dev server on 5176** (pinned via `WEB_PORT` in `apps/api/.env`). Stop it with `stop-app.bat` before any command that regenerates the Prisma client.
- **A gateway may never be a child and a child may never be a gateway** (spec D2). Enforce in the service layer on every write path.
- **Never auto-create an instrument from a payload.** An unknown code in a batch is dead-lettered, never registered (spec §11).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/prisma/migrations/<ts>_instrument_gateway/migration.sql` | Placement columns, `is_gateway`, `gateway_id` FK, last-seen columns, indexes |
| `apps/api/src/modules/instruments/gateway-fanout.ts` | **Pure.** Device-keyed blocks + child map → readings and dead-letters |
| `apps/api/src/modules/instruments/gateway-children.ts` | `childMapFor(gatewayId)` with TTL cache + invalidation |
| `apps/api/src/modules/instruments/last-seen.ts` | Throttled `stampLastSeen(instrumentIds, via)` |
| `apps/api/src/modules/instruments/ingest-routes.ts` | Replace the batch 400 with the fan-out (flat path unchanged) |
| `apps/api/src/modules/instruments/ingest-auth.ts` | `IngestIdentity` gains `isGateway` |
| `apps/api/src/modules/instruments/routes.ts` | Placement + gateway fields, link/unlink, eligible-children, D6/D7 guards |
| `packages/shared/src/schemas/instruments.ts` | Placement + gateway fields on the Zod schemas |
| `apps/web/src/routes/instruments/gateway-panel.tsx` | Linked Instruments panel (gateway detail page) |
| `apps/web/src/routes/instruments/connection-instructions.tsx` | Gateway batch example; child "via gateway" note |
| `apps/web/src/routes/instruments/{create,detail,list}.tsx` | Placement fields, Is Gateway toggle, filters, panel mount |

---

### Task 1: Schema — placement, gateway link, last-seen

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (the `Instrument` model, ~line 750)
- Create: `apps/api/prisma/migrations/20260805120000_instrument_gateway/migration.sql`

**Interfaces:**
- Produces: `Instrument.{location, area, block, isGateway, gatewayId, lastSeenAt, lastSeenVia}`, relation `GatewayChildren`

- [ ] **Step 1: Add the fields to the Prisma model**

In `apps/api/prisma/schema.prisma`, inside `model Instrument`, after `expectedIntervalSec`:

```prisma
  // Placement — free text by design (spec D8). No lookup tables, no admin
  // screens; `code` remains the unique identifier and the MQTT topic segment.
  location            String?  @map("location")
  area                String?  @map("area")
  block               String?  @map("block")

  // Gateway model. `gatewayId` IS the authorisation rule: a gateway may write
  // instrument X iff X.gatewayId = gateway.id. One comparison, no link table.
  isGateway           Boolean  @default(false) @map("is_gateway")
  gatewayId           String?  @map("gateway_id")

  // Last-seen lives on the INSTRUMENT, not on its credential: a child reported
  // through its gateway never presents its own credential, so a
  // credential-based column would read "Never" for exactly the instruments the
  // gateway feature exists to serve.
  lastSeenAt          DateTime? @map("last_seen_at") @db.Timestamptz(3)
  lastSeenVia         String?   @map("last_seen_via")
```

and add the relations next to `credentials`:

```prisma
  gateway  Instrument?  @relation("GatewayChildren", fields: [gatewayId], references: [id], onDelete: SetNull)
  children Instrument[] @relation("GatewayChildren")
```

and the indexes next to `@@map("instruments")`:

```prisma
  @@index([gatewayId])
  @@index([block, area, location])
```

- [ ] **Step 2: Hand-author the migration**

Create `apps/api/prisma/migrations/20260805120000_instrument_gateway/migration.sql`:

```sql
-- Placement (spec D8) — free text, nullable, no backfill needed.
ALTER TABLE "instruments" ADD COLUMN "location" TEXT;
ALTER TABLE "instruments" ADD COLUMN "area"     TEXT;
ALTER TABLE "instruments" ADD COLUMN "block"    TEXT;

-- Gateway link. ON DELETE SET NULL implements spec D7 at the database level:
-- deleting a gateway unlinks its children, it never deletes them.
ALTER TABLE "instruments" ADD COLUMN "is_gateway" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "instruments" ADD COLUMN "gateway_id" TEXT;
ALTER TABLE "instruments"
  ADD CONSTRAINT "instruments_gateway_id_fkey"
  FOREIGN KEY ("gateway_id") REFERENCES "instruments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- An instrument cannot be its own gateway. The service layer enforces the two
-- richer invariants (a gateway has no parent; only a gateway may be a parent),
-- which a CHECK cannot express because they read another row.
ALTER TABLE "instruments"
  ADD CONSTRAINT "instruments_gateway_not_self" CHECK ("gateway_id" IS DISTINCT FROM "id");

-- Last-seen on the instrument (spec D9).
ALTER TABLE "instruments" ADD COLUMN "last_seen_at"  TIMESTAMPTZ(3);
ALTER TABLE "instruments" ADD COLUMN "last_seen_via" TEXT;

CREATE INDEX "instruments_gateway_id_idx" ON "instruments"("gateway_id");
CREATE INDEX "instruments_block_area_location_idx" ON "instruments"("block", "area", "location");
```

- [ ] **Step 3: Apply, regenerate, verify no drift**

Stop the dev server first — `prisma generate` cannot replace the query engine while a node process holds it open (that is the EPERM failure documented in `scripts/start-app.ps1`).

```bash
stop-app.bat
cd apps/api
DATABASE_URL='postgresql://digilog:digilog123@localhost:5432/compliance_core_db?schema=public' npx prisma migrate resolve --applied 20260805120000_instrument_gateway
DATABASE_URL='postgresql://digilog:digilog123@localhost:5432/compliance_core_db?schema=public' psql -h localhost -U digilog -d compliance_core_db -f prisma/migrations/20260805120000_instrument_gateway/migration.sql
npx prisma generate
cd ../.. && npm run db:verify-migrations
```

Expected: drift guard PASS.

- [ ] **Step 4: Prove the self-reference constraint holds**

```bash
PGPASSWORD=digilog123 psql -h localhost -U digilog -d compliance_core_db \
  -c "UPDATE instruments SET gateway_id = id WHERE id = (SELECT id FROM instruments LIMIT 1);"
```

Expected: `ERROR: new row for relation "instruments" violates check constraint "instruments_gateway_not_self"`. If there are no instruments, create one via the UI first — an unexercised constraint is an unverified one.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260805120000_instrument_gateway/
git commit -m "feat(db): instrument placement, gateway link and instrument-level last-seen"
```

---

### Task 2: Pure fan-out — device blocks to readings and dead-letters

**Files:**
- Create: `apps/api/src/modules/instruments/gateway-fanout.ts`
- Test: `apps/api/src/modules/instruments/__tests__/gateway-fanout.test.ts`

**Interfaces:**
- Consumes: `Reading`, `classifyValue`, `toReadings` from `./payload-parser.js`
- Produces:
  ```ts
  export interface ChildRef { id: string; isActive: boolean }
  export type ChildMap = Map<string, ChildRef>;   // key: instrument.code
  export interface FanoutResult {
    readings: (Reading & { instrumentId: string })[];
    rejected: { code: string; reason: string }[];
  }
  export function fanoutDevices(
    devices: Record<string, unknown>, childMap: ChildMap, ts: Date, gatewayCode: string,
  ): FanoutResult;
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/modules/instruments/__tests__/gateway-fanout.test.ts
import { describe, it, expect } from 'vitest';
import { fanoutDevices, type ChildMap } from '../gateway-fanout.js';

const TS = new Date('2026-08-05T10:00:00Z');
const map: ChildMap = new Map([
  ['SENSOR-A', { id: 'id-a', isActive: true }],
  ['SENSOR-B', { id: 'id-b', isActive: true }],
  ['SENSOR-OFF', { id: 'id-off', isActive: false }],
]);

describe('fanoutDevices', () => {
  it('attributes each block to its own instrument', () => {
    const r = fanoutDevices(
      { 'SENSOR-A': { temperature: 21.5 }, 'SENSOR-B': { humidity: 47 } },
      map, TS, 'GW-1',
    );
    expect(r.rejected).toEqual([]);
    expect(r.readings).toEqual([
      { instrumentId: 'id-a', key: 'temperature', value: 21.5, valueType: 'float', ts: TS },
      { instrumentId: 'id-b', key: 'humidity', value: 47, valueType: 'int', ts: TS },
    ]);
  });

  it('rejects a code this gateway does not own, and keeps the rest', () => {
    // Partial success (spec D5): one mistyped code must not discard a
    // 40-sensor payload.
    const r = fanoutDevices(
      { 'SENSOR-A': { temperature: 21.5 }, 'NOT-MINE': { temperature: 9 } },
      map, TS, 'GW-1',
    );
    expect(r.readings).toHaveLength(1);
    expect(r.readings[0].instrumentId).toBe('id-a');
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].code).toBe('NOT-MINE');
    // The reason must name the gateway — otherwise a dead-letter in a fleet of
    // 30 gateways cannot be traced back to the one that sent it.
    expect(r.rejected[0].reason).toMatch(/GW-1/);
  });

  it('rejects an inactive child', () => {
    const r = fanoutDevices({ 'SENSOR-OFF': { temperature: 1 } }, map, TS, 'GW-1');
    expect(r.readings).toEqual([]);
    expect(r.rejected[0].reason).toMatch(/not active/i);
  });

  it('rejects a block that is not an object', () => {
    const r = fanoutDevices({ 'SENSOR-A': 42 }, map, TS, 'GW-1');
    expect(r.readings).toEqual([]);
    expect(r.rejected[0].reason).toMatch(/object/i);
  });

  it('honours a per-block timestamp over the envelope one', () => {
    const own = '2026-08-05T09:00:00Z';
    const r = fanoutDevices({ 'SENSOR-A': { ts: own, temperature: 5 } }, map, TS, 'GW-1');
    expect(r.readings).toHaveLength(1);
    expect(r.readings[0].ts.toISOString()).toBe(new Date(own).toISOString());
  });

  it('returns nothing for an empty devices map', () => {
    expect(fanoutDevices({}, map, TS, 'GW-1')).toEqual({ readings: [], rejected: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/gateway-fanout.test.ts`
Expected: FAIL — cannot resolve `../gateway-fanout.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/modules/instruments/gateway-fanout.ts
/**
 * Gateway fan-out — PURE. No database, no I/O.
 *
 * Splits a device-keyed batch payload into per-child readings, applying the one
 * authorisation rule this feature exists for: a gateway may write instrument X
 * iff X is in its child map. Everything else is dead-lettered rather than
 * silently dropped, and never auto-created — a registry that grows itself from
 * payloads cannot be trusted as a §11 record.
 */
import { toReadings, type Reading } from './payload-parser.js';

export interface ChildRef { id: string; isActive: boolean }
/** code → child. The gateway's OWN code is deliberately absent. */
export type ChildMap = Map<string, ChildRef>;

export interface FanoutResult {
  readings: (Reading & { instrumentId: string })[];
  rejected: { code: string; reason: string }[];
}

/** Reserved keys inside a per-device block (mirrors payload-parser's META_KEYS). */
const BLOCK_META = new Set(['ts', 'timestamp', 'quality']);

export function fanoutDevices(
  devices: Record<string, unknown>,
  childMap: ChildMap,
  ts: Date,
  gatewayCode: string,
): FanoutResult {
  const readings: FanoutResult['readings'] = [];
  const rejected: FanoutResult['rejected'] = [];

  for (const [code, block] of Object.entries(devices)) {
    const child = childMap.get(code);
    if (!child) {
      rejected.push({
        code,
        reason: `"${code}" is not linked to gateway "${gatewayCode}" (unknown or linked elsewhere)`,
      });
      continue;
    }
    if (!child.isActive) {
      rejected.push({ code, reason: `Instrument "${code}" is not active` });
      continue;
    }
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      rejected.push({ code, reason: `Block for "${code}" must be a JSON object` });
      continue;
    }

    const obj = block as Record<string, unknown>;
    // A per-block timestamp wins: the gateway may be forwarding a reading it
    // buffered minutes ago, and stamping it with the envelope time would
    // silently rewrite when it was measured.
    let blockTs = ts;
    const rawTs = obj.ts ?? obj.timestamp;
    if (typeof rawTs === 'string' || typeof rawTs === 'number') {
      const d = new Date(rawTs);
      if (!Number.isNaN(d.getTime())) blockTs = d;
    }

    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (!BLOCK_META.has(k)) values[k] = v;

    for (const r of toReadings(values, blockTs)) {
      readings.push({ ...r, instrumentId: child.id });
    }
  }

  return { readings, rejected };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/gateway-fanout.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc -p apps/api/tsconfig.json --noEmit
git add apps/api/src/modules/instruments/gateway-fanout.ts apps/api/src/modules/instruments/__tests__/gateway-fanout.test.ts
git commit -m "feat(instruments): pure gateway fan-out with per-block authorisation"
```

---

### Task 3: Child-map resolver with TTL cache

**Files:**
- Create: `apps/api/src/modules/instruments/gateway-children.ts`
- Test: `apps/api/src/modules/instruments/__tests__/gateway-children.test.ts`

**Interfaces:**
- Consumes: `ChildMap` from `./gateway-fanout.js`
- Produces: `childMapFor(gatewayId: string): Promise<ChildMap>`, `invalidateChildMapCache(gatewayId?: string): void`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/modules/instruments/__tests__/gateway-children.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
vi.mock('../../../lib/prisma.js', () => ({
  prisma: { instrument: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

import { childMapFor, invalidateChildMapCache } from '../gateway-children.js';

beforeEach(() => { findMany.mockReset(); invalidateChildMapCache(); });

describe('childMapFor', () => {
  it('maps code -> {id, isActive}', async () => {
    findMany.mockResolvedValue([{ id: 'id-a', code: 'SENSOR-A', isActive: true }]);
    const map = await childMapFor('gw-1');
    expect(map.get('SENSOR-A')).toEqual({ id: 'id-a', isActive: true });
  });

  it('queries only this gateway\'s children', async () => {
    findMany.mockResolvedValue([]);
    await childMapFor('gw-1');
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { gatewayId: 'gw-1' } });
  });

  it('caches within the TTL', async () => {
    findMany.mockResolvedValue([]);
    await childMapFor('gw-1');
    await childMapFor('gw-1');
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('re-queries after invalidation — an unlinked child must stop being writable', async () => {
    findMany.mockResolvedValue([]);
    await childMapFor('gw-1');
    invalidateChildMapCache('gw-1');
    await childMapFor('gw-1');
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('invalidating one gateway does not clear another', async () => {
    findMany.mockResolvedValue([]);
    await childMapFor('gw-1');
    await childMapFor('gw-2');
    invalidateChildMapCache('gw-1');
    await childMapFor('gw-2');
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/gateway-children.test.ts`
Expected: FAIL — cannot resolve `../gateway-children.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/modules/instruments/gateway-children.ts
import { prisma } from '../../lib/prisma.js';
import type { ChildMap } from './gateway-fanout.js';

// Same 10s window as ingest-auth: a gateway posting every second must not cost
// a query per reading. The TTL is also the worst case before an unlink takes
// effect, which is why link/unlink invalidates explicitly rather than waiting.
const TTL_MS = 10_000;
const cache = new Map<string, { map: ChildMap; at: number }>();

export function invalidateChildMapCache(gatewayId?: string): void {
  if (!gatewayId) { cache.clear(); return; }
  cache.delete(gatewayId);
}

export async function childMapFor(gatewayId: string): Promise<ChildMap> {
  const hit = cache.get(gatewayId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.map;

  const rows = await prisma.instrument.findMany({
    where: { gatewayId },
    select: { id: true, code: true, isActive: true },
  });
  const map: ChildMap = new Map(rows.map((r) => [r.code, { id: r.id, isActive: r.isActive }]));
  cache.set(gatewayId, { map, at: Date.now() });
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/gateway-children.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/instruments/gateway-children.ts apps/api/src/modules/instruments/__tests__/gateway-children.test.ts
git commit -m "feat(instruments): cached gateway child-map resolver"
```

---

### Task 4: Instrument-level last-seen

**Files:**
- Create: `apps/api/src/modules/instruments/last-seen.ts`
- Test: `apps/api/src/modules/instruments/__tests__/last-seen.test.ts`

**Interfaces:**
- Produces: `stampLastSeen(instrumentIds: string[], via: 'direct' | 'gateway'): Promise<void>`, `resetLastSeenThrottle(): void`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/modules/instruments/__tests__/last-seen.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateMany = vi.fn();
vi.mock('../../../lib/prisma.js', () => ({
  prisma: { instrument: { updateMany: (...a: unknown[]) => updateMany(...a) } },
}));

import { stampLastSeen, resetLastSeenThrottle } from '../last-seen.js';

beforeEach(() => { updateMany.mockReset(); updateMany.mockResolvedValue({ count: 1 }); resetLastSeenThrottle(); });

describe('stampLastSeen', () => {
  it('records who reported and how', async () => {
    await stampLastSeen(['id-a'], 'gateway');
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['id-a'] } },
      data: { lastSeenVia: 'gateway' },
    });
  });

  it('throttles repeats within the window', async () => {
    await stampLastSeen(['id-a'], 'direct');
    await stampLastSeen(['id-a'], 'direct');
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('does not throttle a different instrument', async () => {
    await stampLastSeen(['id-a'], 'direct');
    await stampLastSeen(['id-b'], 'direct');
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it('stamps immediately when the source changes — direct vs gateway is the point', async () => {
    await stampLastSeen(['id-a'], 'direct');
    await stampLastSeen(['id-a'], 'gateway');
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it('is a no-op for an empty list', async () => {
    await stampLastSeen([], 'direct');
    expect(updateMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/last-seen.test.ts`
Expected: FAIL — cannot resolve `../last-seen.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/api/src/modules/instruments/last-seen.ts
import { prisma } from '../../lib/prisma.js';

/**
 * Last-seen lives on the instrument, not on its credential (spec D9). A child
 * reported through its gateway never presents its own credential, so a
 * credential-based column reads "Never" for precisely the instruments the
 * gateway feature exists to serve.
 */
const WINDOW_MS = 10_000;
const lastStamped = new Map<string, { at: number; via: string }>();

/** Test seam. Never call from production code. */
export function resetLastSeenThrottle(): void { lastStamped.clear(); }

export async function stampLastSeen(
  instrumentIds: string[],
  via: 'direct' | 'gateway',
): Promise<void> {
  const now = Date.now();
  // A source change is stamped immediately even inside the window: "is this
  // device reporting directly or through its gateway?" is the question this
  // column exists to answer, and a stale answer is worse than none.
  const due = instrumentIds.filter((id) => {
    const prev = lastStamped.get(id);
    return !prev || prev.via !== via || now - prev.at >= WINDOW_MS;
  });
  if (due.length === 0) return;

  for (const id of due) lastStamped.set(id, { at: now, via });
  await prisma.instrument.updateMany({
    where: { id: { in: due } },
    data: { lastSeenAt: new Date(now), lastSeenVia: via },
  }).catch(() => {
    // Never fail an accepted reading over a telemetry-about-telemetry write.
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/last-seen.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/instruments/last-seen.ts apps/api/src/modules/instruments/__tests__/last-seen.test.ts
git commit -m "feat(instruments): throttled instrument-level last-seen with source"
```

---

### Task 5: Wire the fan-out into HTTP ingest

**Files:**
- Modify: `apps/api/src/modules/instruments/ingest-auth.ts` (add `isGateway` to `IngestIdentity`)
- Modify: `apps/api/src/modules/instruments/ingest-routes.ts:70-80` (replace the batch 400)
- Modify: `apps/api/src/modules/instruments/__tests__/ingest-auth.test.ts` (fixture gains `isGateway`)
- Test: `apps/api/src/e2e/gateway-ingest.test.ts`

**Interfaces:**
- Consumes: `fanoutDevices`, `childMapFor`, `stampLastSeen`
- Produces: `POST /api/ingest/v1/telemetry` accepting `{"devices": {...}}` from a gateway token, responding `{ accepted, rejected }`

- [ ] **Step 1: Add `isGateway` to the resolved identity**

In `ingest-auth.ts`, extend the interface and the select:

```typescript
export interface IngestIdentity { id: string; code: string; transport: string; isGateway: boolean }
```

and where the identity is built from `r.instrument`:

```typescript
    identity = {
      id: r.instrument.id, code: r.instrument.code,
      transport: r.instrument.transport, isGateway: r.instrument.isGateway,
    };
```

In `__tests__/ingest-auth.test.ts`, add `isGateway: false` to the `instrument` object inside the `row()` helper.

- [ ] **Step 2: Replace the batch rejection with the fan-out**

In `ingest-routes.ts`, replace the whole `if (parsed.devices) { … }` block (currently the dead-letter + `400 UNSUPPORTED_BATCH_PAYLOAD`) with:

```typescript
    if (parsed.devices) {
      // A batch payload is device-keyed data for OTHER instruments. Only a
      // gateway may send one, and only for the instruments linked to it.
      if (!identity.isGateway) {
        await writeDeadLetters([{
          id: randomUUID(), instrumentId: identity.id, transport: 'http',
          reason: 'Batch (devices) payload from an instrument that is not configured as a gateway',
          rawPayload: raw.toString('utf8').slice(0, 4000),
        }]);
        return reply.code(400).send({
          error: 'NOT_A_GATEWAY',
          message: `Instrument "${identity.code}" is not configured as a gateway, so it cannot report for other instruments. Enable "Is Gateway" on it and link the instruments it reports for.`,
        });
      }

      const childMap = await childMapFor(identity.id);
      const { readings, rejected } = fanoutDevices(parsed.devices, childMap, ts, identity.code);

      if (rejected.length > 0) {
        // Attributed to the GATEWAY: the named child either does not exist or
        // is not ours, so filing it against that child would be a claim we
        // cannot make.
        await writeDeadLetters(rejected.map((r) => ({
          id: randomUUID(), instrumentId: identity.id, transport: 'http',
          reason: r.reason, rawPayload: raw.toString('utf8').slice(0, 4000),
        })));
      }

      if (readings.length > 0) {
        await writeBatch(readings);
        await stampLastSeen([...new Set(readings.map((r) => r.instrumentId))], 'gateway');
      }

      // 200, not 207: the request was handled correctly and every accepted
      // reading is stored. `rejected` tells an integrator about partial
      // failure without making them read the dead-letter table.
      return reply.send({ accepted: readings.length, rejected: rejected.length });
    }
```

Add the imports at the top of the file:

```typescript
import { fanoutDevices } from './gateway-fanout.js';
import { childMapFor } from './gateway-children.js';
import { stampLastSeen } from './last-seen.js';
```

Add `rejected` to the 200 response schema:

```typescript
        200: { type: 'object', properties: { accepted: { type: 'integer' }, rejected: { type: 'integer' } } },
```

And on the flat path, immediately after the existing `await writeBatch(...)`:

```typescript
    await stampLastSeen([identity.id], 'direct');
```

- [ ] **Step 3: Write the e2e test**

```typescript
// apps/api/src/e2e/gateway-ingest.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let auth: Record<string, string>;
const created: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});
afterAll(async () => {
  for (const id of created) await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  await app.close();
});

async function mk(payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/api/instruments', headers: auth, payload });
  expect(res.statusCode).toBe(201);
  created.push(res.json().id);
  return res.json() as { id: string; code: string; token: string };
}
const ingest = (token: string, body: unknown) => app.inject({
  method: 'POST', url: '/api/ingest/v1/telemetry',
  headers: { authorization: `Bearer ${token}` }, payload: body as Record<string, unknown>,
});

describe('gateway ingest', () => {
  it('accepts a batch for its own children and attributes each block correctly', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GW', code: `GW-${s}`, transport: 'http', isGateway: true });
    const a = await mk({ name: 'A', code: `A-${s}`, transport: 'http', gatewayId: gw.id });
    const b = await mk({ name: 'B', code: `B-${s}`, transport: 'http', gatewayId: gw.id });

    const res = await ingest(gw.token, {
      devices: { [`A-${s}`]: { temperature: 21.5 }, [`B-${s}`]: { humidity: 47 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 2, rejected: 0 });

    const ta = await app.inject({ method: 'GET', url: `/api/instruments/${a.id}/telemetry`, headers: auth });
    expect(ta.json().latest.map((r: { key: string }) => r.key)).toEqual(['temperature']);
    const tb = await app.inject({ method: 'GET', url: `/api/instruments/${b.id}/telemetry`, headers: auth });
    expect(tb.json().latest.map((r: { key: string }) => r.key)).toEqual(['humidity']);
  });

  it('dead-letters a code it does not own and still stores the rest', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GW2', code: `GW2-${s}`, transport: 'http', isGateway: true });
    const a = await mk({ name: 'A2', code: `A2-${s}`, transport: 'http', gatewayId: gw.id });
    const orphan = await mk({ name: 'O', code: `O-${s}`, transport: 'http' });

    const res = await ingest(gw.token, {
      devices: { [`A2-${s}`]: { temperature: 1 }, [`O-${s}`]: { temperature: 2 } },
    });
    expect(res.json()).toEqual({ accepted: 1, rejected: 1 });

    // Filed against the GATEWAY, naming the code it tried to write.
    const dl = await app.inject({ method: 'GET', url: `/api/instruments/${gw.id}/dead-letters`, headers: auth });
    expect(dl.json().data[0].reason).toContain(`O-${s}`);

    // The orphan must have received nothing.
    const to = await app.inject({ method: 'GET', url: `/api/instruments/${orphan.id}/telemetry`, headers: auth });
    expect(to.json().latest).toEqual([]);
  });

  it('refuses a batch from an instrument that is not a gateway', async () => {
    const s = Date.now();
    const plain = await mk({ name: 'P', code: `P-${s}`, transport: 'http' });
    const res = await ingest(plain.token, { devices: { [`P-${s}`]: { temperature: 1 } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NOT_A_GATEWAY');
  });

  it('records the source: gateway for a relayed child, direct for its own post', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GW3', code: `GW3-${s}`, transport: 'http', isGateway: true });
    const c = await mk({ name: 'C', code: `C-${s}`, transport: 'http', gatewayId: gw.id });

    await ingest(gw.token, { devices: { [`C-${s}`]: { temperature: 3 } } });
    let row = await app.inject({ method: 'GET', url: `/api/instruments/${c.id}`, headers: auth });
    expect(row.json().lastSeenVia).toBe('gateway');
    expect(row.json().lastSeenAt).not.toBeNull();

    // The child keeps its own credential (spec D4) and using it flips the source.
    await ingest(c.token, { temperature: 4 });
    row = await app.inject({ method: 'GET', url: `/api/instruments/${c.id}`, headers: auth });
    expect(row.json().lastSeenVia).toBe('direct');
  });

  it('stops writing a child the moment it is unlinked — no cache grace period', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'GW4', code: `GW4-${s}`, transport: 'http', isGateway: true });
    const d = await mk({ name: 'D', code: `D-${s}`, transport: 'http', gatewayId: gw.id });

    expect((await ingest(gw.token, { devices: { [`D-${s}`]: { temperature: 5 } } })).json())
      .toEqual({ accepted: 1, rejected: 0 });

    await app.inject({
      method: 'PUT', url: `/api/instruments/${d.id}`, headers: auth, payload: { gatewayId: null },
    });

    // Proves link changes invalidate the child-map cache rather than waiting
    // out its 10s TTL.
    expect((await ingest(gw.token, { devices: { [`D-${s}`]: { temperature: 6 } } })).json())
      .toEqual({ accepted: 0, rejected: 1 });
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/e2e/gateway-ingest.test.ts src/modules/instruments --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS. (This depends on Task 6's `isGateway` / `gatewayId` accepted on create + update — implement Task 6 first if the fixtures 400.)

- [ ] **Step 5: Verify against the running API**

```bash
start-app.bat
# create a gateway + child in the UI, then with the gateway's token:
curl -k -X POST https://localhost:3001/api/ingest/v1/telemetry \
  -H "Authorization: Bearer <GATEWAY_TOKEN>" -H "Content-Type: application/json" \
  -d '{"devices": {"<CHILD_CODE>": {"temperature": 21.5}}}'
```

Expected: `{"accepted":1,"rejected":0}`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/instruments/ingest-routes.ts apps/api/src/modules/instruments/ingest-auth.ts apps/api/src/modules/instruments/__tests__/ingest-auth.test.ts apps/api/src/e2e/gateway-ingest.test.ts
git commit -m "feat(instruments): gateways may report telemetry for their linked instruments"
```

---

### Task 6: Registry API — placement, gateway toggle, link/unlink

**Files:**
- Modify: `packages/shared/src/schemas/instruments.ts`
- Modify: `apps/api/src/modules/instruments/routes.ts`
- Modify: `packages/shared/src/types/audit-actions.ts`, `packages/shared/src/types/audit-templates.ts`
- Test: `apps/api/src/e2e/instruments.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 schema, `invalidateChildMapCache` from Task 3
- Produces: `location/area/block/isGateway/gatewayId` on create + update; `GET /api/instruments/:id/children`; `GET /api/instruments/eligible-children`

- [ ] **Step 1: Extend the Zod schemas**

In `packages/shared/src/schemas/instruments.ts`, add to BOTH `createInstrumentSchema` and `updateInstrumentSchema`:

```typescript
  location: z.string().max(120).nullish(),
  area: z.string().max(120).nullish(),
  block: z.string().max(120).nullish(),
  isGateway: z.boolean().optional(),
  // null is meaningful: it unlinks. `.nullish()` keeps "omitted" and
  // "explicitly cleared" distinguishable in the handler.
  gatewayId: z.string().uuid().nullish(),
```

and to `instrumentQuerySchema`:

```typescript
  block: z.string().optional(),
  area: z.string().optional(),
  location: z.string().optional(),
  isGateway: z.enum(['true', 'false']).optional(),
```

Then: `npm run build -w @digilog/shared`

- [ ] **Step 2: Write the failing tests**

Append to `apps/api/src/e2e/instruments.test.ts`:

```typescript
describe('Instrument gateway links', () => {
  const mk = async (payload: Record<string, unknown>) => {
    const res = await app.inject({ method: 'POST', url: '/api/instruments', headers: auth, payload });
    if (res.statusCode === 201) created.push(res.json().id);
    return res;
  };

  it('stores placement fields', async () => {
    const res = await mk({
      name: 'Placed', code: `PL-${Date.now()}`, transport: 'http',
      block: 'Block C', area: 'Sterile Core', location: 'Room 214',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ block: 'Block C', area: 'Sterile Core', location: 'Room 214' });
  });

  it('refuses linking to an instrument that is not a gateway', async () => {
    const s = Date.now();
    const plain = await mk({ name: 'Plain', code: `PN-${s}`, transport: 'http' });
    const res = await mk({ name: 'Child', code: `CH-${s}`, transport: 'http', gatewayId: plain.json().id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NOT_A_GATEWAY');
  });

  it('refuses making a linked child into a gateway (one level only)', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'G', code: `G-${s}`, transport: 'http', isGateway: true });
    const child = await mk({ name: 'C', code: `C-${s}`, transport: 'http', gatewayId: gw.json().id });
    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${child.json().id}`, headers: auth, payload: { isGateway: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NESTED_GATEWAY');
  });

  it('refuses disabling a gateway that still has children, and names them', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'G2', code: `G2-${s}`, transport: 'http', isGateway: true });
    await mk({ name: 'C2', code: `C2-${s}`, transport: 'http', gatewayId: gw.json().id });
    const res = await app.inject({
      method: 'PUT', url: `/api/instruments/${gw.json().id}`, headers: auth, payload: { isGateway: false },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('GATEWAY_HAS_CHILDREN');
    expect(res.json().message).toContain(`C2-${s}`);
  });

  it('lists children, and eligible candidates exclude gateways and already-linked instruments', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'G3', code: `G3-${s}`, transport: 'http', isGateway: true });
    const child = await mk({ name: 'C3', code: `C3-${s}`, transport: 'http', gatewayId: gw.json().id });

    const kids = await app.inject({ method: 'GET', url: `/api/instruments/${gw.json().id}/children`, headers: auth });
    expect(kids.json().data.map((c: { id: string }) => c.id)).toContain(child.json().id);

    const elig = await app.inject({ method: 'GET', url: '/api/instruments/eligible-children', headers: auth });
    const ids = elig.json().data.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(gw.json().id);      // a gateway cannot be a child
    expect(ids).not.toContain(child.json().id);   // already parented
  });

  it('deleting a gateway unlinks its children rather than deleting them', async () => {
    const s = Date.now();
    const gw = await mk({ name: 'G4', code: `G4-${s}`, transport: 'http', isGateway: true });
    const child = await mk({ name: 'C4', code: `C4-${s}`, transport: 'http', gatewayId: gw.json().id });

    await app.inject({ method: 'DELETE', url: `/api/instruments/${gw.json().id}`, headers: auth });

    const still = await app.inject({ method: 'GET', url: `/api/instruments/${child.json().id}`, headers: auth });
    expect(still.statusCode).toBe(200);
    expect(still.json().gatewayId).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/e2e/instruments.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — the new fields are ignored and the new routes 404.

- [ ] **Step 4: Implement the guards and routes**

In `apps/api/src/modules/instruments/routes.ts`:

Add to `instrumentProps` so the fields are serialised (Fastify strips anything unlisted):

```typescript
  location: { type: 'string', nullable: true },
  area: { type: 'string', nullable: true },
  block: { type: 'string', nullable: true },
  isGateway: { type: 'boolean' },
  gatewayId: { type: 'string', nullable: true },
  lastSeenVia: { type: 'string', nullable: true },
```

(`lastSeenAt` is already listed; change `present()` so it returns the instrument's own `lastSeenAt`/`lastSeenVia` columns instead of deriving `lastSeenAt` from the credential. Keep `tokenPrefix` derived from the credential.)

Add the shared invariant guard, used by both create and update:

```typescript
/**
 * Spec D2/D3 invariants. Returns an error payload, or null when the write is
 * allowed. Cannot be a CHECK constraint — two of the three rules read a
 * different row.
 */
async function gatewayInvariantError(
  next: { isGateway?: boolean; gatewayId?: string | null },
  current: { id: string; isGateway: boolean; gatewayId: string | null } | null,
): Promise<{ status: number; body: { error: string; message: string } } | null> {
  const isGateway = next.isGateway ?? current?.isGateway ?? false;
  const gatewayId = next.gatewayId === undefined ? (current?.gatewayId ?? null) : next.gatewayId;

  if (isGateway && gatewayId) {
    return { status: 400, body: { error: 'NESTED_GATEWAY', message: 'A gateway cannot itself be linked to another gateway. Unlink it first.' } };
  }
  if (current && gatewayId === current.id) {
    return { status: 400, body: { error: 'SELF_GATEWAY', message: 'An instrument cannot be its own gateway.' } };
  }
  if (gatewayId) {
    const parent = await prisma.instrument.findUnique({
      where: { id: gatewayId }, select: { id: true, code: true, isGateway: true },
    });
    if (!parent) return { status: 400, body: { error: 'NOT_FOUND', message: 'The selected gateway does not exist.' } };
    if (!parent.isGateway) {
      return { status: 400, body: { error: 'NOT_A_GATEWAY', message: `Instrument "${parent.code}" is not configured as a gateway.` } };
    }
  }
  // Spec D6 — refusing beats silently unlinking, which would stop those
  // sensors reporting with nothing in the UI to say why.
  if (current?.isGateway && next.isGateway === false) {
    const kids = await prisma.instrument.findMany({ where: { gatewayId: current.id }, select: { code: true } });
    if (kids.length > 0) {
      return {
        status: 409,
        body: {
          error: 'GATEWAY_HAS_CHILDREN',
          message: `Unlink these instruments before disabling gateway mode: ${kids.map((k) => k.code).join(', ')}.`,
        },
      };
    }
  }
  return null;
}
```

Call it in `POST /` (with `current = null`) and in `PUT /:id` (with the existing row) immediately after `safeParse`, returning `reply.code(err.status).send(err.body)` when non-null.

After a successful create or update that touched `gatewayId`, invalidate BOTH the old and new gateway's child map — a moved child must stop being writable by its former gateway at once:

```typescript
    if (parsed.data.gatewayId !== undefined) {
      invalidateChildMapCache(existing?.gatewayId ?? undefined);
      invalidateChildMapCache(parsed.data.gatewayId ?? undefined);
      await auditLog({
        action: parsed.data.gatewayId ? 'INSTRUMENT_LINKED_TO_GATEWAY' : 'INSTRUMENT_UNLINKED_FROM_GATEWAY',
        targetType: 'Instrument', targetId: id,
        beforeValue: { gatewayId: existing.gatewayId }, afterValue: { gatewayId: parsed.data.gatewayId },
        signatureMeaning: `Instrument "${existing.code}" ${parsed.data.gatewayId ? 'linked to' : 'unlinked from'} a gateway`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    }
```

(and the equivalent `INSTRUMENT_GATEWAY_ENABLED` / `INSTRUMENT_GATEWAY_DISABLED` when `isGateway` changes — inside the same transaction, per §11.10(e).)

Extend the list `where` with the new filters:

```typescript
      ...(block ? { block: { contains: block, mode: 'insensitive' as const } } : {}),
      ...(area ? { area: { contains: area, mode: 'insensitive' as const } } : {}),
      ...(location ? { location: { contains: location, mode: 'insensitive' as const } } : {}),
      ...(isGateway !== undefined ? { isGateway: isGateway === 'true' } : {}),
```

Add the two read routes (both `INSTRUMENT_READ`, both returning `{ data: [...] }` of `{ id, code, name, isActive }`):

```typescript
  // GET /api/instruments/:id/children
  //   where: { gatewayId: id }, ordered by code
  // GET /api/instruments/eligible-children
  //   where: { isGateway: false, gatewayId: null, isActive: true }, ordered by code
  //   — a gateway cannot be a child (D2) and an instrument has one parent (D3),
  //     so both exclusions are the invariants, not a UI preference.
```

Register `eligible-children` **before** any handler that could shadow it; Fastify ranks static segments above `/:id`, so no ordering change is required, but keep it adjacent to `/children` for readability.

- [ ] **Step 5: Add the audit actions and templates**

In `packages/shared/src/types/audit-actions.ts`, after the existing `INSTRUMENT_*` entries:

```typescript
  INSTRUMENT_GATEWAY_ENABLED: 'INSTRUMENT_GATEWAY_ENABLED',
  INSTRUMENT_GATEWAY_DISABLED: 'INSTRUMENT_GATEWAY_DISABLED',
  INSTRUMENT_LINKED_TO_GATEWAY: 'INSTRUMENT_LINKED_TO_GATEWAY',
  INSTRUMENT_UNLINKED_FROM_GATEWAY: 'INSTRUMENT_UNLINKED_FROM_GATEWAY',
```

In `packages/shared/src/types/audit-templates.ts`, four entries under the existing `'Instruments'` category, e.g.:

```typescript
  INSTRUMENT_LINKED_TO_GATEWAY: {
    label: 'Instrument Linked to Gateway',
    category: 'Instruments',
    template: 'Instrument "{instrument}" linked to gateway "{gateway}" by {actor}',
    placeholders: ['actor', 'instrument', 'gateway'],
  },
```

Then: `npm run build -w @digilog/shared`

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && npx vitest run src/e2e/instruments.test.ts src/e2e/gateway-ingest.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/instruments/routes.ts packages/shared/src apps/api/src/e2e/instruments.test.ts
git commit -m "feat(instruments): placement fields, gateway toggle and child linking"
```

---

### Task 7: Connection instructions for gateways and children

**Files:**
- Modify: `apps/web/src/routes/instruments/connection-instructions.tsx`
- Test: `apps/web/src/routes/instruments/__tests__/connection-instructions.test.tsx`

**Interfaces:**
- Produces: `<ConnectionInstructions transport code token? isGateway? childCodes? gatewayCode? />`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/routes/instruments/__tests__/connection-instructions.test.tsx`:

```tsx
describe('ConnectionInstructions — gateway', () => {
  it('shows the devices batch shape naming this gateway\'s real children', () => {
    render(
      <ConnectionInstructions transport="http" code="GW-1" token="TOK" isGateway childCodes={['SENSOR-A', 'SENSOR-B']} />,
    );
    // Not an illustrative example — the correct command for THIS gateway.
    expect(screen.getAllByText(/"devices"/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SENSOR-A/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SENSOR-B/).length).toBeGreaterThan(0);
  });

  it('tells a gateway with no children to link some first', () => {
    render(<ConnectionInstructions transport="http" code="GW-1" token="TOK" isGateway childCodes={[]} />);
    expect(screen.getByText(/link.*instrument/i)).toBeInTheDocument();
  });

  it('tells a child it is reported via its gateway, without hiding its own credentials', () => {
    render(<ConnectionInstructions transport="http" code="SENSOR-A" token="TOK" gatewayCode="GW-1" />);
    expect(screen.getByText(/GW-1/)).toBeInTheDocument();
    expect(screen.getByText(/curl/)).toBeInTheDocument();   // direct path still shown (spec D4)
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/routes/instruments/__tests__/connection-instructions.test.tsx`
Expected: FAIL — the new props are ignored.

- [ ] **Step 3: Implement**

Extend the props interface with `isGateway?: boolean; childCodes?: string[]; gatewayCode?: string`.

When `isGateway`, the HTTP/HTTPS body becomes the batch shape built from `childCodes` (fall back to a `<CHILD_CODE>` placeholder plus a "link instruments to this gateway first" note when the list is empty). Do the same substitution for the MQTT / WebSocket / TCP payloads — the transport changes, the payload shape does not.

When `gatewayCode` is set, render a note above the existing block: *"This instrument is also reported by gateway `{gatewayCode}`. The credentials below remain valid for reporting directly."*

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && npx vitest run src/routes/instruments/__tests__/connection-instructions.test.tsx`
Expected: PASS (8 tests — 5 existing + 3 new)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/instruments/connection-instructions.tsx apps/web/src/routes/instruments/__tests__/connection-instructions.test.tsx
git commit -m "feat(web): gateway batch and child relay connection instructions"
```

---

### Task 8: UI — placement fields, gateway toggle, linked-instruments panel

**Files:**
- Create: `apps/web/src/routes/instruments/gateway-panel.tsx`
- Modify: `apps/web/src/routes/instruments/{create,detail,list}.tsx`

**Interfaces:**
- Consumes: `GET /api/instruments/:id/children`, `GET /api/instruments/eligible-children`, `PUT /api/instruments/:id`

- [ ] **Step 1: Add placement + gateway to the create form**

In `create.tsx`, add a "Placement" `Card` with Block / Area / Location text inputs (same `set()` pattern as the existing optional fields — send only non-empty values), and an **Is Gateway** checkbox in the Identity card with the helper text: *"A gateway reports telemetry on behalf of the instruments linked to it."* Relabel the Code field **Instrument ID**, keeping the existing immutability note.

- [ ] **Step 2: Add the columns and filters to the list**

In `list.tsx`, add Block / Area / Location text filters (mirroring the existing `search` debounce), a gateway `Badge` on the name cell when `isGateway`, and read `lastSeenVia` beside "Last seen" so a gateway-relayed child is visibly not silent.

- [ ] **Step 3: Build the Linked Instruments panel**

`gateway-panel.tsx` renders only when `isGateway`:

```tsx
export function GatewayPanel({ instrumentId, canEdit }: { instrumentId: string; canEdit: boolean }) {
  // SWR: `/api/instruments/${instrumentId}/children` and, when the picker is
  // open, `/api/instruments/eligible-children`.
  // Link   → PUT /api/instruments/<childId> { gatewayId: instrumentId }
  // Unlink → PUT /api/instruments/<childId> { gatewayId: null }
  // Both mutate() the children list AND the parent instrument, because the
  // connection instructions above are built from the child codes.
}
```

Show an explicit empty state: *"No instruments linked. This gateway cannot report for anything until you link some."*

- [ ] **Step 4: Mount it and wire the child banner**

In `detail.tsx`: render `<GatewayPanel />` when `inst.isGateway`; pass `isGateway`, `childCodes` and `gatewayCode` through to `<ConnectionInstructions />`; add Block / Area / Location to the details `<dl>` and to the inline edit form; show the D6 refusal (409 `GATEWAY_HAS_CHILDREN`) as a toast carrying the server's message, which already names the children.

- [ ] **Step 5: Typecheck**

```bash
cd apps/web && npx tsc -p tsconfig.json --noEmit
```
Expected: no output.

- [ ] **Step 6: Verify in the browser**

At `https://localhost:5176/instruments`:
1. Create a gateway with Block/Area/Location filled, and two plain instruments.
2. Link both on the gateway's detail page; confirm they appear under Linked Instruments and that the connection example on that page now lists **their real codes**.
3. Copy that command and run it verbatim. It must return `{"accepted":2,"rejected":0}` — if it does not, the instructions are wrong, which is the whole point of showing them.
4. Open a child: it shows "reported by gateway …", its Last seen is populated and reads **via gateway**.
5. Try to switch Is Gateway off: refused, naming both children.
6. Unlink one, re-run the command: `{"accepted":1,"rejected":1}`.
7. Check the browser console is clean and no element is unstyled.

- [ ] **Step 7: Full verification sweep**

```bash
npx tsc -p apps/api/tsconfig.json --noEmit
cd apps/web && npx tsc -p tsconfig.json --noEmit && npx vitest run && cd ..
cd apps/api && npm test        # single-fork; expect the 14 pre-existing failures, no new ones
cd ../.. && npm run db:verify-migrations
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/routes/instruments/
git commit -m "feat(web): instrument placement fields and gateway child linking UI"
```

---

### Task 9: Documentation sync

**Files:**
- Modify: `CHANGELOG.md`, `docs/recreation/06-api/endpoints.md`, `docs/recreation/05-database/README.md`

- [ ] **Step 1: Update the docs**

CHANGELOG entry covering the gateway model and the last-seen relocation. Add `/api/instruments/:id/children` and `/api/instruments/eligible-children` to the endpoints appendix and bump its verified path count (re-derive it: `curl -sk https://localhost:3001/docs/json | python -c "import sys,json;print(len(json.load(sys.stdin)['paths']))"`). Update the database doc's model/column notes for `Instrument`.

Per the repo's documentation-sync rule, **every numerical claim must be re-derived from live code at the moment the doc is touched** — do not copy a count from a prior doc.

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md docs/
git commit -m "docs: sync for the instrument gateway model"
```

---

## Self-Review — spec coverage

| Spec section | Covered by |
|---|---|
| §4 Schema (placement, isGateway, gatewayId, last-seen) | Task 1 |
| §5 Fan-out — pure decision logic | Task 2 |
| §5 Child map + cache invalidation | Task 3 |
| §6 Last-seen on the instrument, with source | Tasks 4, 5 |
| §5 Ingest wiring, non-gateway 400, `{accepted, rejected}` | Task 5 |
| §3 D2/D3 invariants, D6 refusal, D7 unlink-on-delete | Tasks 1 (FK) + 6 (service guards) |
| §7 UI — form, filters, Linked Instruments panel, child banner | Tasks 7, 8 |
| §7 Connection instructions per protocol | Task 7 |
| §8 RBAC (no new permissions) and audit actions | Task 6 |
| §9 Testing — pure, integration, browser | Tasks 2-8 |
| §10 Risk: unlink must take effect immediately | Task 3 (invalidation) + Task 5 e2e |
| §11 Out of scope — no auto-provisioning of unknown children | Task 2 (dead-letter, never create) |

**Ordering note:** Task 5's e2e fixtures create instruments with `isGateway` / `gatewayId`, which Task 6 implements. Execute **6 before 5**, or expect Task 5 Step 4 to fail on fixture setup. The tasks are numbered by subject rather than by dependency; this is the only inversion.
