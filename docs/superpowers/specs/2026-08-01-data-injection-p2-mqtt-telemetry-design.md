# Data Injection Layer — Phase 2 + 3 (MQTT Adapter & Telemetry) — Design Spec

- **Date:** 2026-08-01
- **Branch:** `data-injection`
- **Status:** Approved for planning (awaiting spec review)
- **Author:** Claude (with user)
- **Builds on:** `2026-08-01-data-injection-p1-foundation-design.md` (delivered, 31 commits)
- **Reference implementation:** sibling repo `C:\Users\hello\21cfrlogbook-DigitalFMS`, tag
  `pre-ingestion-removal` — `transport/mqtt-client.ts` (138 lines),
  `transport/mqtt-handler.ts` (286), `modules/data-ingestion/{message-normalizer,
  entity-resolver,dlq-manager,connectivity-tracker}.ts`

---

## 1. What this phase delivers

P1 built the configuration backbone: instruments, gateways, communication profiles,
a hierarchy, and derived UNS topics. It talks to nothing. **P2+P3 makes data flow.**

At the end of this phase, a real MQTT device publishing to a real broker results in
rows you can query through the API and see in the UI. That is the acceptance test,
not a unit-test count.

P2 and P3 were separate slices in the P1 decomposition. They are **merged here
deliberately**: an adapter with nowhere to put data cannot be verified except by
reading logs, and a telemetry schema with nothing feeding it is a dead table. The
project already has one dead table (`instrument_settings`, created in P1 and never
wired) and does not need a second.

## 2. Decisions taken

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Merge P2 and P3.** Adapter *and* partitioned telemetry storage ship together | Neither half is verifiable alone. See §1 |
| **D2** | **The app is an MQTT *client*; the broker is external** | Matches the upstream design (so `mqtt-client.ts` is largely reusable), and matches industrial reality — sites usually already run a broker and devices often cannot be repointed. Cost: one more service to install and validate, including on the AWS instance |
| **D3** | **Fan-out supports BOTH topic-addressed and payload-addressed messages** | Real fleets mix them: simple sensors publish their own topic; PLCs and edge gateways batch. `deviceKey` (unique per gateway since P1) is the join key in both cases |
| **D4** | **Shared subscriber credential; per-device MQTT auth is deferred** | The API connects using the credentials already in the P1 Communication Profile. Device-side auth stays the broker's business. Porting the upstream auth webhook + ACL generator (~500 lines) would roughly double this phase and couple us to Mosquitto's specific plugin format |
| **D5** | **Telemetry is NOT audited** — carried forward from P1 D1, unchanged | Telemetry is process data, not a §11 electronic record. Auditing millions of rows/day would make the O(n) `verify-chain` walk unusable within weeks. **Configuration changes remain fully audited** |
| **D6** | **`instrument_telemetry_history` is modelled in `schema.prisma`, not omitted** | P1 omitted the `ltree` `path` column, and the final review found that every future `prisma migrate diff` then proposes `DROP COLUMN "path"` — with `apps/api/CLAUDE.md`'s own authoring flow telling the next developer to strip exactly that kind of line as noise. Do not repeat it. Model it as `Unsupported(...)` where needed so the field stays tracked |
| **D7** | **Unresolvable messages go to `dead_letters`, never dropped** | Silent loss in a regulated system is indistinguishable from data that never arrived. A dead-lettered message is a fact an operator can act on |

## 3. Architecture

```
external broker (Mosquitto / EMQX / site's own)
      │  subscribe — shared credential from CommunicationProfile (P1, masked)
      ▼
 MqttAdapter ─────────────── implements IProtocolAdapter
      ▼
 ConnectionManager ───────── one connection per ACTIVE profile
      │                      exponential backoff, never blocks API boot
      ▼
 TopicRouter ─────────────── topic → { gatewaySlug, instrumentSlug?, category }
      ▼
 PayloadParser ───────────── bytes → JSON → normalised readings[]
      ▼
 FanOut ──────────────────── topic-addressed (1 instrument)
      │                      payload-addressed (N instruments, keyed by deviceKey)
      ▼
 TelemetryWriter ─────────── batched: upsert latest + append history
      ▼
 PostgreSQL ──────────────── latest (hot) + monthly-partitioned history
```

Anything unresolvable at any stage — unknown topic, unparseable payload, unknown
`deviceKey` — is written to `dead_letters` with a reason and the raw payload.

### 3.1 Module layout

Follows the existing convention. New files:

```
apps/api/src/modules/data-injection/
  adapters/protocol-adapter.ts        the IProtocolAdapter interface + registry
  adapters/mqtt.adapter.ts            MQTT implementation (mqtt.js)
  connection-manager.ts               lifecycle: start/stop/reconnect per profile
  topic-router.ts                     pure: topic string → routing decision
  payload-parser.ts                   pure: bytes → readings[]
  fan-out.ts                          pure: routing + payload → per-instrument readings
  telemetry.repository.ts             ALL raw SQL for the partitioned table
  telemetry.routes.ts                 latest / history / dead-letter endpoints
  ingestion.service.ts                orchestrates router → parser → fan-out → writer
```

**The pure files (`topic-router`, `payload-parser`, `fan-out`) must not import
prisma.** That is what makes the routing and splitting logic exhaustively testable
without a broker or a database — the same property that made P1's `topic-resolver`
the easiest thing in that phase to verify.

## 4. The adapter interface

```ts
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

export interface IProtocolAdapter {
  readonly protocolKey: string;                          // 'mqtt'
  start(profile: CommunicationProfileWithSecrets,
        onMessage: (m: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  health(): AdapterHealth;
  /** Optional. Only adapters that can write implement this — arrives in P8. */
  publish?(topic: string, payload: Buffer, opts?: { qos?: number; retain?: boolean }): Promise<void>;
}
```

Adapters register into a map keyed by `protocolKey`. The `ConnectionManager` starts
an adapter only for profiles whose `Protocol.isEnabled` is true — the flag P1 already
seeds `false` for all 18. **Adding a protocol later is one new file plus flipping one
row**, which is the plugin extensibility the original brief asked for.

`start()` receives the profile **with secrets unmasked** — it needs the real broker
password. This is the one place unmasked config is legitimate, and it must never be
returned over HTTP or written to an audit row.

## 5. Topic routing and fan-out

### 5.1 Routing

P1 derives topics as `prefix/hierarchy…/gateway/instrument/category`. The router
reverses that, matching from the right, because the hierarchy depth varies:

```
controlyt/india/area-02/gw-001/temp001/telemetry
                        └gateway┘└inst─┘└category┘   → topic-addressed
controlyt/india/area-02/gw-001/telemetry
                        └gateway┘└category┘          → payload-addressed (batch)
```

The last segment must be a known `TopicCategory`. Resolution is by **slug lookup**,
not by re-deriving paths, so a hierarchy rename cannot orphan in-flight messages.

### 5.2 Fan-out

```
topic-addressed   → resolve instrument by (gateway.slug, instrument.slug)
                    one reading set, one instrument

payload-addressed → payload.devices is an object keyed by deviceKey
                    resolve each via @@unique([gatewayId, deviceKey]) from P1
                    N reading sets, N instruments
```

An unknown `deviceKey` dead-letters **that entry only** — the rest of the batch still
lands. One bad key in a 50-device payload must not discard 49 good readings.

### 5.3 Value typing

A reading's value is stored as `jsonb` alongside an explicit `value_type`
(`boolean|int|float|string|json`). Storing everything as text and guessing on read is
how "0" becomes `0` becomes `false`. In a system whose whole purpose is faithful
records, the type is part of the record.

## 6. Schema

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
  @@map("instrument_telemetry_latest")
}

model DeadLetter {
  id         String    @id @default(uuid())
  protocolKey String   @map("protocol_key")
  topic      String
  payload    String                       // raw, as received
  reason     String
  detail     String?
  receivedAt DateTime  @default(now()) @map("received_at")
  resolvedAt DateTime? @map("resolved_at")
  @@index([receivedAt])
  @@map("dead_letters")
}
```

`instrument_telemetry_history` is created by raw SQL because Prisma cannot express
partitioning:

```sql
CREATE TABLE instrument_telemetry_history (
  instrument_id text        NOT NULL,
  key           text        NOT NULL,
  value         jsonb       NOT NULL,
  value_type    text        NOT NULL,
  quality       text,
  ts            timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, key, ts)      -- MUST include the partition column
) PARTITION BY RANGE (ts);

CREATE INDEX ON instrument_telemetry_history (instrument_id, key, ts DESC);
```

Per **D6** it is ALSO declared in `schema.prisma`, so `migrate diff` never proposes
dropping it:

```prisma
model InstrumentTelemetryHistory {
  instrumentId String   @map("instrument_id")
  key          String
  value        Json
  valueType    String   @map("value_type")
  quality      String?
  ts           DateTime
  receivedAt   DateTime @default(now()) @map("received_at")
  @@id([instrumentId, key, ts])
  @@index([instrumentId, key, ts(sort: Desc)])
  @@map("instrument_telemetry_history")
}
```

**Why this works and why the composite key is not optional.** PostgreSQL permits a
primary key on a partitioned table only if it *includes every partition column*, so
`(instrument_id, key, ts)` is both the natural key and the only legal one — a
synthetic `id` PK would be rejected outright. Prisma also requires an `@id`, so the
same composite satisfies both constraints. Prisma sees a partitioned parent as an
ordinary table with columns; the partitioning itself is invisible to it, which is
precisely why declaring the model keeps `migrate diff` quiet while the raw SQL owns
the partition structure.

**The implementer must verify this empirically before building on it** — create the
table, run `prisma migrate diff`, and confirm it proposes nothing. If Prisma turns
out to disagree with a partitioned parent, say so and stop rather than forcing it;
the fallback is `Unsupported(...)` or an explicit drift-guard exception, and that is
a decision to surface, not to improvise.

**Retention is a partition DROP, not a DELETE.** Default 12 months, configurable via
a new `telemetry-retention` config surface. Dropping a partition is instant and
reclaims disk; a `DELETE` of millions of rows is neither.

A `graphile-worker` task (`telemetry_partition_maintenance`) pre-creates next month's
partition and drops expired ones. It must run **ahead** of the boundary — a missing
partition means inserts fail, which would surface as data loss at midnight on the 1st.

## 7. Backpressure and batching

Writing one row per message will not survive a real fleet.

- Messages accumulate in a **bounded in-memory queue** (default 10 000).
- A writer flushes every **250 ms or 500 readings**, whichever first, as one batched
  statement per table.
- **When the queue is full, the oldest entries are dead-lettered with reason
  `QUEUE_OVERFLOW`** rather than silently discarded, and the adapter records it in
  health. An operator can then see that ingest is behind, which is the actionable
  fact.

The queue is in-process, so it does not survive a restart. That is an accepted
limitation of a single-instance design and is stated here so nobody assumes
durability the system does not have.

## 8. Error handling

The API process now owns long-lived device connections. Three rules:

1. **Adapter startup failure must not block API boot.** Configuration must remain
   editable with every broker down — otherwise a broker outage locks you out of the
   settings needed to fix it.
2. **A malformed payload must never kill a connection.** Parse failures dead-letter
   and processing continues.
3. **Broker disconnects reconnect with exponential backoff** (1 s → 60 s cap, jitter),
   and the reconnect count is exposed in health.

## 9. API surface

```
GET  /api/instruments/:id/telemetry/latest      all current key values
GET  /api/instruments/:id/telemetry/history     ?key=&from=&to=&limit=  paginated
GET  /api/data-injection/health                 per-profile adapter health
GET  /api/data-injection/dead-letters           ?resolved=  paginated
POST /api/data-injection/dead-letters/:id/resolve   mark handled (audited)
```

Reads gate on `INSTRUMENT_VIEW`. Dead-letter resolve gates on `INSTRUMENT_UPDATE`
and **is audited** — it is an operator decision about a record, not process data.

## 10. UI

One new page, `/data-injection/instruments/:id` — an instrument detail view with a
**Live Telemetry** panel (latest values, polled) and a **History** tab (table +
simple chart). Plus a **Health** strip on the Data Injection dashboard showing
per-profile connection state.

Deliberately NOT in this phase: the full Message Explorer, alarms, and rules. Those
were P4–P6 and stay there.

## 11. What is reusable from the sibling repo

Genuinely reusable, with adaptation: `mqtt-client.ts` (connection + subscribe
shape), `message-normalizer.ts` (payload → readings), `entity-resolver.ts`
(slug/key → entity), `dlq-manager.ts` (dead-letter handling), `connectivity-tracker.ts`
(online/offline transitions).

**Not reusable:** anything referencing `AssetInstance`, `Organization`, TimescaleDB
hypertables, or the EMQX/Mosquitto auth webhook. It is a **different repository with
no shared history** — code moves by copy-and-adapt, never cherry-pick.

## 12. Testing

**Unit (no broker, no DB):** topic routing incl. varying hierarchy depth; payload
parsing incl. malformed input; fan-out both addressing modes; unknown `deviceKey`
dead-letters only its own entry; value typing across all five types.

**Integration:** a real broker via `aedes` as a **test-only devDependency — not
shipped**, publishing both message shapes and asserting rows land in both tables.
Explicitly covered: a batch containing one unknown key still writes the good ones;
queue overflow dead-letters rather than dropping; a `ts` crossing a partition
boundary lands in the right partition.

**Live:** the acceptance test is a real message from a real broker producing a row
visible in the UI. P1 taught that unit tests, code review and source inspection all
passed while two real defects sat in the code; only running it found them.

## 13. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Prisma cannot express partitioning; raw SQL again | Confine to `telemetry.repository.ts`, exactly as P1 confined ltree to `hierarchy.repository.ts`. Model in `schema.prisma` anyway (D6) |
| R2 | Missing future partition ⇒ inserts fail at a month boundary | Maintenance job creates ahead; integration test crosses a boundary; job failure is surfaced in health, not silent |
| R3 | The API process now owns device connections | §8's three rules; adapters isolated so a crash cannot take the HTTP server down |
| R4 | Volume exceeds a single instance | Bounded queue + explicit `QUEUE_OVERFLOW` dead-lettering, so saturation is visible rather than mysterious. Horizontal scale still blocked by the in-process session/reauth caches — unchanged from P1 |
| R5 | Broker is an extra component to install, secure and validate on-prem | Accepted under D2. Deployment docs must state it; the AWS instance needs one before P2 works there |
| R6 | Unmasked profile secrets reach the adapter | Single code path, never returned over HTTP, never written to audit. Covered by a test asserting no broker password appears in any response or audit row |

## 14. Out of scope

Per-device MQTT credentials and ACL generation (D4); every non-MQTT protocol
(the interface makes them additive); alarms, rules, Message Explorer, commands/RPC
(P4–P8); horizontal scale; multi-tenancy; dark mode.

**Success criterion:** a device publishes to the broker; the reading is queryable via
the API and visible in the UI; an unknown `deviceKey` appears in dead-letters rather
than vanishing.
