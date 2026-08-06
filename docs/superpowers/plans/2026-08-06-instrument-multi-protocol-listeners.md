# Instrument Multi-Protocol Listeners (P2 + P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the five remaining transports actually accept connections — MQTT, MQTTS, WebSocket, WSS and TCP — so every protocol the UI advertises has a listener behind it.

**Architecture:** Today the entire ingest pipeline (parse → gateway fan-out or flat → dead-letter → batched write → last-seen) is inline in the HTTP route handler. Four more listeners must not each re-implement it. Task 1 extracts a transport-agnostic core, `ingestPayload()`, and reduces the HTTP route to a thin caller; Tasks 2-5 then add listeners that only **obtain bytes and obtain a token** and hand both to that core. That boundary is the whole design — a fix in ingestion is then a fix for all five.

**Tech Stack:** Fastify 5, Prisma 6, PostgreSQL 18, `@fastify/websocket`, node `net`, EMQX 5.3.2 (already installed at `C:\Users\hello\emqx-5.3.2`), vitest.

**Prior art:** `docs/superpowers/specs/2026-08-04-instruments-inbound-ingestion-design.md` §5.1 fixes the auth mechanism per transport; `docs/superpowers/specs/2026-08-05-instrument-gateway-model-design.md` defines the gateway fan-out these listeners inherit for free.

## Global Constraints

- **Run the API suite single-fork only:** `cd apps/api && npm test`. **Baseline: 14 pre-existing failures in 5 files** (`auth-profile-reauth`, `entities`, `replacement-audit-enrichment`, `super-admin-unretire`, `block-change-approval-current`). Do not "fix" those. Web baseline: 5 pre-existing failures (`use-can`, `url-utils`).
- **vitest never typechecks.** Every task must also pass `npx tsc -p apps/api/tsconfig.json --noEmit`, and for web changes `cd apps/web && npx tsc -p tsconfig.json --noEmit`.
- **Always pass `DATABASE_URL` explicitly:** `postgresql://digilog:digilog123@localhost:5432/compliance_core_db?schema=public`.
- **Every listener is internet-facing and unauthenticated until the token is checked.** Apply the same three defences the HTTP route already has: a body/frame size cap **enforced before parsing**, a rate or connection cap, and a timeout on unauthenticated connections. A listener that parses before it authenticates is a defect, not a style choice.
- **A token is a token on every transport.** `resolveInstrumentByToken` is the single authority; no listener may add its own credential path or its own bypass.
- **Never auto-create an instrument from a payload**, on any transport.
- **The `transport` recorded on a dead-letter must be the transport it actually arrived on** — that is the field's whole purpose now that instruments no longer declare one.
- **Do not disturb the gateway lock ordering** (`gateway row → own row → advisory`), documented in `apps/api/DECISIONS.md` §4a. None of these tasks should need a row lock; if you think yours does, stop and report.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/modules/instruments/ingest-core.ts` | **Transport-agnostic.** identity + bytes + transport → `{accepted, rejected}` or a typed refusal. Owns fan-out, dead-lettering, writes, last-seen. |
| `apps/api/src/modules/instruments/ingest-routes.ts` | HTTP/HTTPS listener — thin caller of the core |
| `apps/api/src/modules/instruments/listeners/ws-listener.ts` | WebSocket/WSS upgrade + frame handling |
| `apps/api/src/modules/instruments/listeners/tcp-listener.ts` | TCP server, newline framing, caps and timeouts |
| `apps/api/src/modules/instruments/listeners/line-framer.ts` | **Pure.** Byte chunks → complete lines. The split-packet correctness lives here. |
| `apps/api/src/modules/instruments/mqtt-auth-routes.ts` | `POST /api/ingest/v1/mqtt-auth` — the hook EMQX calls per device |
| `apps/api/src/modules/instruments/listeners/mqtt-bridge.ts` | Subscribes `instruments/+/telemetry`, routes to the core |
| `apps/api/src/app.ts` | Start/stop the TCP server and MQTT bridge with the process |
| `apps/web/src/routes/instruments/connection-instructions.tsx` | `LIVE_TRANSPORTS` grows as each listener lands |

---

### Task 1: Extract the transport-agnostic ingest core

**Files:**
- Create: `apps/api/src/modules/instruments/ingest-core.ts`
- Modify: `apps/api/src/modules/instruments/ingest-routes.ts`
- Test: `apps/api/src/modules/instruments/__tests__/ingest-core.test.ts`

**Interfaces:**
- Consumes: `parsePayload`, `toReadings` (`./payload-parser.js`); `fanoutDevices` (`./gateway-fanout.js`); `childMapFor` (`./gateway-children.js`); `writeBatch`, `writeDeadLetters` (`./telemetry.repository.js`); `stampLastSeen` (`./last-seen.js`); `IngestIdentity` (`./ingest-auth.js`)
- Produces:
  ```ts
  export type IngestOutcome =
    | { ok: true;  accepted: number; rejected: number }
    | { ok: false; code: 'UNPARSEABLE' | 'NOT_A_GATEWAY' | 'TOO_MANY_KEYS'; message: string };

  export async function ingestPayload(args: {
    identity: IngestIdentity;
    raw: Buffer;
    transport: string;   // recorded verbatim on dead-letters
  }): Promise<IngestOutcome>;
  ```

- [ ] **Step 1: Characterise the CURRENT behaviour before moving it**

Read `ingest-routes.ts` end to end and write down, as a list, every branch it takes and what each returns: unparseable → dead-letter + 202; batch from a non-gateway → dead-letter + 400 `NOT_A_GATEWAY`; batch from a gateway → fan-out, dead-letter the rejects, `writeBatch`, stamp children `'gateway'` and the gateway itself `'direct'`, return `{accepted, rejected}`; flat → key-count cap then `writeBatch` + stamp `'direct'`. Put this list in your report. It is the contract you must preserve — the existing e2e tests are the proof, and they must pass **unchanged**.

- [ ] **Step 2: Write the core's test first**

```typescript
// apps/api/src/modules/instruments/__tests__/ingest-core.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const writeBatch = vi.fn(); const writeDeadLetters = vi.fn();
const childMapFor = vi.fn(); const stampLastSeen = vi.fn();
vi.mock('../telemetry.repository.js', () => ({
  writeBatch: (...a: unknown[]) => writeBatch(...a),
  writeDeadLetters: (...a: unknown[]) => writeDeadLetters(...a),
}));
vi.mock('../gateway-children.js', () => ({ childMapFor: (...a: unknown[]) => childMapFor(...a) }));
vi.mock('../last-seen.js', () => ({ stampLastSeen: (...a: unknown[]) => stampLastSeen(...a) }));

import { ingestPayload } from '../ingest-core.js';

const plain = { id: 'i1', code: 'P-1', transport: 'http', isGateway: false };
const gw = { id: 'g1', code: 'GW-1', transport: 'http', isGateway: true };
const buf = (o: unknown) => Buffer.from(JSON.stringify(o));

beforeEach(() => {
  writeBatch.mockReset(); writeDeadLetters.mockReset();
  childMapFor.mockReset(); stampLastSeen.mockReset();
  writeBatch.mockResolvedValue(undefined); writeDeadLetters.mockResolvedValue(undefined);
  stampLastSeen.mockResolvedValue(undefined);
  childMapFor.mockResolvedValue(new Map([['CH-A', { id: 'a1', isActive: true }]]));
});

describe('ingestPayload', () => {
  it('records the transport it actually arrived on, not the instrument\'s', async () => {
    // The whole point of the field now that instruments no longer declare one.
    await ingestPayload({ identity: plain, raw: Buffer.from('not json'), transport: 'tcp' });
    expect(writeDeadLetters.mock.calls[0][0][0]).toMatchObject({ transport: 'tcp' });
  });

  it('accepts a flat payload and stamps the sender direct', async () => {
    const r = await ingestPayload({ identity: plain, raw: buf({ temperature: 21.5 }), transport: 'ws' });
    expect(r).toEqual({ ok: true, accepted: 1, rejected: 0 });
    expect(stampLastSeen).toHaveBeenCalledWith(['i1'], 'direct');
  });

  it('refuses a batch from a non-gateway', async () => {
    const r = await ingestPayload({ identity: plain, raw: buf({ devices: { 'CH-A': { t: 1 } } }), transport: 'mqtt' });
    expect(r).toMatchObject({ ok: false, code: 'NOT_A_GATEWAY' });
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('fans a gateway batch out to its children and reports partial rejection', async () => {
    const r = await ingestPayload({
      identity: gw, raw: buf({ devices: { 'CH-A': { t: 1 }, 'NOPE': { t: 2 } } }), transport: 'tcp',
    });
    expect(r).toEqual({ ok: true, accepted: 1, rejected: 1 });
    expect(stampLastSeen).toHaveBeenCalledWith(['a1'], 'gateway');
    expect(stampLastSeen).toHaveBeenCalledWith(['g1'], 'direct');
  });

  it('dead-letters an unparseable payload rather than throwing', async () => {
    const r = await ingestPayload({ identity: plain, raw: Buffer.from('{oops'), transport: 'ws' });
    expect(r).toMatchObject({ ok: false, code: 'UNPARSEABLE' });
    expect(writeDeadLetters).toHaveBeenCalled();
  });

  it('never lets a dead-letter write failure lose an accepted reading', async () => {
    writeDeadLetters.mockRejectedValue(new Error('db down'));
    const r = await ingestPayload({
      identity: gw, raw: buf({ devices: { 'CH-A': { t: 1 }, 'NOPE': { t: 2 } } }), transport: 'http',
    });
    expect(r).toMatchObject({ ok: true, accepted: 1 });
    expect(writeBatch).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it, confirm it fails on module resolution**

Run: `cd apps/api && npx vitest run src/modules/instruments/__tests__/ingest-core.test.ts`

- [ ] **Step 4: Move the logic — move it, do not rewrite it**

Cut the body of the HTTP handler into `ingestPayload`, replacing `reply.code(...)` returns with the `IngestOutcome` values. Keep every comment: they record why 202-not-400 for an unparseable payload, why the batch key cap exists, and why dead-letters attach to the gateway. Then reduce the route to: resolve token → `ingestPayload` → map the outcome to a status code, preserving today's exact codes (`UNPARSEABLE` → 202, `NOT_A_GATEWAY` → 400, `TOO_MANY_KEYS` → 400, ok → 200).

- [ ] **Step 5: Prove nothing changed**

Run: `cd apps/api && npx vitest run src/e2e/gateway-ingest.test.ts src/e2e/instrument-ingest.test.ts src/modules/instruments --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS with **no test edited**. If you had to change an existing assertion, you changed behaviour — stop and report it instead.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc -p apps/api/tsconfig.json --noEmit
git add apps/api/src/modules/instruments/ingest-core.ts apps/api/src/modules/instruments/ingest-routes.ts apps/api/src/modules/instruments/__tests__/ingest-core.test.ts
git commit -m "refactor(instruments): extract a transport-agnostic ingest core"
```

---

### Task 2: Line framer (pure) — the split-packet correctness

**Files:**
- Create: `apps/api/src/modules/instruments/listeners/line-framer.ts`
- Test: `apps/api/src/modules/instruments/listeners/__tests__/line-framer.test.ts`

**Interfaces:**
- Produces: `class LineFramer { push(chunk: Buffer): string[]; get buffered(): number }`

Framing bugs pass every normal test and fail the first time a message straddles a packet boundary. That is why this is its own pure unit with its own tests, rather than inline in the socket handler.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/modules/instruments/listeners/__tests__/line-framer.test.ts
import { describe, it, expect } from 'vitest';
import { LineFramer } from '../line-framer.js';

describe('LineFramer', () => {
  it('returns whole lines', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('{"a":1}\n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('holds a partial line until its newline arrives — the split-packet case', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('{"a":'))).toEqual([]);
    expect(f.push(Buffer.from('1}\n'))).toEqual(['{"a":1}']);
  });

  it('survives a split INSIDE a multi-byte UTF-8 character', () => {
    // A naive chunk.toString() per packet corrupts this into replacement
    // characters and the JSON silently changes.
    const whole = Buffer.from('{"n":"°C"}\n', 'utf8');
    const f = new LineFramer();
    expect(f.push(whole.subarray(0, 8))).toEqual([]);
    expect(f.push(whole.subarray(8))).toEqual(['{"n":"°C"}']);
  });

  it('handles CRLF as well as LF', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('{"a":1}\r\n'))).toEqual(['{"a":1}']);
  });

  it('skips blank lines rather than emitting empty strings', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('\n\n{"a":1}\n'))).toEqual(['{"a":1}']);
  });

  it('reports how much is buffered so a caller can enforce a cap', () => {
    const f = new LineFramer();
    f.push(Buffer.from('abcdef'));
    expect(f.buffered).toBe(6);
  });
});
```

- [ ] **Step 2: Run it, confirm module-not-found**

- [ ] **Step 3: Implement**

Accumulate `Buffer`s and only decode UTF-8 once a complete line is in hand — decoding per chunk is what breaks the multi-byte case. Expose `buffered` so the socket handler can kill a client that sends an unbounded line with no newline.

- [ ] **Step 4: Run, expect 6 passing. Commit**

```bash
git add apps/api/src/modules/instruments/listeners/
git commit -m "feat(instruments): pure newline framer for the TCP listener"
```

---

### Task 3: TCP listener

**Files:**
- Create: `apps/api/src/modules/instruments/listeners/tcp-listener.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/.env.example`
- Test: `apps/api/src/e2e/tcp-ingest.test.ts`

**Interfaces:**
- Consumes: `LineFramer`, `resolveInstrumentByToken`, `ingestPayload`
- Produces: `startTcpListener(port: number): Promise<{ close(): Promise<void>; port: number }>`

- [ ] **Step 1: Write the e2e test first**

Use a real `net.Socket` against a listener started on port 0 (ephemeral). Cover: first line authenticates and subsequent lines are ingested; a reading **split across two writes** arrives intact; a bad token closes the socket; a socket that sends nothing is closed by the unauthenticated timeout; a line exceeding the cap closes the socket; malformed JSON after authentication is dead-lettered and the socket **stays open** (one bad reading must not kill a working device).

- [ ] **Step 2: Run it, confirm it fails**

- [ ] **Step 3: Implement**

Protocol per spec §5.1: the FIRST line must be `{"token":"..."}`; every later line is a reading, handed to `ingestPayload` with `transport: 'tcp'`. Required defences — a byte stream has no headers and no framework around it:
- unauthenticated socket timeout (5s) — a scanner must not be able to hold connections
- idle timeout after authentication (configurable, default 15 min)
- max buffered bytes per line (64 KB, matching the HTTP body cap) — exceed it and destroy the socket
- a global concurrent-connection cap; refuse beyond it rather than accepting unboundedly
- `socket.on('error')` handled on every socket. An unhandled `ECONNRESET` takes the whole process down.

Port from `INGEST_TCP_PORT` (default 1884), and **do not start the listener when it is unset** — a port opening by default on someone's machine is a surprise. Document it in `.env.example`.

- [ ] **Step 4: Run the test, then the full instruments set. Commit**

---

### Task 4: WebSocket listener

**Files:**
- Create: `apps/api/src/modules/instruments/listeners/ws-listener.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/e2e/test-helper.ts`, `apps/api/package.json`
- Test: `apps/api/src/e2e/ws-ingest.test.ts`

**Interfaces:**
- Consumes: `resolveInstrumentByToken`, `ingestPayload`
- Produces: a `GET /api/ingest/v1/ws` upgrade endpoint

- [ ] **Step 1: Add the dependency**

`npm install @fastify/websocket -w @digilog/api`. It was removed as dead code in 2026-07; this is a deliberate re-add. Note it in the commit message so nobody strips it again.

- [ ] **Step 2: Write the e2e test first**

Cover: token in the `Authorization` header on upgrade → readings ingested; token in the FIRST frame instead → same; no token within the timeout → socket closed; bad token → closed immediately; malformed JSON after auth → dead-lettered, socket stays open; a gateway's batch frame fans out to its children.

- [ ] **Step 3: Implement**

Register the plugin, add the route, and put it on the **auth-hook allowlist** exactly as `/api/ingest/v1/telemetry` is — then update `plugins/__tests__/public-paths.test.ts`, which asserts the ingest paths are the ONLY exemptions. That test failing is the system working; extend it deliberately rather than loosening it.

Per-frame size cap and a per-connection message rate cap. `transport: 'ws'` on dead-letters (`'wss'` adds nothing — TLS is the same listener).

- [ ] **Step 4: Run, commit**

---

### Task 5: MQTT — the auth hook EMQX calls

**Files:**
- Create: `apps/api/src/modules/instruments/mqtt-auth-routes.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/plugins/auth.ts`, `apps/api/src/plugins/__tests__/public-paths.test.ts`
- Test: `apps/api/src/e2e/mqtt-auth.test.ts`

**Interfaces:**
- Produces: `POST /api/ingest/v1/mqtt-auth` → `{ result: 'allow' | 'deny' }`

This endpoint is what keeps credentials ours: EMQX holds no passwords, it asks us per connection, so revocation is immediate rather than eventually-consistent.

- [ ] **Step 1: Write the failing test**

Cover: a valid token as `username` → `allow`; an unknown token → `deny`; a **revoked** token → `deny` (this is the property that justifies the whole design — assert it explicitly); an inactive instrument → `deny`; a missing username → `deny`. Also assert the endpoint is rate-limited and on the allowlist.

- [ ] **Step 2: Implement**

Body shape is EMQX's `http` authenticator: `{clientid, username, password}`. Resolve `username` via `resolveInstrumentByToken` — no second credential path. Deny is the default on every unexpected shape.

Note the cache interaction and state it in a comment: `resolveInstrumentByToken` caches for 10s, so a revocation can be honoured up to 10s late on a NEW connection. `regenerate-token` already calls `invalidateIngestAuthCache`, which closes it in practice.

- [ ] **Step 3: Run, commit**

---

### Task 6: MQTT bridge — subscribe and route

**Files:**
- Create: `apps/api/src/modules/instruments/listeners/mqtt-bridge.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/.env.example`, `apps/api/package.json`
- Test: `apps/api/src/modules/instruments/listeners/__tests__/mqtt-topic.test.ts`, `apps/api/src/e2e/mqtt-ingest.test.ts`

- [ ] **Step 1: Pure topic parsing first**

`instruments/<code>/telemetry` → code. Test: a valid topic; a topic with extra segments (reject); a code containing a `/` (impossible by the code charset, assert it is rejected anyway); a topic that does not match the pattern.

- [ ] **Step 2: Implement the bridge**

`npm install mqtt -w @digilog/api`. Subscribe `instruments/+/telemetry` at QoS 1. On each message: parse the topic for the code, resolve the **instrument by code**, and hand the payload to `ingestPayload` with `transport: 'mqtt'`.

**The security question you must answer explicitly in your report:** the broker authenticated the device at CONNECT via Task 5's hook, but a connected device could publish to another instrument's topic. Either have EMQX enforce topic ACLs per device, or verify in the bridge that the publishing client is entitled to that topic. Do not assume the CONNECT check covers it — say which mechanism you used and how you tested it.

Start only when `MQTT_BROKER_URL` is set. Reconnect with backoff; log loudly on disconnect — a silently dead bridge means telemetry vanishing with no error anywhere.

- [ ] **Step 3: Verify against the real EMQX**

EMQX 5.3.2 is installed at `C:\Users\hello\emqx-5.3.2` (`bin\emqx.cmd start`). Configure its `http` authenticator to point at `POST /api/ingest/v1/mqtt-auth`, publish with `mosquitto_pub` using a real instrument token as the username, and confirm the reading lands. Then **revoke the token and confirm the next connection is refused** — that is the test that proves the hook is consulted rather than cached. Record the exact EMQX config you used in your report; it has to go in the docs.

- [ ] **Step 4: Commit**

---

### Task 7: Turn the warnings off, and only then

**Files:**
- Modify: `apps/web/src/routes/instruments/connection-instructions.tsx`, its test
- Modify: `CHANGELOG.md`, `docs/recreation/06-api/endpoints.md`, `LOCAL_SETUP_WINDOWS.md`

- [ ] **Step 1: Grow `LIVE_TRANSPORTS` to match reality**

Add each transport **only** once its listener is verified working end to end. A protocol marked live that silently drops data is far worse than one honestly marked not-ready — the banner exists precisely to stop a technician debugging their device for an hour.

- [ ] **Step 2: Update the tests**

The existing test asserting `tcp` shows "not accepting connections yet" must be re-pointed at whatever remains not-live, or deleted with the reason if all seven are live.

- [ ] **Step 3: Docs**

New env vars (`INGEST_TCP_PORT`, `MQTT_BROKER_URL`) in `.env.example` and `LOCAL_SETUP_WINDOWS.md`, including the EMQX authenticator configuration from Task 6. Re-derive the endpoint count from the live OpenAPI document; do not copy it.

- [ ] **Step 4: Full verification sweep**

```bash
npx tsc -p apps/api/tsconfig.json --noEmit
cd apps/web && npx tsc -p tsconfig.json --noEmit && npx vitest run && cd ..
cd apps/api && npm test
```

---

## Self-Review — coverage

| Requirement | Task |
|---|---|
| One ingest pipeline, four thin listeners | 1 |
| Split-packet correctness | 2 |
| TCP listener + in-band auth + caps | 3 |
| WebSocket/WSS listener | 4 |
| MQTT credentials stay ours; revocation immediate | 5 |
| MQTT topic routing + broker verification | 6 |
| Topic-ACL question answered explicitly | 6 |
| UI stops warning only when each is genuinely live | 7 |
| Auth-hook allowlist stays minimal and tested | 4, 5 |

**Ordering:** 1 → 2 → 3 → 4 → 5 → 6 → 7. Task 1 is a hard prerequisite for 3, 4 and 6. Tasks 3, 4 and (5+6) are independent of each other and may run in parallel once 1 lands; 7 must be last, since its whole job is asserting the others are real.
