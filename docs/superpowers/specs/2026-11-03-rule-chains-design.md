# Rule chains — a ThingsBoard-style rule engine (design, 2026-11-03)

Operator: **"add rule chains how in thingsboard has same add rule chains and what ever rule nodes are in thingsboard those all should come in this also, and all the nodes functionalities should be come as same"**, then **"skip questions and start"**. Recon 2026-11-03 at `d96041cd` (the AWS tip); the ThingsBoard node catalogue from thingsboard.io/docs/user-guide/rule-engine-2-0 (filter, enrichment, transformation, action, external, flow pages, read 2026-11-03).

## 1. What this is

ThingsBoard's rule engine: every event in the system (a telemetry post, an attribute report, an alarm raised / cleared / acknowledged, an inactivity event, a REST-injected message, a generated message) becomes a **message** `{ id, type, originator, metadata, data }` that enters the **root rule chain** and flows node to node along labelled **relations** (`Success`, `Failure`, `True`, `False`, a message type, a custom label). A **rule chain** is a graph of **rule nodes** an administrator draws on a canvas; nodes are grouped Filter / Enrichment / Transformation / Action / External / Flow; each node has a configuration form, a **debug mode** that records every message in and out, and a name. Chains call each other (Rule chain / Output nodes); one chain is the root.

This fork has had a rule engine before (`RuleChain` / `RuleNode` / `RuleNodeConnection` models and a `rule-chain` module, dropped 2026-05-17 with DigiLog's domain) — nothing of it survives (recon §8), so this is a fresh build on today's ingest, alarm, notification and queue code.

## 2. The honest scope

ThingsBoard documents **87 nodes** (13 filter, 11 enrichment, 12 transformation, 31 action, 16 external, 4 flow). They fall into three groups here:

- **Built in this build (46 nodes, §7)** — every node whose behaviour has a counterpart in this system, with the SAME name, configuration fields, relations and semantics as ThingsBoard, "device" reading as "instrument".
- **Later (12 nodes)** — a counterpart exists but needs a feature this system does not have yet (relations between instruments beyond the gateway link, GPS keys, RPC/downlink to a device, a synchronous REST request, an LLM provider). Listed with what each needs.
- **No counterpart (29 nodes)** — ThingsBoard-specific (customers, tenants-as-entities, assets, entity views, edge, entity groups, Cassandra, AWS/Azure/GCP/Kafka/RabbitMQ, Twilio-direct, PE report generation). Listed so nobody looks for them. A chain exported from ThingsBoard that uses one of them imports with that node marked **Unsupported** (it passes the message through on `Failure`) rather than refused.

Ruling S-1 (mine): "all nodes with the same functionality" is delivered as the 46 now and the 12 as follow-ups, each honestly labelled in the palette and the docs; the 29 are documented as not applicable. Cost if wrong: the operator expected the 29 — they cannot exist without their entities.

> **Superseded 2026-11-05 (rulings T1-1, T1-2, D-P; `.superpowers/sdd/2026-11-03-rule-chains/progress.md`):** ThingsBoard documents **86** nodes, not 87 (the 13th filter row was an older name of Entity type filter / switch), and the build is **47 built / 10 later / 29 none**: Check relation presence and Related device attributes were counted as both B and L (they are built on the gateway link), "Generate (dashboard) report" is two classes, and Device profile (deprecated) is a BUILT pass-through because every ThingsBoard root chain v3.6 .. v4.2 enters through it. The live numbers and every later ruling are in `docs/feature-notes.md` RULE CHAINS.

## 3. Goals, non-goals, anti-goals

**Goals.** G1 An administrator creates, edits, imports, exports and deletes rule chains on a canvas identical in concept to ThingsBoard's (palette by group, drag to place, connect with labelled relations, node settings dialog, per-node debug mode, "make root"). G2 Every event listed in §5 enters the root chain as a ThingsBoard-typed message with the same `metadata` keys ThingsBoard sets (`deviceName`→`instrumentCode`, `deviceType`→`profileName`, `ts`, …). G3 The 46 nodes behave as their ThingsBoard counterparts (same relation labels, same config semantics, same script API `msg`/`metadata`/`msgType`). G4 Debug mode shows, per node, every incoming and outgoing event with its relation, data, metadata and error — the ThingsBoard "Debug" tab. G5 The engine never slows or breaks ingest: enqueue is O(1) and never throws; a chain that errors ends the message on `Failure`; a script cannot run longer than its timeout. G6 §11: every chain change is a re-authenticated, audited, reasoned write; a rule-created alarm is an `alarms` row like any other (acknowledged, webhooked, notified, reported).

**Non-goals (this build).** The 12 "Later" nodes; TBEL (scripts are JavaScript — ThingsBoard supports both; TBEL is a ThingsBoard-only language); ThingsBoard's three queues with per-queue submit/processing strategies (§6 has two: in-memory Main with per-originator order, and Durable through graphile-worker); rule chains per instrument profile (ThingsBoard "device profile → default rule chain" — Later); versioning / git export of chains; a CONNECT/DISCONNECT event from the broker (needs an EMQX webhook — Later).

**Anti-goals.** A rule that writes telemetry outside the ONE ingest write path (loops, un-offset values, no partition handling). An engine failure that loses or delays a reading. A script that can read the file system, the environment or the database (the VM exposes `msg`, `metadata`, `msgType` and the ThingsBoard helper functions only). A chain edit that is not audited with its whole document before and after. A rule-created alarm that the Alarms page, reports or notifications cannot show.

## 4. Vocabulary

- **Message** — `{ id: uuid v7-ish time-ordered, type: string, originator: { type: 'INSTRUMENT'|'ALARM'|'USER'|'SYSTEM'|'RULE_NODE', id: string, code?: string }, metadata: Record<string,string>, data: Json }`. `data` is ThingsBoard's "payload" (the node scripts see it as `msg`); `metadata` values are strings, as in ThingsBoard.
- **Relation** — the label on a connection: `Success`, `Failure`, `True`, `False`, `Other`, a message type (switch nodes), or a custom label. A node returns zero or more relations for a message; the message is copied to every node connected under each returned label. A node that throws returns `Failure` with `metadata.error`. A returned label with no connection = the message ends there (ThingsBoard: "A message ends as Failure only if a Failure output is unhandled" — we record it in debug as `OUT Failure (unhandled)`).
- **Root chain** — exactly one; the entry point of every message. **Input** node — the fixed entry of every chain (not a node type the user adds; it is the chain's `firstNodeId`).
- **Node type id** — our stable string (`tb:filter:message-type-switch`); `tbClass` — ThingsBoard's class name (`org.thingsboard.rule.engine.filter.TbMsgTypeSwitchNode`) kept for import/export.
- **Debug event** — one row per message IN or OUT of a node whose `debugMode` is on: `{ ts, direction, relation?, msgId, msgType, originator, data, metadata, error? }`.

## 5. Where messages come from (G2)

| Message type | Fired where | Originator | `data` | `metadata` |
|---|---|---|---|---|
| `POST_TELEMETRY_REQUEST` | `ingest-core.ts` after `writeBatchOrDeadLetter` commits (both the flat path ~:384 and the gateway path ~:306, one message per instrument per batch) | INSTRUMENT | `{ ts, values: { key: value } }` (ThingsBoard shape; `ts` ms) — values AFTER sensor offsets; `rawValue` only in `metadata.raw_<key>` when it differs | `instrumentCode`, `instrumentName`, `profileName`, `ts`, `transport`, `rule_engine_origin=ingest` |
| `POST_ATTRIBUTES_REQUEST` | `attribute-report.ts` after the transaction, from `changed` | INSTRUMENT | `{ key: value }` of the CHANGED keys | as above + `scope=CLIENT_SCOPE` |
| `ATTRIBUTES_UPDATED` | a rule node's Save attributes (this build); operator/API attribute writes — Later | INSTRUMENT | `{ key: value }` | `scope=SERVER_SCOPE` |
| `ATTRIBUTES_DELETED` | a rule node's Delete attributes | INSTRUMENT | `{ attributes: [keys] }` | `scope` |
| `ALARM` | every alarm RAISE site (the four in `alarm-evaluation.worker.ts` and the Create alarm node) via ONE helper `emitAlarmMessage` placed beside `enqueueAlarmWebhook` | ALARM (id) with `metadata.instrumentId`/`instrumentCode` | the alarm row as JSON (ThingsBoard shape: `id, type, originator, severity, status, startTs, endTs, details`) | `isNewAlarm=true/false`, `isExistingAlarm`, `isClearedAlarm` as ThingsBoard sets them |
| `ALARM_CLEAR` | every clear site (`claimClear` callers) | ALARM | the alarm | — |
| `ALARM_ACK` | the acknowledge route | ALARM | the alarm | `acknowledgedBy` |
| `INACTIVITY_EVENT` | the inactivity-alarm raise site (the instrument went quiet) | INSTRUMENT | `{ lastActivityTime, inactivityAlarmTime }` | — |
| `ACTIVITY_EVENT` | the inactivity-alarm clear site (data resumed) | INSTRUMENT | `{ lastActivityTime }` | — |
| `ENTITY_CREATED` / `ENTITY_UPDATED` / `ENTITY_DELETED` | instrument create / update / delete routes | INSTRUMENT | the instrument as JSON | — (Later: profiles, users) |
| `REST_API_REQUEST` | `POST /api/rule-engine/v1/messages` (`RULE_CHAIN_MANAGE`, body `{ type?, originatorCode?, data, metadata? }` — ThingsBoard's "REST API request") | INSTRUMENT (by code) or SYSTEM | the body's `data` | `requestId` |
| `GENERATOR_NODE_SELF_MSG` | the Generator node | per its config | script output | — |
| `SEND_EMAIL` | the To email node | unchanged | `{ from, to, cc, bcc, subject, body, isHtml }` | — |
| `CUSTOM:<anything>` | a Script transform may set any `msgType` | — | — | — |

Loop guard: a message a node CREATES or SAVES (Save time series, Save attributes, Delete attributes, Create/Clear alarm) is written through the normal code path, which would fire the events above again. Each write made BY the engine carries `metadata.rule_engine_origin=rule_node:<nodeId>`; the emit helpers skip a message whose origin is a rule node **unless** the chain's "Re-enter on rule-node writes" setting is on (default OFF; ThingsBoard re-enters — Ruling S-2: OFF by default because the shipped root chain saves what ingest already stored and would otherwise loop once per key; cost if wrong: a chain that wants to react to its own writes flips one switch).

**The shipped root chain** (seeded by the migration when the table is empty, exactly ThingsBoard's default): Input → *Message Type Switch* → `Post telemetry` → **Save Timeseries** · `Post attributes` → **Save Attributes** · `RPC Request from Device` → (nothing) · `Other` → **Log Other** (a Log node) · `Alarm`/`Alarm Cleared`/`Activity Event`/`Inactivity Event` → (nothing). Save Timeseries over a reading ingest already stored is an upsert no-op (same value, same ts — `writeBatch` writes no audit row when nothing changed), so the shipped chain costs one no-op transaction per message and changes nothing — the engine's own Configuration page (§10) can set "Skip Save nodes for ingest-origin messages" ON (default ON) to make it zero-cost; Ruling S-3.

> **Superseded 2026-11-05 — read with the table above:**
> - **`POST_TELEMETRY_REQUEST` is FLAT** (ruling M-1, 2026-11-04): `data = { key: value }`, the instant in `metadata.ts` (epoch ms as text), one message per distinct instant — ThingsBoard's rule-engine shape. The `{ ts, values }` in the table was wrong; Save time series still ACCEPTS it.
> - **`ATTRIBUTES_UPDATED` from Save attributes is NOT always sent** (rulings P-9 / P-10, 2026-11-05): only when the node's `sendAttributesUpdatedNotification` is on (default OFF), the effective scope is not `CLIENT_SCOPE`, and the save changed a value. A Math function ATTRIBUTE result sends none.
> - The loop-guard origin is `rule_node:<chainId>:<nodeId>` (the chain that made the write decides re-entry). **Ruling RE-1 (2026-11-05)** caps re-entry at ONE generation even with the switch ON (`1cc3d5f4`).
> - **The shipped root chain has FOUR nodes** (ruling T1-3): the Input is the chain's `firstNodeId`, not a node.
> - `REST_API_REQUEST` is audited (`RULE_ENGINE_MESSAGE_INJECTED`, one row per call) — ruling W-2.

> **Superseded 2026-11-05 — the final fix wave (`.superpowers/sdd/2026-11-03-rule-chains/progress.md`, from "Whole-branch review A"):**
> - **"Originator: ALARM" in the table is SUPERSEDED (ruling AL-1):** every `ALARM` / `ALARM_CLEAR` / `ALARM_ACK` comes from the alarm's INSTRUMENT, with `metadata.alarmId` and data = the alarm JSON (with its `id`), as in ThingsBoard; only the TRUE flag is written.
> - **Ruling AL-2:** a Create / Clear alarm NODE's root-chain message is ThingsBoard's action message — `ENTITY_CREATED`, `ENTITY_UPDATED` or `ALARM_CLEAR`, metadata `ruleNodeId` + `alarmId` + the origin stamp; the node OUTPUT stays `ALARM` + the one true flag; an update that changes nothing goes on Success. The evaluator keeps `ALARM` / `ALARM_CLEAR`; the acknowledge route keeps `ALARM_ACK`.
> - **Ruling DP-1:** Device profile sends the EVALUATOR's alarms on `Alarm Created` / `Alarm Cleared` (only those occur), the clear retyped as `ALARM`; everything else on Success.
> - The bulk instrument upload emits `ENTITY_CREATED` / `ENTITY_UPDATED` as the single routes do (review A M7); an attribute-only update sends nothing.
> - **Ruling TS-1:** a rule write (Save time series, Math TIME_SERIES) REFUSES an instant before 2000-01-01 or more than 10 minutes ahead (`TIMESTAMP_OUT_OF_WINDOW`), including one injected through `REST_API_REQUEST`.

## 6. The engine (G5)

- **Module** `apps/api/src/modules/rule-engine/` (28th module): `engine.ts` (the processor), `message.ts` (types, id, metadata helpers), `registry.ts` (node type registry: id, tbClass, group, label, config zod schema, config UI descriptor, relations list, handler), `nodes/<group>/<node>.ts` (one file per node), `queue.ts` (the in-memory Main queue), `script-vm.ts` (the sandbox), `debug.ts` (event writer + retention), `emit.ts` (the entry helpers called by ingest / attributes / alarms / routes), `routes.ts`, `service.ts`, `import-export.ts`.
- **Main queue** — in memory, bounded (`queueCapacity`, default 10,000 messages); FIFO per originator (ThingsBoard's SequentialByOriginator: messages of one instrument are processed in order, different instruments in parallel up to `concurrency`, default 8); when full, the OLDEST message of the largest originator backlog is dropped and `stats.dropped` increments (visible on the Rule Chains page banner and in the API log; the same shape as the MQTT bridge's buffer rule in `docs/feature-notes.md`). Enqueue never throws and is called AFTER the ingest transaction commits — a reading is never lost or delayed by the engine (G5).
- **Durable queue** — the Checkpoint node hands the message to graphile-worker task `rule_engine_message` (`queueName: rule-engine:<originatorId>` for order; payload = the message + the target chain/node), 8th task; the Delay node uses the same task with `runAt` (ThingsBoard's Delay loses messages on restart and says so; ours survives — a documented improvement, Ruling S-4). The task re-injects the message at the node AFTER the checkpoint/delay. Acknowledge node: a no-op on the Main queue (ThingsBoard's semantics are queue-level), recorded in debug.
- **Processing a message**: load the chain (cached per chain id, invalidated on save; the root chain id cached too); start at `firstNodeId`; for each node, run the handler with `(ctx, msg)` where `ctx` offers `{ node, chain, services (prisma, telemetry writer, attributes, alarms, notifications, http, mqtt, log), tellNext(msg, relations), tellFailure(msg, err), ack(), enqueueDelayed(...), callChain(chainId, msg), output(label) }`; follow every returned relation to the connected nodes; **hop limit 200 per message** (a Rule chain → Output cycle counts) → `Failure` with `metadata.error=HOP_LIMIT`; per-message wall budget 30 s. A node handler that throws → `Failure` relation with `metadata.error` = message, `metadata.errorStack` trimmed. Debug recording when `node.debugMode` (ThingsBoard: all / failures only — we offer `all` and `failures`); events persisted to `rule_node_debug_events` by a batched writer (flush every 500 ms / 200 rows), capped per node (`debugMaxEventsPerNode`, 1,000, oldest deleted) and by age (`debugRetentionHours`, 24; a cron sweep in `telemetry_partition_maintenance`'s slot is NOT reused — a 9th task `rule_engine_debug_sweep` hourly).
- **Rule chain / Output**: the Rule chain node pushes `(callerChainId, callerNodeId)` on the message's call stack (metadata-free; engine-internal) and starts the target chain; an Output node pops and returns to the caller node's connections under the Output node's NAME as the relation (ThingsBoard semantics); a chain with no Output ends the message. Cycles bounded by the hop limit.
- **Scripts** (`script-vm.ts`): `node:vm` with `timeout` = `scriptTimeoutMs` (default 2,000 as ThingsBoard's JS executor); the context exposes `msg` (deep copy), `metadata` (copy), `msgType`, and ThingsBoard's helper surface we can honour: `JSON`, `Math`, `Date`, `parseInt/parseFloat`, `btoa/atob`, `isNaN`, and `TbDate`-free. No `require`, `process`, `fetch`, timers, `globalThis` leaks (a frozen context object, `codeGeneration: { strings:false, wasm:false }`). Documented plainly: **this bounds time and scope; it is not a security sandbox against a hostile administrator** — scripts are written by `RULE_CHAIN_MANAGE` holders only (today the same trust level as SUPER_ADMIN's config pages), the same stance `regex-budget.ts` takes. Filter script returns boolean; Switch returns a string or array of strings; Transform returns `{ msg, metadata, msgType }` or an array of them (multiple outgoing messages). `POST /api/rule-chains/test-script` runs a script against a sample message for the editor's **Test script** button (ThingsBoard has it).
- **HTTP (REST API call, Slack)**: Node 24 `fetch` with the node's timeout, headers templated; the response body replaces `msg` as ThingsBoard does; `metadata.status`, `statusCode`, `statusReason`, `error` set as ThingsBoard sets them.
- **MQTT external**: the `mqtt` package the API already carries, one connection per node instance (lazy, reconnecting), config = host, port, topic pattern, client id, credentials, TLS flag, QoS, retain; the message data is published as JSON. (Publishing to THIS install's broker is the same node pointed at localhost — it works through the broker ACL only for the bridge's identity; documented.)
- **Capacity**: the ingest ceiling measured 2026-10-03 is ~270 msg/s serial; the engine's enqueue adds a map insert; processing runs on the event loop in slices — a chain of ten simple nodes costs ~0.2 ms per message; scripts cost what they cost, bounded by the timeout; the Main queue absorbs bursts to its capacity. Measured in a test with 1,000 messages through the shipped chain (< 2 s).

> **Superseded 2026-11-05 — the final fix wave:** the 30 s per-message budget is ADMINISTERED (`messageBudgetMs`, 1,000 .. 300,000 ms); a flow yields after ~10 ms of work and ends at `STEP_LIMIT` = `hopLimit` × 10 node runs over all its copies (review A C1); nothing is accepted until Configuration → Rule Engine has been read since the engine started (M1). **Scripts (ruling TB-L):** a node whose `scriptLang` is TBEL runs its TBEL text AS JAVASCRIPT — TBEL itself is still not built (§3), but an imported ThingsBoard chain's TBEL nodes now run; the import warns once per such node and the export writes JavaScript only. RE-3's bound is PER CALL (≤ 5 s), not "15 s". The REST node uses `node:http` / `node:https` through the S-6 target guard, not `fetch`, and honours ThingsBoard 4's `requestBodyTemplate` (review B I-3); the MQTT node's broker goes through the same guard (M-4) and protocol 3.1 connects as 3.1. Delay / Checkpoint per originator are capped at `queueCapacity` waiting jobs (`DURABLE_QUEUE_FULL`).

## 7. The node catalogue (G3)

Names, groups and relation labels are ThingsBoard's. "originator" = the message's instrument unless a node changed it. Configuration fields are listed by ThingsBoard's names. **Status: B = built now, L = later (with what it needs), N = no counterpart.**

### Filter (13)
| Node | Status | Behaviour here | Relations |
|---|---|---|---|
| Alarm status filter | B | passes when the originator ALARM's status is in the configured set (`ACTIVE_UNACK`, `ACTIVE_ACK`, `CLEARED_UNACK`, `CLEARED_ACK`) — mapped from `state` + `acknowledgedAt` | True / False |
| Asset profile switch | N | no assets | — |
| Check fields presence | B | `messageNames[]`, `metadataNames[]`, `checkAllKeys` | True / False |
| Check relation presence | L (needs instrument relations beyond gateway; gateway link only now → built as "gateway" direction only) | `direction`, `relationType`, `entityType`/`entityId` | True / False |
| Device profile switch | B | relation = the originator instrument's PROFILE NAME | one per profile |
| Entity type filter | B | `originatorTypes[]` ⊆ INSTRUMENT, ALARM, USER, SYSTEM, RULE_NODE | True / False |
| Entity type switch | B | relation = originator type | one per type |
| GPS geofencing filter | L (needs latitude/longitude keys; pure math) | `latitudeKeyName`, `longitudeKeyName`, `perimeterType` circle/polygon, … | True / False |
| Message type filter | B | `messageTypes[]` (the §5 list + custom) | True / False |
| Message type switch | B | relation = `msg.type` mapped to ThingsBoard's labels (`Post telemetry`, `Post attributes`, `Attributes Updated`, `Attributes Deleted`, `Alarm`, `Alarm Cleared`, `Alarm Acknowledged`, `Activity Event`, `Inactivity Event`, `Entity Created`, `Entity Updated`, `Entity Deleted`, `REST API Request`, `Other`) | per type |
| Script | B | JS `return boolean` | True / False |
| Switch | B | JS `return string | string[]` | custom |
| (ThingsBoard also lists "Originator type filter/switch" under older names — these are Entity type filter/switch) | | | |

### Enrichment (11)
| Node | Status | Behaviour here |
|---|---|---|
| Calculate delta | B | `inputValueKey`, `outputValueKey`, `round`, `tellFailureIfDeltaIsNegative`, `useCache`, `addPeriodBetweenMsgs`, `periodValueKey` — previous value from the latest table / in-memory cache per originator+key |
| Customer attributes | N | no customers |
| Customer details | N | — |
| Fetch device credentials | N (tokens are hashed; nothing to fetch) | — |
| Originator attributes | B | `clientAttributeNames` (instrument attributes), `sharedAttributeNames` (same table — ThingsBoard's scopes collapse to one here, documented), `serverAttributeNames`, `latestTsKeyNames` (latest table), `tellFailureIfAbsent`, `fetchTo` DATA/METADATA |
| Originator fields | B | `fieldsMapping` from `name`, `code`, `label`, `profileName`, `functionalLocation` (Block/Area), `type` (instrumentType), `isGateway`, `createdTime`, `additionalInfo`, `id` |
| Originator telemetry | B | `latestTsKeyNames`, `fetchMode` FIRST/LAST/ALL, `aggregation` NONE/AVG/MIN/MAX/SUM/COUNT, `startInterval`/`endInterval` + units, `orderBy`, `limit` — over `instrument_telemetry_history` |
| Related device attributes | L (gateway relation only now → "the gateway's attributes" built as the one relation; general relations later) | `deviceRelationsQuery`, attribute lists |
| Related entity data | L (same) | — |
| Tenant attributes | L → "Application attributes" (a config def `rule-engine-attributes` holding key/value pairs any chain can read) — built now as that | `attrMapping` |
| Tenant details | B → "Application details": Branding company name, app name, server name/version | `detailsList` |

### Transformation (12)
| Node | Status | Behaviour here |
|---|---|---|
| Change originator | B | `originatorSource`: `ALARM_ORIGINATOR` (the alarm's instrument), `ENTITY` by instrument code, `RELATED` (the gateway), `TENANT`→SYSTEM; `CUSTOMER` N |
| Copy key-value pairs | B | `copyFrom` DATA↔METADATA, `keys[]` |
| Deduplication | B | `interval` s, `strategy` FIRST/LAST/ALL, `outMsgType`, `queueName`, `maxPendingMsgs`, `maxRetries` — per originator window in memory |
| Delete key-value pairs | B | `deleteFrom`, `keys[]` |
| JSON path | B (`jsonpath-plus`, pure JS) | `jsonPath` |
| Rename keys | B | `renameIn`, `renameKeysMapping` |
| Script | B | JS `return { msg, metadata, msgType }` or an array |
| Split array msg | B | one message per element |
| To email | B | `fromTemplate`, `toTemplate`, `ccTemplate`, `bccTemplate`, `subjectTemplate`, `bodyTemplate`, `mailBodyType` plain/html/dynamic → `SEND_EMAIL` |
| Duplicate to group / by name / to related | N (PE) | — |

### Action (31)
| Node | Status | Behaviour here |
|---|---|---|
| Calculated fields | N | — |
| Clear alarm | B | `alarmType` (template), `scriptLang`+`alarmDetailsBuildJs` → clears the ACTIVE alarm of that type on the originator via `claimClear` (fires `ALARM_CLEAR`) → Cleared / False |
| Copy to view | N (no entity views) | — |
| Create alarm | B | `alarmType`, `severity` (CRITICAL/MAJOR/MINOR — ThingsBoard's WARNING/INDETERMINATE map to MINOR, documented), `propagate` (ignored, documented), `useMessageAlarmData`, `overwriteAlarmDetails`, `dynamicSeverity`, `alarmDetailsBuildJs` → creates (or updates the details/severity of the ACTIVE one) an `alarms` row `source=RULE`, `metric=CUSTOM`, `ruleSnapshot={ alarmType, nodeId, chainId, details }`; dedupe by a NEW partial unique index on `(instrument_id, (rule_snapshot->>'alarmType')) WHERE state='ACTIVE' AND source='RULE'`; fires `ALARM` with `isNewAlarm`/`isExistingAlarm` → Created / Updated / False |
| Create relation / Delete relation | L (relations) | — |
| Delay (deprecated) | B (durable — §6) | `periodInSeconds`, `maxPendingMsgs`, `periodInSecondsPattern` |
| Delete attributes | B | `scope`, `keys[]` → deletes instrument attributes (audited as today's attribute delete) → `ATTRIBUTES_DELETED` |
| Device profile (deprecated) | N (profile alarm rules are this system's instrument-limit alarms) | — |
| Device state | L (needs the activity tracker to accept an event; today lastSeen is stamped by ingest only) | — |
| Generator | B | `msgCount`, `periodInSeconds`, `originatorType`/`originatorId`, `jsScript` → `GENERATOR_NODE_SELF_MSG`; runs while the chain is saved with the node present (restart-safe: re-armed on boot) |
| GPS geofencing events | L (GPS keys) | — |
| Log | B | `jsScript` → `return string` → API log at `info` with `[rule-chain <name>/<node>]`; also stored as a debug OUT event when debug is on |
| Math function | B | `operation` (ADD, SUB, MULT, DIV, SIN, SINH, COS, COSH, TAN, TANH, ACOS, ASIN, ATAN, ATAN2, EXP, EXPM1, SQRT, CBRT, GET_EXP, HYPOT, LOG, LOG10, LOG1P, CEIL, FLOOR, FLOOR_DIV, FLOOR_MOD, ABS, MIN, MAX, POW, SIGNUM, RAD, DEG, CUSTOM expression), `arguments[]` from MESSAGE_BODY/METADATA/ATTRIBUTE/TIME_SERIES/CONSTANT, `result` to MESSAGE_BODY/METADATA/ATTRIBUTE/TIME_SERIES with `resultValuePrecision` |
| Message count | B | `interval`, `telemetryPrefix` → emits a `POST_TELEMETRY_REQUEST` from a SYSTEM originator with `<prefix>_<nodeId>` = count |
| Push to edge / Push to cloud | N | — |
| REST call reply | L (needs the synchronous REST request route; the inject route is fire-and-forget now) | — |
| RPC call reply / RPC call request | L (no device RPC; Modbus is read-only; MQTT downlink to a device exists only for attributes) | — |
| Save attributes | B | `scope`, `notifyDevice` (publishes the attribute downlink the attribute path already has), `updateAttributesOnlyOnValueChange` → `instrument_attributes` through the same writer the attribute routes use (audited) → `ATTRIBUTES_UPDATED` |
| Save time series | B | `defaultTTL` (ignored — partitions govern retention; documented), `skipLatestPersistence`, `useServerTs` → `writeBatchOrDeadLetter` with transport `rule-engine` (offsets NOT re-applied — the values are the chain's) → `POST_TELEMETRY_REQUEST` guarded by §5's loop rule |
| Assign to / Unassign from customer | N | — |
| Add to group / Remove from group / Change owner / Generate (dashboard) report / Integration downlink / Save to custom table | N (PE) | — |

### External (16)
| Node | Status | Behaviour here |
|---|---|---|
| AI request | L (needs an LLM provider config def; out of this build) | — |
| AWS Lambda / SNS / SQS, Azure IoT Hub, GCP Pub/Sub, Kafka, RabbitMQ | N (each a vendor SDK; not on this platform) | — |
| MQTT | B | §6 |
| REST API call | B | `restEndpointUrlPattern`, `requestMethod`, `headers`, `useSimpleClientHttpFactory`, `readTimeoutMs`, `maxParallelRequestsCount`, `enableProxy`(ignored), `ignoreRequestBody`, `parseToPlainText`, `credentials` basic/bearer |
| Send email | B | from a `SEND_EMAIL` message via `emailChannel.send` (the configured SMTP) with a `notification_logs` row |
| Send notification | B | `templateId` (an existing `NotificationTemplate`) + `targets` (roles / users) → `sendNotification` per recipient (EMAIL/SMS per the template) |
| Send SMS | B | `numbersToTemplate`, `smsMessageTemplate` via `smsChannel.send` |
| Send to Slack | B | `botToken`/webhook url, `conversation`, `messageTemplate` (chat.postMessage) |
| Twilio SMS / Twilio Voice | N (PE) | — |

### Flow (4)
| Node | Status |
|---|---|
| Acknowledge | B (no-op on Main; records) |
| Checkpoint | B (→ Durable queue) |
| Rule chain | B |
| Output | B |

Counts: B = 46 (13→10 filter … tallied in `packages/shared/src/types/rule-nodes.ts` by a test), L = 12, N = 29.

> **Superseded 2026-11-05:** the counts are B = **47**, L = **10**, N = **29** of **86** (see the §2 note). Message type switch labels are ThingsBoard's `TbMsgType` verbatim — **`REST API request`** (lower-case r), not "REST API Request". Device profile (deprecated) is **B** (a pass-through). Save attributes' `ATTRIBUTES_UPDATED` follows the §5 note (P-10). Configuration keys follow ThingsBoard master where this table differs (Originator fields / Tenant attributes `dataMapping`, Math `MESSAGE_METADATA`, REST credentials `anonymous` / `basic` / `cert.PEM`, no MQTT QoS field) — Task 1 report. Every narrowing is listed by node in the feature note.

> **Superseded 2026-11-05 — the final fix wave:** Device profile (deprecated) is B with ThingsBoard's six relations and sends the evaluator's alarms on `Alarm Created` / `Alarm Cleared` (DP-1), not a pass-through. Entity type filter / Generator store ThingsBoard's `DEVICE` / `TENANT` (SW-1). Delete attributes honours its two toggles, default OFF. Templates follow ONE rule with ThingsBoard's placeholders and one pass (TP-1).

## 8. Data model (40 → 44 models; enums 13 → 14; two migrations)

- `RuleChain { id uuid, name @unique, root Boolean (partial unique index WHERE root), debugMode Boolean, firstNodeId uuid?, document Json (the whole chain: nodes + connections + firstNodeIndex, ThingsBoard export shape; the SOURCE OF TRUTH), reEnterOnRuleNodeWrites Boolean default false, createdAt, updatedAt, createdBy, updatedBy }`. Nodes and connections are ALSO projected into `RuleNode { id, chainId, type, name, config Json, debugMode, x, y, index }` and `RuleNodeConnection { id, chainId, fromNodeId, toNodeId, relation }` by the save transaction so the engine and the debug table have real ids to key on (Ruling D-1: document + projection, like dashboards hold a document; the projection is rebuilt on every save, never edited by itself).
- `RuleNodeDebugEvent { id bigserial, chainId, nodeId, ts, direction IN|OUT (validated string), relation?, msgId, msgType, originatorType, originatorId, data Json, metadata Json, error? }` with an index on `(nodeId, ts desc)`; swept by age and per-node cap.
- `AlarmMetric` gains `CUSTOM` (migration `…_alarm_metric_custom`, its own `ALTER TYPE … ADD VALUE` as every enum change here); the partial unique index for RULE alarms (migration `…_rule_chains`, hand-authored like the 2026-11-02 one). The Alarms page / reports / notifications read a RULE alarm's type NAME from `ruleSnapshot.alarmType` (`alarmTypeKeyFor` returns null for RULE today → `alarmDisplayName` falls back to that field; touch point).
- Seeded root chain (§5) inserted by the migration when `rule_chains` is empty.

> **Superseded 2026-11-05:** **enums stay 13** — `CUSTOM` is a new VALUE of `AlarmMetric`, not an enum (Task 2 report). Models 40 → 44 as stated; migrations `20261103180000_alarm_metric_custom` and `20261103181000_rule_chains`.

## 9. API (`/api/rule-chains`, 57 → 59 web routes)

- `GET /` (list: id, name, root, node count, updatedAt), `GET /:id` (the document + ids), `POST /` (create; body = name + document), `PUT /:id` (whole document, `expectedUpdatedAt`, `reason` required — the dashboards precedent), `DELETE /:id` (refused for the root: 409 `ROOT_CHAIN`), `POST /:id/root` (make root: one transaction unsets the old), `POST /import` (ThingsBoard JSON: maps `tbClass` → our type ids; unknown → `tb:unsupported` node; returns warnings), `GET /:id/export` (ThingsBoard JSON shape), `GET /node-types` (the registry: group, label, description, config descriptor, relations, status), `POST /test-script` (`{ scriptType, script, msg, metadata, msgType }` → result or error), `GET /:id/debug?nodeId&limit&before` (events), `DELETE /:id/debug` (clear), `GET /stats` (queue depth, dropped, processed per minute, per-chain counts), `POST /api/rule-engine/v1/messages` (inject, §5).
- Reads: `RULE_CHAIN_READ`; writes: `RULE_CHAIN_MANAGE` + re-auth `UPDATE_RULE_CHAIN` (new, `Configuration` category, ships OFF) + audit `RULE_CHAIN_CREATED / UPDATED / DELETED / IMPORTED / ROOT_CHANGED` (5; category `Configuration`) with the whole document before/after; debug clear audited `RULE_CHAIN_DEBUG_CLEARED` (6). A rule-created alarm: no audit row (the evaluator's alarms have none); the Save/Delete attributes nodes write the attribute audit rows the attribute routes write, with user `SYSTEM` (`SYSTEM_AUDIT_ACTIONS`).
- Permissions 46 → 48 (`RULE_CHAIN_READ`, `RULE_CHAIN_MANAGE`; MANAGE implies READ via `PERMISSION_IMPLIED_BY`); tree group `rule-chains` (appended LAST) with nodes `rule_chains.view` (configurable) and `rule_chains.manage` (configurable, reauth `UPDATE_RULE_CHAIN`) → `CONFIGURABLE_PRIVILEGE_ORDER` and the frozen snapshot appended; sidebar item `rule-chains` ("Rule Chains", appended LAST; 15 → 16); SUPER_ADMIN holds both; no other shipped role.

## 10. Configuration → Rule Engine (a config def, 37 → 38)

`rule-engine.def.ts` (SUPER_ADMIN card, dynamic page): `enabled` (default ON — the shipped root chain is a no-op; OFF stops processing and empties the queue), `skipSaveNodesForIngestOrigin` (ON), `scriptTimeoutMs` (2000, 100..30000), `queueCapacity` (10000), `concurrency` (8), `debugRetentionHours` (24), `debugMaxEventsPerNode` (1000), `httpTimeoutMs` (10000), `hopLimit` (200). Plus `rule-engine-attributes.def.ts` (38 → 39): the "Application attributes" key/value list the Tenant attributes node reads.

> **Superseded 2026-11-05 (ruling RE-3):** `scriptTimeoutMs`'s administered maximum is **5,000 ms**, not 30,000 — three consecutive time-outs disable a script (ruling C-2), so the worst case is 15 s of a blocked event loop (`6930fa18`). **[Corrected 2026-11-05, review A I1: the bound is per call — one call holds the loop at most `scriptTimeoutMs`; a script that runs just under it is never switched off (accepted; a worker-thread pool is a future item). The def also gained `messageBudgetMs`, and both defs carry `reauthAction: 'UPDATE_CONFIG_PAGE'` (ruling D8-1).]**

## 11. The web (G1, G4)

- Sidebar **Rule Chains** → `/rule-chains` (list: name, root badge, nodes, updated, Open / Export / Make root / Delete; Import; + New) and `/rule-chains/:id` (the editor). Gate `RULE_CHAIN_READ`; the editor's write controls on `rule_chains.manage` via `useCan`.
- **Editor** on **`@xyflow/react`** (pure JS; the react-grid-layout precedent — a node-graph with drag, connect, pan/zoom, minimap is weeks of fiddly work hand-rolled; Ruling W-1): left palette grouped Filter / Enrichment / Transformation / Action / External / Flow in ThingsBoard's group colours, each node draggable onto the canvas; the fixed **Input** node; a connection drawn from a node's source handle opens the **relation picker** (the source node's relations + custom labels, multi-select, as ThingsBoard's); double-click a node → **settings dialog** (name, debug mode all/failures/off, the generic configuration form rendered from the node's descriptor: text / number / boolean / select / multiselect / key list / key-value map / template text / script with a Test script button / instrument picker / template picker / role-user picker); **Unsupported** nodes render grey with the ThingsBoard class name. Top bar: name, Root badge, Debug (open the panel), Save (reason + re-auth), Export, Import, Delete, Undo/Redo (local). Draft kept in component state; a dirty leave prompts.
- **Debug panel** (right drawer, ThingsBoard's "Debug" tab): select a node → its events newest first, IN/OUT, relation chip, msg type, originator, time, expand for data / metadata / error JSON; auto-refresh 2 s while open; Clear (audited). The Rule Chains list shows the engine stats banner (queue depth, dropped, processed/min).
- Tests: jsdom + `@xyflow/react` needs `ResizeObserver` and `DOMMatrix` stubs (written once in `test-support/xyflow-stubs.ts`); render-check the editor with the built CSS at 1240 px before hand-over.

## 12. Security and §11

Writes: `RULE_CHAIN_MANAGE` + re-auth + reason + audit with the whole document. Scripts: time-boxed VM with no I/O; authors are MANAGE holders (SUPER_ADMIN by default). HTTP nodes: outbound only, with the node's timeout; no credentials in debug events (the REST node's `Authorization` header is masked in debug). MQTT external node: credentials stored in the chain document (encrypted? — Ruling S-5: stored as given, masked in the editor and in exports as ThingsBoard does; cost if wrong: an exported chain carries a broker password). Rule-created alarms go through the same acknowledge / webhook / notification paths. Debug events can hold telemetry values — readable only with `RULE_CHAIN_READ`.

> **Superseded 2026-11-05 (ruling T2-D; ruling S-6):** credentials are masked as `"***"` in EVERY response, for EVERY caller (RULE_CHAIN_MANAGE included), in the export and in the audit values; a save sending `"***"` keeps the stored value. REST API call and Send to Slack refuse link-local, unspecified and cloud-metadata addresses after one judged DNS lookup; loopback and private networks are allowed (accepted risk). **[2026-11-05, final fix wave: the secret rule also masks `serviceAccountKey`, `sasl.jaas.config`, PEM PRIVATE KEY values and `x-auth-key` / `x-access-key` / `x-session-id` (review B I-5; scripts and template fields exempt from the value rule); the export names every credential it masked in the chain's Description (SW-2). Rule-node credentials are stored in plain text — an operator question (review A M9). The debug list and the inject route are scoped by the caller's instrument view (review A I3, I4); `RULE_CHAIN_MANAGE` is plant-wide by nature — grant it only to unrestricted roles.]**

## 13. Tests

- shared: the catalogue (`rule-nodes.ts`): 46 built / 12 later / 29 none pinned; every built type has a zod config schema, a descriptor and a relations list; ThingsBoard class map round-trips.
- API unit: the engine (routing by relation, fan-out, Failure on throw, hop limit, Rule chain/Output stack, per-originator order, queue capacity/drop); the VM (timeout, no `process`, returns); EVERY built node with fixtures (one spec file per group; the handler contract `handler(ctx, msg) → relations`); import of a real ThingsBoard export (fixture JSON from a ThingsBoard 3.x root chain).
- API e2e (test DB): chain CRUD + gates + audit + reason + expectedUpdatedAt 409 + root switch + import/export; ingest → root chain → debug events (debug on) → Save Timeseries no-op; Create alarm node raises a RULE alarm (dedupe index), Clear alarm clears it, the Alarms list shows its type name; Send email → `notification_logs`; Delay → a `rule_engine_message` job with `runAt`; REST API call against a local Fastify stub; the inject route; `enabled=false` stops processing.
- web: list page, editor (palette drop adds a node; connection opens the relation picker; settings dialog renders each field type; save sends the document with reason and re-auth; unsupported node), debug panel (events render, clear), config form generator per descriptor type.
- Gates: API suite, shared, every touched web file one per process, tsc ×3, lint, `verify-migrations`.

## 14. Touch points and counts

modules 27 → 28; models 40 → 44; enums 13 → 14 (`AlarmMetric.CUSTOM`); permissions 46 → 48; reauth 58 → 59; audit 105 → 111 / 118 → 124; sidebar items 15 → 16; tree groups 15 → 16, nodes 56 → 58, privileges 39 → 41 (snapshot appended); defs 37 → 39; routes 57 → 59; queue tasks 7 → 9; type files 40 → 41 (`rule-nodes.ts`); web deps + `@xyflow/react`; api deps + `jsonpath-plus`. Docs: CHANGELOG, feature note RULE CHAINS, endpoints.md, the four CLAUDE.md, CONTRIBUTING's 12-touchpoint list for the two defs, `tasks/todo.md`.

> **Superseded 2026-11-05 — the counts as built** (re-derived with root `CLAUDE.md`'s commands): enums **13** (not 14); audit **105 → 112 / 118 → 125** (the inject route is audited too, ruling W-2); type files **40 → 42** (`rule-nodes.ts`, `rule-chain-document.ts`; ruling P-1); config pages 24 unchanged; migrations 54 → 56. The rest as stated.

## 15. Calls I made that the operator did not (overturn any)

1. S-1 three statuses (46 built / 12 later / 29 no counterpart) instead of a claim that all 87 exist.
2. S-2 rule-node writes do not re-enter the engine by default; S-3 the shipped root chain is ThingsBoard's and Save nodes skip ingest-origin messages by default (zero cost).
3. S-4 Delay / Checkpoint are DURABLE through graphile-worker (ThingsBoard's Delay is in-memory and lossy).
4. JavaScript only (no TBEL); `node:vm` time-box, not a security sandbox; MANAGE holders are trusted authors.
5. D-1 the chain DOCUMENT is the source of truth, nodes/connections are a projection with stable ids.
6. One Main queue (per-originator order) + one Durable queue; no HighPriority queue.
7. `AlarmMetric.CUSTOM` + a partial unique index for RULE alarms; a RULE alarm's type name = `ruleSnapshot.alarmType`.
8. W-1 `@xyflow/react` for the canvas.
9. S-5 external credentials stored in the document, masked in the editor and exports.
10. Two new config defs (engine settings; application attributes); engine `enabled` defaults ON.
11. "device" = instrument everywhere; attribute scopes collapse to the one attributes table.
