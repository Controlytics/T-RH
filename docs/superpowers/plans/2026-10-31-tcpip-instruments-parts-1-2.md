# TCP/IP (Modbus) Instruments — Parts 1 and 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A profile can be Gateway or TCP/IP (Modbus); each TCP/IP instrument holds its own IP, port and register map, can be tested before saving, and (Part 2) is read by the server on its profile's interval through the one ingest path.

**Architecture:** Shared zod contracts carry the vocabulary, the register-map rules and the desktop keys-file converter. A self-contained Modbus TCP protocol module inside the API (client, read planner, decoder — no API imports) is used by a Test-connection route (Part 1) and an in-process Reader (Part 2) that builds a flat payload and calls `ingestPayload` with `transport 'modbus'`. The web adds a profile connection choice, a register-map editor and Test-connection panel on the New Instrument form, and status/map cards on the instrument page.

**Tech Stack:** Fastify 5, Prisma (Postgres 18), `node:net`, zod in `@digilog/shared`, React 19 + SWR + Tailwind v4, vitest.

**Spec:** `docs/superpowers/specs/2026-10-31-tcpip-instruments-design.md` (approved 2026-10-31, "go ahead"). Concept: `docs/superpowers/concepts/2026-10-31-tcpip-instruments/TCP-IP Instruments - flow and screens.pdf`.

## Plan rulings (where this plan departs from or settles the spec)

- **P1** The Modbus protocol code lives in `apps/api/src/modules/modbus/protocol/` for Parts 1–2, importing nothing from the API (only `node:net`, `@digilog/shared`). The spec's `packages/modbus` is created in Part 3 by moving these files unchanged — a new workspace now would change the installer, `.deb` and AWS build for no Part 1–2 user. *(The spec marked `packages/modbus` [my call].)*
- **P2** `META_KEYS` moves from `apps/api/src/modules/instruments/payload-parser.ts:40` to `@digilog/shared` as `PAYLOAD_META_KEYS`; the parser imports it and the register-map schema reserves it — one list, never a copy (spec §6.2).
- **P3** `effectiveExpectedIntervalSec` lives in `@digilog/shared` beside `isInstrumentReporting` (`packages/shared/src/schemas/config.ts:339`), so every caller imports the one resolver.
- **P4** "Copy from instrument" lists TCP/IP instruments through `GET /api/instruments?connection=MODBUS_TCP` (a new list filter) and reads the chosen map from `GET /api/instruments/:id`.

## Global Constraints

- Vocabulary in code: `connection` ∈ `'PUSH' | 'MODBUS_TCP'` (screen: "Gateway" / "TCP/IP (Modbus)"); validated strings, **no Postgres enum**.
- Profile: `modbusIntervalSec` default **60**, min **10**, max **3600**; `modbusUnitId` default **1**, range **0..255**; both NULL on a `PUSH` profile.
- Instrument: `modbusHost` IPv4 dotted quad only (no hostnames); `modbusPort` **1..65535** (form default **502**); `modbusRegisters` JSON array, **max 100** entries.
- Refused address ranges always: `0.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`, `224.0.0.0/4` and everything above it (incl. `255.255.255.255`). Plus: inside the administered **device networks** (default `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) → else 400 `ADDRESS_NOT_ALLOWED`.
- Register key: **1..64** chars trimmed, unique case-insensitively, not in `PAYLOAD_META_KEYS` (`ts`, `timestamp`, `quality`, `devices`), not `/^dev\d+$/i`.
- Register reference: 1-based Modicon, 5 or 6 digits, prefix `3` (input → FC 04) or `4` (holding → FC 03), number part **1..65536**; `40001` → address 0. 32-bit types use `n` and `n+1` (same area, ≤ 65536).
- Data types `UINT16 | INT16 | UINT32 | INT32 | FLOAT32`; byte orders `ABCD | BADC | CDAB | DCBA`, **required for 32-bit, absent for 16-bit**; `scale` finite, non-zero, default **1**.
- At most **125** registers per request; FC 03/04 only; no writes, no coils.
- Rounding: FLOAT32 → 7 significant digits; scaled integer → the decimals of `scale`; unscaled integer stays integer. NaN/±Inf → not stored, dead-lettered (`transport 'modbus'`).
- Timeouts: connect **3000 ms**, response **1000 ms**. Reader: reload check every **5 s**; at most **16** reads in flight globally and **1 per `host:port`**; a still-running instrument skips its tick; "not answering" after **3** consecutive failures; recovery after **1** success.
- Test connection: `POST /api/instruments/modbus/test`, gate `INSTRUMENT_CREATE` or `INSTRUMENT_UPDATE`, rate limit **10/min/user**, not stored, not audited.
- Config def `modbus-reader` (SUPER_ADMIN card): `serverReadingEnabled` boolean **default false**; `deviceNetworks` textarea (comma/newline CIDRs) default `10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16`. While OFF the server opens **no** Modbus connection (Test connection included).
- Failure wording (exact, `{host}`/`{port}`/`{range}`/`{n}`/`{name}` substituted):
  - `NO_ANSWER`: "{host} : {port} did not answer within 3 s — check the IP, the cable, and that the device is on."
  - `REFUSED`: "{host} refused port {port} — the device is reachable but not listening on that port."
  - `DEVICE_EXCEPTION`: "The device refused registers {range} (exception {n}, {name}) — the register map does not match it."
  - `BAD_RESPONSE`: "{host} : {port} accepted the connection but did not answer the read within 1 s."
  - `READING_OFF`: "Reading devices from this server is off (Configuration → TCP/IP Reading)."
- New SYSTEM audit actions (category Instruments): `MODBUS_DEVICE_NOT_ANSWERING` "{code}: {host}:{port} stopped answering — {reason}", `MODBUS_DEVICE_ANSWERING` "{code}: answering again after {missed} missed reads, {from}–{to}".
- Error codes: `PROFILE_HAS_INSTRUMENTS` (409), `NOT_FOR_TCPIP` (400), `ADDRESS_NOT_ALLOWED` (400), `ADDRESS_IN_USE` (409), `NO_TOKEN_FOR_TCPIP` (400), `CONNECTION_DIFFERS` (409), `REASON_REQUIRED` (400), `REGISTER_MAP_SA_ONLY` (403).
- `transport` string `'modbus'`; `lastSeenVia` `'polled'`.
- **Every reading enters through `ingestPayload`.** A failed read stores nothing. The browser never decides judgement, address-in-use or decoding (root `CLAUDE.md` "Never").
- **Never open, run, or commit `TCPIP/`.** Never touch the other session's uncommitted files (`git status` at task start); stage BY PATH; `CHANGELOG.md`, `docs/feature-notes.md` and root `CLAUDE.md` carry another session's hunks → anchored-blob procedure only (`git show HEAD:<p>` → apply own hunk keeping CRLF → `git hash-object -w --no-filters` → `git update-index --cacheinfo` → same hunk in the working copy → commit → `git diff --cached` empty, their numstat unchanged).
- Migrations: hand-authored SQL (strip any `DROP` of `instrument_telemetry_history`), applied to **both** `compliance_core_db` and `compliance_core_db_test` with `DATABASE_URL` passed explicitly; `prisma generate` needs `tsx watch` stopped (Windows EPERM) — if it is running, say so in the report rather than killing the operator's dev API.
- Tests: web vitest **one file per process, judged by exit code**; never two vitest processes at once (low memory); API e2e single fork with `DATABASE_URL` = the test DB; mutation-check each new rule, restoring from a backup copy, never `git checkout`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **A device that answers wrongly** — a reply with the wrong transaction id, wrong unit id, wrong function code, or fewer bytes than asked: `BAD_RESPONSE`, nothing stored, socket closed. (Task 2.)
2. **The Reader is stopped mid-read** (API shutdown): `stop()` resolves, no timer fires afterwards, an in-flight read finishing late writes nothing. (Task 9.)
3. **Configuration changes while the Reader runs** — instrument disabled, map edited, profile interval changed, `serverReadingEnabled` switched OFF, device networks narrowed: the next reload (≤ 5 s) applies it; OFF stops all connections. (Task 9.)
4. **Two map keys that resolve to the same measurement** (`Temperature` and `t` under default measurements): `judgedAs` marks only the key `resolvedSlotFor` picks. (Task 5.)
5. **A desktop keys file the converter cannot take** — a coil/discrete reference (`00001`, `10001`), an unknown `data_type`, a missing byte order on FLOAT32, a duplicate key: refused naming the row, nothing half-imported. (Task 1.)

---

### Task 1: Shared contracts — vocabulary, register map, keys-file converter, reporting resolver

**Files:**
- Create: `packages/shared/src/types/modbus.ts`
- Create: `packages/shared/src/types/__tests__/modbus.test.ts`
- Modify: `packages/shared/src/schemas/instrument-profiles.ts` (create/update schemas), `packages/shared/src/schemas/instruments.ts` (create/update + bulk schemas get the fields; `reason`), `packages/shared/src/schemas/config.ts` (resolver beside `isInstrumentReporting`), `packages/shared/src/index.ts` (exports)
- Modify: `apps/api/src/modules/instruments/payload-parser.ts:40` (import `PAYLOAD_META_KEYS`, delete local `META_KEYS`)

**Interfaces — Produces:**
- `MODBUS_CONNECTIONS = ['PUSH','MODBUS_TCP'] as const`; `type ModbusConnection`.
- `MODBUS_INTERVAL = { min: 10, max: 3600, default: 60 }`, `MODBUS_UNIT_ID = { min: 0, max: 255, default: 1 }`, `MODBUS_PORT_DEFAULT = 502`, `MODBUS_MAX_KEYS = 100`, `MODBUS_MAX_REGISTERS_PER_REQUEST = 125`.
- `MODBUS_DATA_TYPES`, `MODBUS_BYTE_ORDERS`; `type ModbusRegister = { key: string; register: string; dataType; byteOrder?; scale: number }`; `type ModbusRegisterMap = ModbusRegister[]`.
- `modbusRegisterSchema`, `modbusRegisterMapSchema` (all §Global Constraints map rules, incl. overlap), `coerceModbusRegisterMap(value: unknown): ModbusRegisterMap` (invalid → `[]`).
- `parseModiconRef(ref: string): { area: 'HOLDING' | 'INPUT'; address: number }` (throws `Error` naming the ref); `registersFor(dataType): 1 | 2`.
- `PAYLOAD_META_KEYS: ReadonlySet<string>` = `ts, timestamp, quality, devices`.
- `modbusHostSchema` (IPv4 + always-refused ranges), `parseDeviceNetworks(text: string): { cidrs: string[]; errors: string[] }`, `ipInNetworks(ip: string, cidrs: string[]): boolean`, `DEVICE_NETWORKS_DEFAULT = '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16'`.
- `fromDesktopKeysFile(json: unknown): { ok: true; map: ModbusRegisterMap } | { ok: false; errors: string[] }` — `{keys:[{key, register, data_type, byte_order}]}`; `byte_order` dropped for 16-bit; `scale` 1.
- `effectiveExpectedIntervalSec(inst: { expectedIntervalSec: number | null }, profile: { connection: string; modbusIntervalSec: number | null }): number | null`.
- Schemas: `createInstrumentProfileSchema` / `update…` gain `connection?`, `modbusIntervalSec?`, `modbusUnitId?` (a `MODBUS_TCP` create defaults interval 60 / unit 1); `createInstrumentSchema` / `update…` gain `modbusHost?`, `modbusPort?`, `modbusRegisters?`; `updateInstrumentSchema` gains `reason?: string`; `bulkCreateInstrumentsSchema` gains `copyRegisterMapFrom?: uuid`.

- [ ] **Step 1: Write the failing tests** in `modbus.test.ts`:
  - `parseModiconRef('40001')` → `{area:'HOLDING', address:0}`; `'40003'` → 2; `'30001'` → `{area:'INPUT',address:0}`; `'465536'` → 65535; `'00001'`, `'10001'`, `'40000'`, `'4001'`, `'465537'` throw.
  - Map schema refuses: duplicate key `Temperature`/`temperature`; key `ts`, `quality`, `dev3`; 65-char key; FLOAT32 at `40001` + UINT16 at `40002` (overlap); FLOAT32 at `49999` (runs past the area); FLOAT32 without `byteOrder`; INT16 with `byteOrder`; `scale: 0`; 101 keys. Accepts the six-key map from spec §6/the PDF.
  - `modbusHostSchema` refuses `127.0.0.1`, `169.254.169.254`, `0.1.2.3`, `224.0.0.1`, `255.255.255.255`, `host.local`, `192.168.1.256`; accepts `192.168.1.24`, `10.0.0.5`.
  - `parseDeviceNetworks('192.168.1.0/24,\n10.0.0.0/8')` → two cidrs; `'192.168.1.0/33'` → an error; `ipInNetworks('192.168.1.24',['192.168.1.0/24'])` true, `('192.168.2.1', …)` false.
  - `fromDesktopKeysFile` accepts the desktop tool's six-key shape (Temperature FLOAT32 `40001` ABCD … Switch INT16 `40010`) → 6 entries, Voltage/Switch without byteOrder; refuses (Review Focus 5) `register:'00001'`, `data_type:'FLOAT64'`, FLOAT32 missing `byte_order`, duplicate key — each error names the row number; on any error `ok:false` and no map.
  - `effectiveExpectedIntervalSec({expectedIntervalSec:null},{connection:'MODBUS_TCP',modbusIntervalSec:60})` → 60; `({expectedIntervalSec:300}, …)` → 300; `({expectedIntervalSec:null},{connection:'PUSH',modbusIntervalSec:null})` → null.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/types/__tests__/modbus.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `modbus.ts` and the schema/resolver edits; move `META_KEYS` (P2).
- [ ] **Step 4: Run** the new test, then the whole shared suite `cd packages/shared && npx vitest run` → exit 0; `npm run build -w @digilog/shared` → exit 0; API parser tests `cd apps/api && npx vitest run src/modules/instruments/__tests__/payload-parser*` (one process) → exit 0.
- [ ] **Step 5: Commit** `feat(shared): TCP/IP (Modbus) contracts — register map, device networks, keys-file converter`.

### Task 2: Modbus protocol module (API, self-contained)

**Files:**
- Create: `apps/api/src/modules/modbus/protocol/{client.ts,plan.ts,decode.ts,errors.ts,index.ts}`
- Create: `apps/api/src/test-support/fake-modbus-slave.ts`
- Test: `apps/api/src/modules/modbus/protocol/__tests__/{plan,decode,client}.test.ts`

**Interfaces — Consumes:** Task 1 `ModbusRegisterMap`, `parseModiconRef`, `registersFor`, `MODBUS_MAX_REGISTERS_PER_REQUEST`.
**Produces:**
- `type ReadRequest = { functionCode: 3 | 4; address: number; quantity: number; keys: string[] }`; `planReads(map: ModbusRegisterMap): ReadRequest[]`.
- `decodeMap(map, words: Map<string /*area:address*/, number>): { values: Record<string, number>; rejected: { key: string; reason: string }[] }`.
- `type ModbusErrorCode = 'NO_ANSWER' | 'REFUSED' | 'DEVICE_EXCEPTION' | 'BAD_RESPONSE'`; `modbusErrorMessage(code, ctx): string` (exact wording, §Global Constraints).
- `type ReadResult = { ok: true; values: Record<string, number>; rejected: {key;reason}[]; elapsedMs: number; requests: number } | { ok: false; code: ModbusErrorCode; message: string }`.
- `readDevice(opts: { host: string; port: number; unitId: number; map: ModbusRegisterMap; connectTimeoutMs?: number; responseTimeoutMs?: number; signal?: AbortSignal }): Promise<ReadResult>` — one connection, requests in order, each awaited, then close.
- `startFakeSlave(opts: { holding?: Record<number, number>; input?: Record<number, number>; unitId?: number; behaviour?: 'normal' | 'exception02' | 'silent' | 'wrongTxId' | 'wrongUnit' | 'wrongFc' | 'short' }): Promise<{ host: string; port: number; close(): Promise<void> }>` (binds 127.0.0.1:0 — the test-only exception to the address rules, which live above this module).

- [ ] **Step 1: Write failing tests.**
  - `plan.test.ts`: six-key map → one FC 03 request `{address:0, quantity:10}`; a map with `40001` and `40200` → two requests (gap > 125 bridged only within the cap); mixed `30001`/`40001` → one FC 04 + one FC 03; 130 consecutive UINT16 → requests of 125 + 5.
  - `decode.test.ts`: the 22.4 table — words `0x41B3,0x3333` ABCD, `0x3333,0x41B3` CDAB, `0xB341,0x3333` BADC, `0x3333,0xB341` DCBA → 22.4 each; UINT16 2301 × 0.1 → 230.1 (not 230.10000000000002); INT16 `0xFFFF` → -1; UINT32/INT32 both orders; FLOAT32 NaN words `0x7FC0,0x0000` → in `rejected`, not in `values`; FLOAT32 22.399999618… → 22.4.
  - `client.test.ts` against the fake slave: success returns the six values and `requests: 1`; `exception02` → `DEVICE_EXCEPTION` with "registers 40001–40010 (exception 02, illegal address)"; `silent` → `BAD_RESPONSE` within ~1 s; closed port → `REFUSED`; unroutable (`10.255.255.1` with `connectTimeoutMs: 200`) → `NO_ANSWER`; **Review Focus 1:** `wrongTxId`, `wrongUnit`, `wrongFc`, `short` → `BAD_RESPONSE`, and the socket is closed (fake slave sees the close).
- [ ] **Step 2: Run** each file alone (`cd apps/api && npx vitest run <file>`) → FAIL.
- [ ] **Step 3: Implement.** MBAP: 7-byte header (txId u16, protocol 0, length u16, unit u8) + PDU (fc, address u16, quantity u16); reply PDU `fc` + byteCount + data, or `fc|0x80` + exception code. Read the full frame by its MBAP length before parsing.
- [ ] **Step 4: Run** the three files (one process each) → exit 0. Mutation-check: drop the txId check → the `wrongTxId` case fails; restore.
- [ ] **Step 5: Commit** `feat(api): Modbus TCP protocol module — client, read planner, decoder (FC 03/04)`.

### Task 3: Profile connection — data model and API

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`InstrumentProfile`: `connection String @default("PUSH")`, `modbusIntervalSec Int? @map("modbus_interval_sec")`, `modbusUnitId Int? @map("modbus_unit_id")`; `Instrument`: `modbusHost String? @map("modbus_host")`, `modbusPort Int? @map("modbus_port")`, `modbusRegisters Json? @map("modbus_registers")`)
- Create: `apps/api/prisma/migrations/20261031120000_tcpip_instruments/migration.sql` (the six columns + `CREATE UNIQUE INDEX "instruments_modbus_address_key" ON "instruments" ("modbus_host","modbus_port") WHERE "modbus_host" IS NOT NULL;`)
- Modify: `apps/api/src/modules/instrument-profiles/routes.ts` (create, update, `profileProps`, audit before/after)
- Test: `apps/api/src/e2e/tcpip-profiles.e2e.test.ts`

**Interfaces — Consumes:** Task 1 schemas and constants. **Produces:** profile rows/responses with `connection`, `modbusIntervalSec`, `modbusUnitId`.

- [ ] **Step 1: Write failing e2e tests** (`TCP ` name prefix, cleanup by prefix):
  - POST `{name, connection:'MODBUS_TCP'}` → 201 with `modbusIntervalSec:60, modbusUnitId:1`; POST `PUSH` → both null; interval 9 / 3601 → 400; unit 256 → 400.
  - PUT changing `connection` on a profile that has an instrument → 409 `PROFILE_HAS_INSTRUMENTS`; on an empty profile → 200 and the fields set/cleared accordingly.
  - `requireDeviceCertificate:true` on a `MODBUS_TCP` profile → 400 `NOT_FOR_TCPIP`; switching a cert-requiring profile to `MODBUS_TCP` → 400 `NOT_FOR_TCPIP`.
  - The `INSTRUMENT_PROFILE_UPDATED` audit row's before/after carries the three fields.
- [ ] **Step 2: Apply the migration** to both DBs (`DATABASE_URL=<db> npx prisma migrate deploy`), `npx prisma generate`; run the new file → FAIL on the route behaviour.
- [ ] **Step 3: Implement** the route rules; declare the fields in `profileProps`.
- [ ] **Step 4: Run** `tcpip-profiles.e2e.test.ts`, `instrument-profiles.e2e.test.ts`, `profile-measurements.e2e.test.ts`, `device-certificate-profile-hook.e2e.test.ts` (one at a time, test DB) → exit 0.
- [ ] **Step 5: Commit** `feat(api): instrument profiles choose Gateway or TCP/IP (Modbus)`.

### Task 4: TCP/IP instruments — API rules and the TCP/IP Reading config

**Files:**
- Create: `apps/api/src/modules/config/defs/modbus-reader.def.ts` (+ import in `config-discovery.ts`; card in `apps/web/src/routes/config/index.tsx` `superAdminCards`); `apps/api/src/modules/modbus/config.ts` (`loadModbusReaderConfig()`)
- Create: `apps/api/src/modules/modbus/address.ts` (`checkModbusAddress`)
- Modify: `apps/api/src/modules/instruments/routes.ts` (create, update, list filter, token routes, `instrumentProps`, `audited()`, `createWithCredential` skip)
- Test: `apps/api/src/e2e/tcpip-instruments.e2e.test.ts`

**Interfaces — Consumes:** Tasks 1, 3. **Produces:**
- `loadModbusReaderConfig(): Promise<{ serverReadingEnabled: boolean; deviceNetworks: string[] }>` (absent row → OFF + default networks; invalid entries never widen the list).
- `checkModbusAddress(host: string, port: number, opts: { excludeInstrumentId?: string; visibility: Awaited<ReturnType<typeof resolveVisibility>> }): Promise<{ ok: true } | { ok: false; status: 400 | 409; code: 'ADDRESS_NOT_ALLOWED' | 'ADDRESS_IN_USE'; message: string }>` (`resolveVisibility` from `apps/api/src/modules/instruments/visibility.ts`) — `ADDRESS_IN_USE` names the holder's code only if that instrument is inside the caller's visibility, else "already in use" (the bulk upload's out-of-view rule).
- `GET /api/instruments?connection=MODBUS_TCP|PUSH`.

- [ ] **Step 1: Write failing e2e tests** (`TCPI-` code prefix):
  - Def: `GET /api/config/dynamic/modbus-reader` shows `serverReadingEnabled:false`; a PUT with `deviceNetworks:'192.168.1.0/33'` → 400.
  - Create in a `MODBUS_TCP` profile with host/port/map → 201, **no `token`**, no `instrument_credentials` row; `isGateway:true` or a `gatewayId` → 400; missing host → 400; `127.0.0.1` → 400 `ADDRESS_NOT_ALLOWED`; host outside the configured networks (set `192.168.1.0/24`, try `10.0.0.5`) → 400; same host:port as another → 409 `ADDRESS_IN_USE` naming it; a holder outside the viewer's scope → message without the code.
  - Create in a `PUSH` profile with any modbus field → 400.
  - Token routes (regenerate / reveal / set) on a TCP/IP instrument → 400 `NO_TOKEN_FOR_TCPIP`.
  - PUT host/port without `reason` → 400 `REASON_REQUIRED`; with reason → 200 and `INSTRUMENT_UPDATED` before/after carries `modbusHost`/`modbusPort`; PUT `modbusRegisters` as ADMIN → 403 `REGISTER_MAP_SA_ONLY`, as SUPER_ADMIN with reason → 200.
  - PUT `profileId` from a `PUSH` profile to a `MODBUS_TCP` one, and back → 409 `CONNECTION_DIFFERS`.
  - `GET /api/instruments?connection=MODBUS_TCP` lists only TCP/IP instruments in view; `GET /api/instruments/:id` returns the three fields.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Add the fields to `instrumentProps` (Fastify strips undeclared) and `audited()` (the e2e at `routes.ts:2270` derives keys from `updateInstrumentSchema.shape`).
- [ ] **Step 4: Run** `tcpip-instruments.e2e.test.ts`, `instrument-token.test.ts`, and every e2e file under `src/e2e` whose name contains `instrument` (one at a time) → exit 0. Mutation-check `REGISTER_MAP_SA_ONLY` and the networks check.
- [ ] **Step 5: Commit** `feat(api): TCP/IP instruments — own address and register map, no token, TCP/IP Reading config`.

### Task 5: Test connection route

**Files:**
- Create: `apps/api/src/modules/modbus/routes.ts` (registered in `apps/api/src/app.ts` **and** `apps/api/src/e2e/test-helper.ts`)
- Test: `apps/api/src/e2e/modbus-test-connection.e2e.test.ts`

**Interfaces — Consumes:** Task 2 `readDevice`, `planReads`; Task 4 `loadModbusReaderConfig`, `checkModbusAddress`; `resolvedSlotFor` (`modules/instruments/data-keys.ts:66`), `slotConfigForProfile` (`profile-measurements.ts:72`). **Produces:** `POST /api/instruments/modbus/test` `{ profileId, modbusHost, modbusPort, modbusRegisters, instrumentId? }` → 200 `{ ok:true, elapsedMs, requests, values:[{key, value, judgedAs}], rejected:[{key,reason}] }` or 200 `{ ok:false, code, message }`. Device failures, `READING_OFF` and an address already in use (`ADDRESS_IN_USE`, wording as Task 4) are all 200 answers with `ok:false`, so the form shows them beside the result. Only a malformed body or a refused address (`ADDRESS_NOT_ALLOWED`) is a 400; a missing permission is 403; the rate limit is 429.

- [ ] **Step 1: Write failing e2e tests** using `startFakeSlave` (the route allows `127.0.0.1` **only** when `process.env.NODE_ENV === 'test'` and the address equals the fake slave — implement as an injectable `allowLoopbackForTests` flag on the route options set by `test-helper.ts`, never by env alone):
  - Reading OFF → `{ ok:false, code:'READING_OFF' }` and the fake slave records **no connection**.
  - Reading ON: six keys → values incl. Temperature 22.4 `judgedAs:'TEMPERATURE'`, Pressure `judgedAs:null`; **Review Focus 4:** a map with `Temperature` and `t` → only the key `resolvedSlotFor` picks is `TEMPERATURE`, the other `null`.
  - `exception02` → `DEVICE_EXCEPTION` with the exact sentence; silent → `BAD_RESPONSE`.
  - 11th call within a minute by one user → 429.
  - A user without `INSTRUMENT_CREATE`/`INSTRUMENT_UPDATE` → 403. No audit row and no telemetry row are written by any call.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the file + `public-paths` and route-registration tests → exit 0.
- [ ] **Step 5: Commit** `feat(api): Test connection reads a device once — nothing stored`.

### Task 6: Web — profile connection and TCP/IP reading settings

**Files:**
- Modify: `apps/web/src/routes/instruments/profile-list.tsx` (create form: Connection segmented choice, "Read every" select 10 s…60 min default 60 s, "Unit ID"; card chip GATEWAY / TCP/IP; empty TCP/IP profile line + "+ New Instrument")
- Modify: `apps/web/src/routes/config/instrument-attributes.tsx` (a "TCP/IP reading" `FormSection` for a `MODBUS_TCP` profile; save via `PUT /api/instrument-profiles/:id` under `UPDATE_INSTRUMENT_PROFILE`)
- Test: `apps/web/src/routes/instruments/__tests__/profile-connection.test.tsx`, extend `apps/web/src/routes/config/__tests__/instrument-attributes.test.tsx`

**Interfaces — Consumes:** Task 3 responses; Task 1 `MODBUS_INTERVAL`, `MODBUS_UNIT_ID`.

- [ ] **Step 1: Write failing tests:** Gateway preselected and the TCP/IP fields hidden; choosing TCP/IP shows "Read every" (default 60 s) and "Unit ID" (1) and POSTs `{connection:'MODBUS_TCP', modbusIntervalSec:60, modbusUnitId:1}`; a `MODBUS_TCP` profile card shows the TCP/IP chip; the attributes page shows the TCP/IP reading section only for a TCP/IP profile and PUTs the changed interval with reauth `UPDATE_INSTRUMENT_PROFILE`.
- [ ] **Step 2–4:** run one file per process → FAIL, implement (UI v3: `FormSection`, segmented control like `seg` in the concept page 4), run → exit 0; `npx tsc --noEmit -p apps/web` clean.
- [ ] **Step 5: Commit** `feat(web): profile chooses Gateway or TCP/IP (Modbus)`.

### Task 7: Web — New Instrument for a TCP/IP profile

**Files:**
- Create: `apps/web/src/routes/instruments/register-map-editor.tsx` (`RegisterMapEditor`), `apps/web/src/routes/instruments/test-connection-panel.tsx` (`TestConnectionPanel`), `apps/web/src/routes/instruments/copy-map-dialog.tsx`
- Modify: `apps/web/src/routes/instruments/create.tsx`
- Test: `apps/web/src/routes/instruments/__tests__/{register-map-editor,test-connection-panel,create-tcpip}.test.tsx`

**Interfaces — Consumes:** Task 1 `modbusRegisterMapSchema`, `fromDesktopKeysFile`, `parseModiconRef`; Task 4 `?connection=MODBUS_TCP`, `GET /:id`; Task 5 route. **Produces:**
- `RegisterMapEditor({ value, onChange, judged?: Record<string, 'TEMPERATURE'|'HUMIDITY'|null>, readOnly? })` — rows Key, Register, Area (shown, from `parseModiconRef`), Data type, Byte order (32-bit only), Scale, Judged as (from `judged`, else "—"); "+ Add key", "Copy from instrument…", "Import keys file"; schema messages under the row.
- `TestConnectionPanel({ profileId, host, port, map, instrumentId?, onJudged })` — button, then the values table or the failure sentence with its code pill.

- [ ] **Step 1: Write failing tests:** for a TCP/IP profile the form hides Is Gateway / Reports through gateway and shows the TCP/IP connection card (IP, Port default 502) and the register map; Import keys file with the desktop six-key JSON fills six rows (Voltage/Switch without byte order); a bad file shows the converter's row errors and changes nothing; Copy from instrument fills the map from the picked instrument's `GET /:id`; Judged as reads only the Test-connection response (a test asserts no client-side measurement lookup: the column is "—" until a response arrives); `READING_OFF` and `ADDRESS_IN_USE` answers render their sentences; submit POSTs `modbusHost`, `modbusPort`, `modbusRegisters` and **no TokenDialog** opens; a Gateway profile renders the form exactly as before (existing `create` tests stay green).
- [ ] **Step 2–4:** one file per process → FAIL, implement, → exit 0; tsc clean; eslint on changed files 0 errors.
- [ ] **Step 5: Commit** `feat(web): New Instrument — TCP/IP connection, register map, Test connection`.

### Task 8: Reporting follows the read interval; ingest accepts `'polled'`

**Files:**
- Modify: `apps/api/src/modules/instruments/telemetry-overview.ts:496`, `apps/api/src/modules/instruments/routes.ts:787`, `apps/api/src/modules/functional-locations/routes.ts:145`, `apps/api/src/workers/alarm-evaluation.worker.ts` (inactivity pass, ~572-602) — each passes `effectiveExpectedIntervalSec(instrument, profile)` (selecting `profile.connection`, `profile.modbusIntervalSec`)
- Modify: `apps/api/src/modules/instruments/last-seen.ts` (`via: 'direct' | 'gateway' | 'polled'`), `apps/api/src/modules/instruments/ingest-core.ts` (`ingestPayload` args gain `lastSeenVia?: 'direct' | 'polled'`, default `'direct'`, threaded to the stamps at :315 and :379)
- Test: `apps/api/src/lib/__tests__/reporting-resolver-callers.test.ts` (reads the four files; asserts every `isInstrumentReporting(` call's second argument is an `effectiveExpectedIntervalSec(` call and that no other file calls `isInstrumentReporting`), extend `src/e2e/telemetry-overview.e2e.test.ts` and an inactivity worker test

- [ ] **Step 1: Write failing tests:** a TCP/IP instrument (interval 60, no `expectedIntervalSec`) last seen 3 min ago reads **not reporting** in the overview, the activity summary and the FL counts, and the inactivity pass raises for it (grace from config); a PUSH instrument with the same `lastSeenAt` is unchanged (still uses `activeWindowMinutes`); `ingestPayload({..., lastSeenVia:'polled'})` stamps `lastSeenVia='polled'`; the caller-grep test.
- [ ] **Step 2–4:** run each touched test file alone (API single fork) → FAIL, implement, → exit 0. Mutation: revert one caller → the grep test fails.
- [ ] **Step 5: Commit** `fix(api): a TCP/IP instrument's "reporting" follows its read interval`.

### Task 9: The Reader (Part 2)

**Files:**
- Modify: `apps/api/prisma/schema.prisma` — model `ModbusPollStatus` (`@@map("modbus_poll_status")`): `instrumentId String @id` (FK → instruments, cascade), `readBy String @default("server")`, `lastAttemptAt DateTime?`, `lastSuccessAt DateTime?`, `failingSince DateTime?`, `consecutiveFailures Int @default(0)`, `lastErrorCode String?`, `lastErrorMessage String?`, `lastErrorAt DateTime?`, `updatedAt DateTime @updatedAt`
- Create: `apps/api/prisma/migrations/20261031130000_modbus_poll_status/migration.sql`
- Create: `apps/api/src/modules/modbus/reader.ts`
- Modify: `apps/api/src/app.ts` (start after the MQTT bridge block ~627; stop in `shutdown()` before `app.close()`), `apps/api/src/lib/audit.ts` (`SYSTEM_AUDIT_ACTIONS` + the two actions), `packages/shared/src/types/audit-actions.ts` + `audit-templates.ts` (two actions, two templates, category Instruments), `apps/web/src/routes/audit/audit-helpers.ts` (substitutions for any new placeholder)
- Test: `apps/api/src/modules/modbus/__tests__/reader.e2e.test.ts` (test DB, fake slave)

**Interfaces — Consumes:** Tasks 1, 2, 4, 8. **Produces:**
- `startModbusReader(opts: { log: FastifyBaseLogger; allowLoopbackForTests?: boolean }): { stop(): Promise<void> }`.
- `readOnce(instrumentId: string, opts?: { allowLoopbackForTests?: boolean }): Promise<{ outcome: 'stored' | 'failed' | 'skipped'; code?: string }>` — the exact path the scheduler runs, exported for tests.
- `ModbusPollStatus` rows as specified.

- [ ] **Step 1: Write failing tests** (`readOnce` + a short-interval `startModbusReader` with fake timers where needed):
  - Success: history + latest rows for the six keys with `ts` = read start; `lastSeenVia='polled'`; alarm evaluation enqueued; status `lastSuccessAt` set, `consecutiveFailures 0`; Temperature stored 22.4 (rounded).
  - A NaN key → a `dead_letters` row (`transport 'modbus'`) and the other keys stored.
  - Failures: 1st and 2nd failed read → no audit row, `failingSince` null, `consecutiveFailures` 1, 2, **no telemetry row**; 3rd → one `MODBUS_DEVICE_NOT_ANSWERING` row (system, `failingSince` = first failure time); 4th → no new row; next success → one `MODBUS_DEVICE_ANSWERING` row with `missed` = 4 and the gap's times.
  - `serverReadingEnabled` OFF → `readOnce` returns `skipped` and the fake slave sees no connection.
  - **Review Focus 3:** instrument disabled / map emptied / host moved outside device networks → `skipped` within one reload; profile interval change applies to the next schedule.
  - Concurrency: two instruments on the same `host:port` (two fake-slave unit ids is not allowed — use one instrument and a slow fake slave + two forced ticks) → one connection at a time; a still-running instrument skips its tick.
  - **Review Focus 2:** `stop()` resolves, no tick after it, and a read in flight at stop writes no telemetry and no status after `stop()` resolved.
- [ ] **Step 2:** migrate both DBs, generate; run → FAIL. **Step 3: Implement** (1 s unref'd scheduler tick; per-instrument phase = hash(id) mod interval; reload when `max(updatedAt)` over TCP/IP instruments/profiles or the `modbus-reader` config row changes, checked every 5 s). **Step 4:** run the reader file, `audit-actions` tests (shared), `audit-actions-registry.test.ts` (API), `template-placeholders.test.ts` (web) → exit 0; `npx tsc --noEmit -p apps/api` clean.
- [ ] **Step 5: Commit** `feat(api): the server reads TCP/IP instruments on their profile's interval`.

### Task 10: Status route and the instrument page

**Files:**
- Modify: `apps/api/src/modules/modbus/routes.ts` (`GET /api/instruments/:id/modbus-status`)
- Create: `apps/web/src/routes/instruments/modbus-connection-card.tsx`, `apps/web/src/routes/instruments/register-map-card.tsx`
- Modify: `apps/web/src/routes/instruments/detail.tsx` (TCP/IP instrument: these two cards in the left column in place of Access token / Device certificate / Connection; everything else unchanged)
- Test: extend `apps/api/src/e2e/modbus-test-connection.e2e.test.ts` (status), `apps/web/src/routes/instruments/__tests__/detail-tcpip.test.tsx`

**Interfaces — Produces:** `GET /api/instruments/:id/modbus-status` (`INSTRUMENT_READ`, visibility-scoped; 404 outside scope; 400 for a PUSH instrument) → `{ state:'reading'|'failing'|'not-read', notReadReason?: 'INSTRUMENT_DISABLED'|'NO_REGISTER_MAP'|'SERVER_READING_OFF'|'NO_ADDRESS', readBy:'server', intervalSec, lastSuccessAt, failingSince, lastError?: {code,message,at}, stored24h, expected24h, inactivityAlarmsOff }` — `stored24h` = count of distinct `ts` in history for the instrument over the last 24 h; `expected24h` = `floor(86400 / intervalSec)`.

- [ ] **Step 1: Write failing tests:** API — each `state`/`notReadReason`; `stored24h` counts instants, not rows; `inactivityAlarmsOff` follows the inactivity config. Web — the connection card renders the state line, address, interval, "stored N of M in 24 h", last failure, Test connection (Task 7 panel with the stored config) and "Edit" (IP/port + reason → PUT with `reason`); with `inactivityAlarmsOff` the card shows the sentence "No alarm is raised when this device stops answering — Inactivity Alarms are off (Configuration → Inactivity Alarms)"; the register-map card shows the map read-only, its Edit only for SUPER_ADMIN (reason dialog → PUT `modbusRegisters` + `reason`); Access token, Device certificate and Connection cards absent; a PUSH instrument's page unchanged (existing `detail-*.test.tsx` run individually stay green).
- [ ] **Step 2–4:** one file per process → FAIL, implement, → exit 0; tsc clean.
- [ ] **Step 5: Commit** `feat: instrument page shows whether the application is reaching a TCP/IP device`.

### Task 11: Bulk upload for TCP/IP profiles

**Files:**
- Modify: `apps/api/src/modules/instruments/bulk-csv.ts` (headings "IP address" → `modbusHost`, "Port" → `modbusPort`, only for a `MODBUS_TCP` profile), `bulk-plan.ts` (rows carry host/port; duplicate address within the file → row error; `checkModbusAddress` per row), `routes.ts` `/bulk` + `/bulk/preview` (`copyRegisterMapFrom` applied to every created row; must be a TCP/IP instrument in view), template download includes the two headings
- Modify: `apps/web/src/routes/instruments/bulk-create.tsx` (per-upload "Copy register map from" picker for a TCP/IP profile)
- Test: extend `apps/api/src/modules/instruments/__tests__/bulk-plan.test.ts`, a new `apps/api/src/e2e/tcpip-bulk.e2e.test.ts`, `apps/web/src/routes/instruments/__tests__/bulk-create.test.tsx`

- [ ] **Step 1: Write failing tests:** CSV with Instrument ID, IP address, Port for a TCP/IP profile → preview plans N creates; a row missing IP → row error; two rows with one address → both rows in error; an address already used → "already in use"; `copyRegisterMapFrom` copies the map to every created row; a PUSH profile's upload ignores nothing new (IP/Port headings there → row error "not a TCP/IP profile"); existing row IP change needs the upload's one remark.
- [ ] **Step 2–4:** run each file alone → FAIL, implement, → exit 0.
- [ ] **Step 5: Commit** `feat: bulk upload creates TCP/IP instruments with their addresses and a copied register map`.

### Task 12: See it, document it, gate it

**Files:**
- Docs: `docs/feature-notes.md` (new note "TCP/IP INSTRUMENTS" at the top: the vocabulary, the rules, the rulings P1–P4, the OFF-by-default switch and device networks, Inactivity dependency, late-reading note for Part 3), `CHANGELOG.md`, root `CLAUDE.md` System Stats (models **38 → 39**, audit actions **100 → 102**, templates **113 → 115**, defs **36 → 37**; re-derive each with the file's own commands first), `docs/recreation/06-api/endpoints.md` (profile/instrument fields, `?connection=`, `POST /api/instruments/modbus/test`, `GET /:id/modbus-status`), `tasks/todo.md` (Part 1–2 section; Part 3 open), `docs/superpowers/concepts/2026-10-31-tcpip-instruments/` (the concept files + `built-*.png` from the render check). `apps/web/CLAUDE.md` must NOT grow.
- [ ] **Step 1: Render check** (method: `.superpowers/sdd/2026-10-30-dashboard-builder-phase2/render-check.md` — built CSS, dumped HTML, fonts inlined, headless Chrome at 1240 px; never log in, never the operator's browser): New Profile with TCP/IP chosen; New Instrument with the six-key map and a successful test; the same with a failure; the instrument page cards (reading, failing, inactivity-off). Look at each PNG: nothing clipped, the longest key and `192.168.100.200` fit, alignment, status colours only where they mean status. Fix in the owning file; keep the PNGs as `built-*.png`.
- [ ] **Step 2: Gates** (on a tree carrying the other session's work — attribute any red before calling it): shared full suite; API — every e2e/unit file touched or added in Tasks 1–11 one at a time; web — every touched test file one per process; `npm run lint` (shared, api, web); `npx vite build --outDir <scratch>` exit 0.
- [ ] **Step 3: Docs** — re-derive every count before writing it; stale-stat sweep for the previous numbers across the active doc set; anchored-blob staging for `CHANGELOG.md`, `docs/feature-notes.md`, root `CLAUDE.md`.
- [ ] **Step 4: Commit** `docs: TCP/IP (Modbus) instruments, parts 1–2`.
