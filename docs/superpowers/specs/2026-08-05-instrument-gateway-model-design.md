# Instrument Gateway Model — Design Spec

**Date:** 2026-08-05
**Status:** Approved for planning
**Branch:** `data-injection`
**Builds on:** `2026-08-04-instruments-inbound-ingestion-design.md` (P1 — registry + HTTP ingest, delivered)

---

## 1. Problem

Field sensors frequently have no network path of their own. They are wired to a
collector — a gateway — which is the only device on the network. Today every
instrument must authenticate individually, so such a fleet cannot be onboarded
at all.

Operators also need to find an instrument by where it physically is. The P1
model records no placement whatsoever.

---

## 2. What already exists (and is deliberately refused)

`parsePayload()` (`apps/api/src/modules/instruments/payload-parser.ts`) accepts
two shapes:

```
flat   {"temperature": 21.5}                              → one instrument
batch  {"devices": {"SENSOR-A": {"temperature": 21.5},    → many, keyed by code
                    "SENSOR-B": {"humidity": 47}}}
```

The HTTP ingest route **rejects the batch shape** with `400
UNSUPPORTED_BATCH_PAYLOAD` (`ingest-routes.ts:70-80`), for a stated reason:

> Batch payload (`{"devices": {...}}`) is device-keyed data for OTHER
> instruments, which P1's single-instrument-token model has no way to
> authenticate.

That is precisely the gap this spec closes. The parser, the batched writer
(`writeBatch`, which already takes `instrumentId` per row) and the dead-letter
path are all in place. What is missing is a rule saying *which* other
instruments a given token may write. This feature supplies that rule; it does
not invent a new pipeline.

---

## 3. Decisions taken (with rationale)

| # | Decision | Rationale |
|---|---|---|
| D1 | Data flows **child → gateway → platform** | The gateway reports on behalf of sensors that cannot reach the network. Matches the batch shape the parser already emits, and the ThingsBoard model the P1 spec took as its reference. |
| D2 | **One level only** — a child may not itself be a gateway | Prevents credential cycles and the "whose token authorised this row?" ambiguity. The wire format does not change if nesting is added later. |
| D3 | **One gateway per instrument** (single parent FK, not many-to-many) | Reduces "may this token write instrument X?" to one comparison. A sensor is physically wired to one collector. |
| D4 | Children **keep their own credentials** | An instrument may be reachable directly *and* via its gateway (mixed fleets, migrations). Linking must never silently stop a deployed device from reporting. |
| D5 | An unknown/unlinked/inactive code in a batch is **dead-lettered; the rest of the payload is accepted** | Mirrors the partial-success rule already used for bulk CSV. One mistyped code must not discard a 40-sensor reading. |
| D6 | Turning **Is Gateway off while children are linked is refused**, naming them | Auto-unlinking would stop those sensors reporting with nothing in the UI to say why. |
| D7 | Deleting a gateway **unlinks** its children, never deletes them | They are real instruments with their own telemetry history. |
| D8 | Location / Area / Block are **free text**; "Instrument ID" is the existing `code` | No new tables, no lookup-admin screens. `code` is already unique and already the MQTT topic segment; renaming the label is the whole change. |
| D9 | Last-seen moves **onto the instrument**, with the source recorded | See §6 — without this a gateway-reported child reads "Never" forever. |

---

## 4. Schema

Three nullable text columns, one boolean, one self-referencing FK. No new tables.

```
model Instrument {
  …existing…
  location    String?   @map("location")
  area        String?   @map("area")
  block       String?   @map("block")

  isGateway   Boolean   @default(false) @map("is_gateway")
  gatewayId   String?   @map("gateway_id")

  // D9 — last-seen belongs to the instrument, not to its credential.
  lastSeenAt  DateTime? @map("last_seen_at") @db.Timestamptz(3)
  lastSeenVia String?   @map("last_seen_via")   // 'direct' | 'gateway'

  gateway     Instrument?  @relation("GatewayChildren", fields: [gatewayId], references: [id], onDelete: SetNull)
  children    Instrument[] @relation("GatewayChildren")

  @@index([gatewayId])
  @@index([block, area, location])
}
```

`gatewayId` **is** the authorisation model: a gateway may write instrument X if
and only if `X.gatewayId = gateway.id`. No link table, nothing to keep in sync,
and the rule is a single equality.

`onDelete: SetNull` implements D7 directly at the database level.

Migration is hand-authored per the repo rule (`apps/api/CLAUDE.md`); `prisma
migrate dev` auto-generation and `db push` are forbidden against a populated DB.

### Invariants enforced in the service layer

- `isGateway = true` ⟹ `gatewayId IS NULL` (D2: a gateway has no parent)
- `gatewayId = X` ⟹ `X.isGateway = true` (only a gateway may be a parent)
- `gatewayId ≠ self` (no self-parenting)
- D2 plus D3 make cycles unreachable: a child cannot be a gateway, so no chain
  longer than two exists to close.

---

## 5. Ingest — the fan-out

```
POST /api/ingest/v1/telemetry
Authorization: Bearer <GATEWAY token>
{"devices": {"SENSOR-A": {"temperature": 21.5},
             "SENSOR-B": {"humidity": 47}}}

  resolve token ─► identity {id, code, transport, isGateway}
        │
        ├─ flat payload            → unchanged P1 behaviour, writes to the sender
        │
        └─ batch payload
             ├─ identity.isGateway false → 400 UNSUPPORTED_BATCH_PAYLOAD (unchanged)
             └─ per keyed block:
                  code → child instrument
                    ├─ unknown code            → dead-letter this block
                    ├─ child.gatewayId ≠ me    → dead-letter this block
                    ├─ child.isActive false    → dead-letter this block
                    └─ otherwise               → readings, instrumentId = child.id
             one writeBatch() for every accepted reading across all children
             → 200 {"accepted": N, "rejected": M}
```

A non-gateway sending a batch keeps the existing `400` — its message is
extended to say the instrument is not configured as a gateway, which is now an
actionable instruction rather than a flat refusal.

`rejected` is reported in the body so a gateway integrator sees partial failure
without reading the dead-letter table. The status stays `200`: the request was
handled correctly and the accepted readings are stored.

### Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `gateway-fanout.ts` | **Pure.** `(devices, childMap, ts) → { readings, deadLetters }`. No DB, no I/O. | payload-parser types only |
| `gateway-children.ts` | `childMapFor(gatewayId)` → `code → {id, isActive}`, short-TTL cached like `ingest-auth` | prisma |
| `ingest-routes.ts` | Wire the two together; unchanged for flat payloads | both of the above |

Keeping the decision logic pure is what makes D5's four rejection reasons
testable without a database.

---

## 6. Last-seen (D9)

P1 stamps `InstrumentCredential.lastUsedAt` on the direct ingest path, and the
list's "Last seen" column reads it. A gateway-reported child never presents its
own credential, so under this feature that column would read **"Never"** for
exactly the instruments the feature exists to serve.

So last-seen moves onto the instrument:

- direct ingest → `lastSeenAt = now`, `lastSeenVia = 'direct'` (the credential's
  `lastUsedAt` is still stamped — that remains a true fact about the credential)
- gateway fan-out → for each accepted child, `lastSeenAt = now`,
  `lastSeenVia = 'gateway'`

Throttled by the same 10-second window as the existing credential stamp, so a
gateway posting every second costs one write per instrument per window, not one
per reading.

`lastSeenVia` is also the answer to the risk D4 creates: a child with two write
paths can be written from two sources, and the detail page showing *"last
reported via gateway GATEWAY-01"* makes that visible instead of silent.

---

## 7. User interface

**Create / edit form** gains a Placement group (Block, Area, Location — free
text) and an **Is Gateway** toggle. `code` is relabelled **Instrument ID**; it
remains immutable after creation (it is baked into MQTT topics and the device
configuration).

**List page** gains Block / Area / Location filters and a gateway marker.
Filters are text `contains`, matching the existing search behaviour.

**Detail page — Linked Instruments panel**, shown only when `isGateway`:
a multi-select of *eligible* instruments (active, not gateways, not already
parented elsewhere) with link / unlink. Attempting to disable Is Gateway while
children remain shows D6's refusal listing them.

**Detail page of a child** shows *"Reported via GATEWAY-01"* with a link, plus
its own direct credentials — both paths are real (D4) so both are shown.

**`connection-instructions.tsx`** learns one new state per protocol family: when
the instrument is a gateway, the example becomes the `devices` batch shape
listing that gateway's **actual linked children**, so the command is not merely
illustrative — it is the correct command for this specific gateway.

---

## 8. RBAC and audit

No new permissions. Linking is an instrument edit: `INSTRUMENT_UPDATE`,
consistent with the `instruments.edit` tree node.

New audit actions, emitted inside the same transaction as the mutation
(§11.10(e)): `INSTRUMENT_GATEWAY_ENABLED`, `INSTRUMENT_GATEWAY_DISABLED`,
`INSTRUMENT_LINKED_TO_GATEWAY`, `INSTRUMENT_UNLINKED_FROM_GATEWAY`. Linking
changes which credential can write an instrument's record, so it is an
access-control change and belongs in the trail.

Telemetry writes are not audited, exactly as in P1 — the readings are the record.

---

## 9. Testing

**Pure** (`gateway-fanout`): unknown code; code linked to a *different* gateway;
inactive child; mixed valid + invalid in one payload; empty `devices`; a block
that is not an object.

**Integration**: gateway posts for two children → two instruments' rows land, and
`writeBatch` is called once; gateway posts for a code it does not own → that
block dead-lettered with the reason naming the gateway, others accepted, `200
{accepted, rejected}`; **non-gateway posting a batch still gets 400**; a child's
own token still works while linked (D4); disabling Is Gateway with children is
refused (D6); deleting a gateway leaves children present with `gatewayId` null
(D7); `lastSeenAt`/`lastSeenVia` set to `gateway` for a child reported through
its gateway (D9).

**Browser**: create a gateway, link two children, copy the batch command shown on
its page and run it verbatim — it must return `{"accepted":N}` and both children
must show readings and "via gateway". If the pasted command does not work the
instructions are wrong, which is the whole point of showing them.

**Suite discipline**: `cd apps/api && npm test` (single-fork). Baseline at time
of writing: **14 pre-existing failures in 5 files** (`auth-profile-reauth`,
`entities`, `replacement-audit-enrichment`, `super-admin-unretire`,
`block-change-approval-current`). Do not "fix" those.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Two write paths per child (D4) disagree | `lastSeenVia` surfaces the source; dead-letter reasons name the gateway |
| A gateway's token becomes a fleet-wide credential — compromise exposes every child | Scope is explicit and bounded by `gatewayId`; linking is audited; regeneration already revokes immediately |
| Child-map cache lets a just-unlinked child keep being written for up to the TTL | Link/unlink invalidates the gateway's child-map cache directly, as `invalidateIngestAuthCache` already does for tokens |
| Free-text placement drifts (`Block C` vs `block-c`) | Accepted (D8). Lookup lists remain an option later; the columns do not change shape |
| Large fleets make one batch enormous | The existing 64 KB body cap and 1000-key ceiling still apply, now counted across all children |

---

## 11. Out of scope

Downlink / commands to devices. Nested gateways. Many-to-many linking. Gateway
auto-provisioning of unknown children (an unknown code is dead-lettered, never
created — silent device creation from an unauthenticated-ish path is how a
registry becomes untrustworthy). MQTT / WebSocket / TCP listeners remain P2/P3;
the fan-out sits behind the listener boundary and will serve them unchanged.
