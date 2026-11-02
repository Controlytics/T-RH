# TCP/IP (Modbus) instruments: the application reads the device

**Date:** 2026-10-31 · **Status:** DRAFT — builder-checked; operator answered §15 Q1–Q2 on 2026-10-31; for approval · **Branch:** `data-layer`
Every choice the operator did not state is marked **[my call]** and is theirs to overturn.
Concept PDF (approved direction): `docs/superpowers/concepts/2026-10-31-tcpip-instruments/TCP-IP Instruments - flow and screens.pdf`.

## 1. The ask

Operator, 2026-10-31, in order:

> "when ever instrument profile was creating at that time ask anothere option like is gateway or TCP/IP,
> if is gateway then present process will go, if user selected TCP/IP then in the instrument creation
> tcp/ip need to integrate, for one instrument one ip address and port, what ever added keys should come
> to that instrument how you will interface that application to this application"

> "in one profile each instrument will have one ip and port"

> "register map should be inside of instrument because each instrument should added different keys"

> "go with all recommendations" — the five on the PDF's last page:
> 1. the Reader runs **inside the server** when the server is on the plant network (A) **and** as a
>    **Plant Reader** on a plant PC when the server is in AWS (B) — build once, offer both;
> 2. the option is labelled **"TCP/IP (Modbus)"**;
> 3. a device is read **every 60 s by default**, set per profile, **never under 10 s**;
> 4. **read-only** — the application never writes to a device;
> 5. retire the `TCPIP/` desktop tool and withdraw instrument 101-01's old token (see §15 Q1 for how).

"That application" is the untracked `TCPIP/` folder: a Windows Modbus TCP → MQTT desktop tool that
polls a Modbus slave every 200 ms and publishes six keys (Temperature, Humidity, Pressure, Power,
Voltage, Switch) to AWS instrument `CWH/RDU/101-01` over plain MQTT 1883, with that instrument's token
in plaintext in its JSON. Its register map (`ModbusTCPReader_keys.json`) is
`{"keys":[{"key","register":"40001","data_type":"FLOAT32","byte_order":"ABCD"}, …]}`.
This feature replaces it. **Never commit, open in code, or run `TCPIP/`.**

## 2. What exists today (verified against the tree 2026-10-31, `a75ef269`)

- **One ingest path.** `ingestPayload({ identity, raw, transport, certificateVerified? })`
  (`apps/api/src/modules/instruments/ingest-core.ts:184`) parses a flat JSON object, applies sensor
  offsets, upserts history (`ON CONFLICT (instrument_id,key,ts)`; a same-instant change is audited
  `TELEMETRY_READING_REWRITTEN`) and latest (newer-wins), stamps `lastSeenAt`, enqueues alarm
  evaluation, and dead-letters what it cannot store. `transport` is a free string stored on dead
  letters (`'http'`, `'mqtt'`, `'ws'`, `'tcp'` today). Four callers: `ingest-routes.ts:78`,
  `listeners/mqtt-bridge.ts:500`, `listeners/ws-listener.ts:406`, `listeners/tcp-listener.ts:340`.
- **A payload's own time.** Top-level `ts`/`timestamp` (`payload-parser.ts:78-109`): a stamp more than
  10 min ahead or before 2000 is replaced by arrival time; an older stamp is accepted; one older than
  the earliest monthly partition is dead-lettered (`TIMESTAMP_OUT_OF_RANGE`). `devices` (and a
  gateway's `devN`) switch to the batch path.
- **Identity without a token.** `IngestIdentity = { id, code, isGateway, deviceCert:{required,issueId} }`
  (`ingest-auth.ts:14`); the MQTT bridge builds one from an instrument code (`mqtt-bridge.ts:581-601`).
- **In-process services** start after `app.listen` in `apps/api/src/app.ts` (TCP listener 560-583, MQTT
  bridge 585-627, `startRtcTicker()` 620 — `unref()`'d timers returning `{ stop() }`, the closest
  precedent for a timed loop) and stop in `shutdown()` (630-684). The e2e app
  (`src/e2e/test-helper.ts:126`) starts no listeners. graphile-worker cron is minute-granular
  (`packages/queue/crontab.txt`), so a seconds-level poll cannot be a cron entry.
- **Liveness.** `Instrument.lastSeenAt` (arrival wall-clock) + `lastSeenVia` (`'direct'|'gateway'`,
  `last-seen.ts:15`). "Reporting" = `isInstrumentReporting(lastSeenAt, expectedIntervalSec,
  activeWindowMinutes, now)` (`packages/shared/src/schemas/config.ts:339`): `expectedIntervalSec × 2`,
  **else the 1440-minute `activeWindowMinutes` default** — so an instrument without an expected interval
  reads "reporting" for a day after its last reading. The inactivity alarm pass
  (`workers/alarm-evaluation.worker.ts:555-660`) uses the same inputs.
- **Judgement.** The profile's `measurements` (`InstrumentProfile.measurements`, codes `TEMPERATURE`,
  `HUMIDITY`) name the device keys that are judged; `measuredSlotFor(cfg, key)` (`data-keys.ts:37`)
  case-folds. Every other key is stored and shown, never judged or alarmed.
- **Instruments.** `POST /api/instruments` (`routes.ts:1773`, `INSTRUMENT_CREATE` + reauth
  `CREATE_INSTRUMENT`) creates the instrument **and a token** in one transaction
  (`createWithCredential`, 402-494) and returns the token once. `PUT /:id` (2103, `INSTRUMENT_UPDATE` +
  `UPDATE_INSTRUMENT`) audits `INSTRUMENT_UPDATED` with before/after from `audited()` (2274-2293; an e2e
  derives the keys from `updateInstrumentSchema.shape`). Fastify strips undeclared response fields
  (`instrumentProps`, 89). `Instrument` has **no transport column by design** (`schema.prisma:1041`:
  "a credential authenticates on any listener") — this feature adds a *profile* connection type, which
  is a different fact: whether the application reads the device, not how a device logs in.
- **Profiles.** `POST /api/instrument-profiles` (`INSTRUMENT_CREATE`; reauth only when measurements
  differ from the defaults), `PUT /:id` (`INSTRUMENT_UPDATE` + `UPDATE_INSTRUMENT_PROFILE`; the governed
  `requireDeviceCertificate` switch at 640-666 is the precedent: SUPER_ADMIN, a reason, no-op if
  unchanged). Response schema `profileProps` (102). The web create form (`profile-list.tsx:119-148`) has
  Name and Description; keys and measurements are edited on Configuration → Instrument Attributes.
- **Bulk upload** (`bulk-plan.ts`, `bulk-csv.ts`): `code` + six optional columns + the profile's
  attribute keys; profile and functional location chosen once per upload; the CSV parser cannot carry a
  structured cell.
- **Audit.** 100 actions / 113 templates; adding one needs the registry, a template, the placeholder
  test, the API literal test, and — for an action with no user — `SYSTEM_AUDIT_ACTIONS`
  (`apps/api/src/lib/audit.ts:50-55`, or `auditLog` throws). Reauth actions: 57 in 8 categories, pinned
  by `reauth-actions.test.ts:32-33`.
- **Counts today:** 38 models / 13 enums, 36 config defs, 23 config pages, 56 routes, 7 tasks.

## 3. Goals, non-goals, anti-goals

**Goals**
1. A profile is created as **Gateway** (today, unchanged) or **TCP/IP (Modbus)**.
2. A TCP/IP profile holds how its instruments are read: **read interval** (60 s default, 10–3600 s) and
   **Modbus unit ID** (default 1). It holds no keys.
3. Each TCP/IP instrument holds **its own IP address and port** and **its own register map**; two
   instruments never share an IP and port.
4. **Test connection** reads a device once with a draft address and map and shows every key's decoded
   value before anything is saved.
5. **Part 2:** the server reads every enabled TCP/IP instrument on its profile's interval and feeds the
   values through `ingestPayload` — so offsets, limits, alarms, history, dashboards, reports and the
   audit trail need no change.
6. A TCP/IP instrument says, in plain words, whether the application is reaching it.
7. **Part 3:** a Plant Reader on a plant PC does the same for a server in AWS, outbound HTTPS only.

**Non-goals**
- Writing to a device (FC 05/06/15/16) — recommendation 4. A separate, separately validated project.
- Coils and discrete inputs (FC 01/02) **[my call]** — the operator's keys are registers; add later as
  another `area` value if a device needs it.
- Modbus RTU (serial) and RTU-over-TCP framing; only Modbus TCP (MBAP) is built.
- Raising alarms *retroactively* for readings a Plant Reader delivers late (§11.6).
- A per-profile register map. The operator chose per instrument; §5.3 gives Copy / Import instead.
- Moving an existing Gateway instrument into a TCP/IP profile (§15 Q1).

**Anti-goals** (would be failures even if they "work")
- A second way into the telemetry tables. Every reading enters through `ingestPayload`.
- A made-up value: a failed or undecodable read stores **nothing** — never 0, never the last value.
- The browser deciding anything: which keys are judged, whether an address is in use, how a register
  decodes. The server answers; the web shows the answer (root `CLAUDE.md` "Never").
- A token or password for a TCP/IP instrument stored anywhere, in any file.
- Polling so fast it floods history (the desktop tool's 200 ms is 2.6 M rows/day/instrument).

## 4. Vocabulary

| On screen | In code **[my call]** | Meaning |
|---|---|---|
| Connection: **Gateway** | `connection = 'PUSH'` | The device sends its own data (MQTT, HTTP, WS, raw TCP, via a gateway). Today's process. `'PUSH'` in code because "gateway" already means an RS485 gateway *instrument* (`isGateway`). |
| Connection: **TCP/IP (Modbus)** | `connection = 'MODBUS_TCP'` | The application (or a Plant Reader) reads the device. |
| **Register map** | `modbusRegisters` | The instrument's list of keys and where each one lives in the device. |
| **Reader** | `modbus-reader` | The server component that reads devices (Part 2). |
| **Plant Reader** | `plant-reader` | The Windows service that reads devices for a cloud server (Part 3). |
| **Test connection** | `modbus/test` | One read with a draft configuration; nothing stored. |

## 5. Data model

All new vocabularies are **validated strings, not Postgres enums** (the `FloorplanRoom.grade` /
alarm-webhook precedent) so they can grow without a migration. One migration per Part; each migration
is applied to **both** `compliance_core_db` and `compliance_core_db_test`. `prisma migrate diff` wants to
drop the partitioned `instrument_telemetry_history` — strip that from the generated SQL by hand.

### 5.1 `InstrumentProfile` — Part 1
> **Amended 2026-11-02 (§18, CR-1):** `modbusIntervalSec` and `modbusUnitId` moved to `Instrument`; the profile keeps only `connection`.

| Column | Type | Rule |
|---|---|---|
| `connection` | `String @default("PUSH")` | `'PUSH' \| 'MODBUS_TCP'`. Existing profiles become `PUSH` by the default. Changeable only while the profile has **no instruments** (409 `PROFILE_HAS_INSTRUMENTS`). |
| `modbusIntervalSec` | `Int?` | Required when `MODBUS_TCP` (default 60), 10..3600; NULL when `PUSH`. |
| `modbusUnitId` | `Int?` | Required when `MODBUS_TCP` (default 1), 0..255; NULL when `PUSH`. |

A `MODBUS_TCP` profile cannot have `requireDeviceCertificate = true` (400 `NOT_FOR_TCPIP`, both
directions): no device logs in, so there is no certificate to require.

### 5.2 `Instrument` — Part 1
> **Amended 2026-11-02 (§18, CR-1):** plus `modbusUnitId` (Slave ID) and `modbusIntervalSec` (Read every).

| Column | Type | Rule |
|---|---|---|
| `modbusHost` | `String?` | An IPv4 dotted quad. Required for a `MODBUS_TCP` profile's instrument, NULL otherwise. It must lie inside one of the administered **device networks** (§7.1: the TCP/IP Reading def's CIDR list, default `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and never in `0.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16` (incl. the cloud metadata address), `224.0.0.0/4` and above (400 `ADDRESS_NOT_ALLOWED`). Checked on every write (create, update, bulk), on Test connection and before every read, so narrowing the list stops reads at once. Hostnames are not accepted **[my call]** — the operator said "IP address", and a name that re-resolves breaks the one-address rule. |
| `modbusPort` | `Int?` | 1..65535, default 502 in the form. |
| `modbusRegisters` | `Json?` | The register map (§6), validated by the shared `modbusRegisterMapSchema` on every write, read only through a `coerce…` reader. `[]` is allowed (an instrument created before its map is known is simply not read — §7.1). |

Unique partial index on `(modbusHost, modbusPort) WHERE modbusHost IS NOT NULL`; a clash is 409
`ADDRESS_IN_USE` naming the instrument that has it **if the caller can see it**, else "already in use"
(the bulk upload's out-of-view rule).

A TCP/IP instrument: `isGateway = false`, `gatewayId = NULL` (400 otherwise); **no
`InstrumentCredential` is created**, and the token routes (regenerate / reveal / set) refuse it with 400
`NO_TOKEN_FOR_TCPIP`. `PUT /api/instruments/:id` still accepts `profileId` (`routes.ts:2116`, though the
UI control is gone): a move between a `PUSH` and a `MODBUS_TCP` profile, either way, is refused with 409
`CONNECTION_DIFFERS` (§15 Q1).

### 5.3 Reading status — Part 2: model `ModbusPollStatus` (38 → 39 models)
`instrumentId` (PK, FK cascade), `readBy` (`'server'` or a Plant Reader id), `lastAttemptAt`,
`lastSuccessAt`, `failingSince` (NULL while healthy), `lastErrorCode`, `lastErrorMessage`,
`lastErrorAt`, `consecutiveFailures`, `updatedAt`. Written by the Reader (Part 2) and by Plant Reader
status posts (Part 3). It is operational state, not a §11 record; the §11 record is the audit row on
each healthy↔failing transition (§10).

### 5.4 Part 3: `PlantReader` (39 → 40 models) — see §11.

## 6. The register map

### 6.1 Shape (shared zod, `packages/shared`)
```
ModbusRegister = {
  key: string,               // the telemetry key stored, e.g. "Temperature"
  register: string,          // Modicon reference: 30001-39999 / 300001-365536 (input),
                             //                    40001-49999 / 400001-465536 (holding)
  dataType: 'UINT16'|'INT16'|'UINT32'|'INT32'|'FLOAT32',
  byteOrder: 'ABCD'|'BADC'|'CDAB'|'DCBA',   // required for 32-bit types; absent for 16-bit
  scale: number              // default 1; finite, non-zero
}
ModbusRegisterMap = ModbusRegister[]   // max 100 keys [my call]
```
The **area** (Input / Holding) is derived from the reference and shown, never entered — the desktop tool
stores only `"register": "40001"` **[my call]**. **No unit column [my call]:** a raw key's unit is
already set where it is shown (widget key display, trend-page display keys) and a measured key's unit
comes from its measurement; a third place would disagree (the concept PDF showed one — this removes it).

### 6.2 Rules (server-enforced; the same schema gives the form its messages)
- `key`: 1..64 characters, trimmed, unique **case-insensitively** within the map; not `ts`,
  `timestamp`, `devices`, `dev` followed by digits, or any other key the payload parser treats as
  metadata (`payload-parser.ts` `META_KEYS`, e.g. `quality`) — they change how `ingestPayload` reads the
  payload or are silently dropped by it. The reserved list is derived from the parser's own constants,
  never a second copy.
- References are 1-based Modicon, as the desktop tool's `parse_modicon_ref` (verified 2026-10-31):
  `40001` → holding address 0, `40003` → 2, `30001` → input address 0; 5 or 6 digits, number part
  1..65536. Import keys file therefore needs no offset.
- No two keys may share a register: a 32-bit type occupies `register` and `register + 1`, which must be
  in the same area and range.
- A map's registers in one area may span at most 125 registers per request; the read plan (§6.3)
  splits, so this is a planning rule, not a refusal.

### 6.3 Read plan and decoding (`packages/modbus`, §7.2)
- Per area, sort keys by address and merge into the fewest **FC 03 (holding) / FC 04 (input)** requests
  of ≤ 125 registers each, bridging gaps inside a request (the device must answer for the gap; if it
  refuses with exception 02, the error names the request's range).
- Decode: 16-bit big-endian per register (UINT16 / INT16); 32-bit from the two registers' four bytes
  `A B C D` (first register = A B) re-ordered by `byteOrder` into big-endian before reading UINT32 /
  INT32 / FLOAT32. Worked example (pinned by a test): 22.4 = `0x41B33333`; ABCD `41B3 3333`,
  CDAB `3333 41B3`, BADC `B341 3333`, DCBA `3333 B341` all decode to 22.4.
- Then `× scale`, then **round**: FLOAT32 to 7 significant digits (its precision — 22.399999618… →
  22.4); a scaled integer to the decimals of `scale` (× 0.1 → 1 decimal, so 2301 × 0.1 → 230.1, never
  230.10000000000002); an unscaled integer stays an integer.
- A FLOAT32 that decodes to NaN or ±Infinity is **not stored**; that key goes to a dead letter
  (`transport 'modbus'`, reason names the key and the raw words) and the other keys are stored.

## 7. Part 2 — the Reader inside the server

### 7.1 What is read
An instrument is read by the server when **all** hold: its profile is `MODBUS_TCP` and active; the
instrument is active; `modbusHost`, `modbusPort` set; its map has at least one key; it is not assigned
to a Plant Reader (Part 3); and Configuration → **TCP/IP Reading** → "Read devices from this server" is
ON. New def `modbus-reader.def.ts` (SUPER_ADMIN card, 36 → 37 defs) with two settings **[my call]**:
- **Read devices from this server** — **default OFF**. While OFF the server opens **no** Modbus
  connection at all: no reads, and Test connection answers "Reading devices from this server is off
  (Configuration → TCP/IP Reading)". A plant install turns it on once; an AWS install leaves it off, so
  a cloud server can never be made to connect into its own network.
- **Device networks** — the CIDR list a device address must fall in (§5.2), default the three private
  ranges. A plant narrows it to its device subnets (e.g. `192.168.1.0/24`).

### 7.2 Where the code lives **[my call]**
- **`packages/modbus`** (new workspace package, Node-only, no dependencies): the Modbus TCP client
  (MBAP framing, FC 03/04 only, connect + response timeouts, exception codes → plain words), the read
  planner and the decoder. Hand-written like the desktop tool (≈150 lines of protocol), not an npm
  Modbus library: a validated system should not pull a dependency tree for two function codes. It is
  shared by the server Reader and the Plant Reader so the two can never decode differently.
- **`apps/api/src/modules/modbus/`**: `reader.ts` (`startModbusReader({ log }) → { stop() }`, started
  after the MQTT bridge in `app.ts`, stopped in `shutdown()` before `app.close()`, never started by the
  e2e app — tests drive `readOnce(instrumentId)` directly), the Test-connection route, the status route.

### 7.3 Scheduling and connection
- Every 5 s the Reader reloads the set of instruments to read (§7.1) if anything changed (a cheap
  `updatedAt` max check) — so a new instrument starts being read within one interval, a disabled one
  stops.
- Each instrument is read every `modbusIntervalSec` of its profile, its first read offset by a hash of
  its id across the interval (no thundering herd). At most **16 reads in flight** **[my call]**; an
  instrument whose previous read is still running skips the tick (no queue builds up).
- One TCP connection **per read**: connect (3 s timeout), send the planned requests in order on that
  connection, each awaited (1 s response timeout), close. Many field devices accept one or two
  connections only; holding none open between reads is the safe default **[my call]**.
- **At most one read in flight per `host:port`** **[my call]** — the in-flight cap is per address as
  well as global, so a converter that serves several unit IDs (§15 Q2) is never opened twice at once.
- The API runs as one process on every install (`scripts/aws/digilog-api.service`,
  `scripts/linux/systemd/digilog-api.service`, the Windows service), so there is one Reader; nothing
  here coordinates several.
- Unit ID = the profile's `modbusUnitId`.

### 7.4 Into the ingest path
A successful read builds `{ <key>: <value>, …, "ts": <read start, ms> }` and calls
`ingestPayload({ identity, raw, transport: 'modbus' })` with an identity built from the instrument row
(as the MQTT bridge does) and `deviceCert.required = false` (a TCP/IP profile cannot require one, §5.1).
`stampLastSeen` gains the source `'polled'` (`lastSeenVia`), which means `ingestPayload` takes an
optional `lastSeenVia` argument (default `'direct'`) threaded to its two stamp calls
(`ingest-core.ts:315`, `:379`) — the only change to the ingest core. The outcome is recorded on
`ModbusPollStatus`. A `WRITE_FAILED` outcome is a server fault, logged and counted as a failed read.

### 7.5 Failures
| Situation | Code | Words on screen |
|---|---|---|
| connect timed out / host unreachable | `NO_ANSWER` | "192.168.1.24 : 502 did not answer within 3 s — check the IP, the cable, and that the device is on." |
| connection refused | `REFUSED` | "192.168.1.24 refused port 502 — the device is reachable but not listening on that port." |
| Modbus exception 01/02/03/04… | `DEVICE_EXCEPTION` | "The device refused registers 40001–40010 (exception 02, illegal address) — the register map does not match it." |
| response timeout / short or malformed frame | `BAD_RESPONSE` | "192.168.1.24 : 502 accepted the connection but did not answer the read within 1 s." |

A failed read stores nothing. **Three consecutive failed reads** **[my call]** set `failingSince` (= the
first of the three) and write the SYSTEM audit row `MODBUS_DEVICE_NOT_ANSWERING`; the first success after
that clears it and writes `MODBUS_DEVICE_ANSWERING` with the missed-read count and the gap's start and
end (§10). One or two misses in a row are counted on the status row but neither change the state nor
write an audit row — a lossy link must not write thousands of chained audit rows a day. Nothing is
audited per failed read.

Alarms come from the existing **Inactivity alarm** (it reads `lastSeenAt`) — no new alarm source, as
the approved concept says. That alarm ships OFF (`inactivity-alarms.def.ts`); it is ON on the local
install (grace 1 min, checked 2026-10-31) and must be checked on AWS at deploy. When it is OFF, the
status route returns `inactivityAlarmsOff: true` and the TCP/IP card says "No alarm is raised when this
device stops answering — Inactivity Alarms are off (Configuration → Inactivity Alarms)".

### 7.6 "Reporting" follows the read interval
One server-side resolver, used by **every** caller of `isInstrumentReporting` — `buildTelemetryOverview`,
the inactivity pass, the activity summary (`instruments/routes.ts:787`) and the functional-locations
counts (`functional-locations/routes.ts:145`):
`effectiveExpectedIntervalSec(instrument, profile) = instrument.expectedIntervalSec ??
(profile.connection === 'MODBUS_TCP' ? profile.modbusIntervalSec : null)`. Without it a silent TCP/IP
instrument reads "reporting" for up to `activeWindowMinutes` (default 1440, §2). A test greps that no
caller of `isInstrumentReporting` bypasses the resolver.

## 8. Test connection — Part 1
> **Amended 2026-11-02 (§18, CR-1):** the body carries `modbusUnitId`; the limit is 30 per minute per user.


`POST /api/instruments/modbus/test` `{ profileId, modbusHost, modbusPort, modbusRegisters,
instrumentId? }` → `{ ok: true, elapsedMs, requests: n, values: [{ key, value, judgedAs }] }` or
`{ ok: false, code, message }` (§7.5 wording). Gate: `INSTRUMENT_CREATE` or `INSTRUMENT_UPDATE`; no
reauth, **not stored, not audited** — it creates no reading and changes nothing **[my call]**. Rate limit
10 per minute per user. The address rules of §5.2 apply (it is the route that would otherwise let a user
make the server connect anywhere). `judgedAs` (`'TEMPERATURE' | 'HUMIDITY' | null`) is the server's
`resolvedSlotFor` over the map's keys for that profile (so when two keys fold to one measurement, the one
actually judged is the one marked) — the form's "Judged as" column shows it after a test and "—" before,
never a browser guess. The address-in-use check runs here too, so the form can say "already
CWH/RDU/101-01" before Save. With "Read devices from this server" OFF the route makes no connection and
says so (§7.1); in Part 3 an instrument assigned to a Plant Reader is tested *through* that reader
(§11.4).

## 9. API changes — Parts 1 and 2

- Profile create/update schemas + routes: `connection`, `modbusIntervalSec`, `modbusUnitId`;
  declared in `profileProps`; in `INSTRUMENT_PROFILE_CREATED/UPDATED` before/after. Creating a TCP/IP
  profile needs no reauth (as creating any profile with default measurements today); changing its
  connection, interval or unit ID is the existing `UPDATE_INSTRUMENT_PROFILE` path.
- Instrument create/update schemas + routes: `modbusHost`, `modbusPort`, `modbusRegisters`; declared in
  `instrumentProps`; in `audited()` (so `INSTRUMENT_CREATED/UPDATED` carry before/after). On a
  **`PUT` that changes any of the three on an existing instrument a `reason` is required** (400
  `REASON_REQUIRED`) **[my call]** — the concept promised "remarks and signature" and the attribute edits
  already work this way; the signature is the existing `UPDATE_INSTRUMENT` reauth.
- **Changing an existing instrument's register map is SUPER_ADMIN only** (403 `REGISTER_MAP_SA_ONLY`)
  **[my call]**, the `MEASUREMENTS_DIFFER` precedent (`routes.ts:2146-2162`): a map edit can stop an
  instrument being judged (renaming "Temperature") or shift every stored value (× 0.1 → × 1). Setting the
  map at create, and changing the IP or port later, stay with `INSTRUMENT_CREATE` / `INSTRUMENT_UPDATE`.
  The web shows the map's Edit button only to a SUPER_ADMIN; the 403 is the control.
- Create of a TCP/IP instrument: no credential, no `token` in the 201.
- `GET /api/instruments/:id/modbus-status` (`INSTRUMENT_READ`, visibility-scoped) → `{ state:
  'reading' | 'failing' | 'not-read', notReadReason?, readBy, intervalSec, lastSuccessAt,
  failingSince, lastError?, stored24h, expected24h }`. `stored24h` = distinct reading instants in the
  last 24 h (from history); `expected24h` = 86400 / interval. `notReadReason`: `INSTRUMENT_DISABLED`,
  `NO_REGISTER_MAP`, `SERVER_READING_OFF`, `NO_ADDRESS`.
- Bulk upload, TCP/IP profile: headings **"IP address"** and **"Port"**, required per row; an optional
  per-upload **"Copy register map from"** instrument (a TCP/IP instrument in view) applied to every
  created row **[my call]** — 100 identical devices in one upload, not 100 map edits. Existing rows: IP /
  Port changes follow the existing bulk rules (blank keeps; one remark for the upload).
- `docs/recreation/06-api/endpoints.md`: new rows.

## 10. 21 CFR Part 11 and the audit trail

- Configuration changes are records: profile connection/interval/unit ID (`INSTRUMENT_PROFILE_*`),
  instrument address and register map (`INSTRUMENT_CREATED/UPDATED`, before/after, reason on change).
- New **SYSTEM** actions (no user; added to `SYSTEM_AUDIT_ACTIONS`), category Instruments:
  `MODBUS_DEVICE_NOT_ANSWERING` ("{code}: {host}:{port} stopped answering — {reason}") and
  `MODBUS_DEVICE_ANSWERING` ("{code}: answering again after {missed} missed reads, {from}–{to}").
  100 → 102 actions, 113 → 115 templates (Part 2). Any new placeholder gets its substitution in
  `apps/web/src/routes/audit/audit-helpers.ts`.
- Test connection is not a record (it stores nothing).
- A reading's time is the moment the read started (server clock; Plant Reader clock in Part 3, §11.5).
- OQ: new test cases (outside the code) — register map validation, Test connection success and each
  failure, address clash, disabled instrument not read, interval honoured, healthy↔failing audit rows.

## 11. Part 3 — the Plant Reader (its own plan, after Parts 1–2 ship)

### 11.1 What it is
`apps/plant-reader/`: a Node 24 service using `packages/modbus`, installed on a plant PC by its own
small Inno Setup installer (the same toolchain and service approach as `scripts/build-installer.ps1`;
the builder picks the service wrapper the main installer already uses). Configured with the server URL
and a **reader key**; nothing else is typed on the PC, and no device credential exists anywhere.

### 11.2 Server side
- Model `PlantReader`: `id`, `name` (unique), `keyHash`, `keyPrefix` (the instrument-token scheme,
  `token.ts`), `scopeFunctionalLocationIds Json` (Blocks/Areas it reads; expanded server-side like the
  list route's scope), `revokedAt`, `lastCheckInAt`, `lastCheckInIp`, `clockOffsetMs`, `version`,
  `createdAt/By`. Scopes of two readers may not overlap (409). An instrument in a reader's scope is
  read by that reader and never by the server.
- Page **Configuration → Plant Readers** (`/config/plant-readers`, SUPER_ADMIN card; routes 56 → 57,
  config pages 23 → 24): list (name, PC, instruments, last check-in, clock offset, status), Add (name +
  scope → the key **shown once** + the installer download), Revoke (immediate; reauth). New reauth action
  `MANAGE_PLANT_READER` under Configuration (57 → 58). Audit `PLANT_READER_CREATED`, `_UPDATED`,
  `_REVOKED`.
- Reader API under `/api/plant-reader/v1/` (`Authorization: Bearer <reader key>`; added to the public
  paths allowlist and its test): `GET config` (its instruments: id, code, host, port, unit ID, interval,
  register map, an ETag), `POST readings` (a batch of `{ instrumentId, ts, values }`, each fed through
  `ingestPayload` with `transport 'plant-reader'`; an instrument outside its scope is refused per item),
  `POST status` (per-instrument `ModbusPollStatus` + check-in with its clock), `GET jobs` / `POST
  jobs/:id/result` (Test connection relayed to the reader for its instruments).

### 11.3 Reading
Exactly §6–§7 (same package), on the PC.

### 11.4 Test connection through a reader
The form's Test connection for an instrument in a reader's scope creates a job; the reader polls `jobs`
every 5 s, runs it, posts the result; the form waits up to 15 s, then says "The Plant Reader did not
pick up the test — is it running?".

### 11.5 Time and outages
- Readings are stamped with the PC's clock. Each check-in carries the PC time; the server stores the
  offset and the page warns above 60 s. The existing 10-minute "future stamp" rule still applies.
- If the server is unreachable the reader keeps readings on disk in order (bounded at 24 h) and sends
  them oldest first when it returns; past 24 h the oldest are dropped and the reader reports the gap,
  which the server audits (`PLANT_READER_GAP`, SYSTEM).

### 11.6 Late readings are stored but not judged
A reading delivered late is stored and drawn, but limit alarms evaluate the *latest* value, so an
excursion that happened during the outage raises no alarm when it arrives. The outage itself already
raised the Inactivity alarm. **Accepted for Part 3** **[my call]**, recorded in the feature note; judging
late readings is a separate change to the alarm pipeline (§15 Q3).

## 12. Screens
> **Amended 2026-11-02 (§18, CR-1):** Read every / Unit ID left the profile screens; they, Quantity and a per-key Test are on the instrument.


- **Instrument Profiles → + New Profile** (`profile-list.tsx`): Connection — Gateway | TCP/IP (Modbus),
  Gateway preselected; with TCP/IP, "Read every" (10 s..60 min, default 60 s) and "Unit ID" (1). Profile
  cards carry a GATEWAY / TCP/IP chip. A new empty TCP/IP profile says "Each instrument gets its own IP
  address, port and register map when it is added" with + New Instrument.
- **Configuration → Instrument Attributes**, TCP/IP profile: a "TCP/IP reading" section (interval, unit
  ID; `UPDATE_INSTRUMENT_PROFILE`). Attribute keys and Measurements unchanged.
- **New Instrument** (`create.tsx`), TCP/IP profile: Identity (Is Gateway and Reports through gateway
  hidden); **TCP/IP connection** card (IP address, Port); **Register map** card (rows: Key, Register,
  Area [shown], Data type, Byte order [32-bit only], Scale, Judged as [server, after a test]; + Add key;
  **Copy from instrument…** — a picker of TCP/IP instruments in view; **Import keys file** — the desktop
  tool's JSON, converted in the form and validated by the server like any map); **Test connection**
  (values table, or the failure in words); Attributes (unchanged); Create. No TokenDialog.
- **Instrument page** (`detail.tsx`), TCP/IP instrument: **TCP/IP connection** card in place of Access
  token / Connection (state line, address, interval, stored/expected in 24 h, last failure, Test
  connection, Edit address with reason); **Register map** card (view; Edit with reason). Device
  certificate and Connection-instructions cards hidden.
- **Part 3:** Configuration → Plant Readers (§11.2).
- Visual language: UI v3 (`PageHero`, `FormSection`, shared `Table`, `--band-gradient`); the concept PDF
  is the reference; the operator sees it rendered (headless Chrome with the built CSS) before hand-over.

## 13. Security

- Modbus TCP has no authentication or encryption; the Reader only reads. Document it in the feature
  note; plant network segmentation is the customer's.
- The server connects only when "Read devices from this server" is ON (default OFF), only to addresses
  inside the administered device networks (default the private ranges) and never to loopback,
  link-local/cloud metadata, multicast or broadcast (§5.2); Test connection only for a user holding
  instrument create/update rights, rate-limited.
- No device secret exists for a TCP/IP instrument. The reader key (Part 3) is hashed at rest, shown once,
  revocable, and scoped to its Blocks/Areas.

## 14. Tests (each Part)

- `packages/modbus`: MBAP framing; FC 03/04 against an in-process fake slave (`node:net`), incl.
  exception replies, short frames, timeouts, refused; planner (merging, 125 cap, two areas); decoder
  (all types × byte orders, the 22.4 table, NaN/Inf, rounding incl. 230.1 and 22.4).
- Shared schema: every §6.2 rule; the reserved keys; 32-bit overlap.
- API e2e: profile connection rules (no change with instruments; NOT_FOR_TCPIP both ways); instrument
  create/update (no credential, token routes refuse, address rules incl. device networks,
  ADDRESS_IN_USE incl. out of view, REASON_REQUIRED, REGISTER_MAP_SA_ONLY, CONNECTION_DIFFERS,
  before/after in audit); Test connection (success against a fake slave started by the test, each
  failure code, the OFF switch makes no connection, rate limit, judgedAs via resolvedSlotFor); Reader
  `readOnce` → history + latest + `lastSeenVia 'polled'` + alarm enqueue; failure → nothing stored; one
  and two misses change nothing, the third writes one transition row, recovery writes one; one read per
  `host:port` at a time; §7.6 resolver in every `isInstrumentReporting` caller (plus the grep test);
  modbus-status figures incl. `inactivityAlarmsOff`; bulk upload columns + Copy from.
- Web: create form (TCP/IP shows the two cards, hides gateway fields, no TokenDialog; Judged as only
  from the response); detail cards; profile form. One file per process, judged by exit code.
- Render check of the new screens at 1240 px with the built stylesheet.

## 15. Questions for the operator

1. **101-01 — ANSWERED 2026-10-31: register it fresh.** No profile move is built (the API refuses one,
   `CONNECTION_DIFFERS`, §5.2). The operator withdraws 101-01's token and disables the old 101-01 (its
   readings are the desktop tool's simulator data); the device is registered as a new TCP/IP
   instrument once Part 2 is deployed and reading is on. Production writes on AWS are the operator's.
2. **Several sensors behind one converter — ANSWERED 2026-10-31: no, each device has its own IP.**
   Built as written: every instrument has its own IP and port, unique; the unit ID is set once on the
   profile. (The per-address read limit of §7.3 stays — it costs nothing.)
3. **Late readings (Part 3).** Should an excursion delivered late raise an alarm when it arrives? Not
   built; recommended to decide after Part 3 is in use.

Settled by the builder check (2026-10-31), not questions any more: the AWS server cannot be made to
connect into its network (§7.1, default OFF + device networks); a dead device's alarm is the Inactivity
alarm, and the screen says when that is off (§7.5); map edits on an existing instrument are SUPER_ADMIN
only (§9); Modicon numbering matches the desktop tool (§6.2); healthy↔failing is debounced to three
reads (§7.5). Acceptance for Parts 1–2: the test suite's in-process fake slave, then the operator's
ModSlave simulator on the plant network (the device the desktop tool reads today).

## 16. Touch points and docs

API: `schema.prisma` + 1 migration per Part; `modules/instruments/{routes,ingest-core(no change),
last-seen,telemetry-overview,bulk-*}.ts`; `modules/instrument-profiles/routes.ts`; `workers/alarm-
evaluation.worker.ts` (resolver); `modules/modbus/*`; `app.ts`; `lib/audit.ts` (SYSTEM actions);
`config/defs/modbus-reader.def.ts` (+ `config-discovery.ts`, + card); `plugins/auth.ts` public paths
(Part 3). Shared: schemas (profile, instrument, register map), audit actions + templates, reauth (Part
3). New `packages/modbus` (root `CLAUDE.md` monorepo list; workspaces). Web: `profile-list.tsx`,
`create.tsx`, `detail.tsx`, `routes/config/instrument-attributes.tsx`, audit helpers. Docs: root
`CLAUDE.md` counts (models, actions/templates, defs, packages; routes/pages and reauth in Part 3) —
**root `CLAUDE.md`, `CHANGELOG.md` and `docs/feature-notes.md` carry another session's uncommitted
hunks: stage only this work's hunks (the anchored-blob procedure)**; new feature note in
`docs/feature-notes.md` (not `apps/web/CLAUDE.md`, which must not grow past its 150k limit);
`docs/recreation/06-api/endpoints.md`; `CHANGELOG.md`; `tasks/todo.md`.

## 17. Calls I made that the operator did not

| Call | Cost if wrong |
|---|---|
| `connection` values `PUSH` / `MODBUS_TCP` in code ("Gateway" on screen) | a rename |
| Unit ID on the profile, not the instrument | a column moves |
| IPv4 only, no hostnames | a schema widening |
| No unit column in the register map | a column added later |
| Area derived from the Modicon reference | an input added |
| 16-bit types have no byte order | an option added |
| Max 100 keys per map; 16 reads in flight; connect-per-read | constants |
| Hand-written Modbus client in a new `packages/modbus` | swap for a library |
| Reason required to change address/map on an existing instrument | a rule relaxed |
| Map edits on an existing instrument SUPER_ADMIN only | a gate widened |
| Test connection not stored, not audited, rate-limited | an audit action added |
| "Read devices from this server" toggle, **default OFF**; device networks default to the private ranges | a plant install turns it on once |
| "Not answering" after 3 consecutive failed reads | a constant |
| One read in flight per `host:port` | a constant |
| Bulk "Copy register map from" per upload | a column instead |
| Coils/discrete inputs and RTU out of scope | a later Part |
| Late Plant Reader readings not judged (Part 3) | an alarm-pipeline change |

## 18. Change request CR-1 (operator, 2026-11-02, after Parts 1–2 were deployed as `20bff73`)

Operator: "slave id should comes in instrument page, and also big endian, little endian this text was not
showing and read every should come in instrument page, give one test button after adding key check data was
coming or not and also quantity was not there, and if register address is 2 registers for one key then how to
add, fix all these". Asked and answered: **remove both from the profile**; **Quantity 1 or 2** per key.
This section overrides §5.1, §5.2, §7.3, §7.6, §8, §9 and §12 wherever they disagree.

- **The profile** chooses only Gateway or TCP/IP. `instrument_profiles.modbus_interval_sec` and
  `.modbus_unit_id` are dropped after copying them to every instrument on a MODBUS_TCP profile
  (`COALESCE` to 1 / 60). A profile body carrying either is a 400.
- **Each TCP/IP instrument** has `modbusUnitId` (**Slave ID**, 0..255, default 1) and `modbusIntervalSec`
  (**Read every**, 10..3600 s, default 60). Set on New Instrument and in bulk ("Slave ID", "Read every"
  columns); changed on the instrument page with a reason under `UPDATE_INSTRUMENT` re-auth (the host/port
  rule). On a Gateway profile's instrument either field is a 400. The Reader, the status route, Test
  connection and the reporting resolver (`effectiveExpectedIntervalSec`) take both from the instrument.
- **Quantity** (1 or 2 registers) is a column of the register map editor, derived from the data type
  (`registersFor`) and NOT stored — the map's shape is unchanged. It limits the data types offered (1: UINT16,
  INT16; 2: UINT32, INT32, FLOAT32); changing it clears an incompatible type so the operator chooses one
  (a wrong type reads a believable wrong number). The row shows the range read ("40001–40002").
- **Byte order** is shown by name: Big-endian (ABCD), Little-endian (DCBA), Big-endian, byte swap (BADC),
  Little-endian, byte swap (CDAB). The stored value is still the code.
- **Per-key Test** on every register-map row reuses `POST /api/instruments/modbus/test` with a one-key map;
  its answer prints under that row. The route's limit rises from 10 to 30 per minute per user so
  "add key, test" on a full device does not hit it.
- No model, enum, permission, reauth action, audit action, def or page count moves.
