# Data Injection P2+P3 — MQTT Adapter & Telemetry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make device data flow — a real MQTT device publishing to a real broker produces rows queryable through the API and visible in the UI.

**Architecture:** The app is an MQTT **client** connecting to an external broker using credentials from the P1 Communication Profile. A plugin registry (`IProtocolAdapter`) keeps protocols additive. Inbound messages pass through three **pure, database-free** stages — topic router → payload parser → fan-out — before a batching writer lands them in a latest table and a monthly-partitioned history table. Anything unresolvable is dead-lettered, never dropped.

**Tech Stack:** Fastify 5, Prisma 6, PostgreSQL 18 (declarative partitioning), `mqtt` (mqtt.js) as a new runtime dependency, `aedes` as a **test-only** devDependency, graphile-worker, React 19 + SWR + Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-01-data-injection-p2-mqtt-telemetry-design.md`

## Global Constraints

- **Branch `data-injection`.** Verify with `git branch --show-current` before every task. `final-user-management` is a FROZEN BACKUP — never commit to it.
- **CI baselines, ratchet DOWN only:** api **14 failed / 738 passed**, web **6 failed**, shared **3 failed**. Enforced by `node scripts/ci-test-gate.mjs`.
- **`tsc --noEmit` must stay at 0 errors** for BOTH `apps/api` and `apps/web`. `vitest` runs through esbuild and does **not** typecheck — green tests do not mean it compiles. This is how two `TS2322` errors survived eight tasks in P1.
- **Stop the app before `prisma generate` or `npm ci`** (`stop-app.bat`). A live dev server holds `query_engine-windows.dll.node` open; `prisma generate` then fails in a way that leaves the OLD client in place, whose looser types mask real errors.
- API tests run single-fork: `cd apps/api && npm test`. Plain `npx vitest run` there is flaky for reasons unrelated to correctness.
- **Telemetry writes are NOT audited** (spec D5). Configuration changes and dead-letter resolution ARE.
- **Never drop a message.** Unresolvable input goes to `dead_letters` with a reason.
- **The three pure files must not import prisma** — that is what makes routing and splitting exhaustively testable without infrastructure.
- **Adapter startup must never block API boot** (spec §8). Follow the graphile-worker pattern at `apps/api/src/app.ts:415-445`: start after `app.listen`, wrap in try/catch, log an error, keep serving.
- Don't hardcode values or comment out assertions to make tests pass. Find root causes.
- Do NOT edit root docs (`CLAUDE.md`, `PROJECT_ARCHITECTURE.md`, …) — they describe a different, pre-strip product. Only `docs/recreation/` and `CHANGELOG.md`.
- Migrations are hand-authored; `prisma db push` / `migrate dev` auto-generation is forbidden. `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-migrations.ps1` must PASS before any schema commit (the plain npm script fails on this machine's execution policy).

---

## File Structure

**Created — backend**
```
apps/api/src/modules/data-injection/
  adapters/protocol-adapter.ts     IProtocolAdapter interface + registry     (Task 1)
  adapters/mqtt.adapter.ts         mqtt.js implementation                     (Task 7)
  topic-router.ts                  PURE: topic → routing decision             (Task 2)
  payload-parser.ts                PURE: bytes → readings[]                   (Task 3)
  fan-out.ts                       PURE: routing + payload → per-instrument   (Task 4)
  telemetry.repository.ts          ALL raw SQL for the partitioned table      (Task 6)
  connection-manager.ts            per-profile lifecycle, backoff, health     (Task 8)
  ingestion.service.ts             queue + batching + dead-letter             (Task 9)
  routes.ts                        latest / history / health / dead-letters   (Task 11)
apps/api/src/workers/telemetry-partition.worker.ts                            (Task 12)
```

**Created — frontend**
```
apps/web/src/routes/data-injection/instrument-detail.tsx    live + history    (Task 13)
```

**Modified**
```
apps/api/package.json              + mqtt (runtime), + aedes (devDependency)  (Task 1)
apps/api/prisma/schema.prisma      + 3 models                                 (Task 5)
apps/api/prisma/migrations/<UTC>_telemetry/migration.sql                      (Task 5)
apps/api/src/app.ts                register routes + start connection manager (Tasks 10, 11)
apps/api/src/e2e/test-helper.ts    register the new module                    (Task 11)
packages/queue/crontab.txt         partition maintenance schedule             (Task 12)
apps/web/src/main.tsx              + 1 route (44 → 45)                        (Task 13)
apps/web/src/routes/data-injection/index.tsx   health strip                   (Task 14)
docs/recreation/**, CHANGELOG.md                                              (Task 15)
```

**Boundary rationale.** `topic-router`, `payload-parser` and `fan-out` are separate files because each is a distinct decision with its own failure modes, and keeping them database-free means the hardest logic in this phase is testable in milliseconds. `telemetry.repository.ts` is the ONLY file containing raw SQL — the same containment that made P1's `hierarchy.repository.ts` reviewable.

---

## Task 1: Dependencies + IProtocolAdapter interface and registry

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/src/modules/data-injection/adapters/protocol-adapter.ts`
- Test: `apps/api/src/modules/data-injection/adapters/__tests__/protocol-adapter.test.ts`

**Interfaces:**
- Produces: `IProtocolAdapter`, `InboundMessage`, `AdapterHealth`, `registerAdapter(a)`, `getAdapter(key)`, `listAdapters()`

- [ ] **Step 1: Stop the app, then add dependencies**

```bash
cd /c/Users/hello/compliance-core && ./stop-app.bat
cd apps/api && npm install mqtt && npm install --save-dev aedes
```

`mqtt` is a runtime dependency (the client). `aedes` is **test-only** — it provides an in-process broker for integration tests and must NOT ship. Verify placement:

```bash
grep -A2 '"dependencies"' package.json | grep mqtt
grep -A2 '"devDependencies"' package.json | grep aedes
```

- [ ] **Step 2: Write the failing test**

```ts
// apps/api/src/modules/data-injection/adapters/__tests__/protocol-adapter.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerAdapter, getAdapter, listAdapters, clearAdaptersForTest,
  type IProtocolAdapter,
} from '../protocol-adapter.js';

const stub = (key: string): IProtocolAdapter => ({
  protocolKey: key,
  async start() {},
  async stop() {},
  health: () => ({
    connected: false, lastMessageAt: null, lastErrorAt: null,
    lastError: null, messagesReceived: 0, reconnectCount: 0,
  }),
});

describe('protocol adapter registry', () => {
  beforeEach(() => clearAdaptersForTest());

  it('registers and retrieves by protocolKey', () => {
    registerAdapter(stub('mqtt'));
    expect(getAdapter('mqtt')?.protocolKey).toBe('mqtt');
  });

  it('returns undefined for an unregistered protocol', () => {
    expect(getAdapter('modbus-tcp')).toBeUndefined();
  });

  it('rejects a duplicate registration rather than silently replacing', () => {
    registerAdapter(stub('mqtt'));
    expect(() => registerAdapter(stub('mqtt'))).toThrow(/already registered/i);
  });

  it('lists registered keys', () => {
    registerAdapter(stub('mqtt'));
    registerAdapter(stub('http'));
    expect(listAdapters().sort()).toEqual(['http', 'mqtt']);
  });
});
```

- [ ] **Step 3: Run it — expect failure**

```bash
cd apps/api && npx vitest run src/modules/data-injection/adapters/__tests__/protocol-adapter.test.ts
```
Expected: FAIL — cannot resolve `../protocol-adapter.js`.

- [ ] **Step 4: Implement**

```ts
// apps/api/src/modules/data-injection/adapters/protocol-adapter.ts
/**
 * Protocol adapter contract + registry.
 *
 * Adding a protocol is one new file implementing IProtocolAdapter plus flipping
 * Protocol.isEnabled — no change to the ingestion pipeline. That is the whole
 * point of the indirection.
 */

/** A message as it arrived, before any parsing. */
export interface InboundMessage {
  protocolKey: string;
  profileId: string;
  topic: string;
  payload: Buffer;
  receivedAt: Date;
  qos?: number;
  retained?: boolean;
}

export interface AdapterHealth {
  connected: boolean;
  lastMessageAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  messagesReceived: number;
  reconnectCount: number;
}

/** Communication profile WITH secrets unmasked — the adapter needs the real password. */
export interface ProfileWithSecrets {
  id: string;
  name: string;
  protocolKey: string;
  config: Record<string, unknown>;
}

export interface IProtocolAdapter {
  readonly protocolKey: string;
  start(profile: ProfileWithSecrets,
        onMessage: (m: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  health(): AdapterHealth;
  /** Optional — only adapters that can write implement this. Arrives in P8. */
  publish?(topic: string, payload: Buffer,
           opts?: { qos?: number; retain?: boolean }): Promise<void>;
}

const adapters = new Map<string, IProtocolAdapter>();

export function registerAdapter(adapter: IProtocolAdapter): void {
  if (adapters.has(adapter.protocolKey)) {
    // Throw rather than replace: a silent overwrite means two adapters fight
    // over the same protocol and which one wins depends on import order.
    throw new Error(`Protocol adapter '${adapter.protocolKey}' is already registered.`);
  }
  adapters.set(adapter.protocolKey, adapter);
}

export function getAdapter(protocolKey: string): IProtocolAdapter | undefined {
  return adapters.get(protocolKey);
}

export function listAdapters(): string[] {
  return [...adapters.keys()];
}

/** Test-only. Never call from application code. */
export function clearAdaptersForTest(): void {
  adapters.clear();
}
```

- [ ] **Step 5: Run tests — expect pass**

```bash
cd apps/api && npx vitest run src/modules/data-injection/adapters/__tests__/protocol-adapter.test.ts
```
Expected: 4 passed.

- [ ] **Step 6: Typecheck (vitest does NOT do this)**

```bash
cd /c/Users/hello/compliance-core && npx tsc --noEmit -p apps/api/tsconfig.json
```
Expected: exit 0, zero errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json apps/api/package-lock.json apps/api/src/modules/data-injection/
git commit -m "Add IProtocolAdapter contract and registry, plus mqtt/aedes deps"
```

---

## Task 2: Topic router (pure)

**Files:**
- Create: `apps/api/src/modules/data-injection/topic-router.ts`
- Test: `apps/api/src/modules/data-injection/__tests__/topic-router.test.ts`

**Interfaces:**
- Produces: `tailOf(topic, baseTopic, separator): string | null`, `routeTail(tail, separator): RoutedTail | null`, `type RoutedTail = { instrumentSlug: string | null; category: TopicCategory }`, and `interface TopicRoute extends RoutedTail { gatewaySlug: string }`

> **REVISED 2026-08-02 — the original right-anchored design was unimplementable.**
> As first written, this task's own tests contradicted its own implementation:
> `routeTopic('controlyt/india/area-02/gw-001/telemetry', '/')` returned
> `{gatewaySlug:'area-02', instrumentSlug:'gw-001'}` where the test expected
> `{gatewaySlug:'gw-001', instrumentSlug:null}`. Verified by running it.
>
> The cause is fundamental, not a typo. Matching from the RIGHT cannot separate
> `…/<hierarchy>/<gateway>/<category>` from `…/<gateway>/<instrument>/<category>`
> — both are ≥3 segments and the topic string carries nothing to tell them apart.
> The original comment claiming "a hierarchy segment can never be mistaken for an
> instrument here" was simply false.
>
> **Resolution: anchor on the subscription.** The adapter subscribes per gateway
> to `<gatewayBaseTopic>/#`, so the gateway is known when the message arrives and
> only the tail needs interpreting (2 segments ⇒ instrument+category, 1 ⇒ category,
> anything else ⇒ null/dead-letter). The ambiguity is removed at its source.
>
> **Knock-on effects:** `InboundMessage` (Task 1) gains `gatewaySlug` and
> `baseTopic`, populated by the adapter from the subscription. Task 4 is
> **unchanged** — `TopicRoute` still carries `gatewaySlug`; the caller composes it
> as `{ gatewaySlug: m.gatewaySlug, ...routeTail(tail, sep) }`. Task 9's call site
> is updated below.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/data-injection/__tests__/topic-router.test.ts
import { describe, it, expect } from 'vitest';
import { routeTopic } from '../topic-router.js';

describe('routeTopic', () => {
  it('routes a topic-addressed message (gateway + instrument + category)', () => {
    expect(routeTopic('controlyt/india/area-02/gw-001/temp001/telemetry', '/'))
      .toEqual({ gatewaySlug: 'gw-001', instrumentSlug: 'temp001', category: 'TELEMETRY' });
  });

  it('routes a payload-addressed message (gateway + category, no instrument)', () => {
    expect(routeTopic('controlyt/india/area-02/gw-001/telemetry', '/'))
      .toEqual({ gatewaySlug: 'gw-001', instrumentSlug: null, category: 'TELEMETRY' });
  });

  it('is independent of hierarchy depth', () => {
    expect(routeTopic('a/gw-001/temp001/alarm', '/')?.instrumentSlug).toBe('temp001');
    expect(routeTopic('a/b/c/d/e/f/gw-001/temp001/alarm', '/')?.instrumentSlug).toBe('temp001');
  });

  it('returns null when the last segment is not a known category', () => {
    expect(routeTopic('controlyt/india/gw-001/temp001/bogus', '/')).toBeNull();
  });

  it('returns null for a topic too short to carry gateway + category', () => {
    expect(routeTopic('telemetry', '/')).toBeNull();
  });

  it('honours a dot separator', () => {
    expect(routeTopic('controlyt.india.gw-001.temp001.status', '.'))
      .toEqual({ gatewaySlug: 'gw-001', instrumentSlug: 'temp001', category: 'STATUS' });
  });

  it('is case-insensitive on the category segment', () => {
    expect(routeTopic('a/gw-001/temp001/Telemetry', '/')?.category).toBe('TELEMETRY');
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```bash
cd apps/api && npx vitest run src/modules/data-injection/__tests__/topic-router.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/data-injection/topic-router.ts
/**
 * Topic routing — PURE. No database, no imports beyond the category list.
 *
 * P1 derives topics as  prefix / hierarchy… / gateway / instrument / category.
 * We match from the RIGHT because hierarchy depth varies per site, so the only
 * reliable anchors are the trailing segments.
 *
 *   …/gw-001/temp001/telemetry  → topic-addressed   (one instrument)
 *   …/gw-001/telemetry          → payload-addressed (batch, keyed by deviceKey)
 *
 * Resolution downstream is by SLUG LOOKUP, never by re-deriving the path, so a
 * hierarchy rename cannot orphan messages already in flight.
 */
import { TOPIC_CATEGORIES, type TopicCategory } from '../instruments/topic-resolver.js';

export interface TopicRoute {
  gatewaySlug: string;
  /** null ⇒ payload-addressed: the batch payload names its own devices. */
  instrumentSlug: string | null;
  category: TopicCategory;
}

const CATEGORY_SET = new Set<string>(TOPIC_CATEGORIES);

export function routeTopic(topic: string, separator: string): TopicRoute | null {
  const parts = topic.split(separator).filter(p => p.length > 0);
  if (parts.length < 2) return null;

  const category = parts[parts.length - 1].toUpperCase();
  if (!CATEGORY_SET.has(category)) return null;

  // …/<gateway>/<instrument>/<category>  → 3 trailing segments
  // …/<gateway>/<category>               → 2 trailing segments
  // A hierarchy segment can never be mistaken for an instrument here, because
  // the instrument slot is only claimed when there are ≥3 segments AND the
  // gateway slot is then filled from the position before it.
  if (parts.length >= 3) {
    return {
      gatewaySlug: parts[parts.length - 3],
      instrumentSlug: parts[parts.length - 2],
      category: category as TopicCategory,
    };
  }
  return {
    gatewaySlug: parts[parts.length - 2],
    instrumentSlug: null,
    category: category as TopicCategory,
  };
}
```

> **Ambiguity note for the implementer:** with exactly 3 segments (`gw/inst/telemetry`) this returns topic-addressed. That is correct — a bare `gw/telemetry` has only 2. The resolver in Task 9 treats a topic-addressed message whose instrument slug does not resolve as a dead-letter, so a mis-shaped topic surfaces rather than being silently reinterpreted as a batch.

- [ ] **Step 4: Run tests — expect pass**

```bash
cd apps/api && npx vitest run src/modules/data-injection/__tests__/topic-router.test.ts
```
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/data-injection/topic-router.ts apps/api/src/modules/data-injection/__tests__/topic-router.test.ts
git commit -m "Add pure topic router for inbound message addressing"
```

---

## Task 3: Payload parser (pure)

**Files:**
- Create: `apps/api/src/modules/data-injection/payload-parser.ts`
- Test: `apps/api/src/modules/data-injection/__tests__/payload-parser.test.ts`

**Interfaces:**
- Produces: `parsePayload(buf: Buffer): ParsedPayload`, `type Reading = { key: string; value: unknown; valueType: ValueType; ts: Date; quality?: string }`, `type ValueType = 'boolean'|'int'|'float'|'string'|'json'`, `classifyValue(v: unknown): ValueType`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/data-injection/__tests__/payload-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parsePayload, classifyValue, toReadings } from '../payload-parser.js';

const buf = (o: unknown) => Buffer.from(JSON.stringify(o));

describe('classifyValue', () => {
  it('distinguishes int from float', () => {
    expect(classifyValue(21)).toBe('int');
    expect(classifyValue(21.5)).toBe('float');
  });
  it('classifies the remaining types', () => {
    expect(classifyValue(true)).toBe('boolean');
    expect(classifyValue('ok')).toBe('string');
    expect(classifyValue({ a: 1 })).toBe('json');
    expect(classifyValue([1, 2])).toBe('json');
  });
});

describe('parsePayload', () => {
  it('parses a flat reading object', () => {
    const p = parsePayload(buf({ temp: 21.5, rh: 45 }));
    expect(p.ok).toBe(true);
    expect(p.devices).toBeNull();
    expect(p.values).toEqual({ temp: 21.5, rh: 45 });
  });

  it('detects a batch payload keyed by deviceKey', () => {
    const p = parsePayload(buf({ devices: { temp001: { temp: 21.5 }, hum002: { rh: 45 } } }));
    expect(p.ok).toBe(true);
    expect(Object.keys(p.devices!)).toEqual(['temp001', 'hum002']);
  });

  it('reports invalid JSON instead of throwing', () => {
    const p = parsePayload(Buffer.from('{not json'));
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/json/i);
  });

  it('rejects a non-object payload', () => {
    expect(parsePayload(buf(42)).ok).toBe(false);
    expect(parsePayload(buf('hello')).ok).toBe(false);
  });

  it('honours an explicit timestamp when present', () => {
    const p = parsePayload(buf({ ts: '2026-08-01T10:00:00.000Z', temp: 21.5 }));
    expect(p.ts?.toISOString()).toBe('2026-08-01T10:00:00.000Z');
    expect(p.values).toEqual({ temp: 21.5 });   // ts must not become a reading
  });

  it('ignores an unparseable timestamp rather than failing the message', () => {
    const p = parsePayload(buf({ ts: 'not-a-date', temp: 21.5 }));
    expect(p.ok).toBe(true);
    expect(p.ts).toBeNull();
  });
});

describe('toReadings', () => {
  it('produces one typed reading per key', () => {
    const now = new Date('2026-08-01T10:00:00.000Z');
    expect(toReadings({ temp: 21.5, on: true }, now)).toEqual([
      { key: 'temp', value: 21.5, valueType: 'float', ts: now },
      { key: 'on', value: true, valueType: 'boolean', ts: now },
    ]);
  });

  it('skips null and undefined values', () => {
    const now = new Date();
    expect(toReadings({ a: null, b: undefined, c: 1 }, now).map(r => r.key)).toEqual(['c']);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```bash
cd apps/api && npx vitest run src/modules/data-injection/__tests__/payload-parser.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/data-injection/payload-parser.ts
/**
 * Payload parsing — PURE. No database, no imports.
 *
 * Two accepted shapes:
 *   flat  { "temp": 21.5, "rh": 45 }                          → one instrument
 *   batch { "devices": { "temp001": { "temp": 21.5 }, … } }   → many, by deviceKey
 *
 * Values keep an explicit type. Storing everything as text and guessing on read
 * is how "0" becomes 0 becomes false — unacceptable in a system whose purpose is
 * faithful records.
 */

export type ValueType = 'boolean' | 'int' | 'float' | 'string' | 'json';

export interface Reading {
  key: string;
  value: unknown;
  valueType: ValueType;
  ts: Date;
  quality?: string;
}

export interface ParsedPayload {
  ok: boolean;
  reason?: string;
  /** Present for a batch payload; null for a flat one. */
  devices: Record<string, Record<string, unknown>> | null;
  /** Present for a flat payload; empty for a batch. */
  values: Record<string, unknown>;
  /** Device-supplied timestamp, if it sent a valid one. */
  ts: Date | null;
}

/** Reserved top-level keys that carry metadata, not readings. */
const META_KEYS = new Set(['ts', 'timestamp', 'quality', 'devices']);

export function classifyValue(v: unknown): ValueType {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'string';
  return 'json';
}

export function parsePayload(buf: Buffer): ParsedPayload {
  const empty: ParsedPayload = { ok: false, devices: null, values: {}, ts: null };

  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return { ...empty, reason: `Invalid JSON: ${(e as Error).message}` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...empty, reason: 'Payload must be a JSON object' };
  }

  const obj = raw as Record<string, unknown>;

  // A device-supplied timestamp is used when valid and ignored when not — a bad
  // clock should not discard an otherwise good reading.
  let ts: Date | null = null;
  const rawTs = obj.ts ?? obj.timestamp;
  if (typeof rawTs === 'string' || typeof rawTs === 'number') {
    const d = new Date(rawTs);
    if (!Number.isNaN(d.getTime())) ts = d;
  }

  if (obj.devices && typeof obj.devices === 'object' && !Array.isArray(obj.devices)) {
    return {
      ok: true, devices: obj.devices as Record<string, Record<string, unknown>>,
      values: {}, ts,
    };
  }

  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!META_KEYS.has(k)) values[k] = v;
  }
  return { ok: true, devices: null, values, ts };
}

export function toReadings(values: Record<string, unknown>, ts: Date): Reading[] {
  const out: Reading[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    out.push({ key, value, valueType: classifyValue(value), ts });
  }
  return out;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd apps/api && npx vitest run src/modules/data-injection/__tests__/payload-parser.test.ts
```
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/data-injection/payload-parser.ts apps/api/src/modules/data-injection/__tests__/payload-parser.test.ts
git commit -m "Add pure payload parser with explicit value typing"
```

---

## Task 4: Fan-out (pure)

**Files:**
- Create: `apps/api/src/modules/data-injection/fan-out.ts`
- Test: `apps/api/src/modules/data-injection/__tests__/fan-out.test.ts`

**Interfaces:**
- Consumes: `TopicRoute` (Task 2), `ParsedPayload`/`Reading` (Task 3)
- Produces: `fanOut(route, parsed, resolver, receivedAt): FanOutResult` where `resolver` is `{ bySlug(gatewaySlug, instrumentSlug): string|null; byDeviceKey(gatewaySlug, deviceKey): string|null }` and `FanOutResult = { batches: { instrumentId: string; readings: Reading[] }[]; deadLetters: { reason: string; detail: string }[] }`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/data-injection/__tests__/fan-out.test.ts
import { describe, it, expect } from 'vitest';
import { fanOut, type InstrumentResolver } from '../fan-out.js';
import { parsePayload } from '../payload-parser.js';

const buf = (o: unknown) => Buffer.from(JSON.stringify(o));
const AT = new Date('2026-08-01T10:00:00.000Z');

const resolver: InstrumentResolver = {
  bySlug: (g, i) => (g === 'gw-001' && i === 'temp001' ? 'inst-1' : null),
  byDeviceKey: (g, k) =>
    g === 'gw-001' ? ({ temp001: 'inst-1', hum002: 'inst-2' } as Record<string, string>)[k] ?? null : null,
};

describe('fanOut', () => {
  it('topic-addressed: one batch for the resolved instrument', () => {
    const r = fanOut(
      { gatewaySlug: 'gw-001', instrumentSlug: 'temp001', category: 'TELEMETRY' },
      parsePayload(buf({ temp: 21.5 })), resolver, AT);
    expect(r.deadLetters).toEqual([]);
    expect(r.batches).toHaveLength(1);
    expect(r.batches[0].instrumentId).toBe('inst-1');
    expect(r.batches[0].readings[0]).toMatchObject({ key: 'temp', value: 21.5, valueType: 'float' });
  });

  it('topic-addressed: unknown instrument dead-letters, no batch', () => {
    const r = fanOut(
      { gatewaySlug: 'gw-001', instrumentSlug: 'nope', category: 'TELEMETRY' },
      parsePayload(buf({ temp: 1 })), resolver, AT);
    expect(r.batches).toEqual([]);
    expect(r.deadLetters[0].reason).toBe('UNKNOWN_INSTRUMENT');
  });

  it('payload-addressed: splits a batch into one entry per device', () => {
    const r = fanOut(
      { gatewaySlug: 'gw-001', instrumentSlug: null, category: 'TELEMETRY' },
      parsePayload(buf({ devices: { temp001: { temp: 21.5 }, hum002: { rh: 45 } } })), resolver, AT);
    expect(r.deadLetters).toEqual([]);
    expect(r.batches.map(b => b.instrumentId).sort()).toEqual(['inst-1', 'inst-2']);
  });

  it('payload-addressed: ONE unknown deviceKey does not discard the good ones', () => {
    const r = fanOut(
      { gatewaySlug: 'gw-001', instrumentSlug: null, category: 'TELEMETRY' },
      parsePayload(buf({ devices: { temp001: { temp: 21.5 }, ghost: { x: 1 } } })), resolver, AT);
    expect(r.batches).toHaveLength(1);
    expect(r.batches[0].instrumentId).toBe('inst-1');
    expect(r.deadLetters).toHaveLength(1);
    expect(r.deadLetters[0].reason).toBe('UNKNOWN_DEVICE_KEY');
    expect(r.deadLetters[0].detail).toContain('ghost');
  });

  it('uses the device-supplied timestamp when present', () => {
    const r = fanOut(
      { gatewaySlug: 'gw-001', instrumentSlug: 'temp001', category: 'TELEMETRY' },
      parsePayload(buf({ ts: '2026-07-01T00:00:00.000Z', temp: 1 })), resolver, AT);
    expect(r.batches[0].readings[0].ts.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('falls back to receivedAt when the device sent no timestamp', () => {
    const r = fanOut(
      { gatewaySlug: 'gw-001', instrumentSlug: 'temp001', category: 'TELEMETRY' },
      parsePayload(buf({ temp: 1 })), resolver, AT);
    expect(r.batches[0].readings[0].ts).toEqual(AT);
  });

  it('dead-letters an unparseable payload', () => {
    const r = fanOut(
      { gatewaySlug: 'gw-001', instrumentSlug: 'temp001', category: 'TELEMETRY' },
      parsePayload(Buffer.from('{bad')), resolver, AT);
    expect(r.batches).toEqual([]);
    expect(r.deadLetters[0].reason).toBe('UNPARSEABLE_PAYLOAD');
  });

  it('produces no batch when a resolved device carries no usable readings', () => {
    const r = fanOut(
      { gatewaySlug: 'gw-001', instrumentSlug: 'temp001', category: 'TELEMETRY' },
      parsePayload(buf({ a: null })), resolver, AT);
    expect(r.batches).toEqual([]);
    expect(r.deadLetters[0].reason).toBe('NO_READINGS');
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```bash
cd apps/api && npx vitest run src/modules/data-injection/__tests__/fan-out.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/data-injection/fan-out.ts
/**
 * Fan-out — PURE. Resolution is injected, so this file never touches a database.
 *
 * The load-bearing rule: in a batch payload, ONE unknown deviceKey dead-letters
 * only its own entry. Discarding 49 good readings because the 50th device was
 * mis-keyed would turn a configuration error into data loss.
 */
import type { TopicRoute } from './topic-router.js';
import { toReadings, type ParsedPayload, type Reading } from './payload-parser.js';

export interface InstrumentResolver {
  bySlug(gatewaySlug: string, instrumentSlug: string): string | null;
  byDeviceKey(gatewaySlug: string, deviceKey: string): string | null;
}

export interface FanOutBatch {
  instrumentId: string;
  readings: Reading[];
}

export interface FanOutResult {
  batches: FanOutBatch[];
  deadLetters: { reason: string; detail: string }[];
}

export function fanOut(
  route: TopicRoute,
  parsed: ParsedPayload,
  resolver: InstrumentResolver,
  receivedAt: Date,
): FanOutResult {
  if (!parsed.ok) {
    return { batches: [], deadLetters: [{ reason: 'UNPARSEABLE_PAYLOAD', detail: parsed.reason ?? 'unknown' }] };
  }

  const ts = parsed.ts ?? receivedAt;
  const batches: FanOutBatch[] = [];
  const deadLetters: { reason: string; detail: string }[] = [];

  const push = (instrumentId: string, values: Record<string, unknown>, label: string) => {
    const readings = toReadings(values, ts);
    if (readings.length === 0) {
      deadLetters.push({ reason: 'NO_READINGS', detail: `${label} produced no usable values` });
      return;
    }
    batches.push({ instrumentId, readings });
  };

  if (route.instrumentSlug !== null) {
    const id = resolver.bySlug(route.gatewaySlug, route.instrumentSlug);
    if (!id) {
      deadLetters.push({
        reason: 'UNKNOWN_INSTRUMENT',
        detail: `No instrument '${route.instrumentSlug}' under gateway '${route.gatewaySlug}'`,
      });
      return { batches, deadLetters };
    }
    push(id, parsed.values, route.instrumentSlug);
    return { batches, deadLetters };
  }

  if (!parsed.devices) {
    deadLetters.push({
      reason: 'EXPECTED_BATCH_PAYLOAD',
      detail: `Gateway-level topic requires a 'devices' object`,
    });
    return { batches, deadLetters };
  }

  for (const [deviceKey, values] of Object.entries(parsed.devices)) {
    const id = resolver.byDeviceKey(route.gatewaySlug, deviceKey);
    if (!id) {
      // Only THIS entry is lost. The rest of the batch still lands.
      deadLetters.push({
        reason: 'UNKNOWN_DEVICE_KEY',
        detail: `No instrument with deviceKey '${deviceKey}' under gateway '${route.gatewaySlug}'`,
      });
      continue;
    }
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      deadLetters.push({ reason: 'INVALID_DEVICE_ENTRY', detail: `devices['${deviceKey}'] is not an object` });
      continue;
    }
    push(id, values as Record<string, unknown>, deviceKey);
  }

  return { batches, deadLetters };
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd apps/api && npx vitest run src/modules/data-injection/__tests__/fan-out.test.ts
```
Expected: 8 passed.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /c/Users/hello/compliance-core && npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/modules/data-injection/fan-out.ts apps/api/src/modules/data-injection/__tests__/fan-out.test.ts
git commit -m "Add pure fan-out: topic- and payload-addressed message splitting"
```

---

## Task 5: Schema + partitioned migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260801140000_telemetry/migration.sql`

**Interfaces:**
- Produces: models `InstrumentTelemetryLatest`, `InstrumentTelemetryHistory`, `DeadLetter`; table `instrument_telemetry_history` partitioned by month

- [ ] **Step 1: VERIFY THE CORE ASSUMPTION FIRST — do not skip this**

The spec assumes Prisma tolerates a partitioned parent declared as an ordinary model. **Prove it before building on it.** Create the table by hand in a scratch database, add the model, and check `migrate diff` proposes nothing:

```bash
cd /c/Users/hello/compliance-core && ./stop-app.bat
```

If `prisma migrate diff` proposes dropping or altering the partitioned table, **STOP and report** rather than forcing it. The fallback is `Unsupported(...)` or a documented drift-guard exception — a decision to surface, not to improvise.

- [ ] **Step 2: Add the three models to `schema.prisma`**

```prisma
model InstrumentTelemetryLatest {
  instrumentId String   @map("instrument_id")
  key          String
  value        Json
  valueType    String   @map("value_type")
  quality      String?
  ts           DateTime
  receivedAt   DateTime @map("received_at")
  @@id([instrumentId, key])
  @@index([instrumentId])
  @@map("instrument_telemetry_latest")
}

model InstrumentTelemetryHistory {
  instrumentId String   @map("instrument_id")
  key          String
  value        Json
  valueType    String   @map("value_type")
  quality      String?
  ts           DateTime
  receivedAt   DateTime @default(now()) @map("received_at")
  // PK MUST include ts: PostgreSQL requires a partitioned table's primary key
  // to contain every partition column. A synthetic id would be rejected outright.
  @@id([instrumentId, key, ts])
  @@map("instrument_telemetry_history")
}

model DeadLetter {
  id          String    @id @default(uuid())
  protocolKey String    @map("protocol_key")
  topic       String
  payload     String
  reason      String
  detail      String?
  receivedAt  DateTime  @default(now()) @map("received_at")
  resolvedAt  DateTime? @map("resolved_at")
  resolvedBy  String?   @map("resolved_by")
  @@index([receivedAt])
  @@index([resolvedAt])
  @@map("dead_letters")
}
```

- [ ] **Step 3: Hand-author the migration**

Generate a candidate, then hand-author. `20260801140000_telemetry/migration.sql`:

```sql
-- Latest values: one row per (instrument, key). Hot path for the live panel.
CREATE TABLE "instrument_telemetry_latest" (
  "instrument_id" TEXT NOT NULL,
  "key"           TEXT NOT NULL,
  "value"         JSONB NOT NULL,
  "value_type"    TEXT NOT NULL,
  "quality"       TEXT,
  "ts"            TIMESTAMP(3) NOT NULL,
  "received_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "instrument_telemetry_latest_pkey" PRIMARY KEY ("instrument_id","key")
);
CREATE INDEX "instrument_telemetry_latest_instrument_id_idx"
  ON "instrument_telemetry_latest"("instrument_id");

-- History: monthly range partitions. Retention is a partition DROP, not a DELETE
-- of millions of rows. Prisma cannot express PARTITION BY, so this is raw SQL —
-- but the model IS declared in schema.prisma so migrate diff stays quiet.
CREATE TABLE "instrument_telemetry_history" (
  "instrument_id" TEXT NOT NULL,
  "key"           TEXT NOT NULL,
  "value"         JSONB NOT NULL,
  "value_type"    TEXT NOT NULL,
  "quality"       TEXT,
  "ts"            TIMESTAMP(3) NOT NULL,
  "received_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "instrument_telemetry_history_pkey"
    PRIMARY KEY ("instrument_id","key","ts")
) PARTITION BY RANGE ("ts");

CREATE INDEX "instrument_telemetry_history_lookup_idx"
  ON "instrument_telemetry_history"("instrument_id","key","ts" DESC);

-- Seed the current and next month so inserts work immediately. The
-- telemetry_partition_maintenance job keeps this rolling forward; without a
-- future partition, inserts fail at midnight on the 1st.
CREATE TABLE "instrument_telemetry_history_2026_08" PARTITION OF "instrument_telemetry_history"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "instrument_telemetry_history_2026_09" PARTITION OF "instrument_telemetry_history"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

CREATE TABLE "dead_letters" (
  "id"           TEXT NOT NULL,
  "protocol_key" TEXT NOT NULL,
  "topic"        TEXT NOT NULL,
  "payload"      TEXT NOT NULL,
  "reason"       TEXT NOT NULL,
  "detail"       TEXT,
  "received_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at"  TIMESTAMP(3),
  "resolved_by"  TEXT,
  CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "dead_letters_received_at_idx" ON "dead_letters"("received_at");
CREATE INDEX "dead_letters_resolved_at_idx" ON "dead_letters"("resolved_at");
```

**No foreign key from telemetry to `instruments`.** Same reasoning as `audit_trail`: a cascade would destroy history when an instrument is deleted, and a restrict would make deletion impossible. `instrument_id` is a plain column.

**Scan the migration for destructive statements before applying.** If the generated candidate contains any `DROP`, `TRUNCATE`, or `ALTER … DROP`, stop and report — do not clean it up and proceed.

- [ ] **Step 4: Apply and verify**

```bash
cd apps/api && npx prisma migrate deploy && npx prisma generate
DATABASE_URL="postgresql://digilog:digilog123@localhost:5432/compliance_core_db_test?schema=public" npx prisma migrate deploy
```

- [ ] **Step 5: Drift guard MUST pass**

```bash
cd /c/Users/hello/compliance-core && powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-migrations.ps1
```
Expected: `PASS: migrations reproduce the reference schema exactly.` If it fails, fix the migration — never commit past a failing drift guard.

- [ ] **Step 6: Confirm partitioning is real**

```bash
PGPASSWORD=digilog123 psql -U digilog -d compliance_core_db -c "\d+ instrument_telemetry_history" | grep -i partition
```
Expected: shows `Partition key: RANGE (ts)` and lists the two partitions.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/
git commit -m "Add telemetry schema: latest, monthly-partitioned history, dead letters"
```

---

## Task 6: Telemetry repository (all raw SQL)

**Files:**
- Create: `apps/api/src/modules/data-injection/telemetry.repository.ts`
- Test: `apps/api/src/modules/data-injection/__tests__/telemetry.repository.test.ts`

**Interfaces:**
- Produces: `writeBatch(batches, receivedAt)`, `getLatest(instrumentId)`, `getHistory({instrumentId, key, from, to, limit, offset})`, `writeDeadLetters(rows)`, `buildResolverCache()`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/data-injection/__tests__/telemetry.repository.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import { writeBatch, getLatest, getHistory, writeDeadLetters } from '../telemetry.repository.js';

const INST = 'test-instrument-repo';
const AT = new Date('2026-08-15T10:00:00.000Z');

describe('telemetry repository', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM instrument_telemetry_latest WHERE instrument_id = '${INST}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM instrument_telemetry_history WHERE instrument_id = '${INST}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM dead_letters WHERE topic = 'repo/test'`);
  });

  it('writes latest and history in one batch', async () => {
    await writeBatch([{ instrumentId: INST, readings: [
      { key: 'temp', value: 21.5, valueType: 'float', ts: AT },
      { key: 'on', value: true, valueType: 'boolean', ts: AT },
    ] }], AT);

    const latest = await getLatest(INST);
    expect(latest.map(r => r.key).sort()).toEqual(['on', 'temp']);
    expect(latest.find(r => r.key === 'temp')!.value).toBe(21.5);

    const hist = await getHistory({ instrumentId: INST, limit: 10 });
    expect(hist.rows).toHaveLength(2);
  });

  it('upserts latest on a repeat key but appends to history', async () => {
    const later = new Date(AT.getTime() + 60_000);
    await writeBatch([{ instrumentId: INST, readings: [{ key: 'temp', value: 1, valueType: 'int', ts: AT }] }], AT);
    await writeBatch([{ instrumentId: INST, readings: [{ key: 'temp', value: 2, valueType: 'int', ts: later }] }], later);

    const latest = await getLatest(INST);
    expect(latest).toHaveLength(1);
    expect(latest[0].value).toBe(2);              // overwritten
    const hist = await getHistory({ instrumentId: INST, limit: 10 });
    expect(hist.rows).toHaveLength(2);            // both retained
  });

  it('preserves value types across a round trip', async () => {
    await writeBatch([{ instrumentId: INST, readings: [
      { key: 'b', value: true, valueType: 'boolean', ts: AT },
      { key: 'i', value: 7, valueType: 'int', ts: AT },
      { key: 'f', value: 1.5, valueType: 'float', ts: AT },
      { key: 's', value: 'ok', valueType: 'string', ts: AT },
      { key: 'j', value: { a: 1 }, valueType: 'json', ts: AT },
    ] }], AT);
    const byKey = Object.fromEntries((await getLatest(INST)).map(r => [r.key, r]));
    expect(byKey.b.value).toBe(true);
    expect(byKey.i.value).toBe(7);
    expect(byKey.f.value).toBe(1.5);
    expect(byKey.s.value).toBe('ok');
    expect(byKey.j.value).toEqual({ a: 1 });
    expect(byKey.i.valueType).toBe('int');
  });

  it('filters history by key and time window', async () => {
    const t1 = new Date('2026-08-10T00:00:00Z');
    const t2 = new Date('2026-08-20T00:00:00Z');
    await writeBatch([{ instrumentId: INST, readings: [{ key: 'temp', value: 1, valueType: 'int', ts: t1 }] }], t1);
    await writeBatch([{ instrumentId: INST, readings: [{ key: 'temp', value: 2, valueType: 'int', ts: t2 }] }], t2);
    await writeBatch([{ instrumentId: INST, readings: [{ key: 'rh', value: 9, valueType: 'int', ts: t2 }] }], t2);

    const onlyTemp = await getHistory({ instrumentId: INST, key: 'temp', limit: 10 });
    expect(onlyTemp.rows).toHaveLength(2);
    const windowed = await getHistory({
      instrumentId: INST, key: 'temp',
      from: new Date('2026-08-15T00:00:00Z'), limit: 10,
    });
    expect(windowed.rows).toHaveLength(1);
    expect(windowed.rows[0].value).toBe(2);
  });

  it('writes dead letters', async () => {
    await writeDeadLetters([
      { protocolKey: 'mqtt', topic: 'repo/test', payload: '{}', reason: 'UNKNOWN_DEVICE_KEY', detail: 'ghost' },
    ]);
    const n = await prisma.deadLetter.count({ where: { topic: 'repo/test' } });
    expect(n).toBe(1);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```bash
cd apps/api && npx vitest run src/modules/data-injection/__tests__/telemetry.repository.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/data-injection/telemetry.repository.ts
/**
 * Telemetry persistence — the ONLY file in this module containing raw SQL.
 *
 * Raw because:
 *  - the history table is PARTITIONED, which Prisma cannot express, and
 *  - ingest writes must be BATCHED; one Prisma call per reading will not survive
 *    a real fleet.
 *
 * NOTE: telemetry writes are deliberately NOT audited (spec D5). Telemetry is
 * process data, not a 21 CFR §11 electronic record. Do not add auditLog() here.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import type { Reading } from './payload-parser.js';

export interface TelemetryRow {
  key: string;
  value: unknown;
  valueType: string;
  quality: string | null;
  ts: Date;
  receivedAt: Date;
}

export async function writeBatch(
  batches: { instrumentId: string; readings: Reading[] }[],
  receivedAt: Date,
): Promise<void> {
  const flat = batches.flatMap(b => b.readings.map(r => ({ instrumentId: b.instrumentId, r })));
  if (flat.length === 0) return;

  const histValues = Prisma.join(flat.map(({ instrumentId, r }) => Prisma.sql`(
    ${instrumentId}, ${r.key}, ${JSON.stringify(r.value)}::jsonb,
    ${r.valueType}, ${r.quality ?? null}, ${r.ts}, ${receivedAt})`));

  const latestValues = Prisma.join(flat.map(({ instrumentId, r }) => Prisma.sql`(
    ${instrumentId}, ${r.key}, ${JSON.stringify(r.value)}::jsonb,
    ${r.valueType}, ${r.quality ?? null}, ${r.ts}, ${receivedAt})`));

  await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO instrument_telemetry_history
        (instrument_id, key, value, value_type, quality, ts, received_at)
      VALUES ${histValues}
      ON CONFLICT (instrument_id, key, ts) DO NOTHING`,
    // A device that re-sends the same (instrument, key, ts) is a duplicate, not
    // new information — DO NOTHING keeps history idempotent under redelivery,
    // which MQTT QoS 1 makes routine.
    prisma.$executeRaw`
      INSERT INTO instrument_telemetry_latest
        (instrument_id, key, value, value_type, quality, ts, received_at)
      VALUES ${latestValues}
      ON CONFLICT (instrument_id, key) DO UPDATE SET
        value = EXCLUDED.value, value_type = EXCLUDED.value_type,
        quality = EXCLUDED.quality, ts = EXCLUDED.ts, received_at = EXCLUDED.received_at
      WHERE instrument_telemetry_latest.ts <= EXCLUDED.ts`,
    // The WHERE guard stops an out-of-order arrival overwriting a NEWER value.
  ]);
}

export async function getLatest(instrumentId: string): Promise<TelemetryRow[]> {
  return prisma.$queryRaw<TelemetryRow[]>`
    SELECT key, value, value_type AS "valueType", quality, ts, received_at AS "receivedAt"
    FROM instrument_telemetry_latest
    WHERE instrument_id = ${instrumentId}
    ORDER BY key`;
}

export async function getHistory(opts: {
  instrumentId: string; key?: string; from?: Date; to?: Date; limit?: number; offset?: number;
}): Promise<{ rows: TelemetryRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 100, 1000);
  const offset = opts.offset ?? 0;
  const where = Prisma.sql`
    WHERE instrument_id = ${opts.instrumentId}
    ${opts.key ? Prisma.sql`AND key = ${opts.key}` : Prisma.empty}
    ${opts.from ? Prisma.sql`AND ts >= ${opts.from}` : Prisma.empty}
    ${opts.to ? Prisma.sql`AND ts <= ${opts.to}` : Prisma.empty}`;

  const rows = await prisma.$queryRaw<TelemetryRow[]>`
    SELECT key, value, value_type AS "valueType", quality, ts, received_at AS "receivedAt"
    FROM instrument_telemetry_history ${where}
    ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}`;

  const [{ count }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM instrument_telemetry_history ${where}`;

  return { rows, total: Number(count) };
}

export async function writeDeadLetters(
  rows: { protocolKey: string; topic: string; payload: string; reason: string; detail?: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  await prisma.deadLetter.createMany({
    data: rows.map(r => ({ ...r, detail: r.detail ?? null })),
  });
}

/**
 * Slug/deviceKey → instrumentId lookup for the fan-out resolver.
 *
 * Keys are joined with '|', which sanitizeSlug can never emit (it strips
 * everything outside [a-z0-9-]). Plain concatenation would collide:
 * gateway 'gw-1' + instrument '0temp' would equal 'gw-10' + 'temp'.
 * Loaded once per flush rather than per message: a 500-reading batch would
 * otherwise issue 500 lookups for what is almost always the same few gateways.
 */
export async function buildResolverCache(): Promise<{
  bySlug: Map<string, string>; byDeviceKey: Map<string, string>;
}> {
  const rows = await prisma.instrument.findMany({
    where: { isActive: true, gateway: { isNot: null } },
    select: { id: true, slug: true, deviceKey: true, gateway: { select: { slug: true } } },
  });
  const bySlug = new Map<string, string>();
  const byDeviceKey = new Map<string, string>();
  for (const r of rows) {
    if (!r.gateway) continue;
    bySlug.set(`${r.gateway.slug}|${r.slug}`, r.id);
    if (r.deviceKey) byDeviceKey.set(`${r.gateway.slug}|${r.deviceKey}`, r.id);
  }
  return { bySlug, byDeviceKey };
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd apps/api && npx vitest run src/modules/data-injection/__tests__/telemetry.repository.test.ts
```
Expected: 5 passed.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /c/Users/hello/compliance-core && npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/modules/data-injection/telemetry.repository.ts apps/api/src/modules/data-injection/__tests__/telemetry.repository.test.ts
git commit -m "Add telemetry repository: batched partitioned writes, latest upsert, history reads"
```

---

## Task 7: MQTT adapter

**Files:**
- Create: `apps/api/src/modules/data-injection/adapters/mqtt.adapter.ts`
- Test: `apps/api/src/modules/data-injection/adapters/__tests__/mqtt.adapter.test.ts`

**Interfaces:**
- Consumes: `IProtocolAdapter`, `InboundMessage`, `ProfileWithSecrets` (Task 1)
- Produces: `createMqttAdapter(): IProtocolAdapter`

- [ ] **Step 1: Write the failing integration test (real in-process broker)**

```ts
// apps/api/src/modules/data-injection/adapters/__tests__/mqtt.adapter.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:net';
import Aedes from 'aedes';
import mqtt from 'mqtt';
import { createMqttAdapter } from '../mqtt.adapter.js';
import type { InboundMessage } from '../protocol-adapter.js';

const PORT = 18883;
let broker: Aedes;
let server: Server;

beforeAll(async () => {
  broker = new Aedes();
  server = createServer(broker.handle as never);
  await new Promise<void>(r => server.listen(PORT, r));
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  await new Promise<void>(r => broker.close(r));
});

const profile = {
  id: 'p1', name: 'Test', protocolKey: 'mqtt',
  config: { brokerUrl: `mqtt://localhost:${PORT}`, topicFilter: 'test/#', qos: 1 },
};

describe('mqtt adapter', () => {
  it('connects, subscribes, and delivers a message', async () => {
    const adapter = createMqttAdapter();
    const got: InboundMessage[] = [];
    await adapter.start(profile, async m => { got.push(m); });

    const pub = mqtt.connect(`mqtt://localhost:${PORT}`);
    await new Promise<void>(r => pub.on('connect', () => r()));
    pub.publish('test/gw-001/temp001/telemetry', JSON.stringify({ temp: 21.5 }), { qos: 1 });

    await new Promise(r => setTimeout(r, 400));
    expect(got).toHaveLength(1);
    expect(got[0].topic).toBe('test/gw-001/temp001/telemetry');
    expect(JSON.parse(got[0].payload.toString()).temp).toBe(21.5);
    expect(adapter.health().connected).toBe(true);
    expect(adapter.health().messagesReceived).toBe(1);

    pub.end();
    await adapter.stop();
    expect(adapter.health().connected).toBe(false);
  });

  it('a handler that throws does not kill the connection', async () => {
    const adapter = createMqttAdapter();
    let calls = 0;
    await adapter.start(profile, async () => { calls++; throw new Error('boom'); });

    const pub = mqtt.connect(`mqtt://localhost:${PORT}`);
    await new Promise<void>(r => pub.on('connect', () => r()));
    pub.publish('test/a/b/telemetry', '{"x":1}', { qos: 1 });
    await new Promise(r => setTimeout(r, 300));
    pub.publish('test/a/b/telemetry', '{"x":2}', { qos: 1 });
    await new Promise(r => setTimeout(r, 300));

    expect(calls).toBe(2);                       // still receiving after a throw
    expect(adapter.health().connected).toBe(true);
    expect(adapter.health().lastError).toContain('boom');

    pub.end();
    await adapter.stop();
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```bash
cd apps/api && npx vitest run src/modules/data-injection/adapters/__tests__/mqtt.adapter.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/data-injection/adapters/mqtt.adapter.ts
/**
 * MQTT adapter — the app is a CLIENT of an external broker (spec D2).
 *
 * Connection details come from the P1 CommunicationProfile config, WITH secrets
 * unmasked. That value must never be returned over HTTP or written to an audit
 * row; this is the one legitimate consumer of the raw form.
 */
import mqtt, { type MqttClient } from 'mqtt';
import type { IProtocolAdapter, InboundMessage, AdapterHealth, ProfileWithSecrets } from './protocol-adapter.js';

export function createMqttAdapter(): IProtocolAdapter {
  let client: MqttClient | null = null;
  let profileId = '';
  const health: AdapterHealth = {
    connected: false, lastMessageAt: null, lastErrorAt: null,
    lastError: null, messagesReceived: 0, reconnectCount: 0,
  };

  return {
    protocolKey: 'mqtt',

    async start(profile: ProfileWithSecrets, onMessage) {
      profileId = profile.id;
      const cfg = profile.config as {
        brokerUrl?: string; username?: string; password?: string;
        topicFilter?: string; qos?: 0 | 1 | 2; clientId?: string;
      };
      if (!cfg.brokerUrl) throw new Error(`Profile '${profile.name}' has no brokerUrl.`);

      const filter = cfg.topicFilter ?? '#';
      const qos = (cfg.qos ?? 1) as 0 | 1 | 2;

      client = mqtt.connect(cfg.brokerUrl, {
        username: cfg.username,
        password: cfg.password,
        clientId: cfg.clientId ?? `compliance-core-${profile.id.slice(0, 8)}`,
        reconnectPeriod: 1000,     // mqtt.js backs off internally; capped below
        connectTimeout: 15_000,
        clean: true,
      });

      client.on('connect', () => {
        health.connected = true;
        client!.subscribe(filter, { qos });
      });
      client.on('reconnect', () => { health.reconnectCount++; });
      client.on('close', () => { health.connected = false; });
      client.on('error', (err) => {
        health.lastError = err.message;
        health.lastErrorAt = new Date();
      });
      client.on('message', (topic, payload, packet) => {
        health.messagesReceived++;
        health.lastMessageAt = new Date();
        // A handler failure must never take down the connection. Record it and
        // keep consuming — one poison payload cannot be allowed to stop ingest.
        void onMessage({
          protocolKey: 'mqtt', profileId, topic, payload,
          receivedAt: new Date(), qos: packet.qos, retained: packet.retain,
        }).catch((e: unknown) => {
          health.lastError = (e as Error).message;
          health.lastErrorAt = new Date();
        });
      });

      // Resolve once connected OR once the first connection attempt fails, so a
      // dead broker does not hang API startup forever.
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        client!.once('connect', done);
        client!.once('error', done);
        setTimeout(done, 15_000);
      });
    },

    async stop() {
      if (!client) return;
      await new Promise<void>(r => client!.end(false, {}, () => r()));
      client = null;
      health.connected = false;
    },

    health: () => ({ ...health }),

    async publish(topic, payload, opts) {
      if (!client) throw new Error('MQTT adapter is not started.');
      await new Promise<void>((resolve, reject) => {
        client!.publish(topic, payload, { qos: (opts?.qos ?? 1) as 0 | 1 | 2, retain: opts?.retain ?? false },
          err => (err ? reject(err) : resolve()));
      });
    },
  };
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd apps/api && npx vitest run src/modules/data-injection/adapters/__tests__/mqtt.adapter.test.ts
```
Expected: 2 passed.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /c/Users/hello/compliance-core && npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/modules/data-injection/adapters/
git commit -m "Add MQTT adapter with health tracking and poison-payload isolation"
```

---

## Task 8: Connection manager

**Files:**
- Create: `apps/api/src/modules/data-injection/connection-manager.ts`
- Test: `apps/api/src/modules/data-injection/__tests__/connection-manager.test.ts`

**Interfaces:**
- Consumes: registry + adapters (Tasks 1, 7)
- Produces: `startConnections(onMessage)`, `stopConnections()`, `getConnectionHealth(): Record<string, AdapterHealth & {profileName: string; protocolKey: string}>`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/data-injection/__tests__/connection-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import { registerAdapter, clearAdaptersForTest, type IProtocolAdapter } from '../adapters/protocol-adapter.js';
import { startConnections, stopConnections, getConnectionHealth } from '../connection-manager.js';

let started: string[] = [];
const fake = (key: string, failOnStart = false): IProtocolAdapter => ({
  protocolKey: key,
  async start(p) { if (failOnStart) throw new Error('cannot connect'); started.push(p.id); },
  async stop() {},
  health: () => ({ connected: !failOnStart, lastMessageAt: null, lastErrorAt: null, lastError: null, messagesReceived: 0, reconnectCount: 0 }),
});

describe('connection manager', () => {
  beforeEach(async () => {
    clearAdaptersForTest();
    started = [];
    await prisma.$executeRawUnsafe(`DELETE FROM communication_profiles WHERE name LIKE 'cmtest-%'`);
    await prisma.protocol.updateMany({ where: { key: 'mqtt' }, data: { isEnabled: false } });
  });
  afterEach(async () => { await stopConnections(); });

  it('starts nothing when the protocol is disabled', async () => {
    await prisma.communicationProfile.create({
      data: { name: 'cmtest-a', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://x' } },
    });
    registerAdapter(fake('mqtt'));
    await startConnections(async () => {});
    expect(started).toEqual([]);
  });

  it('starts one connection per active profile when the protocol is enabled', async () => {
    await prisma.protocol.update({ where: { key: 'mqtt' }, data: { isEnabled: true } });
    const p = await prisma.communicationProfile.create({
      data: { name: 'cmtest-b', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://x' } },
    });
    registerAdapter(fake('mqtt'));
    await startConnections(async () => {});
    expect(started).toContain(p.id);
    expect(getConnectionHealth()[p.id].connected).toBe(true);
  });

  it('one failing profile does not prevent the others starting', async () => {
    await prisma.protocol.update({ where: { key: 'mqtt' }, data: { isEnabled: true } });
    await prisma.communicationProfile.create({
      data: { name: 'cmtest-c', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://x' } },
    });
    registerAdapter(fake('mqtt', true));
    await expect(startConnections(async () => {})).resolves.not.toThrow();
  });

  it('skips inactive profiles', async () => {
    await prisma.protocol.update({ where: { key: 'mqtt' }, data: { isEnabled: true } });
    const p = await prisma.communicationProfile.create({
      data: { name: 'cmtest-d', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://x' }, isActive: false },
    });
    registerAdapter(fake('mqtt'));
    await startConnections(async () => {});
    expect(started).not.toContain(p.id);
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```bash
cd apps/api && npx vitest run src/modules/data-injection/__tests__/connection-manager.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/data-injection/connection-manager.ts
/**
 * Connection lifecycle: one adapter instance per ACTIVE profile whose protocol
 * is ENABLED.
 *
 * Every failure here is isolated and non-fatal. A broker being down must leave
 * the configuration UI usable — otherwise an outage locks you out of the very
 * settings needed to fix it.
 */
import { prisma } from '../../lib/prisma.js';
import { getAdapter, type AdapterHealth, type IProtocolAdapter, type InboundMessage } from './adapters/protocol-adapter.js';

interface Live {
  adapter: IProtocolAdapter;
  profileName: string;
  protocolKey: string;
  startError: string | null;
}

const live = new Map<string, Live>();

export async function startConnections(
  onMessage: (m: InboundMessage) => Promise<void>,
): Promise<void> {
  const profiles = await prisma.communicationProfile.findMany({
    where: { isActive: true, protocol: { isEnabled: true } },
  });

  for (const p of profiles) {
    const adapter = getAdapter(p.protocolKey);
    if (!adapter) continue;                       // protocol enabled but no adapter shipped yet
    const entry: Live = { adapter, profileName: p.name, protocolKey: p.protocolKey, startError: null };
    live.set(p.id, entry);
    try {
      await adapter.start(
        { id: p.id, name: p.name, protocolKey: p.protocolKey, config: p.config as Record<string, unknown> },
        onMessage,
      );
    } catch (e) {
      // Isolated on purpose: one unreachable broker must not stop the others.
      entry.startError = (e as Error).message;
    }
  }
}

export async function stopConnections(): Promise<void> {
  for (const entry of live.values()) {
    try { await entry.adapter.stop(); } catch { /* shutting down; nothing useful to do */ }
  }
  live.clear();
}

export function getConnectionHealth(): Record<
  string, AdapterHealth & { profileName: string; protocolKey: string; startError: string | null }
> {
  const out: Record<string, AdapterHealth & { profileName: string; protocolKey: string; startError: string | null }> = {};
  for (const [id, e] of live) {
    out[id] = { ...e.adapter.health(), profileName: e.profileName, protocolKey: e.protocolKey, startError: e.startError };
  }
  return out;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd apps/api && npx vitest run src/modules/data-injection/__tests__/connection-manager.test.ts
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/data-injection/connection-manager.ts apps/api/src/modules/data-injection/__tests__/connection-manager.test.ts
git commit -m "Add connection manager with per-profile isolation"
```

---

## Task 9: Ingestion service — queue, batching, dead-lettering

**Files:**
- Create: `apps/api/src/modules/data-injection/ingestion.service.ts`
- Test: `apps/api/src/modules/data-injection/__tests__/ingestion.service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 3, 4, 6
- Produces: `enqueue(m: InboundMessage)`, `flushNow()`, `getQueueStats(): {depth: number; dropped: number; flushed: number}`, `startFlushLoop()`, `stopFlushLoop()`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/modules/data-injection/__tests__/ingestion.service.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import { enqueue, flushNow, getQueueStats, resetQueueForTest } from '../ingestion.service.js';
import { getLatest } from '../telemetry.repository.js';

const buf = (o: unknown) => Buffer.from(JSON.stringify(o));
let hierarchyId = '', gatewayId = '', instA = '', instB = '';

beforeEach(async () => {
  resetQueueForTest();
  await prisma.$executeRawUnsafe(`DELETE FROM dead_letters WHERE topic LIKE 'ing/%'`);
  const node = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO hierarchy_nodes (id, parent_id, level, name, slug, path, sort_order, is_active, created_at, updated_at)
    VALUES (gen_random_uuid(), NULL, 'COMPANY', 'IngTest', 'ingtest', 'ingtest'::ltree, 0, true, now(), now())
    ON CONFLICT (parent_id, slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id`;
  hierarchyId = node[0].id;
  const prof = await prisma.communicationProfile.upsert({
    where: { name: 'ing-profile' },
    update: {}, create: { name: 'ing-profile', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://x' } },
  });
  const gw = await prisma.gateway.upsert({
    where: { code: 'INGGW' }, update: {},
    create: { name: 'Ing GW', code: 'INGGW', slug: 'ing-gw', gatewayType: 'edge', externalId: 'ing-gw',
              hierarchyNodeId: hierarchyId, communicationProfileId: prof.id },
  });
  gatewayId = gw.id;
  const a = await prisma.instrument.upsert({
    where: { code: 'INGA' }, update: {},
    create: { name: 'Ing A', code: 'INGA', slug: 'ing-a', instrumentType: 'sensor',
              hierarchyNodeId: hierarchyId, gatewayId, deviceKey: 'inga' },
  });
  const b = await prisma.instrument.upsert({
    where: { code: 'INGB' }, update: {},
    create: { name: 'Ing B', code: 'INGB', slug: 'ing-b', instrumentType: 'sensor',
              hierarchyNodeId: hierarchyId, gatewayId, deviceKey: 'ingb' },
  });
  instA = a.id; instB = b.id;
});
afterEach(async () => { resetQueueForTest(); });

describe('ingestion service', () => {
  it('lands a topic-addressed message as telemetry', async () => {
    await enqueue({ protocolKey: 'mqtt', profileId: 'p', topic: 'ing/ing-gw/ing-a/telemetry',
                    payload: buf({ temp: 21.5 }), receivedAt: new Date() });
    await flushNow();
    const latest = await getLatest(instA);
    expect(latest.find(r => r.key === 'temp')?.value).toBe(21.5);
  });

  it('splits a batch across two instruments', async () => {
    await enqueue({ protocolKey: 'mqtt', profileId: 'p', topic: 'ing/ing-gw/telemetry',
                    payload: buf({ devices: { inga: { t: 1 }, ingb: { t: 2 } } }), receivedAt: new Date() });
    await flushNow();
    expect((await getLatest(instA)).find(r => r.key === 't')?.value).toBe(1);
    expect((await getLatest(instB)).find(r => r.key === 't')?.value).toBe(2);
  });

  it('dead-letters one unknown key while still writing the good one', async () => {
    await enqueue({ protocolKey: 'mqtt', profileId: 'p', topic: 'ing/ing-gw/telemetry',
                    payload: buf({ devices: { inga: { t: 5 }, ghost: { t: 9 } } }), receivedAt: new Date() });
    await flushNow();
    expect((await getLatest(instA)).find(r => r.key === 't')?.value).toBe(5);
    const dl = await prisma.deadLetter.findMany({ where: { reason: 'UNKNOWN_DEVICE_KEY' } });
    expect(dl.length).toBeGreaterThanOrEqual(1);
  });

  it('dead-letters an unroutable topic', async () => {
    await enqueue({ protocolKey: 'mqtt', profileId: 'p', topic: 'ing/nonsense',
                    payload: buf({ t: 1 }), receivedAt: new Date() });
    await flushNow();
    const dl = await prisma.deadLetter.findFirst({ where: { reason: 'UNROUTABLE_TOPIC' } });
    expect(dl).not.toBeNull();
  });

  it('dead-letters on queue overflow rather than silently dropping', async () => {
    resetQueueForTest(2);   // tiny queue
    for (let i = 0; i < 5; i++) {
      await enqueue({ protocolKey: 'mqtt', profileId: 'p', topic: 'ing/ing-gw/ing-a/telemetry',
                      payload: buf({ t: i }), receivedAt: new Date() });
    }
    expect(getQueueStats().dropped).toBeGreaterThan(0);
    await flushNow();
    const dl = await prisma.deadLetter.findFirst({ where: { reason: 'QUEUE_OVERFLOW' } });
    expect(dl).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect failure**

```bash
cd apps/api && npx vitest run src/modules/data-injection/__tests__/ingestion.service.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/modules/data-injection/ingestion.service.ts
/**
 * Ingestion orchestration: queue → route → parse → fan-out → batched write.
 *
 * Writing one row per message will not survive a real fleet, so messages
 * accumulate in a BOUNDED queue and flush on an interval or a size threshold.
 *
 * The queue is in-process and does NOT survive a restart. That is an accepted
 * limitation of the single-instance design, stated so nobody assumes durability
 * the system does not have.
 */
import type { InboundMessage } from './adapters/protocol-adapter.js';
import { tailOf, routeTail } from './topic-router.js';
import { parsePayload } from './payload-parser.js';
import { fanOut, type InstrumentResolver } from './fan-out.js';
import { writeBatch, writeDeadLetters, buildResolverCache } from './telemetry.repository.js';

const FLUSH_MS = 250;
const FLUSH_SIZE = 500;
const DEFAULT_MAX_QUEUE = 10_000;
/** Topic separator. Matches the uns-settings default; '/' is MQTT's own. */
const SEPARATOR = '/';

let queue: InboundMessage[] = [];
let maxQueue = DEFAULT_MAX_QUEUE;
let dropped = 0;
let flushed = 0;
let timer: NodeJS.Timeout | null = null;
const overflowDeadLetters: { protocolKey: string; topic: string; payload: string; reason: string; detail: string }[] = [];

export async function enqueue(m: InboundMessage): Promise<void> {
  if (queue.length >= maxQueue) {
    // Drop the OLDEST and record it. Silent loss is indistinguishable from data
    // that never arrived; an operator needs to see that ingest fell behind.
    const victim = queue.shift();
    dropped++;
    if (victim) {
      overflowDeadLetters.push({
        protocolKey: victim.protocolKey, topic: victim.topic,
        payload: victim.payload.toString('utf8').slice(0, 4000),
        reason: 'QUEUE_OVERFLOW',
        detail: `Ingest queue full (${maxQueue}); oldest message discarded`,
      });
    }
  }
  queue.push(m);
  if (queue.length >= FLUSH_SIZE) await flushNow();
}

export async function flushNow(): Promise<void> {
  const batchMsgs = queue;
  queue = [];
  const overflow = overflowDeadLetters.splice(0, overflowDeadLetters.length);
  if (batchMsgs.length === 0 && overflow.length === 0) return;

  const deadLetters = [...overflow];
  const allBatches: { instrumentId: string; readings: import('./payload-parser.js').Reading[] }[] = [];

  // One resolver load per flush, not per message.
  const cache = await buildResolverCache();
  const resolver: InstrumentResolver = {
    bySlug: (g, i) => cache.bySlug.get(`${g}|${i}`) ?? null,
    byDeviceKey: (g, k) => cache.byDeviceKey.get(`${g}|${k}`) ?? null,
  };

  for (const m of batchMsgs) {
    // REVISED: gateway comes from the subscription (m.gatewaySlug), not parsing.
    const tail = tailOf(m.topic, m.baseTopic, SEPARATOR);
    const routed = tail === null ? null : routeTail(tail, SEPARATOR);
    if (!routed) {
      deadLetters.push({
        protocolKey: m.protocolKey, topic: m.topic,
        payload: m.payload.toString('utf8').slice(0, 4000),
        reason: 'UNROUTABLE_TOPIC',
        detail: 'Topic is not under the subscribed base, does not end in a known '
              + 'category, or has an ambiguous tail depth',
      });
      continue;
    }
    const route = { gatewaySlug: m.gatewaySlug, ...routed };
    const result = fanOut(route, parsePayload(m.payload), resolver, m.receivedAt);
    allBatches.push(...result.batches);
    for (const dl of result.deadLetters) {
      deadLetters.push({
        protocolKey: m.protocolKey, topic: m.topic,
        payload: m.payload.toString('utf8').slice(0, 4000),
        reason: dl.reason, detail: dl.detail,
      });
    }
  }

  if (allBatches.length > 0) {
    await writeBatch(allBatches, new Date());
    flushed += allBatches.length;
  }
  if (deadLetters.length > 0) await writeDeadLetters(deadLetters);
}

export function startFlushLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    void flushNow().catch(() => { /* a failed flush must not kill the loop */ });
  }, FLUSH_MS);
}

export function stopFlushLoop(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export function getQueueStats(): { depth: number; dropped: number; flushed: number } {
  return { depth: queue.length, dropped, flushed };
}

/** Test-only. `max` lets a test force overflow without enqueuing 10 000 messages. */
export function resetQueueForTest(max = DEFAULT_MAX_QUEUE): void {
  queue = []; dropped = 0; flushed = 0; maxQueue = max;
  overflowDeadLetters.length = 0;
  stopFlushLoop();
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd apps/api && npx vitest run src/modules/data-injection/__tests__/ingestion.service.test.ts
```
Expected: 5 passed.

- [ ] **Step 5: Typecheck and commit**

```bash
cd /c/Users/hello/compliance-core && npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/modules/data-injection/ingestion.service.ts apps/api/src/modules/data-injection/__tests__/ingestion.service.test.ts
git commit -m "Add ingestion service: bounded queue, batched flush, dead-lettering"
```

---

## Task 10: Wire into application startup

**Files:**
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `createMqttAdapter` (7), `registerAdapter` (1), `startConnections`/`stopConnections` (8), `enqueue`/`startFlushLoop`/`stopFlushLoop` (9)

- [ ] **Step 1: Register the adapter and start connections after `app.listen`**

Insert immediately AFTER the existing graphile-worker startup block (around `apps/api/src/app.ts:445`), following the same non-fatal pattern:

```ts
  // ── Data Injection: protocol adapters ────────────────────────────────────
  // Deliberately non-fatal, exactly like the job runner above. A broker being
  // unreachable must still leave the configuration UI usable — otherwise an
  // outage locks you out of the settings needed to fix it.
  try {
    registerAdapter(createMqttAdapter());
    startFlushLoop();
    await startConnections(enqueue);
    const n = Object.keys(getConnectionHealth()).length;
    app.log.info(`data-injection: ${n} protocol connection(s) started`);
  } catch (adapterErr) {
    app.log.error({ err: adapterErr }, 'data-injection: adapter startup failed — ingest is DOWN, configuration still available');
  }
```

Add the imports at the top of `app.ts` alongside the existing module imports:

```ts
import { registerAdapter } from './modules/data-injection/adapters/protocol-adapter.js';
import { createMqttAdapter } from './modules/data-injection/adapters/mqtt.adapter.js';
import { startConnections, stopConnections, getConnectionHealth } from './modules/data-injection/connection-manager.js';
import { enqueue, startFlushLoop, stopFlushLoop, flushNow } from './modules/data-injection/ingestion.service.js';
```

- [ ] **Step 2: Flush and disconnect on shutdown**

Find the existing shutdown/`onClose` handling in `app.ts` (search for `onClose` or a `SIGTERM` handler). Add:

```ts
app.addHook('onClose', async () => {
  stopFlushLoop();
  await flushNow().catch(() => { /* best effort on the way down */ });
  await stopConnections();
});
```

If no `onClose` hook exists yet, add this one. Flushing on shutdown matters: the queue is in-process, so anything unflushed at exit is genuinely lost.

- [ ] **Step 3: Verify the API still boots with NO broker running**

```bash
cd /c/Users/hello/compliance-core && ./start-app.bat -SkipBrowser
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:3001/api/hierarchy
```
Expected: the app starts, logs the adapter error (no broker), and `/api/hierarchy` still answers (401 without a token is fine). **If the API fails to boot because a broker is down, the isolation is wrong — fix it before proceeding.**

- [ ] **Step 4: Typecheck and commit**

```bash
cd /c/Users/hello/compliance-core && npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/app.ts
git commit -m "Wire protocol adapters into startup, non-fatal, with shutdown flush"
```

---

## Task 11: Telemetry API routes

**Files:**
- Create: `apps/api/src/modules/data-injection/routes.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/e2e/test-helper.ts`
- Test: `apps/api/src/e2e/telemetry.test.ts`

**Interfaces:**
- Produces: `GET /api/instruments/:id/telemetry/latest`, `GET /api/instruments/:id/telemetry/history`, `GET /api/data-injection/health`, `GET /api/data-injection/dead-letters`, `POST /api/data-injection/dead-letters/:id/resolve`

- [ ] **Step 1: Write the failing e2e test**

Provision a uniquely-named user via `prisma.user.upsert` + `hashPassword` (mirror `apps/api/src/e2e/hierarchy.test.ts`). **Never** use a module-scope `const auth = {...token...}` — it is evaluated before `beforeAll` sets `token`, producing `"Bearer undefined"`. Use `const auth = () => ({ authorization: \`Bearer ${token}\` })`.

Cover: latest returns written values; history filters by `key` and window; a role lacking `INSTRUMENT_VIEW` gets 403; `GET /api/data-injection/health` returns per-profile entries; resolving a dead letter sets `resolvedAt` **and writes an audit row**.

- [ ] **Step 2: Run it — expect 404s**

```bash
cd apps/api && npx vitest run src/e2e/telemetry.test.ts
```

- [ ] **Step 3: Implement the routes**

Gate reads on `INSTRUMENT_VIEW`. Gate `POST /dead-letters/:id/resolve` on `INSTRUMENT_UPDATE`, call `enforceReauth('UPDATE_INSTRUMENT', req, reply)`, and wrap the update plus `auditLog(entry, tx)` in ONE `prisma.$transaction` — resolving a dead letter is an operator decision about a record, so it IS audited even though telemetry is not. Use `buildContext(req)` and always pass `ctx.userId`.

Register a new audit action `DEAD_LETTER_RESOLVED` in `packages/shared/src/types/audit-actions.ts` (match the existing entry shape exactly) before using it.

- [ ] **Step 4: Register in BOTH `app.ts` and `e2e/test-helper.ts`**

```ts
await app.register(dataInjectionRoutes, { prefix: '/api/data-injection' });
```

Telemetry read routes mount under the existing instruments prefix. Skipping `test-helper.ts` means route-parity and your own e2e tests will not see them.

- [ ] **Step 5: Run tests, typecheck, commit**

```bash
cd apps/api && npx vitest run src/e2e/telemetry.test.ts && npm test
cd /c/Users/hello/compliance-core && npx tsc --noEmit -p apps/api/tsconfig.json
git add apps/api/src/modules/data-injection/routes.ts apps/api/src/app.ts apps/api/src/e2e/ packages/shared/src/types/audit-actions.ts
git commit -m "Add telemetry and dead-letter API routes"
```

---

## Task 12: Partition maintenance worker

**Files:**
- Create: `apps/api/src/workers/telemetry-partition.worker.ts`
- Modify: `apps/api/src/app.ts` (taskList), `packages/queue/crontab.txt`
- Test: `apps/api/src/workers/__tests__/telemetry-partition.test.ts`

**Interfaces:**
- Produces: `telemetryPartitionTask`, `ensurePartitions(monthsAhead)`, `dropExpiredPartitions(retentionMonths)`

- [ ] **Step 1: Write the failing test**

Assert `ensurePartitions(2)` creates partitions for the next two months and is **idempotent** (running twice does not throw), and that `dropExpiredPartitions` removes only partitions entirely older than the retention window — never the current one. Query `pg_class`/`pg_inherits` to verify.

- [ ] **Step 2: Run it — expect failure**

- [ ] **Step 3: Implement**

Partition names follow `instrument_telemetry_history_YYYY_MM`. Create with `CREATE TABLE IF NOT EXISTS … PARTITION OF … FOR VALUES FROM (…) TO (…)`. Retention default 12 months, read from a new `telemetry-retention` config surface (follow `uns-settings.def.ts` — it is the reference for a def rendering through the dynamic page; verify the real `ModuleConfigDefinition` shape in `lib/config-registry.ts` rather than assuming).

**A missing future partition means inserts fail at midnight on the 1st**, which surfaces as sudden total data loss. Create at least 2 months ahead, and log loudly on failure.

- [ ] **Step 4: Register the task and schedule**

`app.ts` taskList: `telemetry_partition_maintenance: telemetryPartitionTask`.
`packages/queue/crontab.txt`: `0 2 1 * * telemetry_partition_maintenance` (02:00 on the 1st) **plus** a mid-month run `0 2 15 * * telemetry_partition_maintenance` — one missed monthly run should not be enough to break inserts.

- [ ] **Step 5: Run tests, typecheck, commit**

---

## Task 13: Instrument detail page — live telemetry + history

**Files:**
- Create: `apps/web/src/routes/data-injection/instrument-detail.tsx`
- Modify: `apps/web/src/main.tsx` (44 → 45 routes)

- [ ] **Step 1: Verify the real hook signatures before writing**

`useCan`, `apiClient`, `useToast` (note: `useToast()` returns an OBJECT — `toast.success(title, msg)` / `toast.error(...)` and `toast.successToast`/`errorToast` all exist; there is **no** callable `toast({title, variant})`). `apps/web/src/routes/data-injection/hierarchy.tsx` is the best template. Light theme only, no `dark:` variants.

- [ ] **Step 2: Build the page**

Route `/data-injection/instruments/:id`, guarded on `PERMISSIONS.INSTRUMENT_VIEW`, lazy-loaded inside `<Suspense fallback={<LazyFallback />}>` matching the existing pattern.

Two panels: **Live** (latest values, `refreshInterval: 5000`, showing key / value / type / age) and **History** (key selector, time window, paginated table). Show the instrument's derived topics from `GET /api/instruments/:id/topics`. Empty state must say **"No telemetry received yet"** and name the topic the device should publish to — that turns a blank panel into a diagnostic.

- [ ] **Step 3: Link from the instruments list**

Make the name a `<Link>` to the detail page in `instruments.tsx`.

- [ ] **Step 4: Verify in a browser**

Build, then check the route renders, the empty state appears for an instrument with no data, and the console has **0 unexpected errors**.

- [ ] **Step 5: Commit**

---

## Task 14: Health strip on the Data Injection dashboard

**Files:**
- Modify: `apps/web/src/routes/data-injection/index.tsx`

- [ ] **Step 1: Add the health panel**

Fetch `GET /api/data-injection/health` (conditional SWR key — `null` when the user lacks `INSTRUMENT_VIEW`, matching the existing convention so no 403 reaches the console). Show per-profile: name, protocol, connected state, last message age, reconnect count, and `startError` when present.

Add a dead-letter count card linking to a filtered list. **A non-zero dead-letter count is the single most useful signal on this page** — it means data is arriving and being rejected, which is invisible everywhere else.

- [ ] **Step 2: Verify in a browser, then commit**

---

## Task 15: Documentation sync

**Files:**
- Modify: `docs/recreation/**`, `CHANGELOG.md`

- [ ] **Step 1: Re-derive every count from live code**

```bash
grep -cE "^model " apps/api/prisma/schema.prisma
grep -cE "^enum " apps/api/prisma/schema.prisma
ls apps/api/src/modules/ | wc -l
grep -cE "<Route" apps/web/src/main.tsx
ls apps/api/src/modules/config/defs/*.def.ts | wc -l
```

Expected: 33 models, 8 enums, 23 API modules, 45 routes, 23 config defs. **Verify rather than assume** — use what you observe and say so if it differs.

- [ ] **Step 2: Update `docs/recreation/` and `CHANGELOG.md` ONLY**

Do **NOT** touch root docs. They describe a different, pre-strip product; editing counts inside them makes them look maintained while everything else stays wrong.

The changelog must state plainly: **telemetry now flows end-to-end for MQTT**; per-device broker credentials are NOT implemented (the broker owns device auth); the ingest queue is in-process and does not survive a restart; and only MQTT has an adapter — the other 17 protocols remain seeded-and-disabled.

- [ ] **Step 3: Commit**

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §2 D1 merged P2+P3 | Tasks 5, 6 deliver storage alongside 7–9 |
| §2 D2 external broker, app is client | Task 7 |
| §2 D3 both addressing modes | Tasks 2, 4 |
| §2 D4 shared credential | Task 7 (profile config); per-device auth explicitly out of scope |
| §2 D5 telemetry not audited | Task 6 (comment forbidding auditLog); Task 11 audits only dead-letter resolve |
| §2 D6 history declared in schema.prisma | Task 5 Steps 1–2, with an explicit verify-first gate |
| §2 D7 dead-letter, never drop | Tasks 4, 9 |
| §3.1 pure files | Tasks 2, 3, 4 — no prisma import |
| §5 routing + fan-out | Tasks 2, 4 |
| §5.3 value typing | Task 3 + repository round-trip test |
| §6 schema + partitioning + retention | Tasks 5, 12 |
| §7 backpressure/batching | Task 9 |
| §8 error handling, non-fatal boot | Tasks 7, 8, 10 |
| §9 API surface | Task 11 |
| §10 UI | Tasks 13, 14 |
| §12 testing | Per-task; live acceptance in 13 |

**Placeholder scan.** No TBD/TODO. Tasks 11–15 are specified more tightly than they are code-complete: they name exact files, gates, audit actions, registration points and verification commands, but leave routine CRUD and JSX to the implementer rather than inventing 400 lines of route boilerplate. Tasks 1–10 — everything novel or risky — carry complete code.

**Type consistency.** `Reading`/`ValueType` (Task 3) flow unchanged into 4, 6, 9. `TopicRoute` (2) → 4. `InboundMessage`/`AdapterHealth`/`ProfileWithSecrets` (1) → 7, 8, 9, 10. `InstrumentResolver` (4) is satisfied by `buildResolverCache` (6) via the `|`-joined composite key in 9. `getConnectionHealth()` (8) → 10, 11, 14.

**Known risk carried from P1.** Task 5 Step 1 is a hard gate on an unverified assumption (Prisma tolerating a partitioned parent). It says stop and report rather than force. Ten of P1's defects were unverified assumptions of exactly this kind.
