# Instruments — Inbound Multi-Protocol Ingestion — Design Spec

**Date:** 2026-08-04
**Status:** Approved for planning
**Branch:** `data-injection`

---

## 1. Problem

The application has no way to register a physical instrument or receive data from
one. We need an **Instruments** page where an operator can create instruments —
one at a time or in bulk — and where each instrument can connect to this
application and send readings over its own protocol.

ThingsBoard is the reference for the *experience* (a flat device registry, a
credential per device, connection instructions the technician can paste), not a
system to clone.

---

## 2. Context: this overlaps work that was deleted

On 2026-08-04 the Data Injection Layer was removed from this repository and the
tree rolled back to `9a6350f`. All of it survives on the pushed tag
**`pre-data-injection-drop`** (see [[data-injection-programme]] in memory).

That work is **not** a drop-in answer here, because its direction was opposite:

| | Deleted P1/P2 | This spec |
|---|---|---|
| Who connects | This app connected **out** to a broker | Instruments connect **in** to us |
| Auth | One service account for the whole broker | One token **per instrument** |
| MQTT role | Client subscriber | EMQX authorises each device against our API |
| Instrument model | Required `hierarchyNodeId`, gateway, profile | Flat; none of those |

What *is* reusable is everything **behind** the listeners, because it is
protocol-agnostic — `parsePayload()` takes a `Buffer`, which an HTTP body, MQTT
payload, WebSocket frame and TCP line all are.

**Reused from the tag (verbatim where possible):**

- `payload-parser.ts` — `parsePayload(Buffer)`, `classifyValue()`, `toReadings()`
- `telemetry.repository.ts` — `writeBatch()`, `writeDeadLetters()`, `getLatest()`, `getHistory()`
- the `20260801140000_telemetry` schema — `instrument_telemetry_latest`,
  `instrument_telemetry_history` (monthly range partitions), `dead_letters`
- `telemetry-partition.worker.ts` — partition maintenance

**Not reused:** `mqtt.adapter.ts`, `connection-manager.ts`, `subscriptions.ts`,
`topic-router.ts` (all outbound-client concerns), and the hierarchy, gateway and
communication-profile models.

---

## 3. Decisions taken (with rationale)

| # | Decision | Rationale |
|---|---|---|
| D1 | Instruments connect **inbound** | Chosen explicitly over outbound; matches the ThingsBoard reference |
| D2 | **All six named** transports live in v1 | HTTP, HTTPS, MQTT, MQTTS, WebSocket, TCP/IP. `wss` is additionally included as the TLS form of WebSocket, for symmetry with http/https and mqtt/mqtts — so **7 enum values, 4 protocol families** |
| D3 | **One transport per instrument** | Lets the UI show exactly one correct connection example; matches ThingsBoard device profiles |
| D4 | **Per-instrument access token** | One credential that works identically across every transport; simple to issue, rotate, revoke |
| D5 | ~~Token **stored hashed, shown once**~~ — **REVERSED 2026-08-06, see below** | A retrievable credential is a standing liability |
| D6 | **EMQX** hosts MQTT; this app authorises | EMQX 5.3.2 is already installed and verified; writing a broker is not the job. The HTTP auth hook keeps credentials owned by us, so revocation is immediate |
| D7 | Payload is **JSON key/value** | Maps directly onto telemetry key/value/timestamp; the reused parser already does this |
| D8 | TCP framing is **newline-delimited** | Most common for instruments; simple to implement correctly |
| D9 | **Flat instrument model** — no hierarchy FK | The deleted model *required* a hierarchy node. ThingsBoard devices are flat; grouping can come later |
| D10 | Ingest queue stays **in-process** for v1 | Durable queueing is a separate piece of work. Consequence is stated in §9 |

### 3.1 D5 reversed — tokens are viewable and settable (2026-08-06)

**D5's reasoning above still stands and is not deleted: a retrievable credential
IS a standing liability.** It was reversed anyway, at the operator's explicit
request, because the cost it imposed was higher than the risk it avoided. With a
write-once token, the only way to learn what a deployed device is using is to
regenerate — which stops that device dead until somebody physically goes and
reconfigures it. In practice that turns "what token is PROBE-07 on?" into a site
visit, and the predictable result is operators keeping the creation-time token in
a spreadsheet, which is strictly worse than the platform holding it encrypted.

**What changed.** `instrument_credentials` gains `token_encrypted` — AES-256-GCM
`iv:authTag:ciphertext`, keyed on `INSTRUMENT_TOKEN_KEY` from the environment.
Two endpoints: `GET /api/instruments/:id/token` (reveal) and
`PUT /api/instruments/:id/token` (set a specific value, e.g. to match a token
baked into a device's firmware).

**Compensating controls** — these are what make the reversal defensible, and
removing any one of them re-opens the liability D5 named:

1. **Encrypted at rest, key outside the database.** A stolen `pg_dump`, backup or
   snapshot yields ciphertext. It does *not* protect against a host compromise
   where the attacker reads both the database and the environment.
2. **`INSTRUMENT_UPDATE` + an ALWAYS-ON password re-auth** on both endpoints.
   Reveal uses the *update* permission, not `INSTRUMENT_READ`: reading a live
   credential is not a read of registry metadata. The re-auth (actions
   `REVEAL_INSTRUMENT_TOKEN` / `SET_INSTRUMENT_TOKEN`) uses
   `enforceReauthAlways`, so it is **not** an admin-managed policy and cannot be
   switched off. Corrected 2026-08-06, hours after the endpoints landed: the
   first implementation used the configurable `enforceReauth`, and
   `system_config['action-reauth']` lists nothing on a stock install — so an
   installation that never opened the policy page had control 1 and control 3
   only, while this document claimed three. Because the gate is intrinsic, the
   two actions are deliberately NOT registered in `REAUTH_ACTIONS`: a per-role
   toggle that changes nothing is worse than no toggle.
3. **Every view is audited.** `INSTRUMENT_TOKEN_VIEWED` is written inside the
   transaction, before the value is returned. The token remains a secret; who
   looked at it and when does not. `INSTRUMENT_TOKEN_SET` covers the write side.
   Neither row ever carries the token value — only its 8-char prefix.

**What did NOT change, and must not:**

- **The hash is still the only thing authentication consults.**
  `resolveInstrumentByToken` compares against `token_hash` exactly as before and
  never decrypts. If hash and ciphertext ever disagree, the hash is right.
- **Ingest is independent of the key.** No `INSTRUMENT_TOKEN_KEY`, or a wrong
  one, costs a reveal — never a reading. Issuance does not depend on it either.
- **Credentials issued before 2026-08-06 stay unviewable.** Plaintext cannot be
  derived from a hash, so there is no backfill; those report
  `TOKEN_NOT_RECOVERABLE` and the remedy is to regenerate. `token_encrypted` is
  nullable for exactly this reason.

Implementation and the full threat-model note: `apps/api/src/modules/instruments/token-crypto.ts`.

---

## 4. Schema

### 4.1 `Instrument` (new)

```
id                  uuid pk
name                text
code                text unique     -- human reference, used in MQTT topics
transport           text            -- http|https|mqtt|mqtts|websocket|wss|tcp
isActive            boolean default true
instrumentType      text?
manufacturer        text?
model               text?
serialNumber        text?
description         text?
expectedIntervalSec int?            -- null = exempt from liveness
createdAt, updatedAt, createdBy
```

Deliberately absent: `hierarchyNodeId`, `gatewayId`, `communicationProfileId`.

### 4.2 `InstrumentCredential` (new)

```
id           uuid pk
instrumentId uuid fk -> Instrument (cascade delete)
tokenHash    text            -- the ONLY column authentication consults
tokenPrefix  text            -- first 8 chars, for identification + lookup
tokenEncrypted text?         -- added 2026-08-06 (§3.1): AES-256-GCM copy so the
                             -- token can be revealed. NULL for anything issued
                             -- before that date, or with no key configured.
createdAt    timestamptz
lastUsedAt   timestamptz?
revokedAt    timestamptz?
```

One active (non-revoked) credential per instrument. Regeneration revokes the old
row and inserts a new one, so history is preserved for audit.

`tokenPrefix` exists so authentication can index-seek rather than scan-and-compare
every hash.

### 4.3 Reused telemetry tables

Restored from the tag unchanged. Note two properties that must survive:

- `instrument_telemetry_history` is `PARTITION BY RANGE (ts)` and its primary key
  **must** include `ts` — Postgres requires the partition column in the PK.
- **The partition-maintenance worker is not housekeeping.** An insert whose `ts`
  falls outside every existing partition is rejected outright, so without a
  future partition ingestion stops at midnight on the 1st.

---

## 5. Architecture — thin listeners, one ingest pipeline

Four listener implementations cover all seven transport values: HTTP and MQTT
each serve their TLS variant through the same code path, and WebSocket likewise.
Only TCP stands alone.

```
HTTP/HTTPS ─┐
MQTT/MQTTS ─┤   authenticate → resolve instrument → parsePayload(Buffer)
WebSocket  ─┼──→   → toReadings → bounded queue → batched writeBatch
TCP/IP     ─┘            ├─→ instrument_telemetry_latest
                         ├─→ instrument_telemetry_history (partitioned)
                         └─→ dead_letters (on failure)
```

Each listener has exactly two responsibilities: **obtain bytes** and **obtain a
token**. Everything downstream is shared. This is what stops each added protocol
from multiplying the work, and it means a fix in ingestion is a fix for all of them.

### 5.1 Authentication per transport

| Transport | Endpoint / topic | Token delivery |
|---|---|---|
| HTTP / HTTPS | `POST /api/ingest/v1/telemetry` | `Authorization: Bearer <token>` |
| MQTT / MQTTS | `instruments/<code>/telemetry` | MQTT **username**; EMQX calls `POST /api/ingest/v1/mqtt-auth` → allow/deny |
| WebSocket / WSS | `/api/ingest/v1/ws` | header on upgrade, or first frame |
| TCP/IP | raw socket | **first line** `{"token":"..."}`, then newline-delimited readings |

TCP authenticates in-band because a byte stream has no headers. Sockets that do
not authenticate within a short timeout are closed, so a scanner cannot hold
connections open.

### 5.2 Auth-hook exemption (security-critical)

Ingest endpoints authenticate with **device tokens, not user JWTs**, so they must
be exempt from the global auth hook. An allowlist on an auth hook is exactly
where holes are made, so a test asserts the ingest paths are the **only**
exemptions — the same shape as the existing audit URL-exclusion invariant test.

These endpoints are rate-limited: they are the only routes reachable without a
login.

---

## 6. User interface

### 6.1 Sidebar

New `instruments` id added to **both** lists:

- `SIDEBAR_ITEMS` in `packages/shared/src/types/sidebar-items.ts` (governs
  Roles & Access)
- `allNavItems` in `apps/web/src/components/layout/sidebar.tsx` (renders the nav)

The parity test asserting these hold the same ids is **restored from the tag**
(`a27bfe9`); it was lost in the rollback and nothing currently enforces the
invariant. A feature has shipped with no nav link from exactly this gap before.

### 6.2 List page

Mirrors `users/list.tsx` (SWR + `usePaginationConfig`). Columns: name, code,
transport, status, **last seen**, actions. Filters on transport and active state,
plus search. "Last seen" is the at-a-glance answer to "is this device talking?".

### 6.3 Single create

Form → **one-time credential dialog** showing:

- the token, with copy affordance and an explicit "shown only once" warning
- **connection instructions for that instrument's transport** — exact endpoint or
  topic plus a paste-ready example (`curl`, `mosquitto_pub`, …)

The commonest onboarding failure is a technician guessing the topic. Because each
instrument has exactly one transport (D3), exactly one correct example is shown.

### 6.4 Bulk create

`@fastify/multipart` is already registered (5 MB, 1 file).

- Download a CSV template with correct headers
- Upload → **per-row validation, partial success**: valid rows are created,
  invalid rows reported with row number and reason. Mirrors the existing
  bulk-operate pattern; one typo must not reject 200 devices.
- Result is a **downloadable CSV** of created instruments and their tokens.

> ⚠️ That result file contains live credentials in plaintext, and is labelled as
> such in the UI. It was originally unavoidable because tokens were knowable only
> at creation; since the D5 reversal (§3.1) they can also be revealed one at a
> time, but the bulk file is still the practical way to configure 200 devices.

### 6.5 Detail page

Connection details, latest telemetry, recent history, **regenerate token**
(reauth-gated), and that instrument's dead letters — the place to look when data
is arriving but not appearing.

---

## 7. RBAC and audit

New permissions in `PERMISSION_TREE`: `INSTRUMENT_READ`, `INSTRUMENT_CREATE`,
`INSTRUMENT_UPDATE`, `INSTRUMENT_DELETE`.

New reauth action for **token regeneration** — issuing a credential warrants the
same password proof as disabling a user. That one is admin-configurable
(`REGENERATE_INSTRUMENT_TOKEN`, in `REAUTH_ACTIONS`). The D5 reversal (§3.1) adds
`REVEAL_INSTRUMENT_TOKEN` and `SET_INSTRUMENT_TOKEN` on the same reasoning, but
**always-on** and outside the registry — see §3.1 control 2.

Audit rows for: instrument created (single and bulk), updated, deleted, token
regenerated, token revoked, **token viewed** and **token set** (§3.1). Bulk creation writes one row per instrument, so the
trail is per-entity rather than per-batch.

---

## 8. Testing

| Transport | Verification |
|---|---|
| MQTT / MQTTS | **Real EMQX** on this machine — publish, assert row lands and UI updates |
| HTTP / HTTPS | `curl` |
| WebSocket / WSS | Node client script |
| TCP/IP | Node socket, **including a split-packet test** |

The TCP split test is mandatory: framing bugs pass every normal test and fail the
first time a message straddles a packet boundary.

**Negative tests, every transport:** wrong token rejected; **revoked token
rejected immediately** (proves the EMQX hook is consulted, not cached); malformed
JSON dead-lettered rather than crashing the listener.

Unit tests for the pure pieces: token hashing/verification, CSV row validation,
TCP line framing.

**Stated limit:** this proves our side is correct. It does **not** prove any
particular physical instrument interoperates. That is first-contact work.

**Suite note:** `apps/api` must be run single-fork
(`npm test`) — the default pool produces unstable counts from the shared-`admin`
login race. Baseline at time of writing: **14 pre-existing failures** in 4 files.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| **In-process ingest queue loses unflushed readings on restart** (D10) | Short flush interval; stated plainly in the UI/docs. Durable queueing deferred |
| Partition exhaustion halts ingestion at month boundary | Restore the partition-maintenance worker; test that it creates ahead |
| Auth-hook allowlist widens over time | Invariant test asserting ingest paths are the only exemptions |
| TCP socket exhaustion | Connection cap, idle timeout, unauthenticated-socket timeout |
| MQTTS/HTTPS certificate handling on Windows | Reuse existing mkcert setup; verify against real EMQX |
| Bulk token CSV is a plaintext secret file | Explicit UI labelling; no server-side retention |
| EMQX 5.3.2 is unmaintained (Windows dev only) | Acceptable for development; production should run current EMQX on Linux |

---

## 10. Out of scope for v1

Hierarchy, gateways, communication profiles. Alarms, thresholds, rule engine.
Dashboards. Commands *to* devices (downlink/RPC). Durable ingest queue.
Non-telemetry categories (dead-lettered). Certificate-based (X.509) device auth.

Each is a real feature; none is required to create instruments and receive their
data.
