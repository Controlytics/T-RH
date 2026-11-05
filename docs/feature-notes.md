# Feature notes (moved out of CLAUDE.md on 2026-10-07)

These bullets lived in the root `CLAUDE.md` until it passed the 150k-char load limit.
They were moved VERBATIM — nothing was rewritten or dropped. They are design decisions,
operator instructions and traps per feature; read the relevant one before touching that area.
Counts quoted inside them are historical — the live numbers are in `CLAUDE.md` System Stats
(and must be re-derived from code before quoting).

## Feature notes (part 1)

- **RULE CHAINS — a ThingsBoard-style rule engine: every event becomes a message that runs through rule chains an administrator draws (2026-11-03 .. 2026-11-05; operator: "add rule chains how in thingsboard has same add rule chains and what ever rule nodes are in thingsboard those all should come in this also, and all the nodes functionalities should be come as same", then "skip questions and start").** Spec `docs/superpowers/specs/2026-11-03-rule-chains-design.md` (§15 = the controller's calls; dated superseding notes added 2026-11-05 where the build moved away from it), plan `docs/superpowers/plans/2026-11-03-rule-chains.md`, every ruling in `.superpowers/sdd/2026-11-03-rule-chains/progress.md` (task reports and reviews beside it), built screens `docs/superpowers/concepts/2026-11-03-rule-chains/built-*.png`. 35 commits, `0c1bb61c` .. `b8a17e1f`, after the spec `a83a67e7` and plan `7f505568` (listed by area in `CHANGELOG.md`). **Built, not pushed, not deployed.** Engine fix round 3 landed rulings RE-3 (`6930fa18`), RE-1 (`1cc3d5f4`) and RE-2 (`366f9b63`) and the e2e on the REAL handlers (`bcbe2bf3`, re-review I2) on 2026-11-05; the rest of that round (the services minors, the owed mutants) and a final fix wave were still open when this note was written — read `task-3c-report.md` beside the ledger, and the final fix wave's commits, before trusting a sentence below that says "owed". **[Superseded 2026-11-05, final fix wave: engine fix round 3 is COMPLETE (`a7fce274` lifecycle m1-m3, `aef2d5b0` + `398c8004` MQTT 3.1 / client id / fail fast / `cert.PEM` without SSL / `services.http` removed, `daaaa0ab`, `39ddd221` ruling D8-1, `9d6b6aac`), and the FINAL FIX WAVE after the three whole-branch reviews (`whole-review-a.md` / `-b.md` / `-c.md`) has landed, `924fda9f` .. `2b2114b6` — its summary is the next sub-bullet, and every sentence below it made false carries a dated note like this one]**
  - **FINAL FIX WAVE (2026-11-05) — what changed after the whole-branch reviews.** Rulings in the ledger from "Whole-branch review A" on; reports `fw-api-report.md`, `fw-n1-report.md`, `fw-n2-report.md`, `fw-n3-report.md`; every commit by area in `CHANGELOG.md` "RULE CHAINS — final fix wave". **No count moved and no migration** (`git diff --stat 9d6b6aac..HEAD -- apps/api/prisma` is empty). In one place, the rules a change must not undo:
    - **No flow holds the event loop (review A C1, `d2847e2e`).** A flow yields (`setImmediate`) after ~10 ms of continuous work while it has steps left (the originator stays busy, so per-originator order holds). **`STEP_LIMIT`** = `hopLimit` × 10 node runs over ALL the flow's copies — `_hops` counts one lineage per copy, so a fan-out cycle never reached the hop limit — recorded like `HOP_LIMIT` (IN + OUT `Failure (unhandled)`), counted `step_limit`, the waiting steps `steps_abandoned`, a warning at most once a minute. The per-message budget is ADMINISTERED: **`messageBudgetMs`** (Configuration → Rule Engine, 30,000 shipped, 1,000 .. 300,000, clamped on read and logged once). `stop()` halts a flow still running after `stopWaitMs` (5 s) at its next step (`halted_on_stop`). `GET /stats` returns the engine's `counters` map.
    - **Nothing is accepted until the configuration is read (review A M1, `bc7acc6f`).** `accepting()` and `started` need a successful read of Configuration → Rule Engine since THIS start: a database unreadable at boot means OFF, not the shipped defaults. A durable job before the read is RESCHEDULED; the inject route answers `ENGINE_NOT_STARTED`.
    - **The durable path.** `stop()` hands the waiting Delay / Checkpoint backlog back in BATCHED `graphile_worker.add_jobs` inserts (500 a statement, `durableHandBackBudgetMs` 5 s, a failed batch retried item by item, one log line — "not confirmed" for a batch still running at the budget; review A M6, `ba8ff042`, `bf6fbb29`). graphile 0.16 orders a queue by (priority, `run_at`) with NO id tie-break, and one statement's rows share `now()`, so each job's `run_at` is now() + its place in the whole hand-back in microseconds — per-originator order survives (the last of a full queue runs at most 1 s late). The hourly `rule_engine_debug_sweep` also deletes EMPTY `rule-engine:` job queues (`gcRuleEngineJobQueues`, review A M3, `a14dc105`) — graphile's own GC SQL restricted to that prefix, deliberately NOT `WorkerUtils.cleanup`: `add_jobs` ensures a queue and inserts its job in two statements with no foreign key, so an unrestricted GC could strand an `alarm_evaluation` job queue-less and let two alarm passes overlap (audit 2026-10-12 #2). `services.durable.enqueue` builds its job with `durableJobPayload` (the hand-back's builder) and REFUSES with `DURABLE_QUEUE_FULL` (the Delay / Checkpoint node's Failure, nothing queued) when `rule-engine:<originatorId>` already holds `queueCapacity` waiting jobs — a fan-out cycle through Delay / Checkpoint restarts the step count at every resume, and this is what ends it (`0bed30b2`; the count is a bounded scan, ≤ 5.5 ms at 10,000 waiting jobs). Documented (review A M4): a RESCHEDULED durable message can be overtaken by a later one of the same originator.
    - **The routes (review A I3, I4, I5, M2; `d78a558f`, `71cc027f`).** `GET /:id/debug` is scoped by the caller's instrument view: a restricted caller sees only rows whose originator is an instrument in its view, or an ALARM of one (looked up in `alarms`, never through metadata); SYSTEM / USER / RULE_NODE rows are hidden from it. `DELETE /:id/debug` stays chain-wide (accepted: a chain-level, audited act by a MANAGE holder). The inject route resolves `originatorCode` inside the caller's view (out of view = 404 `ORIGINATOR_NOT_FOUND`, nothing audited), refuses a restricted caller that names no instrument (403 `ORIGINATOR_REQUIRED`), and takes at most 256 KB (413). `POST /test-script` is 10 calls a minute per user (429). **Operator note: `RULE_CHAIN_MANAGE` is plant-wide by nature** — a chain's Generator / Change originator / Save nodes act on any instrument whatever its author's view — so scoping the rule-chain routes is defence in depth, not a boundary: grant MANAGE only to unrestricted roles (open question for the operator: should the server refuse MANAGE to a restricted role?).
    - **Alarms (rulings AL-1, AL-2, DP-1).** AL-1 (`171214e9`): EVERY alarm message — the evaluator's raise / clear, the acknowledge route, the rule nodes — comes from the alarm's INSTRUMENT, with `metadata.alarmId` (and `instrumentId` on evaluator / ack messages) and data = the alarm JSON with its `id`; only the TRUE flag is written. AL-2 (`4f3a8809`): a Create / Clear alarm node's ROOT-CHAIN message is ThingsBoard's action message — `ENTITY_CREATED`, `ENTITY_UPDATED` (a severity change included) or `ALARM_CLEAR`, metadata `ruleNodeId` + `alarmId` + the origin stamp, no isNewAlarm / isExistingAlarm flags; the node's OUTPUT stays `ALARM` + the one true flag. Unchanged: the evaluator keeps `ALARM` / `ALARM_CLEAR`, the acknowledge route keeps `ALARM_ACK`. **`2b2114b6`:** an alarm update that changes nothing (neither the severity nor the details) sends the INCOMING message on `Success` with no action message, as ThingsBoard's `TbAbstractAlarmNode.onMsg` does — and since Create alarm's relations are ThingsBoard's `Created` / `Updated` / `False` (no Success connection is offered), such a message normally ends at the node; an `ALARM_CLEAR` from any origin but a rule node carries no `ruleNodeId` (it carried `''`). DP-1 (`ab0bdcff`, `da23d112`): Device profile sends the EVALUATOR's alarms (origin `system`) on `Alarm Created` / `Alarm Cleared`, each on that label ONLY, the clear retyped as `ALARM` (ThingsBoard's `AlarmState.pushMsg`); `Alarm Updated` / `Alarm Severity Updated` exist for parity and never occur (the evaluator never updates an alarm or changes its severity); everything else — acks, rule-node alarm messages, telemetry — goes on `Success`. The shipped root chain has no Device profile node and nothing on an alarm label, so no shipped behaviour moved.
    - **Writes and audit.** A rule-engine rewrite of a stored reading is audited as `SYSTEM`, reason `Rewritten by rule chain "X" node "Y" (message <id>, origin <origin>)`, its `msgId` the one the inject route's `RULE_ENGINE_MESSAGE_INJECTED` row names; a device re-send keeps its wording byte for byte (review A I2, `273b65c3`, `8f72e910`). A warning is logged once a minute when rule-engine audit rows pass **600 in a minute** (Save attributes' changed keys, Delete attributes' removed keys, telemetry rewrites); nothing is throttled — every changed attribute stays an audit row (review A I5, `13fbde43`; Save attributes' help says so, `15a82df3`). **Ruling TS-1** (`9ce6453e`): a rule write REFUSES an instant before 2000-01-01 or more than 10 minutes ahead (`TIMESTAMP_OUT_OF_WINDOW`, the node's Failure, nothing stored, no dead letter — ingest replaces such an instant, a chain's explicit instant is never restamped); an in-window backdated reading is stored as ingest stores one. Save time series reads a whole-number STRING ts (Gson `getAsLong`, M-2) and fails a null with `Can't parse value: <the whole object>`. Delete attributes honours its two toggles, both OFF by default (P-10 treatment, `a33ea0cf`). The debug writer keeps a batch's ROW ORDER whatever the plan (`98183ee3` — the planner could hash the VALUES side and number a batch backwards once `rule_chains` was estimated bigger than the batch).
    - **Scripts and templates.** **Ruling TB-L** (`c00bff63`, `9587e541`): TBEL imports as JavaScript running the TBEL text, ONE warning per TBEL node ("its TBEL script now runs as JavaScript — check it"); every script handler runs what `scriptLang` selects through the shared `ruleNodeScript` (a document stored before TB-L that still says TBEL runs its TBEL text as JavaScript); the export writes JS only; `SCRIPT_LANGUAGE_UNSUPPORTED` no longer exists. ThingsBoard's own root chains therefore import with THREE true warnings (its two TBEL Log nodes + RPC Call Request). **Ruling TP-1** (`61f450dc`): ONE template rule (`processPattern` in `nodes/action/support.ts`) for every node — ThingsBoard's placeholders `${key}`, `${*}`, `$[path]`, `$[*]` and the trailing-dot rule, own keys only, ONE pass (a deliberate difference: a substituted value is never expanded again, a placeholder a substitution would build is not one, an unresolved one no longer swallows the text after it), an `escapeJson` mode (Jackson `quoteAsString`) for the REST body template, numbers printed as Jackson `asText` (a whole number as is, others by Java's `Double.toString`: 0.0001 → `1.0E-4`, 12345678.9 → `1.23456789E7` — this reaches RULE alarm type text, REST URLs and Math keys). M-1 (`c84ffbba`): ONE metadata-ts reader, ThingsBoard's `Long.parseLong` rule (sign, ASCII digits, no trim, a safe integer), else the message's own time, else now. M-3 / M-11 (`b1ec7247`): attributes fetched INTO DATA are typed; a missing key sends the ENRICHED message to Failure with ThingsBoard's per-scope wording. M-5 (`4ce1f3a5`, `58447bae`, `2e576af4`, `887af67c`): Copy / Delete key patterns run under `lib/regex-budget.ts`; a pattern that runs out its budget 3 times IN TOTAL is switched off for its node until a save that changes the chain.
    - **Outbound.** REST API call honours ThingsBoard 4's `requestBodyTemplate` — the "Body template" field (review B I-3, `3ac4720f`, `46464b3c`); a bodyless request drops a node's `Content-Length`; 100.100.100.200 (Alibaba Cloud metadata) and 168.63.129.16 (Azure WireServer) are refused with their mapped / compatible / NAT64 spellings; `services.http.fetch` is REMOVED (`aef2d5b0`). The MQTT node's broker goes through the S-6 guard (M-4, `be125e32`), and protocol 3.1 connects as 3.1 (`aef2d5b0`).
    - **ThingsBoard boundary.** SW-1 (`47b7b2bf`, web `6a55825a`), SW-2 (`e09dfd96`, `422bb2e0`, `981a3d07`, `8c4f4da5`), M-7 import warnings, DP-1's dead-connection warning, I-5 secrets (`99e3a24e`, `aca4a11b`, `3f69f388`) and the corrected import order — in the Importing / Exporting / Credentials sub-bullets below.
    - **Web (`924fda9f`, `6a55825a`)** — in the web sub-bullet below.
  - **The catalogue: 86 ThingsBoard nodes = 47 built / 10 later / 29 none** (`packages/shared/src/types/rule-nodes.ts`, pinned by `rule-nodes.test.ts` and the `GET /node-types` e2e `[47, 10, 29]`). The spec's 87 = 46 / 12 / 29 was wrong three ways: its 13th filter row was an older name of Entity type filter / switch (T1-1); two of its "later" rows were also counted as built, in their gateway-only form (T1-2); and Device profile (deprecated) moved from none to built as a pass-through (D-P), because every ThingsBoard root chain v3.6 .. v4.2 enters through it. **[Superseded 2026-11-05, final fix wave: Device profile is no longer a plain pass-through — ruling DP-1 sends the evaluator's alarms on `Alarm Created` / `Alarm Cleared`, and its relations are ThingsBoard's six]** Built per group: filter 10, enrichment 7, transformation 9, action 11, external 6, flow 4. Names, groups, configuration keys, defaults and relation labels are ThingsBoard's ("device" reads "instrument"); Message type switch labels are `TbMsgType`'s verbatim (`REST API request`, lower-case r). A later or none node has no handler: placed by an import, every message it gets goes to `Failure` with `UNSUPPORTED_NODE: …`. The palette lists later / none nodes in one collapsed "Not available here" group that cannot be placed. Check relation presence, Related device attributes and Change originator RELATED are built on the ONE relation this system has, the gateway link. Tenant attributes / Tenant details read Configuration → Application Attributes / the application's details.
  - **Where messages come from (spec §5; ruling M-1).** `POST_TELEMETRY_REQUEST` is ThingsBoard's FLAT shape: `data = { key: value }`, the instant in `metadata.ts` (epoch ms as text), one message per distinct instant (one per instrument per batch, normally). Values are the STORED ones, after sensor offsets; a device value an offset corrected is in `metadata.raw_<key>`. **Spec §5's `{ ts, values }` was wrong** (M-1, 2026-11-04); Save time series still ACCEPTS `{ ts, values }` and arrays, as ThingsBoard does. Also: `POST_ATTRIBUTES_REQUEST` (a device's CHANGED keys, `CLIENT_SCOPE`), `ALARM` / `ALARM_CLEAR` / `ALARM_ACK` (originator = the alarm, flags as ThingsBoard sets them), **[Superseded 2026-11-05, final fix wave: AL-1 — the originator is the alarm's INSTRUMENT, with `metadata.alarmId` and data = the alarm; AL-2 — a rule node's root-chain message is `ENTITY_CREATED` / `ENTITY_UPDATED` / `ALARM_CLEAR`]** `INACTIVITY_EVENT` / `ACTIVITY_EVENT`, `ENTITY_CREATED` / `UPDATED` / `DELETED` for instruments (a whitelist — never a token or certificate), `REST_API_REQUEST` (the inject route), `GENERATOR_NODE_SELF_MSG`, `SEND_EMAIL`, and `ATTRIBUTES_UPDATED` / `ATTRIBUTES_DELETED` from the attribute nodes. NOT emitted: bulk upload, a person's attribute writes, profiles and users (spec: later). **[Superseded 2026-11-05, final fix wave: review A M7 (`ffd10633`) — the bulk instrument upload emits `ENTITY_CREATED` per created instrument and `ENTITY_UPDATED` per instrument whose own columns moved (a TCP/IP address or reading), as the single routes do; an attribute-only update sends nothing. A person's attribute writes, profiles and users are still not emitted]** Every emit helper (`modules/rule-engine/emit.ts`) runs AFTER the caller's commit, never throws, never waits on the database, and is O(1); the engine fills `instrumentCode` / `instrumentName` / `profileName` from a 30 s cache before the first node, never on the ingest path. `metadata.rule_engine_origin` says where a message came from: `ingest`, `system`, `user`, `rest_api` or `rule_node:<chainId>:<nodeId>`.
  - **How a message flows (`engine.ts`, `queue.ts`).** The Main queue is in memory, bounded by `queueCapacity` (10,000) and FIFO per ORIGINATOR (ThingsBoard's SequentialByOriginator): one instrument's messages in order, `concurrency` (8) originators at once. Full: the OLDEST message of the LARGEST backlog is dropped and counted (`dropped`, a banner on the list page) — the MQTT bridge's buffer rule; `push` never throws. One message is one FLOW: run the node, follow every returned relation to every connected node (a copy each). A handler that throws → `Failure` with `metadata.error` / `errorStack`. A relation with no connection ends the message there. **The hop limit (`hopLimit`, 200) ENDS the message** (T3-5): recorded `OUT Failure (unhandled)` with `error = HOP_LIMIT` even when a Failure connection exists (routing it would spend more hops on the loop it is stopping); a Rule chain → Output cycle counts. A message has 30 s: a handler still running then is abandoned (`MESSAGE_TIMEOUT`) and anything it calls later is dropped (`late_dropped`). **[Superseded 2026-11-05, final fix wave: the budget is the administered `messageBudgetMs` (30,000 shipped, 1,000 .. 300,000); a flow also yields after ~10 ms of work and ends at `STEP_LIMIT` (`hopLimit` × 10 node runs over all its copies) — see the FINAL FIX WAVE sub-bullet]** **Rule chain / Output:** the Rule chain node pushes (its chain, itself) on the message's `_stack`; an Output node pops it and the message leaves the CALLER node under the Output node's NAME; an Output in a chain nobody called ends the message (`<name> (no caller)`). `_stack` and `_hops` are engine-internal: never shown to a script, never in a debug row. A chain's own `debugMode` column is not used — each node's `debugMode` decides (T3-15). Switching Configuration → Rule Engine OFF empties the queue; the setting is read into a snapshot every second. **[Superseded 2026-11-05, final fix wave: nothing is accepted until that setting has been read once since the engine started (review A M1)]** Nodes with a lifecycle (Generator, Message count, Deduplication) make a started engine re-read `rule_chains (id, updated_at)` every 5 s. (Round 3, `a7fce274`: a lifecycle node that fails to start backs off per chain and version — 5 s, 10 s, 20 s … at most 5 min — with a best-effort `onDestroy`; a save or a force retries at once.)
  - **The loop guard, re-entry and the Save-node skip.** A write made BY a node (Save time series, Save / Delete attributes, Create / Clear alarm, a Math TIME_SERIES or ATTRIBUTE result) goes through the normal write path with origin `rule_node:<chainId>:<nodeId>`, and its event is skipped unless THAT chain's **"Re-enter on rule-node writes"** (`reEnterOnRuleNodeWrites`, default OFF — ruling S-2) is on. **`skipSaveNodesForIngestOrigin`** (Configuration → Rule Engine, default ON — ruling S-3): Save time series and Save attributes do nothing for a message ingest already stored and pass it on `Success`, so the chain continues. With the skip OFF, writing the same value back at a stored instant is a no-op that keeps the stored raw value (T3-11). A rule telemetry write enqueues an alarm evaluation and does NOT stamp last-seen (T3-14); only readings that CHANGED are emitted back (ruling C-1). **Ruling RE-1 (`1cc3d5f4`, 2026-11-05): re-entry is ONE generation deep.** Every queue item carries a `reentryDepth` decided at ADMISSION — a root message from the origin its emit helper stamped (`rule_node:` = depth 1), a late call or `tellSelf` from the flow it came from, a lifecycle call 0, a durable resume the job's `_reentryDepth` — and never re-read from metadata a script can rewrite; `runFlow` always runs in its OWN `AsyncLocalStorage` context (`context.ts`, `REENTRY_DEPTH_MAX = 1` — without its own context the queue's `setImmediate` would hand a flow the context of whichever flow pushed last). `deliver()` skips a `rule_node:` emit inside a depth ≥ 1 flow (`loop_skipped`) BEFORE the chain's switch is consulted — telemetry, attributes (Save attributes' ATTRIBUTES_UPDATED included), deletions and alarms alike. `alarms.createOrUpdate` is changed-only: the same severity and the same details by content → no UPDATE and no ALARM, still `{ alarm, created: false }`, so the node's `Updated` output is unchanged. **[Superseded 2026-11-05, final fix wave: `2b2114b6` — an update that changes nothing sends the incoming message on `Success` (normally unconnected: Create alarm offers `Created` / `Updated` / `False`), as ThingsBoard's `TbAbstractAlarmNode.onMsg` does; a real change, a severity change alone included, stays on `Updated`; and since AL-2 the root-chain message of a real update is `ENTITY_UPDATED`, not `ALARM`]** Stricter than ThingsBoard, which has no re-enter switch; cost: a chain relying on a second-generation re-entry sees only the first (none exists). **Before RE-1** a chain with re-entry ON whose write CHANGED something (Save time series with `useServerTs`, a transform that changes the value, a changing attribute, Create alarm fed its own ALARM) re-entered without bound — every re-entered message started at `_hops` 0, so the hop limit never saw it, and each pass could add a §11 audit row (re-review C1, `task-3b-review.md`). All three are pinned on the REAL handlers by `bcbe2bf3`: Save Timeseries with `useServerTs` gives exactly 2 switch IN rows and 2 stored rows (`loop_skipped` + 1); a transform adding 1 at the same instant writes exactly ONE `TELEMETRY_READING_REWRITTEN`; a Create alarm fed its own ALARM ends at the second pass. **Residual, not guarded (re-review m10):** a loop through the alarm EVALUATOR escapes both guards — a rule write → `alarm_evaluation` → the evaluator's raise / clear emits with origin `system` → the chain writes the judged key back across the bound → clear → raise … It needs a chain that writes the very metric that is judged. **Residual, the same class (review A, 2026-11-05):** a DEVICE-mediated attribute loop — Save attributes with `notifyDevice` → the firmware re-reports the attribute → ingest's `POST_ATTRIBUTES_REQUEST` (origin `ingest`) → the chain saves again — also escapes RE-1; it is periodic (one round trip per device report), not explosive.
  - **The shipped root chain** is seeded by migration `20261103181000_rule_chains` only when `rule_chains` is empty: id `b1a7e000-0000-4000-8000-000000000000` (`SEEDED_ROOT_CHAIN_ID`), "Root Rule Chain", from `defaultRootChainDocument()` (a test compares the seeded row with the function). **Four nodes — the Input is NOT a node** (T1-3; the chain's `firstNodeId` is the switch): Message Type Switch → `Post telemetry` → Save Timeseries · `Post attributes` → Save Attributes (`CLIENT_SCOPE`) · `Other` → Log Other; `RPC Request from Device`, the alarm and activity labels are unconnected. With S-3 ON it costs one map insert per message and writes nothing. It has no creation audit row (a migration cannot write the hash chain; `updatedBy` is null). Exactly ONE root: partial unique index `rule_chains_one_root`; `POST /:id/root` moves it under an advisory lock with raw SQL so `updated_at` (the editor's version) does not move; the root cannot be deleted.
  - **Scripts are a TIME-BOX, not a security sandbox (`script-vm.ts`).** ThingsBoard's JavaScript node scripts as a function body `function (msg, metadata, msgType)`, each compiled once into its own `node:vm` context: code generation from strings and WebAssembly off, `msg` / `metadata` cross as JSON text (no host object enters), the context frozen once built, the result serialised to JSON inside the budget. Usable names: `msg`, `metadata`, `msgType`, `JSON`, `Math`, `Date`, `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `btoa`, `atob`, `String`, `Number`, `Boolean`, `Array`, `Object`, and `Error` / `RegExp` (T3-6); `process`, `require`, `globalThis`, `fetch`, timers, `console`, `Function`, `Promise`, `Reflect`, `Proxy` are shadowed `undefined`. It bounds TIME (`scriptTimeoutMs`, default 2,000) and what a script can NAME; memory is not bounded and `node:vm` is not a security mechanism. Scripts are written by `RULE_CHAIN_MANAGE` holders (SUPER_ADMIN by default) — the `lib/regex-budget.ts` stance. **The blacklist (ruling C-2):** three CONSECUTIVE time-outs of one node's script disable it (`SCRIPT_DISABLED: timed out 3 times — fix and save the chain`) until the chain is saved (key `<chain>:<node>:<updatedAt>` + the script's hash; the Test script route is never disabled) — ThingsBoard's blacklist. (Round 3, `a7fce274`: the wording is now `SCRIPT_DISABLED: timed out 3 times in a row — change the chain and save it`; a lifecycle node's strikes key on the chain's CURRENT version, so a save that does not touch a Generator re-enables it, and a save that changes nothing keeps the version.) **Ruling RE-3 (`6930fa18`): the administered maximum of `scriptTimeoutMs` is 5,000 ms** (the def's setting and zod schema; a stored value above it reads as 5,000, with a warning logged once per stored value), so the worst case is 3 × 5 s = 15 s of a blocked event loop — it was 30,000 ms, 90 s, while the MQTT bridge buffers 500 messages and then loses them. **[Superseded 2026-11-05, final fix wave: "worst case 15 s" was wrong — the bound is PER CALL: one script call holds the loop for at most `scriptTimeoutMs` (5 s), three strikes switch a timing-out script off after at most 15 s of time-outs, and a script that runs just UNDER its timeout on every message is never switched off (review A I1, `b1b5c9bc`). Accepted for this build: scripts run in-process, as ThingsBoard runs TBEL, bounded per call, by the switch-off and (after C1) by yielding between steps; a worker-thread script pool is a future item in `tasks/todo.md`]** Cost: an admin cannot give a slow script more than 5 s. TBEL does not run (spec §3): a Log, alarm-details or Generator script set to TBEL fails `SCRIPT_LANGUAGE_UNSUPPORTED` (T5-12); filter, switch and transform run their `jsScript` (T4-15); the import warns when a node's two scripts differ. **[Superseded 2026-11-05, final fix wave: ruling TB-L — every script node runs the script `scriptLang` selects (the shared `ruleNodeScript`): a stored TBEL node runs its TBEL text as JavaScript; an import turns a TBEL node into JavaScript running the TBEL text, with ONE warning; `SCRIPT_LANGUAGE_UNSUPPORTED` no longer exists. Note, UNVERIFIED: ThingsBoard's default JavaScript evaluator is `local` (the Nashorn sandbox), which may not run ES2015+ syntax (`const`, arrow functions, template literals) written here]** Math function's CUSTOM expression uses a parser of ThingsBoard's exp4j grammar, never the VM (`^` is power there, XOR in JavaScript). Key regular expressions (Copy / Delete keys) and JSON-path filters are NOT time-boxed, as in ThingsBoard. **[Superseded 2026-11-05, final fix wave: review B M-5 — Copy / Delete key patterns now run under `lib/regex-budget.ts` (`regexWithBudget`, `58447bae`: `'match'` / `'no-match'` / `'timeout'` / `'invalid'`, the timeout recognised by the vm's own `ERR_SCRIPT_EXECUTION_TIMEOUT` code, never by message text; `testRegexWithBudget` is now its one-line wrapper with its contract unchanged for its other two callers, the alarm webhooks and the SMS gateway); a run-out is "no match" (Copy skips the key, Delete KEEPS it), a key over 1,000 characters never matches, definite answers are remembered per (pattern, key) up to 4,096, a plain name compares as text; a pattern that runs out its budget 3 times IN TOTAL (not in a row — alternating harmless keys must not keep it alive) is switched off for its node, keyed `<nodeKey>:<ctx.chain.version>` + the pattern, until a save that changes the chain; a run-out is never remembered. JSON-path filters are still not time-boxed]**
  - **Delay and Checkpoint are DURABLE (ruling S-4).** Both hand the message to graphile-worker task `rule_engine_message` on the named queue `rule-engine:<originatorId>` (one originator's durable messages in order); Delay sets `runAt` = now + the period. The job re-injects the message AFTER the node on `Success`, with its `_hops` and `_stack`. A restart BEFORE the job runs loses nothing (ThingsBoard's Delay is in memory and lossy). **The job completes when the Main queue ADMITS the resumed message** (ruling C-2 — a job that held its graphile slot for the whole flow blocked the per-originator queue behind a slow chain); a restart between admission and processing loses it — the accepted crash window. **Ruling RE-2 (`366f9b63`): a durable item is never lost on overflow or stop.** The queue never evicts one (a queue full of kept items refuses the newcomer rather than grow past capacity), `resumeAfter` refuses admission at capacity (`durable_refused`) so graphile keeps the job, and `stop()` hands every waiting durable item back through `services.durable.enqueue` with its relation and re-entry depth (`durable_requeued`; a failed hand-back `durable_dropped`, logged; switching the engine OFF counts the durable items it drops). A job the engine cannot take (not started, stopping, full) is RESCHEDULED — re-added on the same queue at now + 5 s × 2^requeues, at most 5 min — instead of throwing: graphile 0.16 counts an attempt whenever it locks a job, so throwing spent one of the five attempts each time and failed a Delay for good after ~4 min of refusals. Cost: a crash between the re-add and the completion runs the message twice. Before RE-2 an admitted durable message was lost to a full queue and to every graceful stop (re-review I1). Jobs are enqueued `maxAttempts: 5`. **[Superseded 2026-11-05, final fix wave: the hand-back is batched `add_jobs` with `run_at` order, empty `rule-engine:` queues are deleted hourly, and `services.durable.enqueue` refuses `DURABLE_QUEUE_FULL` at `queueCapacity` waiting jobs per originator — see the FINAL FIX WAVE sub-bullet]** Delay's `maxPendingMsgs` is counted in graphile's private job table, so the count survives a restart (T5-16). `releaseQueueLocks` frees every `rule-engine:` queue at boot (T3-13; graphile frees a named queue a killed process left locked only after 4 h). The hourly `rule_engine_debug_sweep` (crontab `17 * * * *`) is the 9th task.
  - **Credentials (rulings S-5, T2-B, T2-C, T2-D; `modules/rule-engine/secrets.ts`, ONE rule for every path).** A secret leaf is a STRING whose key matches the secret pattern (password, passphrase, secret, token — `botToken` —, private key, API key, an `Authorization` header) or any string inside a `credentials` object except `type`, `username`, `caCert` and `cert`. **EVERY response that carries a chain masks every non-empty secret leaf as `"***"`, for EVERY caller, `RULE_CHAIN_MANAGE` included** (T2-D supersedes T2-B's "MANAGE sees them"); the export masks the same way. A save or an import that sends `"***"` KEEPS the value stored for the SAME node id and type; a node that kept its id but changed type inherits nothing, and a new node sent with `"***"` stays `"***"` and is refused at run time (`CREDENTIAL_NOT_SET`); an import names each node whose credential must be entered again. An unchanged save counts `"***"` as its stored value. **Audit rows hold the document MASKED, with `secretsChanged` on UPDATED** (T2-C: the immutable trail must not hold plaintext). The editor shows a masked value as `•••• (stored)` (Change / Keep stored; "Keep stored" sends `"***"`); a masked map row's KEY is locked ("A stored secret keeps its key: type a new value first to rename it."), and a JSON edit that moves a `"***"` to another path is refused (`movedMasks` in `config-form.tsx`) — the server keeps a secret only at the same node, key and path, so a moved marker would be saved as the three characters. Any text that equals `•••• (stored)` is written as `"***"` (accepted, Task 7 re-review M3). Known gaps of the heuristic, deferred: the key pattern over-masks (`tokenKeyName`), only string leaves are masked (a numeric secret, a secret inside a URL or a header list passes), array-held secrets merge by index, a literal password `***` cannot be stored, and the REST node's response-header mask misses names like `x-auth-key` / `x-access-key` / `x-session-id`. **[Superseded 2026-11-05, final fix wave: review B I-5 (`99e3a24e`) — the key rule also masks `serviceAccountKey` (`account[-_]?key$`, anchored so the key FILE name stays readable), `sasl.jaas.config` (`jaas`) and the header names `x-auth-key` / `x-access-key` / `x-session-id`; a VALUE holding a PEM PRIVATE KEY block (any algorithm) or a service-account `"private_key"` is a secret under any key and as an array element (a CERTIFICATE PEM stays public, N1-6). Exempt from the value rule: a node's SCRIPT keys entirely (a script is code, N1-13, `aca4a11b`), and its TEMPLATE fields from the `"private_key"` text rule only (a pasted PEM private key still masks; `3f69f388`). **Operator question (review A M9):** rule-node credentials are stored in plain text in `rule_chains.document` / `rule_nodes.config` and in backups, unlike instrument tokens — ask whether to encrypt them at rest]** Debug rows record REST response headers named like a credential, and the cookies, as `"***"`.
  - **Where a REST API call or Slack node may connect (ruling S-6; `nodes/external/target-guard.ts`, `http.ts`).** REFUSED: link-local and unspecified addresses (169.254.0.0/16, fe80::/10, 0.0.0.0/8, `::`) and EC2's IPv6 metadata endpoint fd00:ec2::254, also spelled as an IPv4-mapped / -compatible / NAT64 address — a `RULE_CHAIN_MANAGE` author pointing a URL at 169.254.169.254 would otherwise read the server's cloud instance role. An IP literal is judged before any I/O; a NAME is resolved ONCE inside the connect (`ruleTargetLookup`), every address it resolves to is judged, and the socket connects to exactly the judged addresses — no second lookup for a rebinding DNS answer. ALLOWED, an accepted risk: loopback and the private ranges — ThingsBoard allows them and a plant's systems live on private networks. The address judgement is `lib/outbound-guard.ts`'s (the alarm webhooks' and SMS gateway's), with plain loopback put back. `node:http` / `node:https` with `agent: false` (env proxies cannot move it), redirects never followed (a 3xx is a `Failure`), one abort signal bounds DNS + connect + body, the body capped at `maxInMemoryBufferSizeInKb`, `error_body` cut at 4 KB. Owed: delete the unguarded `services.http.fetch` (no node calls it; engine fix round 3), and in the final fix wave refuse the Alibaba (100.100.100.200) and Azure (168.63.129.16) metadata literals, drop a user `Content-Length` on a bodyless request. **[Superseded 2026-11-05, final fix wave: all done — `services.http.fetch` REMOVED (`aef2d5b0`); 100.100.100.200 and 168.63.129.16 refused with their mapped / compatible / NAT64 spellings, before outbound-guard's verdict; a node's `Content-Length` dropped on a bodyless request (`46464b3c`); and the MQTT node's broker goes through the same guard (M-4, `be125e32`: one lookup, every address judged, connect to the judged address with `servername` = the name; an IP literal is judged with no lookup; a refusal leaves no client to reconnect). Still not covered (accepted): the SIIT `::ffff:0:a.b.c.d` and 6to4 `2002::` spellings]**
  - **Importing a ThingsBoard chain (`POST /api/rule-chains/import`; shared `fromThingsboardExport`).** The export as an object or JSON text; optional `name` (a name in use is 409 `NAME_IN_USE` — ask and resend); never made root. Per BUILT node, in this order: the node's `configurationVersion` (absent = 0) → **ThingsBoard's own upgrade, mirrored from its source** (`upgradeThingsboardConfig`; ruling CV-1: Check relation presence v0 → v1 flips FROM ↔ TO, Copy / Delete / Rename keys → v2, Device profile; ruling CV-3: Save attributes v0 / v1 / v2 → v3, Originator / Related device attributes `fetchToData` → `fetchTo`, Tenant details `addToMetadata`, Originator fields `fieldsMapping` → `dataMapping`, Tenant attributes `attrMapping` / `telemetry`, Originator telemetry v0 / v1 → v2, Calculate delta) → `coerceThingsboardScalars` (ThingsBoard 3.6.0 – 3.6.3 exported some booleans and numbers as STRINGS: exactly `"true"` / `"false"` and plain decimals, top level only) → the CV-3 boundary `fromThingsboardConfig` → validation. **[Superseded 2026-11-05, final fix wave: that ORDER was wrong (review B M-8): the code runs the upgrade → the CV-3 boundary `fromThingsboardConfig` → `coerceThingsboardScalars` → validation (`rule-chain-document.ts` `fromThingsboardExport`, lines 481-491)]** **CV-3 boundary rules:** Save time series' editor toggle `skipLatestPersistence` is the ONE source of truth; a v1+ `processingSettings` sets it (Advanced latest SKIP → true; Basic / latest ON_EVERY_MESSAGE → false) and is kept beside it; a strategy not built here (Deduplicate, WebSockets only, a time-series Skip) imports with ONE warning naming it. Save attributes keeps ThingsBoard's v3 shape; its `processingSettings` is judged the same way. An older version with no mirrored upgrade still imports as itself with `Node "<name>": configuration version N is older than M — review its settings.` (CV-1b; ThingsBoard would reset such a node to its default, P-4) — the additive upgrades of Change originator, Deduplication, Generator, MQTT, REST API call, Checkpoint and Rule chain are NOT mirrored. **Device profile (deprecated) is a built PASS-THROUGH (D-P):** in ThingsBoard it evaluates the profile's alarm rules, and this system's profile alarm rules are its instrument-limit alarms, raised by the evaluator whether or not a chain runs. **[Superseded 2026-11-05, final fix wave: ruling DP-1 — it sends the evaluator's alarms on `Alarm Created` / `Alarm Cleared` (FINAL FIX WAVE sub-bullet); and an import now warns once for every connection whose label a BUILT node with fixed relations can never send, naming the node, the label and what it does send (the connection is kept; dynamic and later / none / Unsupported nodes are not judged)]** A later / none class imports as itself with a warning (`<name>: <label> has no counterpart here and sends every message to Failure`); an UNKNOWN class, or a known class whose configuration fails its schema, imports as `tb:unsupported` (grey in the editor, with its ThingsBoard class name) with a warning; a TBEL / JavaScript script mismatch and a node needing a credential warn too. **[Superseded 2026-11-05, final fix wave: the TBEL mismatch warning is replaced by TB-L's ONE warning per TBEL node ("its TBEL script now runs as JavaScript — check it"; a TBEL node with an empty TBEL script says so instead). Also new: SW-1 maps ThingsBoard's entity-type vocabulary at the boundary — the Entity type filter and Generator store `DEVICE` / `TENANT` (labelled Instrument / System; a legacy stored `INSTRUMENT` / `SYSTEM` still reads, through `canonicalRuleNodeConfig`), and an Entity type switch's connection labels map `Device` ↔ `Instrument`, `Tenant` ↔ `System` (only connections out of that switch); M-7 warns per node for an id that came with the file (Rule chain, Generator `DEVICE`, Check relation single entity, notification template / ThingsBoard targets — worded true whether it is a ThingsBoard id or another installation's; an exact "does not resolve here" check is deferred) and for `useSystemSmtpSettings: false`, `useSystemSmsSettings: false`, `enableProxy: true`]** **Acceptance: ThingsBoard's real root chains v3.6.4 and v4.2 each import with exactly ONE warning — RPC Call Request (later)** **[Superseded 2026-11-05, final fix wave: THREE true warnings since TB-L (ruling N1-1): its two TBEL Log nodes ("Log RPC from Device", "Log Other") and RPC Call Request; a re-import of our own export has only the RPC one, and the imported 4.2 chain's Log nodes RUN on the real handlers]** (`__tests__/fixtures/thingsboard-root-chain-3.x.json` and `thingsboard-root-chain-4.2.json`, byte for byte from tags `v3.6.4` `0c25a3b3` and `v4.2` `29a6e980`; Task 6's "six-node root chain" never shipped in any release).
  - **Exporting (`GET /api/rule-chains/:id/export`)** writes ThingsBoard's JSON (a CORE chain; per node its `tbClass`, configuration and `configurationVersion` — the modelled version for a built node, always written, 0 included, so a re-import never re-applies an upgrade; an Unsupported node's source version; none for a later / none node), credentials masked. Save time series goes out at version 1 with `processingSettings` consistent with the toggle and NO `skipLatestPersistence` key (P-3: ThingsBoard's v1 class has no such field and its Jackson refuses unknown keys, so the node would not start there); a Save attributes with no `processingSettings` gets On every message (ThingsBoard's `@NotNull` refuses a chain without one). Export → import is the same chain (pinned, the 4.2 chain included). **Owed (final fix wave, Important):** sweep all 47 built nodes' default / exported configuration keys against their ThingsBoard configuration classes — any key ThingsBoard's class lacks makes the exported node fail to start in ThingsBoard; only the two Save nodes were checked. **[Superseded 2026-11-05, final fix wave: the sweep was done (`tb-config-key-sweep.md`): ZERO unknown keys across all 47 built nodes, all configurationVersions match; the failures were VALUES / TYPES, now handled — SW-1 exports `DEVICE` / `TENANT`, and SW-2 names every node ThingsBoard cannot start as exported in the exported rule chain's `additionalInfo.description` (ThingsBoard's rule chain Description; `null` when there is nothing to say), headed `THINGSBOARD_EXPORT_NOTES_HEADER` ("Set in ThingsBoard when you import this chain:"), one line per node worded "… before ThingsBoard will save the chain" (a bean-constraint case ThingsBoard REFUSES: a Slack conversation absent or incomplete — our default Slack node has none —, a notification with no template whose targets deserialise) or "… after import — …; until then ThingsBoard keeps the node but cannot start it" (our notification records, a Slack text id — never mapped to a ThingsBoard conversation object —, Rule chain / Generator / Check relation ids, Tenant details' APP_* / SERVER_* options); and one line per node naming every credential path the export MASKED ("set password after import — this system never exports a stored credential"; `981a3d07`). TB-L: a script node exports `scriptLang: 'JS'` + the running script, never a `tbelScript`]**
  - **Save attributes' notification and Math's attribute result (rulings P-9, P-10; superseding spec §5 / §7, which said Save attributes always emits ATTRIBUTES_UPDATED).** `ATTRIBUTES_UPDATED` is sent only when the node's `sendAttributesUpdatedNotification` is on (default OFF), the effective scope (the message's `metadata.scope`, else the node's) is not `CLIENT_SCOPE` (ThingsBoard's `checkSendNotification`), and the save CHANGED a value; with `updateAttributesOnlyOnValueChange: false` it lists every key of the message. The WRITE stays change-only (21 CFR §11: an unchanged value is never re-written, `updatedAt` never bumped, no audit row, no device downlink); the device is told only the changed keys; `notifyDevice` is taken from the node (ThingsBoard treats it as true unless the metadata says false, and pushes only for SHARED_SCOPE — a documented difference). A Math function ATTRIBUTE result sends NO `ATTRIBUTES_UPDATED` (P-9, `TbMathNode` sends none). Delete attributes' `sendAttributesDeletedNotification` and `notifyDevice` are still dead toggles (the event is always emitted, a removal always announced) — the P-10 treatment, emitting only when a key was really removed, is owed to the final fix wave. **[Superseded 2026-11-05, final fix wave: done (`a33ea0cf`) — both toggles honoured, both OFF by default as in ThingsBoard: `sendAttributesDeletedNotification` emits `ATTRIBUTES_DELETED` naming only the keys actually REMOVED (ThingsBoard names every key asked for; nothing removed = no message) through the loop guard; `notifyDevice` tells the instrument when the toggle is on OR `metadata.notifyDevice` parses true, after a removal only, with no SHARED_SCOPE check (every attribute is the instrument's here)]** All three emits go through `emit.deliver`, so RE-1's cap applies to them.
  - **RULE alarms.** `AlarmMetric` gains `CUSTOM` — an enum VALUE in its own migration `20261103180000_alarm_metric_custom` (Postgres refuses a new value in the transaction that adds it), so **the enum count stays 13** (the plan's "13 → 14" was wrong). Create alarm writes an `alarms` row `source RULE`, `metric CUSTOM`, `ruleSnapshot { alarmType, nodeId, chainId, details }`, deduped by the partial unique index `alarms_active_rule_type_unique` on `(instrument_id, (rule_snapshot ->> 'alarmType')) WHERE state = 'ACTIVE' AND source = 'RULE'` and by looking for the open alarm first (T3-12). The Alarms page, reports and the acknowledge webhook name it by `ruleSnapshot.alarmType` (`ruleAlarmTypeName` in `@digilog/shared`; ruling M-2). It is notified, webhooked and acknowledged like any alarm; its payload carries `metric: 'CUSTOM'` and `ruleName` = the alarm type; it has no audit row, as the evaluator's alarms have none. Severity: CRITICAL / MAJOR / MINOR, ThingsBoard's WARNING / INDETERMINATE stored as MINOR, anything else fails (T5-6). Clear alarm clears RULE alarms only (an evaluator alarm → `False`, T5-11); its Cleared message and the ALARM_CLEAR carry the clear script's details (TB-P 2, ThingsBoard's `clear_alarm` replaces them) while `ruleSnapshot.details` keeps the raise record. **[Superseded 2026-11-05, final fix wave: AL-1 / AL-2 — a rule node's alarm messages come from the alarm's INSTRUMENT; at the root chain a Create alarm sends `ENTITY_CREATED` / `ENTITY_UPDATED` and a Clear alarm `ALARM_CLEAR`, metadata `ruleNodeId` + `alarmId` + the origin stamp; the node OUTPUT stays `ALARM` + the one true flag (`isNewAlarm` / `isExistingAlarm` / `isClearedAlarm`). In the shipped root chain nothing listens on `Entity Created` / `Entity Updated`]**
  - **Governance.** Permissions `RULE_CHAIN_READ` / `RULE_CHAIN_MANAGE` (MANAGE implies READ through `PERMISSION_IMPLIED_BY`); SUPER_ADMIN by bypass, no other shipped role, and `default-roles.ts` does not list them (T2-14). Tree group `rule-chains` (appended LAST; `rule_chains.view`, `rule_chains.manage` with re-auth `UPDATE_RULE_CHAIN`); sidebar item `rule-chains`, HIDDEN for every existing role until enabled (enabling it grants READ). Every chain write, in this order: MANAGE by permission in `preValidation` (403 before the body is read) → the chain exists (404) → `enforceReauth('UPDATE_RULE_CHAIN')` (`Configuration`, ships OFF) → the reason (400 `REASON_REQUIRED`, ≤ 1000 characters) → the strict document parse (400 naming the node) → ONE transaction holding the write and its audit row with the WHOLE document before / after. Audit `RULE_CHAIN_CREATED` / `UPDATED` / `DELETED` / `IMPORTED` / `ROOT_CHANGED` / `DEBUG_CLEARED` and `RULE_ENGINE_MESSAGE_INJECTED`. `PUT /:id` is conditional on `expectedUpdatedAt` (409 `STALE`); an unchanged save is a 200 that writes nothing, decided before the version check. DELETE refuses the root (409 `ROOT_CHAIN`) and a chain another chain's Rule chain node calls (409 `CHAIN_IN_USE`). The chain name is HTML-stripped and unique as typed; the document is stored verbatim (scripts contain `<` and `&` — anything that renders a node name outside React must escape it). Attribute rows a node writes are audited as user `SYSTEM` naming the chain and node (T2-A; the audit userId guard stays intact). The inject route is a machine endpoint: MANAGE, no re-auth, no reason, ONE audit row per call written BEFORE the message can act, credential-like keys masked. **[Superseded 2026-11-05, final fix wave: it is now scoped by instrument view (404 out of view, 403 `ORIGINATOR_REQUIRED` for a restricted caller with no code), takes at most 256 KB (413), and refuses an instant outside ingest's window through Save time series (TS-1); MANAGE is plant-wide — the operator note in the FINAL FIX WAVE sub-bullet]** **Neither config def carries a re-auth action** (T2-13): a SUPER_ADMIN switches the whole engine off with no password even under a re-auth policy — reported in the Task 8 report as a code touch point, not changed. **[Superseded 2026-11-05, final fix wave: ruling D8-1 (`39ddd221`) — both defs carry `reauthAction: 'UPDATE_CONFIG_PAGE'` (`requiresReauth` stays false; ships OFF like every action), so an Action Re-authentication policy can ask for the password before the engine is switched off]**
  - **Debug events (`debug.ts`, table `rule_node_debug_events`).** A node's `debugMode` is `off`, `all` or `failures` (an OUT Failure and the IN that led to it). Rows are batched (500 ms / 200 rows, buffer 10,000; data over 64 KB stored as a truncated preview); a row for a chain deleted meanwhile is skipped by the INSERT. The per-node cap is enforced by the WRITER (ruling W-2): a node past `debugMaxEventsPerNode` (1,000) is trimmed to its newest rows at most once per 10 s, so between trims it holds up to about TWICE the cap; the hourly sweep removes rows older than `debugRetentionHours` (24). The relation column reads `Failure (unhandled)`, `<relation> (unconnected)` or `<label> (no caller)` where the message ended. Debug rows are NOT a §11 record, can hold readings, and need `RULE_CHAIN_READ`. **[Superseded 2026-11-05, final fix wave: a caller whose instrument view is limited sees only rows of instruments in its view and their alarms (review A I3); a batch keeps its row order whatever the plan (`98183ee3`)]** **ThingsBoard's 15-minute debug time-box is NOT built** (W-2): a node left on `all` writes until its cap.
  - **What the nodes do differently from ThingsBoard — every narrowing written in a node file** (`apps/api/src/modules/rule-engine/nodes/<group>/<file>.ts`; read the file before changing the node):
    - *Filter.* Check relation presence: the gateway link only, `relationType` kept for export, not consulted. Device profile switch reads the profile from the instrument, never `metadata.profileName`. Entity type filter / switch: ThingsBoard's DEVICE / TENANT read as INSTRUMENT / SYSTEM; any other ThingsBoard type matches nothing. **[Superseded 2026-11-05, final fix wave: SW-1 — the filter (and the Generator) STORE ThingsBoard's `DEVICE` / `TENANT`, labelled Instrument / System, and still read a legacy `INSTRUMENT` / `SYSTEM`; the switch keeps EMITTING this system's labels (Instrument, System …) and the import / export map its connections `Device` ↔ `Instrument`, `Tenant` ↔ `System`]** Check fields presence with both lists empty is NOT refused (ThingsBoard master has no such check, T4-3).
    - *Enrichment.* Calculate delta reads the previous value from the cache, else from HISTORY strictly before `metadata.ts`, not from the latest table (ingest stored the current reading first, so every delta would be 0 — T5-7); the current value is read as ThingsBoard's `asDouble()` (unparseable text = 0, a boolean 1 / 0); a non-finite delta fails with our own `DELTA_NOT_FINITE` text (P-15). Originator attributes: ThingsBoard's three scopes are ONE table. (Final fix wave: values fetched into the DATA are typed as ThingsBoard adds them — exactly `true` / `false` a boolean, a text that is exactly how its number prints a number, anything else text (007, 1.50, " 25", long serials, JSON text); the metadata keeps the text (M-3); a missing key with `tellFailureIfAbsent` sends the ENRICHED message to Failure with ThingsBoard's wording, "The following attribute/telemetry keys is not present in the DB: " then one `\t[<SCOPE>]:[k1, k2]` line per scope in a fixed client / shared / server / LATEST_TS order (M-11).) Originator fields: a field outside the list fails naming it (T5-15); `type` is the PROFILE name. Originator telemetry: no keys configured fails every message ("Telemetry should be specified!", P-11 — ThingsBoard fails at the actor instead); FIRST / LAST written quoted, as ThingsBoard writes them. Related device attributes: the gateway link only (`TO` = the originator's gateway, the default; `FROM` = the first instrument on a gateway, by code); `relationType`, `maxLevel`, `deviceTypes` kept for export, not applied. Tenant attributes = Application attributes; `dataToFetch` other than ATTRIBUTES fails. Tenant details = the application's title, app name, server name and version under `tenant_<camelCase>`; details with no value here are left out.
    - *Transformation.* Change originator: ENTITY looks the instrument up by CODE (ThingsBoard: by name); RELATED = the gateway, `relationsQuery` not read; TENANT = `SYSTEM`; CUSTOMER fails; metadata is not refreshed (as in ThingsBoard). Deduplication: in memory per originator (a restart, a node change or a chain delete drops what is held, as ThingsBoard's), `maxRetries` kept for export, unused. (Final fix wave, M-1: it reads `metadata.ts` through the ONE reader and falls back to the time the message was MADE, as ThingsBoard's `TbMsg.ts` — not its arrival.) JSON path on `jsonpath-plus` (ThingsBoard: Jayway) with Jayway's rules checked in front of it; filters on its `safe` evaluator, never `eval`; numbers print as JavaScript prints them. **Rename keys: a key mapped to ITSELF is kept** (T4-6 — ThingsBoard deletes it with its value). To email: `%d{…}` in SimpleDateFormat letters; `z` prints the platform's short zone name (`UTC`, not Java's `IST`); `images` / `attachments` / `reports` not carried (no file store); the data carries both `html` and `isHtml`. Templates (`${key}` metadata, `$[path]` data): a placeholder that does not resolve is LEFT AS WRITTEN, and substitution is ONE pass — a substituted value is never expanded again (ThingsBoard re-expands; one pass keeps a device value from pulling other metadata into a URL). Three template helpers exist (`transformation/pattern.ts`, `action/support.ts`, `external/template.ts`) — folding them is owed to the final fix wave. **[Superseded 2026-11-05, final fix wave: folded — ruling TP-1, ONE `processPattern` in `nodes/action/support.ts` with ThingsBoard's `${*}`, `$[*]` and trailing-dot rule, own keys, one pass, `escapeJson`, numbers as Jackson `asText` (FINAL FIX WAVE sub-bullet). Copy / Delete key patterns run under the regex budget (M-5)]**
    - *Action.* Save time series: `defaultTTL` kept for export (monthly partitions govern retention); processing strategies not built here warn on import; only `POST_TELEMETRY_REQUEST` accepted; an empty body fails (`Msg body is empty: …`). **[Superseded 2026-11-05, final fix wave: also: an instant outside ingest's window is refused (TS-1, `TIMESTAMP_OUT_OF_WINDOW`); an object with both `ts` and `values` is the timed shape whatever their types, `ts` read as Gson `getAsLong` (a whole-number STRING accepted, M-2); every failure inside one object reads `Can't parse value: <that object>`, a body that is not an object / array of objects `Can't parse value: <it>` (`TELEMETRY_DATA_INVALID` retired)]** Save attributes / Delete attributes: one table, the scope only labels the message; see P-10 above. Create alarm: `propagate*` and `relationTypes` kept for export, not applied. Clear alarm: RULE alarms only. Math function: a non-finite result FAILS (ThingsBoard stores `(long) NaN = 0` / Long.MAX on the integer path, P-6); ATTRIBUTE / TIME_SERIES result KEYS are templated (ThingsBoard saves under the RAW key text and puts the processed key on the message — kept, ruling on rc-p1's open item 1, P-7); an ATTRIBUTE result is stored as the TEXT of the number (P-8); a TIME_SERIES result stores the UNROUNDED value (P-5). Device profile: a pass-through, `persistAlarmRulesState` / `fetchAlarmRulesStateOnStart` ignored. **[Superseded 2026-11-05, final fix wave: DP-1 — the evaluator's alarms on `Alarm Created` / `Alarm Cleared`, everything else on `Success`; the two flags are still ignored]** Delay: durable (S-4). Generator: originator `RULE_NODE`, an instrument by id, or the system; anything else refuses to start. (SW-1: stored as ThingsBoard's `DEVICE` / `TENANT`, a legacy `INSTRUMENT` / `SYSTEM` still read. M-9: a Math CUSTOM expression looks its functions up as OWN properties only.) Message count: keyed `<telemetryPrefix>_<nodeId>` (ThingsBoard: its service id), from the SYSTEM originator.
    - *External.* REST API call: `enableProxy` ignored; `cert.PEM` refused (no client certificate is sent); (final fix wave: ThingsBoard 4's `requestBodyTemplate`, the "Body template" field, is honoured as `TbHttpClient.getRequestBody` does — a non-empty template is the body, filled with each `${key}` / `$[key]` value JSON-escaped unless `parseToPlainText`, `${*}` / `$[*]` as JSON, and it must parse as JSON unless `parseToPlainText` (`HTTP_BODY_TEMPLATE_INVALID`); no template sends the message data; the filled text goes as written, ThingsBoard re-serialises it;) a bearer token is an `Authorization` header; basic credentials REPLACE a configured `Authorization` (ThingsBoard sends both); a compressed body a server sends anyway is not decoded; a response header named `status` / `error_body` overwrites the metadata, as in ThingsBoard. MQTT: QoS always 1 (ThingsBoard's node has no QoS field); protocol 3.1 connects as 3.1.1 until engine fix round 3 passes the level through. **[Superseded 2026-11-05, final fix wave: round 3 (`aef2d5b0`) — 3.1 connects as 3.1 (`protocolVersion: 3`, `protocolId: 'MQIsdp'`); a client id over ThingsBoard's limit (23 on 3.1 with the suffix, 256 otherwise) is REFUSED with ThingsBoard's wording, never cut short; a client that dropped after connecting fails the publish at once (`MQTT_NOT_CONNECTED`); `cert.PEM` with SSL off WARNS and connects plain, as ThingsBoard does (E-11); the broker goes through the S-6 guard (M-4)]** Send email: `from` ignored (the configured sender sends); To / Cc / Bcc each delivered as a SEPARATE single-recipient email with its own `notification_logs` row (the channel takes one address); `images` not attached; a node's own SMTP settings ignored. Send SMS: a node's own SMS provider ignored. Send notification: `notificationRequestResult` is `{ sent, failed }`, not ThingsBoard's stats object; ThingsBoard notification-target ids from an import fail (`NOTIFICATION_TARGETS_UNSUPPORTED`). Send to Slack: `chat.postMessage` with the bot token only — no incoming-webhook URL (the catalogue has no field for one); `useSystemSettings` refused.
    - *Flow.* Acknowledge is a no-op on the Main queue (it does not retry), recorded in debug. Checkpoint: durable; `queueName` kept for export. Rule chain: `forwardMsgToDefaultRuleChain` always uses `ruleChainId` (profiles have no default chain here). Output: no relations of its own.
  - **Other documented behaviour (ruling C-2 item 11, re-review m4).** The inject route can STORE a backdated reading: through the shipped chain's Save Timeseries it writes whatever `metadata.ts` the caller sends (origin `rest_api`, so S-3 does not skip it); the audit row is the record of who did it. **[Superseded 2026-11-05, final fix wave: not "whatever" any more — TS-1 refuses an instant before 2000-01-01 or more than 10 minutes ahead (`TIMESTAMP_OUT_OF_WINDOW`, nothing stored); an in-window backdated reading is still stored as ingest stores one, and a rewrite of a stored reading is audited as `SYSTEM` naming the chain, node and message id that the inject row also names (review A I2)]** The debug writer's cap holds about twice the cap between trims. `services.instruments.fields().type` is the PROFILE name (ThingsBoard's device type is the device profile).
  - **The 10 "later" nodes and what each needs:** GPS geofencing filter and GPS geofencing events — latitude / longitude keys on instruments; Related entity data, Create relation, Delete relation — relations between instruments beyond the gateway link; Device state — the activity tracker accepting an event (only ingest marks an instrument active today); REST call reply — a synchronous REST request route (the inject route answers at once); RPC call request and RPC call reply — device RPC (instruments here only report); AI request — an AI provider configured. The 29 "none" nodes need entities this system does not have (customers, assets, entity views, edge, groups, cloud queues, Twilio, PE reports) and are listed in the palette only so nobody looks for them.
  - **Configuration.** Two defs (37 → 39), both SUPER_ADMIN cards rendered by the dynamic page (no page of their own; pages stay 24): **Configuration → Rule Engine** (`rule-engine.def.ts`: `enabled` ON, `skipSaveNodesForIngestOrigin` ON, `scriptTimeoutMs` 2,000 (100 .. 5,000 since RE-3), `queueCapacity` 10,000, `concurrency` 8, `debugRetentionHours` 24, `debugMaxEventsPerNode` 1,000, `httpTimeoutMs` 10,000, `hopLimit` 200; the zod schema requires EVERY key because the dynamic PUT replaces the row) **[Superseded 2026-11-05, final fix wave: plus `messageBudgetMs` 30,000 (1,000 .. 300,000; C1); `queueCapacity` also caps each originator's Delay / Checkpoint queue (`DURABLE_QUEUE_FULL`); both defs carry `reauthAction: 'UPDATE_CONFIG_PAGE'` (D8-1). A row stored before `messageBudgetMs` existed (this dev DB only) still saves from the page, which merges defaults; a raw API GET-then-PUT of it is a 400 until the key is added]** and **Configuration → Application Attributes** (`rule-engine-attributes.def.ts`: a list of `{ key, value }`, keys unique ignoring case, read by the Tenant attributes node). Both are read ONLY through `modules/rule-engine/config.ts` (10 s cache, invalidated by the defs' `afterUpdate`; a hand-edited number is clamped to its bounds). Their default rows are written at boot by `configRegistry.seedDefaults()`.
  - **The web (`apps/web/src/routes/rule-chains/`; `/rule-chains`, `/rule-chains/:id`, routes 57 → 59).** List: name, Root badge, nodes, updated, Open / Export / Make root / Delete, Import, + New; the engine's queue depth and messages processed in the last minute as tiles, and a banner only while the engine is switched OFF or messages were DROPPED (`/stats`, polled every 10 s). Editor on `@xyflow/react` 12.12.0 (exact): the palette by group in ThingsBoard's colours (tokens on the editor root), the fixed Input, a relation picker on every new connection (free text only where the source's relations are dynamic — Switch, Device profile switch, Rule chain; R7-1), a settings dialog rendered from `visibleRuleNodeFields` (mounted fresh per open and closed when a newer version of the chain is adopted underneath it), Test script, Unsupported nodes grey with their class, local Undo / Redo, Save with reason and re-auth. The leave guard catches a reload / close and every in-app link, NOT the browser's Back button (needs a data router; R7-3). Export exports the SAVED chain. The debug panel polls every 2 s through the app's polling policy and keeps its rows on a failed poll. **Final fix wave (`924fda9f`, whole-branch review C):** a picker whose list the role may not read (a 403 on users or instruments for a non-SUPER_ADMIN MANAGE holder) says so and keeps the stored value — "(not found)" only against a list that LOADED, and a loading list waits (I-1); the Debug drawer lies OVER the canvas's right edge and the MiniMap steps aside (the canvas was ~312 px at 1240 px with the sidebar open; I-2); the dismissed-password outcome is pinned on New / Make root / Delete / Save and the 409 Reload path re-reads and adopts (I-3); a newer version that arrived while the draft was dirty is adopted once Undo makes it clean, and ONLY a strictly newer version is ever adopted (M-1 — the `chain` prop can lag a version the page already adopted); a list refresh that fails after a successful write is told on its own (M-2); Enter on a focused link edits its labels (M-3); an emptied "Change" box keeps the stored secret, focusing a masked map value selects it, a row with a value and no key is flagged (M-4..M-6); "Debug: failures" shows on the card (M-8). `6a55825a`: the settings form reads each field through the shared `canonicalRuleNodeConfig`, so a node saved before SW-1 shows Instrument / System, never "not in this list"; the draft is not rewritten (an untouched form writes nothing; the first edit writes `DEVICE` / `TENANT`). The Test script panel shows the route's 429 as "Rate limit exceeded, retry in …"; the list page does not show `/stats` `counters`. **Drag, drag-to-connect and pan / zoom were never run in a real browser** — only headless renders and jsdom (`ResizeObserver` / `DOMMatrix` stubs); check them on :5176 before deploying.
  - **Counts moved** (commands in root `CLAUDE.md`, re-derived 2026-11-05): models 40 → 44 (`RuleChain`, `RuleNode`, `RuleNodeConnection`, `RuleNodeDebugEvent`), enums 13 unchanged, migrations 54 → 56, modules 27 → 28 (`rule-engine`), permissions 46 → 48, reauth actions 58 → 59 (8 categories), audit actions 105 → 112, templates 118 → 125 (7 categories), sidebar items 15 → 16, tree groups 15 → 16, nodes 56 → 58, feature privileges 39 → 41, config defs 37 → 39, config pages 24 unchanged, `<Route`s 57 → 59, shared type files 40 → 42 (`rule-nodes.ts`, `rule-chain-document.ts`), graphile-worker tasks 7 → 9 (`rule_engine_message`, `rule_engine_debug_sweep`). New dependencies, both exact: `@xyflow/react` 12.12.0 (web), `jsonpath-plus` 11.2.1 (api). **Final fix wave: NO count moved** — every count above re-derived at `887af67c` (and no count-bearing file moved in `2b2114b6`) (models 44, enums 13, migrations 56, modules 28, permissions 48, reauth 59 in 8 categories, audit 112 / 125 in 7, sidebar items and tree groups 16, nodes 58, privileges 41, defs 39, config pages 24, routes 59, type files 42, graphile tasks 9, catalogue 86 = 47 / 10 / 29).
  - **Tests** (each file alone, by exit code): shared `types/__tests__/{rule-nodes,rule-chain-document}.test.ts`; API unit `modules/rule-engine/__tests__/{engine,queue,script-vm,debug,emit,config,services-durable,services-mqtt,import-export,nodes-filter,nodes-flow,nodes-transformation,nodes-enrichment,nodes-action,nodes-external}.test.ts`; API e2e `e2e/{rule-chains,rule-engine,rule-engine-alarms}.e2e.test.ts` (single fork, test DB); web `routes/rule-chains/__tests__/` (8 files). **Correction, re-review I2:** until `bcbe2bf3` `rule-engine.e2e.test.ts` registered STAND-INS for the four shipped node types, so its loop-guard pins ran on a stand-in Save time series that ignored `useServerTs`, not "on real handlers" as commit `738f9e50` and the ledger said — which is how re-review C1 went unseen. It now asserts the real handlers are registered; never put a stand-in back under a shipped type id. Final fix wave test files added: API unit `durable-handback`, `secrets`, `services-telemetry`, `services-audit-rate`, `nodes-helpers` (the TB-L / TP-1 / M-1 acceptance on REAL handlers) and `lib/__tests__/regex-budget.test.ts`. `import-export.test.ts` still registers stand-ins under shipped type ids for its routing and capacity tests, beside the real-handler acceptance tests (accepted, FW-N3 open item 6).
  - **Before deploying:** the whole-branch review and the gate; on AWS `npm ci` (two new dependencies), `npx prisma migrate deploy` (both migrations; the second seeds the root chain only when `rule_chains` is empty), then every user reloads. Restart the local dev server: `prisma generate` EPERMed on the engine DLL while `tsx watch` held it (the JS client WAS regenerated). **Final fix wave: no new migration** (`git diff --stat 9d6b6aac..HEAD -- apps/api/prisma` empty); the operator list is in `tasks/todo.md` — restart the dev server, every user reloads, a real-browser check of drag / connect / pan on :5176.
- **WIDGET REPORTS AND REPORT TEMPLATES — a governed Download report on every dashboard widget; what it prints is a template per instrument PROFILE per widget TYPE (2026-11-02; operator: "whenever i added a new widgets added report download option should be added, in report each and every field or keys or headers, footers, logos everything should be configurable and for each instrument profile and each widget report should configurable … for each widget each report template should be createable", then "skip questions and start", "make it fast").** Spec `docs/superpowers/specs/2026-11-02-widget-report-templates-design.md` (§15 = the controller's calls), plan `docs/superpowers/plans/2026-11-02-widget-report-templates.md`, every ruling in `.superpowers/sdd/2026-11-02-widget-report-templates/progress.md`, screens `docs/superpowers/concepts/2026-11-02-widget-reports/built-*.png`. Commits `97ed4d78` (shared) · `26107a97` `cdc4f9ec` (api) · `81e68924` (lib) · `8bcda03c` `c206b12d` `39797eb1` (widgets) · `471db4fc` `abdcd7d3` (config page) · `5d421649` (CSP) · fix wave `1a14ea59` `7358f093`. **Pushed and DEPLOYED to AWS `ea7dee92` on 2026-11-03** (migration `20261102150000_report_templates` applied).
  - **The download (R1).** Every `WidgetPanel` on `/` and `/dashboards/:id` has a Download report icon, shown when the viewer's role has PDF on the new Export Options surface `dashboard-widgets` (fails open like the others). It opens the existing `ReportDownloadDialog` (a new `extra` slot carries the "Template: <name> (profile)" lines, a per-profile picker when a profile has several, and a SUPER_ADMIN link to the editor) with kind **`widget:<type>`** — 14 new `REPORT_KINDS` entries built by `flatMap` over `WIDGET_TYPES` (8 → **22**), each Direct or Request in Configuration → Report Settings → Report Downloads, audit `reportType` `Widget: <label>` (`widgetReportType`; `WIDGET_TYPE_SPECS[t].label` is new and is the Add-widget picker's wording). **Every widget kind ships as Request + remarks + password** (the existing kinds' default) until a SUPER_ADMIN sets it to Direct. Everything then goes through `deliverReport` unchanged. `showPeriod` only for types whose spec `followsWindow`; present-time widgets print `period` "Latest".
  - **What it prints.** The widget's OWN data, fetched again at confirm through the widget's own hooks for the dialog's period (`widget-report-data.ts`, one pure `rowsFor<Type>` per type, fixtures-tested); a `WidgetChartRegistry` carries what the widget body is SHOWING (range / zoom, the alarm table's filters, the floor plan's SVG) — never chart instances: ECharts here is SVG-rendered and jsPDF cannot take SVG, so charts are re-drawn as PNG through `lib/svg-raster.ts` (the trend chart via the existing `renderChartToPng`) with a key under the picture. Resolve is capped at 200 instrument ids (the telemetry-overview cap). **THE ROW-GRAIN CONTRACT** (Task 1's report; the doc comment on `WIDGET_REPORT_FIELDS`): the built-ins of reading widgets are LONG — one row per key per instrument — so a built-in prints any profile without knowing its keys; a template that SHOWS `key:<name>` columns gets the wide form, one row per instrument (`keyRowsCollapse`; rows name their instrument in `#group`). Pie chart, alarm counts, floor plan and an all-instruments bar print ONE section with the first profile's template (ruling R5). A text card prints its text as a paragraph; a floor plan its drawing. A column with no `decimals` prints the text the widget shows (`formatKeyValue` / the server's `display`), never a raw float.
  - **Templates (R2, R3).** Table `report_templates` (model `ReportTemplate`, 39 → **40**; migration `20261102150000_report_templates`, hand-authored, both DBs, drift empty; FK → profile ON DELETE CASCADE; `widget_type` a validated string = `WIDGET_TYPES`, no enum; unique `(profile_id, widget_type, lower(name))` by a hand-written index Prisma cannot express; exactly one default per profile × type, set in one transaction). The DOCUMENT (`reportTemplateDocumentSchema`, version 1, `packages/shared/src/types/report-templates.ts`, 39 → **40** type files): header (title / subtitle with placeholders `{dashboard} {widget} {profile} {from} {to} {period} {date} {user} {instrumentCount} {selection}`, company / app name overrides, logo Branding | Upload (a png/jpeg data URL ≤ 1,000,000 characters ≈ 730 KB, format judged by `reportLogoFormat` from the bytes) | None, accent colour), info rows, columns (`id` from the field catalogue, heading, show, decimals, unit), footer (text, page numbers, Printed By / At, signature line), page (orientation, typography), notes. `coerceReportTemplateDocument` is the ONE forgiving reader (a bad stored document → the built-in). API module `report-templates` (26 → **27**; registered in `app.ts` AND `test-helper.ts`): `GET /` (list), `GET /:id`, `GET /catalogue?profileId&widgetType` (built-in fields ∪ `key:<k>` from the profile's measurements + telemetry displayKeys ∪ `attr:<k>` from its attributeKeys — `perKey` / `unit` / `measured` DECLARED, the tenth Fastify-strip lesson), `GET /resolve?widgetType&instrumentIds` (sections per profile in instrument order; ids out of view dropped), `POST` / `PUT /:id` / `DELETE /:id` / `PUT /:id/default` — SUPER_ADMIN by ROLE in `preValidation` (403 `REPORT_TEMPLATES_SUPER_ADMIN_ONLY`), re-auth **`UPDATE_REPORT_TEMPLATE`** (`Reports` category, ships OFF; 57 → **58**), audit `REPORT_TEMPLATE_CREATED` / `UPDATED` / `DELETED` with the whole document (102 → **105** / 115 → **118**, `Data & Approvals` category); a profile DELETE audits each template the cascade removes. 409 `TEMPLATE_NAME_IN_USE`; profiles are not visibility-scoped anywhere, so an unknown profile is 404 `PROFILE_NOT_FOUND`.
  - **Which template a download uses (R4).** The widget's instruments grouped by profile (server `resolve`); each profile's DEFAULT template, else the built-in; one report, one section per profile (a "Profile: <name>" title when more than one), the chrome (header, logo, footer, page) from the FIRST section's template. A column id the profile no longer has prints empty cells and ONE "Not available for this profile: …" line — never dropped, never invented.
  - **Snapshot v3 freezes the chrome** (`pdf-report.ts`): a report drawn from a template records `chrome {companyName, appName, showAppName, logoDataUrl, accentColor, footer, orientation}` and `renderSnapshotToPdf` draws from it with NO branding fetch (mutation-checked), so an approved widget report cannot change under its signatures. **Ruling T3-1 is CLOSED (2026-11-03): every page report now writes v3 too** (see PAGE REPORTS ON TEMPLATES below); v2 snapshots written before that stay readable and still re-read Branding on replay. jsPDF 4.2.1 already detects PNG vs JPEG from the bytes — the spec's "logo always JPEG" bug was never real; `imageFormatOf` just says what it draws.
  - **Configuration → Report Templates** (`/config/report-templates`, 23 → **24** config pages, 56 → **57** routes; a SUPER_ADMIN card; a "Report templates →" link on Instrument Attributes' profile picker): profile picker, the 14 types as tabs, each tab the profile's templates (Default star, Edit / Duplicate / Set as default / Delete, "+ New template" from the built-in; the line says when downloads fall back to the built-in), the editor (placeholder picker inserts at the caret; columns from the catalogue with Show / heading / decimals / unit and up-down ordering; the profile's other fields offered switched off; pie chart and alarm counts offer only their own fields — their rows never fill `key:` / `attr:`) beside a LIVE preview that is the real `buildWidgetReport` over sample rows in an `<iframe>` blob URL — which the helmet CSP refused until `frameSrc: ["'self'", 'blob:']` (`app.ts`; Vite dev has no CSP, so only a prod build showed it). Every write under `reauth.execute('UPDATE_REPORT_TEMPLATE', …)` with all three outcomes.
  - **Whole-branch review (review.md; 1 Critical, 3 Important, 13 Minor — all fixed in `9781ddd6` `16bcda16` `bfdef0b1` `a9036fd5` `4163690f` `6fad9716` except m9, parked).** The rules that came out of it: **a template's `decimals` never re-rounds a value the server or the widget already formatted** — a row value is a STRING when it was formatted (printed verbatim) and a NUMBER only for a raw, unjudged key the widget has no decimals for; the editor offers Decimals only on such raw `key:` fields (C1 — a template could print `25` for a true maximum of 25.4 against NMT 25.0). Footer text placeholders are substituted and frozen (I1). A text card uses its first resolved template (I2). A shown instrument × key whose history request failed is NAMED in the report ("Not read: … — the request failed"), never silently absent (I3). `{user}` is the USERNAME (the DS open point), labelled "Username" (m5). "Page x of N" is forced on every draft and signed copy whatever the footer flag says (m6). Deleting a profile cascades its templates under the profile's own `INSTRUMENT_DELETE` + `DELETE_INSTRUMENT_PROFILE` gate, each template audited with its document (m7, accepted). An alarm table's `{period}` prints "As filtered" (m8). Titles / subtitles are clamped to the request's 500 / 1000 (m11). The helmet CSP's `frameAncestors` is `'self'` (was `'none'`): a blob: document inherits its creator's policy, and an inherited `'none'` refuses the preview's own frame — **verify the preview on the AWS build** (m10). **Parked (m9):** a key outside the profile's measurements / displayKeys can never be a collapsed `key:` column (it still prints in the long form).
  - **Counts moved:** models 40, modules 27, type files 40, reauth 58, audit 105 / 118, config pages 24, routes 57, export surfaces 5, report kinds 22. Unchanged: enums 13, permissions 46, sidebar items 15, tree nodes 56, defs 37, queue tasks 7.
  - **Tests:** shared `report-templates.test.ts`; API `e2e/report-templates.e2e.test.ts` (+ `report-reviews.e2e` re-pinned to every kind, each widget kind fail-closed); web `lib/__tests__/{pdf-report-snapshot,widget-report}.test.ts`, `routes/dashboard/widgets/__tests__/{widget-report-data,widget-report-dialog,widget-panel-download,svg-raster,echart-svg}.test.*`, `routes/config/__tests__/report-templates.test.tsx`. One file per process.
- **PAGE REPORTS ON TEMPLATES — the five page reports (Data Report, Instrument Trend, Instrument Alarms, Alarm Report, Audit Trail) are drawn from the same report templates as the widget reports (2026-11-03; operator: "go ahead with page reports on templates", the standing spec → plan → build rule).** Spec `docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md` (§15 = the controller's calls), plan `docs/superpowers/plans/2026-11-03-page-reports-on-templates.md`, every ruling in `.superpowers/sdd/2026-11-03-page-reports-on-templates/progress.md` (per-task reports `task-N-report.md` beside it), screens `docs/superpowers/concepts/2026-11-03-page-reports/`. Commits `efc19fcf` `05d3bc62` (shared) · `a4333f34` `4f4057f6` (api) · `f16a0761` `09b838b8` `beceb9e9` (web lib) · `2c99c4f4` `a99f3bac` (Report Templates page) · `f60a2474` `fd2e4b16` `907c9ab8` (Alarm Report, Audit Trail) · `7eff0bc6` `aef8a3d1` `d1c257e3` (Data Report, Instrument Trend, Instrument Alarms). **Built, not pushed, not deployed.**
  - **Template kinds and scope.** A template is for a KIND (`TEMPLATE_KINDS`, 19 = the 14 widget types + `PAGE_TEMPLATE_KINDS`): `page:data-report`, `page:trend`, `page:instrument-alarms` (profile scope) and `page:alarms`, `page:audit-trail` (application-wide scope, no profile; `templateKindScope(kind)` decides; each spec also says which profile fields it may print: `'all'`, `'attributes'` or `'none'`). Kinds are validated strings, never an enum, and are APPENDED to, never renamed. Three download points print the ONE Data Report; the two trend charts print the ONE trend template; `TEMPLATE_KIND_SPECS` says which kind supplies which placeholders. `REPORT_PLACEHOLDERS` grew 10 → 27 (`instrument block area location fromDate fromTime toDate toTime interval mkt tempLimit rhLimit extremes recordCount search series level`); each page kind supplies `date`, `user` and `profile` too (review m3: they are advertised on every page kind, so every page MUST pass them).
  - **Table, migration, indexes.** Migration `20261103120000_report_templates_page_kinds`, hand-authored, both databases: `report_templates.widget_type` RENAMED `kind` (rows kept), `profile_id` nullable (NULL = application-wide; the FK stays, so deleting a profile still cascades its own templates and never touches NULL rows). The three unique indexes (`report_templates_scope_kind_name_key`, `…_scope_kind_lower_name_key`, partial `report_templates_one_default`) are on `COALESCE(profile_id, '')` because Postgres treats NULLs as distinct: without it two application templates "Audit" and "audit", or two application defaults, would never collide. The index IS the rule (409 `TEMPLATE_NAME_IN_USE` from P2002, no pre-check). An application default is set under `pg_advisory_xact_lock(hashtext('report_templates:' || kind))`, a profile default under the profile row lock. **Read a stored row's kind through `isTemplateKindValue`**: rows written before 2026-11-03 carried `widgetType` and the rename keeps them.
  - **API rules.** `GET /` takes `profileId` and `kind` (both optional; no `kind` lists every scope). `GET /catalogue` and `GET /resolve` take `kind` (not `widgetType`); `widgetType=` is gone from the wire. A create or update naming a profile on an application kind, or none on a profile kind, is 400 `SCOPE_MISMATCH` (`scopeMismatch`); `resolve` of an application kind takes no `instrumentIds` and answers one section with `profileId: null, profileName: null`. **Read gate (ruling T2-A):** READ routes for an APPLICATION kind (`GET /`, `GET /:id`, `/catalogue`, `/resolve`) need only a signed-in session, because the template exposes no instrument and its chrome is already on every PDF that user can download; profile-kind reads keep `INSTRUMENT_READ`; `GET /` with no `kind` keeps `INSTRUMENT_READ`; `GET /:id` is decided by the STORED row's kind after the row is found (missing row 404, a forbidden profile template 403). A VIEWER-like user resolves `page:audit-trail` 200 and `page:data-report` 403. Writes stay SUPER_ADMIN by role plus `UPDATE_REPORT_TEMPLATE` re-auth. **`COLUMN_NOT_FOR_KIND` (ruling T2-B):** 400, naming the id, for a `key:` column when the kind's `profileFields !== 'all'` and for an `attr:` column or info-row source when it is `'none'` — for EVERY kind including `pie_chart` and `alarm_counts`; a stored template that could only print "Not available" is refused.
  - **Snapshot v3 for every report; v2 stays readable.** All five page reports now record `chrome` (company, app name, logo bytes, accent, footer, orientation) and replay from it with no Branding fetch, so an approved page report cannot change under its signatures. A v2 snapshot replays as before. Logo bytes ride in every snapshot (review C5, deferred: the 8 MB body limit is the ceiling). `buildTemplatedReport` (`lib/templated-report.ts`) is the ONE builder for widget and page kinds; `lib/report-template-plan.ts` (`useReportTemplatePlan`, the URL builders `(kind, profileId | null)`), `components/report-template-lines.tsx` (the "Template: …" lines every dialog shows), `lib/report-header-block.ts` and `lib/report-typography.ts` are shared. `routes/instruments/page-reports.ts` holds `buildDataReport`, `buildTrendReport` and `buildInstrumentAlarmsReport`; the hand-built renderers (`renderTrendReport`, `renderDataReport(s)`, `renderAlarmsReport`) are deleted. **`alarms-report.ts` must not value-import `templated-report.ts`** (import-cycle rule); shared helpers live in `lib/` with re-exports.
  - **The built-in == today's output, pinned.** Each kind's built-in template reproduces what the page printed before the change, byte for byte, against fixtures captured from the OLD renderers before anything moved (`routes/instruments/__tests__/page-reports-builtin.test.ts` and the alarm and audit fixtures under `routes/{alarms,audit}/__tests__/fixtures/`, commit `f60a2474`). **Two documented differences only.** P-2: the built-in Audit Trail subtitle prints `Search: —` when there is no search, where it used to omit the segment (`substitutePlaceholders` is unchanged: an empty value still prints `—`, widget reports depend on it). T4-1: an Instrument Alarms report with NO alarms prints the builder's "No records." row where it used to print a bare header. The Alarm Report's own empty-period row ("No alarms in the selected period", `-` elsewhere) IS reproduced (T5-1, `recordCount` = all rows). The Data Report's legend and cover block come through the builder's structured `input.legend` and `infoBlockRows` (P-1: the built-ins carry NO `notes.legend`; a saved template's own `notes.legend` replaces the structured one).
  - **The Alarm Report's two built-in-only rules.** With NO saved template the report keeps today's level rule (`EXTRA_COLUMNS[level]` adds the Instrument-level columns) and drops a limit column no row fills (`hiddenLimitColumns`); `builtinAlarmColumns(level, rows)` only toggles `show` on the shared ten columns (placement first, ruling T1-F: `PAGE_REPORT_FIELDS['page:alarms']` lists today's printed order). A SAVED template prints exactly the columns it shows, including an all-empty limit column (the empty cell prints blank), and a stored document that does not parse prints the built-in WHOLE through `coerceReportTemplateDocument` (still counted as a saved template: no level rule, no widths).
  - **An intentionally empty cell stays empty (T3-E).** On a PAGE kind `printTable` prints a cell that is exactly `''` as `''` (the switched-off limit box, operator 2026-09-07); `null`, absent and whitespace print `—`; widget kinds are unchanged. Together with T3-B (`TemplatedSection.notes[].style 'title'` for the 2,000-row cap notice, image `dataUrl` / `missingText` so a missing chart prints its title and a muted note) and R-1..R-4 (page kinds' info rows are the ruled header block through `scopeTableRows` / `scopeColumnStyles`; the Data Report's spanning block is `infoBlockRows`, built-in only; the bold grid is indexed by built-in field order and re-indexed to the shown columns; `leadImages`).
  - **Attributes are fetched per instrument (T3-A), and ONLY when its template prints one (final fix wave).** A page report prints `attr:<key>` cells and info rows from `TemplatedSection.attributes` (`attr:<key>` → the instrument's value), filled from `GET /api/instruments/:id/attributes` — asked only for an instrument whose template shows an `attr:` column or has an `attr:` info row (`templateNamesAttributes` in `page-reports.ts`), so a BUILT-IN report makes no attributes request at all. The Data Report page reads it beside each instrument's readings (concurrency 4); the trend page in PARALLEL with the report's own read (`Promise.all`), never before it. At most one GET per printed instrument; a batch route is the follow-up if it bites. The catalogue is asked for every kind whose `profileFields !== 'none'`.
  - **A failed or still-loading template plan REFUSES the download (R5-6).** The widget dialog's rule now holds for all five page reports: the dialog's template line says why and Confirm does not print (Excel is unaffected). An instrument a LOADED plan leaves out (`/resolve` dropped it) gets its own line naming it before Confirm — "No instrument profile resolved for <code> — the report will be refused" (`planLeavesOut` returns the codes; `ReportTemplateLines` `leftOut`) — never "could not be loaded" about a plan that loaded. Cost: a download blocked until the templates route answers.
  - **Every page PDF depends on the templates routes answering.** The Data Report, Instrument Trend, Instrument Alarms, Alarm Report and Audit Trail PDFs need `GET /api/report-templates/resolve`, and (through the dialog's plan) the list and the catalogue, to answer: a failure or a plan still loading refuses the download (Excel is unaffected). A templates-route outage is therefore a page-PDF outage.
  - **What a Data Report's title can name (final fix wave, review Important 1).** The report-level values (title, subtitle, footer) carry every placeholder whose value is IDENTICAL across all its instruments (`sharedValues`): an Area-wise download's "Data Report {area}" prints the Area; a value that differs between instruments (`{instrument}`, `{location}`, a limit, an MKT only one has) prints `—`. One instrument: everything carries. Each section's own header still names ITS instrument.
  - **An empty period under a SAVED template says so — once (final fix wave, review Important 2).** The empty row carries "No readings in the selected period" in its TEMPERATURE cell. Under a saved template that does NOT print that column (hidden, or not in the profile's catalogue so the cell prints empty) an empty period adds that sentence as a muted note after the table instead (`DATA_REPORT_EMPTY_TEXT`, one wording); a saved template that prints it gets no note (no duplicate statement). The built-in prints exactly what it did (fixture pin).
  - **Ruling F-1: a fresh report freezes the CONFIGURED chrome or nothing.** `lib/pdf-report.ts`: when a chrome is resolved for a report being made (`defaultReportChrome` / `loadReportChrome`, frozen into the v3 snapshot), a failed read of Branding (`GET /api/config/branding`, failed or answering an error), of Configuration → Report Page Titles, or of the Branding LOGO (the request failing, an error status, unreadable bytes) THROWS (`REPORT_BRANDING_UNREADABLE` / `REPORT_TITLES_UNREADABLE`) and the dialog shows it — a signed record never freezes the shipped default name, Branding's name in place of the override, or "no logo" by accident. Only the v2 REPLAY (`renderSnapshotToPdf` of a snapshot with no chrome) keeps every old fallback (shipped names, Branding's names, no logo), so an old record still opens. A template naming both its company and app name reads no names; a `custom` / `none` logo reads no logo — nothing to fail. **An UPLOADED Branding logo is a `data:` URL (Configuration → Branding stores the file as one) and is used AS IS, checked to be a PNG or JPEG by its bytes, and NEVER fetched**: the CSP's `connect-src 'self'` refuses a `data:` fetch on every Fastify-served install, which under this ruling would have refused every report wherever a logo was uploaded (re-review, 2026-11-03). Only a path (`/logo.jpg`, the bundled default) is fetched. A logo that cannot be used refuses with `REPORT_LOGO_UNUSABLE` plus what failed (not PNG/JPEG, could not be requested, answered HTTP n, could not be read) and "Check the logo in Configuration → Branding." — no retry advice. The logo is still cached per page load once read. Cost: a transient Branding or config-route failure refuses a download until retried; the Configuration preview shows the same refusal. Tests that build a fresh report answer Branding through `test-support/branding-stub.ts` (`brandingFetch` / `stubBrandingFetch`); the alarm and audit fixture tests compare the chrome less the logo's bytes (captured as `null` while the logo request failed) and pin the logo on its own.
  - **One title clamp for every request.** `lib/report-delivery.ts` `deliveredTitles` (with `clampText`, `REQUEST_TITLE_MAX` 500, `REQUEST_SUBTITLE_MAX` 1000) is used by the widget dialog, the three instrument reports, the Alarm Report and the Audit Trail: a long `{search}` / `{profile}` / `{selection}` is cut with an ellipsis on the request, never a bare 400; the PDF prints it whole.
  - **The preview's end block is the PDF's.** Configuration → Report Templates' preview passes the kind's STRUCTURED legend as the download does (`sampleLegend`: the Data Report's `dataReportLegend` over the sample limits and MKT, the Alarm Report's `ALARM_REPORT_LEGEND`, none for the other kinds); a template's own `notes.legend` still replaces it (P-1).
  - **Deploy: API and web TOGETHER, then every user reloads.** The API takes `kind=` only; an old PWA bundle still sends `widgetType=` and gets 400 from `/api/report-templates/resolve`, so its widget downloads refuse ("templates could not be loaded") until the page is reloaded.
  - **Rollback recipe.** Redeploying `ea7dee92` alone does not work: its routes read `widget_type` and know no page kind or NULL profile. To reverse the migration: `DELETE FROM report_templates WHERE profile_id IS NULL;` (and, beyond the review's recipe, `… WHERE kind LIKE 'page:%'` — `ea7dee92`'s `GET /` lists every row and knows no page kind; not exercised), `ALTER TABLE report_templates RENAME COLUMN kind TO widget_type;`, `ALTER TABLE report_templates ALTER COLUMN profile_id SET NOT NULL;`, drop `report_templates_scope_kind_name_key`, `report_templates_scope_kind_lower_name_key` and `report_templates_one_default`, recreate the three 2026-11-02 ones (`report_templates_profile_id_widget_type_name_key` on `(profile_id, widget_type, name)`, `report_templates_profile_type_lower_name_key` on `(profile_id, widget_type, lower(name))`, `report_templates_one_default` on `(profile_id, widget_type) WHERE is_default`), and delete the `20261103120000_report_templates_page_kinds` row from `_prisma_migrations`. Saved page templates are lost by it.
  - **The editor offers no columns on a fieldless kind (T3-C).** `REPORT_TEMPLATE_FIELDS(kind).length === 0` (a kind whose only profile fields feed info rows) shows no columns section, and the builder ALSO prints one muted note "This report has no table; columns not printed: <headings>" if such a document shows a column. Configuration → Report Templates (`routes/config/report-templates.tsx`): a tab per kind with a file icon on the five page tabs, an application scope with no profile picker for `page:alarms` / `page:audit-trail`, live previews with sample rows (page previews pass sample attributes, widget previews do not: review m4). `?kind=` is read; an old link's `?widgetType=` still selects the tab and is dropped on the next write. Instrument Attributes' "Report templates →" link opens `kind=value_cards`.
  - **Deferred or parked (all from the ledger, none blocks):** review minors m1 (shared arrays assigned by reference in `TEMPLATE_KIND_SPECS`), m2 (a redundant typeof guard), `PAGE_REPORT_KEYS` copied into the preview, DATE / TIME sample columns chosen by id suffix, `kindFromParams` exported from a component file (react-refresh), sample LOW LIMIT above HIGH LIMIT, a stale `profileId` in the URL falling back silently, a `before` title note followed by a picture printing as a pill above it, the tautological `version: 3` assertion (alarms page), the plan wiring and refusal strings duplicated across the two pages (a lib helper), `{search}` trimmed on Alarms but not Audit, and 84 pre-existing type errors in other API test files that no gate compiles. (The final fix wave deleted the orphan helpers `AlarmReportScope`, `instrumentAlarmsHeaderPairs`, `periodPairs`, the unread `ScopedInstrument.profileId` and the test-only `DATA_REPORT_TITLE` / `DATA_REPORT_HEAD`, and pinned the refusal messages exactly. `ChartImage.width/height` were KEPT: not dead — the widget trend chart's report reads them through `pictureWithLegend`; the PDF sizes every picture from its bytes, pinned with a square PNG declared 1800 x 520.) The whole-branch review and the gate run after this note; the final fix wave amends it if they change a rule above.
  - **Before deploying:** read AWS `report_templates` over SSM (expected 0 rows) and confirm the migration applies on both databases (`npm run db:verify-migrations`). Counts: models 40, enums 13, modules 27, permissions 46, reauth 58, defs 37, config pages 24, routes 57, shared type files 40, report kinds 22 are unchanged; migrations 53 → 54; template kinds 19; placeholders 10 → 27.
  - **Tests:** shared `__tests__/{page-template-kinds,report-templates}.test.ts`; API `e2e/report-templates.e2e.test.ts` (kind, scope, read gate, `COLUMN_NOT_FOR_KIND`); web `lib/__tests__/{templated-report,widget-report}.test.ts`, `routes/instruments/__tests__/page-reports-builtin.test.ts`, the Alarm Report and Audit Trail fixture tests, `routes/config/__tests__/report-templates.test.tsx`. One web file per process.
- **TCP/IP INSTRUMENTS — the application reads a Modbus TCP device itself (Parts 1–2, built 2026-10-31 .. 2026-11-02; operator: "if user selected TCP/IP then in the instrument creation tcp/ip need to integrate, for one instrument one ip address and port", "register map should be inside of instrument", "go with all recommendations").** Spec `docs/superpowers/specs/2026-10-31-tcpip-instruments-design.md`, plan `docs/superpowers/plans/2026-10-31-tcpip-instruments-parts-1-2.md`, every build ruling in `.superpowers/sdd/2026-10-31-tcpip-instruments-parts-1-2/progress.md`, concept PDF + built screens `docs/superpowers/concepts/2026-10-31-tcpip-instruments/`. It replaces the untracked `TCPIP/` desktop tool (never open, run or commit it — its JSON holds 101-01's token in plain text). **Parts 1–2 deployed to AWS `20bff73` on 2026-11-02 (TCP/IP Reading OFF there). Read every and the unit ID moved from the profile to each instrument in CR-1 (last bullet) — where a bullet below puts them on the profile, CR-1 wins.**
  - **Vocabulary.** A profile's `connection` is `'PUSH'` (screen: **Gateway** — today's process, the default for every existing profile) or `'MODBUS_TCP'` (screen: **TCP/IP (Modbus)**) — validated strings (`MODBUS_CONNECTIONS`), no Postgres enum; `'PUSH'` because "gateway" already means an RS485 gateway instrument. **Register map** = an instrument's `modbusRegisters`; **Reader** = `apps/api/src/modules/modbus/reader.ts`; **Test connection** = `POST /api/instruments/modbus/test`. Every instrument payload carries the profile's `connection`, so a page never derives it.
  - **Profile (Part 1; interval and unit ID moved to the instrument by CR-1).** A TCP/IP profile holds `modbusIntervalSec` (**60** default, 10..3600) and `modbusUnitId` (**1** default, 0..255), both NULL on a Gateway profile (`MODBUS_INTERVAL` / `MODBUS_UNIT_ID`). It holds no keys. `connection` changes only while the profile has **no instruments** (409 `PROFILE_HAS_INSTRUMENTS`; the profile PUT locks the profile row `FOR UPDATE`, an instrument create takes it `FOR SHARE`, so the count cannot race). A TCP/IP profile cannot require device certificates (400 `NOT_FOR_TCPIP`, both directions). Interval and unit ID are edited on Configuration → Instrument Attributes ("TCP/IP reading", `UPDATE_INSTRUMENT_PROFILE` re-auth, no reason asked). The New Profile form preselects Gateway; cards carry a GATEWAY / TCP/IP chip.
  - **Instrument (Part 1).** `modbusHost` (IPv4 dotted quad only — no hostnames), `modbusPort` (1..65535, form default 502), `modbusRegisters` (≤ 100 keys; `[]` allowed = not read). **One device per host:port** is the partial unique index `instruments_modbus_address_key` (`WHERE modbus_host IS NOT NULL`), not a pre-check: 409 `ADDRESS_IN_USE` names the holder when the caller can see it, else "already in use". An address outside the administered device networks, or ever in `0.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16` or `224.0.0.0/4` and above, is 400 `ADDRESS_NOT_ALLOWED` — on create, update, bulk, Test connection and before every read. A TCP/IP instrument is never a gateway nor behind one (400 `NOT_FOR_TCPIP`); a host / port / map on a Gateway profile's instrument is 400 `NOT_A_TCPIP_PROFILE` (ruling T4-0 named both); **no credential is created and the 201 has no `token`**; the three token routes answer 400 `NO_TOKEN_FOR_TCPIP`; a PUT changing host, port or map on an existing instrument needs `reason` (400 `REASON_REQUIRED`); **changing a stored map is SUPER_ADMIN only** (403 `REGISTER_MAP_SA_ONLY` — a map edit can stop an instrument being judged or shift every stored value); moving between a Gateway and a TCP/IP profile is 409 `CONNECTION_DIFFERS`. All three fields are in `audited()`, so `INSTRUMENT_CREATED` / `UPDATED` carry before / after; `reason` is not an audited field.
  - **The register map's rules are ONE shared schema** (`modbusRegisterMapSchema`, `packages/shared/src/types/modbus.ts`), which gives the form its messages and the server its refusals. Key 1..64 characters trimmed, unique ignoring case, not a payload meta key (`PAYLOAD_META_KEYS` = `ts`, `timestamp`, `quality`, `devices` — the parser imports the same set, ruling **P2**) and not `dev<digits>`. Register = a 1-based Modicon reference, 5 or 6 digits, prefix `3` (input, FC 04) or `4` (holding, FC 03), number 1..65536 (`40001` → address 0; `parseModiconRef`); the Area is DERIVED and shown, never entered. Types `UINT16 | INT16 | UINT32 | INT32 | FLOAT32`; byte order `ABCD | BADC | CDAB | DCBA` required for 32-bit, absent for 16-bit; a 32-bit key occupies n and n+1 in the same area; no two keys share a register; `scale` finite, non-zero, default 1. Read through `coerceModbusRegisterMap` only. The desktop tool's keys file is converted by `fromDesktopKeysFile`, all or nothing, naming the row it refuses (coil / discrete references, an unknown type, a missing 32-bit byte order, a duplicate).
  - **The protocol** lives in `apps/api/src/modules/modbus/protocol/` (client, planner, decoder; imports only `node:net` and `@digilog/shared`) — ruling **P1**: the spec's `packages/modbus` is created in Part 3 by moving these files unchanged, so Parts 1–2 add NO workspace (installer, `.deb` and AWS build untouched). Hand-written MBAP, FC 03 / 04 only, no writes, no coils; ≤ 125 registers per request; connect timeout 3 s, response 1 s, one TCP connection per read. Decode: FLOAT32 rounded to 7 significant digits, a scaled integer to the decimals of `scale` (2301 × 0.1 = 230.1), an unscaled integer stays an integer; a NaN / ±Inf FLOAT32 is not stored and is dead-lettered with its raw words. Failure words (exact, the server's): `NO_ANSWER` "{host} : {port} did not answer within 3 s — check the IP, the cable, and that the device is on."; `REFUSED` "{host} refused port {port} — the device is reachable but not listening on that port."; `DEVICE_EXCEPTION` "The device refused registers {range} (exception {n}, {name}) — the register map does not match it."; **`BAD_RESPONSE` has TWO sentences (ruling T2-1)** — a timeout says "… accepted the connection but did not answer the read within 1 s.", a reply with the wrong transaction, unit, function code or length says "… answered, but the reply did not match the request (wrong transaction, unit, function code or length) — check the unit ID and the register map." (the spec's one sentence was false for the second case and would have put a false cause into a §11 audit row).
  - **Configuration → TCP/IP Reading** (def `modbus-reader`, SUPER_ADMIN card, dynamic page): **"Read devices from this server" ships OFF** and while OFF the server opens NO Modbus connection — no reads, and Test connection answers `READING_OFF` "Reading devices from this server is off (Configuration → TCP/IP Reading)." **Device networks** (CIDRs, comma or newline) default `10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16`; a plant narrows it to its device subnets and narrowing stops reads at the next read. The zod schema requires both keys (the dynamic PUT replaces the row; a body without `deviceNetworks` would silently re-widen it). A plant install turns reading on once; **an AWS install leaves it off**, so a cloud server cannot be made to connect into its own network. Local: OFF on `compliance_core_db` and `_test` (2026-11-02).
  - **Test connection (Part 1; CR-1: body + `modbusUnitId`, 30 per minute).** `POST /api/instruments/modbus/test` `{profileId, modbusHost, modbusPort, modbusRegisters, instrumentId?}`: `INSTRUMENT_CREATE` or `INSTRUMENT_UPDATE`, no re-auth, **10 per minute per user**, stores nothing, audits nothing. Order: profile must be TCP/IP (400 `NOT_A_TCPIP_PROFILE`), map through the shared schema (400), `instrumentId` must be in view (404), the address rules (`ADDRESS_NOT_ALLOWED` = 400; **`ADDRESS_IN_USE` = 200 `ok:false`**, unlike create's 409, so the form can say it before Save), then the OFF switch (200 `READING_OFF`), then one read. Answer `{ok:true, elapsedMs, requests, values:[{key, value, judgedAs}], rejected:[{key, reason}]}` or `{ok:false, code, message}`. `judgedAs` is the server's `resolvedSlotFor` over the map's keys for that profile — when two keys fold to one measurement, only the one actually judged is marked; the form shows it after a test and "—" before ("Not judged" for `null`), never a browser guess. A result is dropped as soon as the draft it was read with changes.
  - **The Reader (Part 2)**, started in `app.ts` after the MQTT bridge whatever the switch (it reads the switch at every reload and before every read, so turning it on needs no restart), stopped in `shutdown()` before `app.close()`; never started by the e2e app (tests drive `readOnce`). A 1 s tick; every **5 s** it asks whether its inputs changed and rebuilds the schedule only then. Each instrument is read every `modbusIntervalSec` of its profile at a stable phase (FNV-1a of its id) so a hundred devices are not read in one second; at most **16 reads in flight** and **1 per host:port**; an instrument whose previous read is still running skips that slot; one blocked by a cap waits. A device that is "not answering" is tried only every `max(interval, 60 s)` (`FAILING_RETRY_SEC`) until a read is stored, then goes back to its own slot (final review F-5) — about 54 dead devices at the 10 s minimum would otherwise hold all 16 slots for their 3 s connect timeouts. `readOnce` re-reads the instrument, profile and switch from the database before EVERY read (`readTarget`, the one rule — also what the status route explains): reading off, not a TCP/IP profile, instrument or profile disabled, no address, no map, an address outside the networks, or a stored value no route could have written (`INVALID_CONFIG`, logged) — and then no socket is opened. A read builds a prototype-less `{key: value, …, ts: <read start>}` and calls **`ingestPayload` with `transport 'modbus'` and `lastSeenVia 'polled'`** (identity: never a gateway, `deviceCert.required false`) — the ONLY change to the ingest core is that optional argument, so offsets, limits, alarms, history, dashboards and reports needed no change. Decoder refusals are **ONE dead letter per read** listing every refused key (ruling T9-2; one per key at the 10 s minimum would be ~8,640 rows a day per dead probe). `stop()` aborts in-flight reads and a read that finishes after it writes nothing; switching reading OFF empties the schedule at the next reload but lets a read in flight finish and be stored.
  - **"Not answering" is debounced and audited once per transition.** Model `ModbusPollStatus` (`modbus_poll_status`, one row per instrument, operational state, not a §11 record): `lastAttemptAt`, `lastSuccessAt`, `failingSince`, `consecutiveFailures`, `lastErrorCode/Message/At`, `readBy` ('server') and **`failureRunStartedAt`** — a column the spec did not list (ruling T9-0): it holds the first failure of the current run from the run's first miss, so `failingSince` is still right after a restart mid-run. The **third** consecutive failed read sets `failingSince` to it and writes the SYSTEM row `MODBUS_DEVICE_NOT_ANSWERING` "{code}: {host}:{port} stopped answering — {reason}"; the first success after that clears it and writes `MODBUS_DEVICE_ANSWERING` "{code}: answering again after {missed} missed reads, {from}–{to}" (`to` = the read that answered); each in the same transaction as the status change. One or two misses write nothing. **A storage failure is not a device failure (ruling T9-1; final review F-4 overturned T9-3)** — when the device answered but `ingestPayload` could not store it, the attempt and error go on the status row and the error log and no row is written ("stopped answering" would be false about a device that answered); it never advances the run, and while the device is not yet "not answering" it RESETS it (miss · miss · storage failure · miss is no transition); once `failingSince` is set only a stored read ends that. Both actions are in `SYSTEM_AUDIT_ACTIONS` and substituted in `apps/web/src/routes/audit/audit-helpers.ts`.
  - **No new alarm source — a silent device is the INACTIVITY alarm.** A failed read stores nothing, so `lastSeenAt` stops moving and the Inactivity pass raises it. That def ships OFF (ON locally, grace 1 min); **check it on AWS at deploy**. While it is off, the status route returns `inactivityAlarmsOff: true` and the card says "No alarm is raised when this device stops answering — Inactivity Alarms are off (Configuration → Inactivity Alarms)."
  - **"Reporting" follows the read interval** (ruling **P3**): `effectiveExpectedIntervalSec(instrument, profile)` beside `isInstrumentReporting` in `@digilog/shared` = the instrument's own `expectedIntervalSec`, else the TCP/IP profile's `modbusIntervalSec`, else null — used by every server caller (`buildTelemetryOverview`, the activity summary, the functional-location counts; the inactivity pass reads the overview row's `reporting` and freezes the effective interval in its snapshot), pinned by `lib/__tests__/reporting-resolver-callers.test.ts`. Without it a silent TCP/IP instrument read "reporting" for a day. **Ruling T8-1:** the instrument list / detail / create / update payloads carry the server's `reporting` and `effectiveExpectedIntervalSec` (declared), and the Instruments list, the instrument page and Settings print them — no web file calls `isInstrumentReporting` (the same test pins it).
  - **`GET /api/instruments/:id/modbus-status`** (`INSTRUMENT_READ`, out of view = 404, a Gateway instrument = 400 `NOT_A_TCPIP_INSTRUMENT`, a name the brief left open) → `{state, notReadReason?, notReadDetail?, readBy, intervalSec, lastSuccessAt, failingSince, lastError?, stored24h, expected24h, inactivityAlarmsOff}`. `state` is `not-read` whenever the Reader's own `readTarget` would not read it, else `failing` iff `failingSince` is set, else `reading` (final review F-2: the Reader clears `failingSince` only on a stored read, so a device disabled or no longer asked kept a stale one and read "Not answering"; `failingSince` is still returned and the card prints "Not answering since" only while `failing`); `notReadReason` is that rule's code — the spec's four (`SERVER_READING_OFF`, `INSTRUMENT_DISABLED`, `NO_REGISTER_MAP`, `NO_ADDRESS`) plus `PROFILE_DISABLED`, `ADDRESS_NOT_ALLOWED`, `INVALID_CONFIG` — with `notReadDetail`, the Reader's sentence, printed verbatim. `lastError` is reported whatever its cause (a storage error included). `stored24h` = distinct reading instants in 24 h; `expected24h` = ⌊86400 / interval⌋. Polled every 15 s; a failed request shows "Could not load the connection status.", the server's message and Try again (F-8).
  - **Screens (CR-1 changed the profile, New Instrument, instrument page and map editor — last bullet).** New Profile: Connection Gateway | TCP/IP (Modbus), with TCP/IP "Read every" (10 s .. 60 min presets) and "Unit ID". New Instrument (TCP/IP profile): Is Gateway / Reports through gateway hidden; TCP/IP connection (IP address, Port 502, the profile's interval and unit ID); Register map (Key, Register, Area, Data type, Byte order [32-bit], Scale, Judged as; + Add key; **Copy from instrument…** — `GET /api/instruments?connection=MODBUS_TCP` then `GET /:id`, ruling **P4**; **Import keys file**; both replace the map after a confirm); Test connection; no token dialog. Instrument page (TCP/IP): a **TCP/IP connection** card (state badge, address, "This server, every N s", "stored N of M in 24 h", last answered, not answering since, the last failure as the server worded it, the Inactivity sentence, Edit address with a reason, Test connection) in place of Access token / Device certificate / Connection; the **Register map** card FULL WIDTH after the two-column grid (read-only; Edit for a SUPER_ADMIN, with a reason). Bulk upload (TCP/IP profile): headings **"IP address"** and **"Port"** (port default 502), an optional per-upload **"Copy register map from"** (a TCP/IP instrument in view, applied to CREATED rows only); an existing row's blank keeps, a changed address needs the upload's one remark; the same address twice in one file refuses every such row; preview and upload plan alike. Status colour only where it means status: the state badge, the Test-connection pill, the amber Inactivity-off warning.
  - **Render check (2026-11-02, built stylesheet, Inter inlined, headless Chrome at 1240 px with the 256 px sidebar; `built-*.png` in the concept folder)** found two faults, both fixed: the Data type select squeezed to "FLOAT3" on New Instrument (the widths sat on table CELLS, which Chrome ignores; now on the controls — `42bf00c8`), and on the instrument page the seven-column map in the half-width column hid Byte order, Scale and Judged as (now full width — `6271a889`). Longest key checked: a 41-character key prints whole in the Test-connection values and the read-only map; in the editable Key input about 29 characters show at this width and the rest scroll inside the input (its own behaviour). `192.168.100.200 : 502` fits everywhere.
  - **Security.** Modbus TCP has no authentication and no encryption; the application only READS (FC 03 / 04) and never writes to a device; segmentation of the plant network is the customer's. No device secret exists for a TCP/IP instrument — issuing it a device certificate is refused 400 `NOT_FOR_TCPIP` (final review F-3; revoke still works). The server connects only with the switch ON, only inside the device networks, never to loopback / link-local (cloud metadata) / multicast / broadcast; Test connection is rate-limited and needs instrument create / update rights. The e2e app alone passes `allowLoopbackForTests` (ruling P-1) so a test can read its in-process fake slave on 127.0.0.1; `app.ts` never sets it and nothing reads it from the environment.
  - **Part 3 (not built):** a Plant Reader service on a plant PC for a server in AWS (outbound HTTPS, a reader key, `packages/modbus`, Configuration → Plant Readers). **Readings a Plant Reader delivers late will be stored and drawn but NOT judged** — limit alarms evaluate the latest value, so an excursion during an outage raises no alarm when it arrives; the outage itself raises the Inactivity alarm. Accepted for Part 3 (spec §11.6); judging late readings is a separate alarm-pipeline change (spec §15 Q3).
  - **101-01 (spec §15 Q1, answered):** register it FRESH as a TCP/IP instrument once Part 2 is deployed and reading is on; no profile move is built (`CONNECTION_DIFFERS`). The operator withdraws 101-01's old token and disables the old 101-01 (its readings are the desktop tool's simulator data). Production writes on AWS are the operator's.
  - **Counts moved:** models 38 → **39** (`ModbusPollStatus`; enums 13 unchanged), API modules 25 → **26** (`modbus`), audit actions 100 → **102** and templates 113 → **115** (7 categories), config defs 36 → **37** (`modbus-reader.def.ts`), shared type files 38 → **39** (`types/modbus.ts`). Unchanged: routes 56, config pages 23, reauth actions 57, sidebar items 15, queue tasks 7 (the Reader is in-process, not a graphile task), workspaces. Migrations `20261031120000_tcpip_instruments` and `20261031130000_modbus_poll_status` (hand-authored, both databases; drift guard run as plain commands 2026-11-02: empty diff against both).
  - **Final review fixes (2026-11-02; `final-review.md`, rulings F-1 … F-10; commits `87b157a2..11ab0e21`).** **F-1** a bulk upload that moves an EXISTING TCP/IP instrument's address takes the configurable `UPDATE_INSTRUMENT` re-auth, as `PUT /:id` does — only when the role's policy asks; the password sent for `CREATE_INSTRUMENT` is reused, so one upload asks once. **F-2** the status route: `not-read` outranks `failing` (above). **F-3** no device certificate is issued to a TCP/IP instrument. **F-4** a storage failure resets a run of misses not yet "not answering" (overturns T9-3). **F-5** a "not answering" device is retried every `max(interval, 60 s)`; `readOnce` returns `failing: true`. **F-6** `readDevice` rejects a unit id outside 0..255 or a port outside 1..65535 at entry — a hand-edited unit 300 threw inside the socket's connect listener, an uncaught exception that ends the process; Test connection refuses a stored bad unit id 400 `INVALID_CONFIG` with the Reader's sentence. **F-7** a device that closes or resets the line after accepting it: "{host} : {port} closed the connection without answering the read." **F-8** the connection card shows a failed status request. **F-9** `GET /eligible-children` offers Gateway-profile instruments only, and a TCP/IP instrument's page neither prints "Gateway" nor offers Is Gateway (both could only end in `NOT_FOR_TCPIP`). `built-detail-failing.png` / `built-detail-not-read.png` re-shot with a coherent polled fixture (header and card agree; not-read = reading OFF over a stale `failingSince`).
  - **Open after the final review (parked by ruling F-parked):** Test connection is outside the Reader's per-host:port lock (a one-connection device can be opened twice); the audit sentence's `{from}`–`{to}` are raw UTC ISO; a backwards clock step stalls reads up to the step; the 10 s last-seen throttle equals the minimum interval; every last-seen stamp moves the Reader's reload signature (a rebuild about every 5 s); the 24 h stored count scans history every 15 s per open page; the card's smaller points ("This server, every N s" while not read, green "Reading" under a persistent storage failure), the input-register hint prefix, full maps in list responses. Bulk: two instruments swapping addresses in one file is refused; an attribute literally named "IP address" / "Port" is shadowed on a TCP/IP profile. "Not judged" vs the concept's "Shown only" — confirm with the operator. For the hand-over: a disabled TCP/IP instrument keeps its address; reading OFF with Inactivity Alarms ON alarms every TCP/IP instrument after the grace.
  - **Tests:** shared `types/__tests__/modbus.test.ts`; API `modules/modbus/protocol/__tests__/{client,decode,plan}.test.ts` (an in-process fake slave, `src/test-support/fake-modbus-slave.ts`), `modules/modbus/__tests__/reader.e2e.test.ts`, `e2e/{tcpip-profiles,tcpip-instruments,modbus-test-connection,tcpip-bulk,instrument-reporting-fields}.e2e.test.ts`, `lib/__tests__/reporting-resolver-callers.test.ts`, plus additions to `instruments.test.ts`, `telemetry-overview`, `instrument-activity-summary`, `alarm-inactivity`, `ingest-core`, `bulk-csv`, `bulk-plan`; web `instruments/__tests__/{profile-connection,register-map-editor,test-connection-panel,create-tcpip,detail-tcpip,bulk-create,reporting-from-server-*}.test.tsx`, `config/__tests__/{index-tcpip-card,instrument-attributes}.test.tsx`, `settings/__tests__/status-of.test.ts` — one file per process.

- **EDIT SETTINGS IS ATTRIBUTES ONLY — `INSTRUMENT_ATTRIBUTE_UPDATE` (2026-10-30; operator: "fix the supervisor instrument ID edit issue").** The OQ walkthrough found a Supervisor — role definition "NMT / NLT switches and limits only" — able to change the Instrument ID on the Settings page and to edit, disable or read the token of an instrument on its page by URL, because the "Edit Settings" toggle granted `INSTRUMENT_UPDATE`, the permission that governs the instrument itself.
  - **The split.** New permission `INSTRUMENT_ATTRIBUTE_UPDATE`; `settings.edit` grants it (+ READ) and gates on it. The three attribute routes (`POST /:id/attributes`, `PUT` / `DELETE /:id/attributes/:key`) require it. Everything about the instrument — `PUT /:id` (code, gateway), enable / disable, delete, token reveal / set / regenerate, certificates, bulk-upload updates — stays on `INSTRUMENT_UPDATE`. The Settings page's Instrument ID input needs `instruments.edit` (`canEditInstrument`); the detail page's Attributes panel stays on `instruments.edit` (stricter, deliberately).
  - **`INSTRUMENT_UPDATE` IMPLIES it** — `PERMISSION_IMPLIED_BY` in `packages/shared/src/types/permissions.ts`, the ONE implication table `hasEffectivePermission` reads, so the API's `requirePermission` / `requireAnyPermission` / `roleHasPermission`, the browser's `useCan` and the Permissions tab's toggle derivation all agree. **No data migration**: a role that held Edit Instruments keeps attribute editing and shows Edit Settings ON. A role that held ONLY Edit Settings still holds `INSTRUMENT_UPDATE` until its Permissions tab is SAVED again — re-save it (Supervisor done locally 2026-10-30; AWS owed after deploy).
  - Attribute Edit Access still narrows which keys; its "can this role edit at all" (`canUpdateInstruments`, name kept as the wire contract) now means either permission. Tests: `apps/api/src/e2e/instrument-attribute-permission.e2e.test.ts` (6; mutation-checked: the route on the old permission fails 2, no implication fails 2 — rebuild `packages/shared` dist before mutating, the API imports the BUILT package), `packages/shared/src/types/__tests__/permission-implication.test.ts` (5), the settings-page test (Edit Settings alone has no Instrument ID input; mutation-checked).
  - **CR-1 — Slave ID and Read every are the INSTRUMENT's; Quantity, byte-order names and a per-key Test (2026-11-02; operator: "slave id should comes in instrument page … read every should come in instrument page, give one test button after adding key check data was coming or not and also quantity was not there, and if register address is 2 registers for one key then how to add"; answers "Remove from profile", "Quantity 1 or 2"; spec §18; rulings CR1-1 … CR1-8 in the ledger; commits `8e0dd141` (api), `6ca81daf` (shared), `887ae913` `fbd8b01f` `1a532481` (web)).** Migration `20261102120000_tcpip_instrument_reading` adds `instruments.modbus_unit_id` / `modbus_interval_sec`, copies each MODBUS_TCP profile's values to its instruments as stored and **DROPS the two profile columns**. The profile chooses only Gateway or TCP/IP; a profile body carrying either field is a 400. Each TCP/IP instrument has **Slave ID** (`modbusUnitId`, 0..255, default 1) and **Read every** (`modbusIntervalSec`, 10..3600 s, default 60): set on New Instrument and in bulk ("Slave ID" / "Read every" columns; blank = the default on a created row, unchanged on an existing one), changed on the instrument page's TCP/IP connection card with a reason under `UPDATE_INSTRUMENT` re-auth (the host/port rule); on a Gateway profile's instrument either is 400 `NOT_A_TCPIP_PROFILE`. The Reader, the status route, Test connection (body `modbusUnitId`, required) and `effectiveExpectedIntervalSec` (`inst.expectedIntervalSec ?? (TCP/IP ? inst.modbusIntervalSec : null)`) all read them from the instrument. **Quantity** (1 or 2 registers) is a register-map column DERIVED from the data type and never stored — the map's shape is unchanged: it limits the data types offered (1: UINT16 / INT16; 2: UINT32 / INT32 / FLOAT32), changing it CLEARS an incompatible type so the operator chooses one (a wrong type reads a believable wrong number), and the range read prints as a caption under the Register (`registerRange`, "Holding · 40001–40002"; null past the area's end). **Byte order** prints `MODBUS_BYTE_ORDER_LABELS` — "Big-endian (ABCD)", "Little-endian (DCBA)", "Big-endian, byte swap (BADC)", "Little-endian, byte swap (CDAB)"; the stored value is still the code. **Per-key Test** on every row reuses `/modbus/test` with a one-key map and prints its answer under that row (the whole-map Test connection's verdict is the Judged as column in the read view and a caption under the Key while editing); the route's limit rose 10 → **30 per minute per user** so "add key, test" on a full device does not hit it. `profile-tcpip-reading.tsx` and Configuration → Instrument Attributes' "TCP/IP reading" section are gone. The status route's `intervalSec` / `expected24h` are null for a stored value the Reader refuses (the card prints no "null"). Every column fits at 1240 px with the sidebar open, in edit and read view (`built-cr1-*.png` in the concept folder; the first cut hid Scale behind a sideways scroll — review I1). Test buttons and the Test connection panel show only to a role that can test (the 403 stays the control). A hand-edited out-of-range Read every makes `effectiveExpectedIntervalSec` null, as the Reader refuses it (review M4). **Fixed on the way:** a blank bulk cell (Port, and now Slave ID / Read every) wrote back the value planned at PREVIEW, silently undoing an edit made between preview and upload — only the cells a file changes are written now. No count moved (models 39, enums 13, type files 39, defs 37, config pages 23). **Built, not pushed, not deployed** — the migration reaches AWS (0 TCP/IP profiles there) with the next deploy.
  - **Test before Add (2026-11-03, operator: "when instrument page for tcp/ip, when key was adding at that time give a test option before adding the key; once test is completed value was coming then user will add that key").** In the register map editor (New Instrument, and the instrument page's Edit) **+ Add key** no longer appends a row: it opens ONE **draft** row under the map — the same six inputs and captions, validated by the shared schema as the map's NEXT row, so a key or register another row already has is named under it — with **Test** (the rows' per-key Test: `/modbus/test` with the draft as a one-key map, its answer printed under the draft), **Add** and **Cancel**. **Add is enabled only once the draft's own Test brought a VALUE back** (an `ok` answer naming a value — a refusal, a failure pill such as No answer, and "Not readable" are answers, not values) for the draft and the target as they stand now: editing the draft or the target DROPS the answer (putting it back does not revive it), and a draft that a row edit has since turned into a duplicate cannot be added. Add appends the draft, its answer moves to the new row's line, and the draft closes. **Exception: with no test target** Add takes a valid draft and says "Test is not available here — the key is added untested." Neither live page hits it today (New Instrument always passes a target; the instrument page's Edit is SUPER_ADMIN, who can test). **Ruling K-1 (2026-11-03): the SERVER's own "TCP/IP Reading is off" answer** (`200 {ok:false, code:'READING_OFF'}`, `isReadingOff` in `modbus-test.ts`) is no verdict on the key, so it ALSO enables Add, untested, with "Reading is off on this server — the key is added untested." under the actions — a device failure (No answer, Register refused …) and every other refusal still keep Add disabled. So where TCP/IP Reading is OFF (AWS today) keys go in untested. The draft is local state and in no map: Cancel, leaving Edit and leaving the page discard it, and **Create Instrument / Save ignore a draft that was never added** — so (**ruling K-2**) a draft holding any input says "This key is not added yet — Test it, then Add." ("— press Add." once Add is enabled), and **Enter in a draft input never submits** the New Instrument form (it is held on the draft's inputs only; Enter on its buttons still presses them). `MODBUS_MAX_KEYS` applies to opening a draft and to Add. Import keys file and Copy from instrument are unchanged (they replace the map; an open draft stays open). Web only, `register-map-editor.tsx` + `isReadingOff` in `modbus-test.ts` (the six inputs are one `EditCells` for the rows and the draft); tests `register-map-editor.test.tsx` (mutation-checked) and `create-tcpip.test.tsx`. No count moved.

- **DASHBOARDS — many named dashboards, built by a SUPER_ADMIN, seen by assignment (2026-10-29, phase 1 of 4; operator: "… like in thingsboard i need same feature like different dashboards creation and different types of widgtes, like charts, graphs, trends, time series, alarms and more", then "yes proceed" to the playback and "do best one" for the look).** Spec `docs/superpowers/specs/2026-10-29-dashboard-builder-design.md`; plan `docs/superpowers/plans/2026-10-29-dashboard-builder-phase1.md`; ledger `.superpowers/sdd/2026-10-29-dashboard-builder-phase1/progress.md`. Built, **not pushed, not deployed.**
  - **What it is.** A new sidebar item **Dashboards** (`/dashboards`, the list) beside **Dashboard** (`/`, untouched); `/dashboards/:id` is one dashboard. A dashboard covers a SOURCE — all instruments, one profile (a "project"), a functional location (`directOnly` or with its Areas), or a fixed list of ≤ 200 — resolved on the server on EVERY read after the viewer's scope, so a new instrument of the profile appears by itself. Its widgets are the home dashboard's library: value cards, latest table, trend chart, time-series table, and the new **alarm table**. ONE library for both places.
  - **ONE document per dashboard**, in the existing `dashboards.layout` JSONB: `{version: 1, source, timeWindow, items, widgets}`. No migration. `@digilog/shared` `dashboard-document.ts`: the STRICT `parseDashboardDocument` on every write (400 naming the widget; `w:` items only, no panel keys, each widget placed once, ≤ 20) and the FORGIVING `readDashboardDocument` on every read (a bad widget is dropped with its item, the rest stays) — never swapped. Built dashboards never go through `normalizeLayout` / `resolveLayout` (the panel gates); the document reuses `readItem` for each item's geometry and style. There, assignment is the gate. `dashboard_widgets` is left in place, UNUSED (dropping it is spec §12 question 1).
  - **An unreadable or vanished source shows NOTHING, never everything.** A stored source that fails the schema reads `null` → no instruments and a banner ("This dashboard's instruments could not be read. A super admin can choose them again in Settings."); a deleted profile / location is summarised "Profile no longer exists" / "Location no longer exists" and selects nothing. A PRESENT-but-empty `instrumentIds` selects nothing on both filtered routes (D3); the web does not even ask when its list is empty.
  - **Seeing** = `DASHBOARD_VIEW` + an active row + an assignment to the caller's user id or role. SUPER_ADMIN sees every active dashboard; **ADMIN is not special; no assignment means none**; anything not visible is a 404, never a 403. **A dashboard grants nothing** — every widget reads `telemetry-overview`, `latest-values`, `data-keys`, `/:id/telemetry`, `telemetry-history` and `/api/alarms` under the viewer's own permissions and scope, so a widget the viewer may not read prints its own error and the others draw.
  - **Writing is SUPER_ADMIN only, checked by ROLE** in a `preValidation` hook, so a non-SUPER_ADMIN is a 403 `DASHBOARDS_SUPER_ADMIN_ONLY` before the path or body is even validated, whatever `DASHBOARD_CREATE` / `MANAGE` / `ASSIGN` grants they hold — **the 2026-10-24 permission strip is still owed on AWS**, so ADMIN may hold them there and must not be let in by them. No route reads those three constants any more. Order on every write: role (403) → active row (404) → `enforceReauth('UPDATE_DASHBOARD')` → validation (400) → ONE transaction with every audit row.
  - **Re-auth `UPDATE_DASHBOARD`** (`Configuration`, ships OFF like every action; reauth 56 → 57) covers create, duplicate, update, delete and assignments. No remarks: this is display configuration, not a decision on a record. The web sends it through `reauth.execute` with `onSuccess`, `onError` and `onCancel`.
  - **Audit** reuses the eight registered actions; every `beforeValue` / `afterValue` carries `name` (the dashboard's title, or the widget's title on a widget row). **"Changed" is decided from what gets audited**: a save whose title, description, source, window, items and widgets are all equal writes nothing and audits nothing — so a reorder of the widget LIST alone (which places nothing) writes nothing; a move of items writes `DASHBOARD_UPDATED`; widgets are diffed by id (`diffWidgets`) into `DASHBOARD_WIDGET_CREATED` / `UPDATED` / `DELETED`; assignments into one `DASHBOARD_ASSIGNED` / `UNASSIGNED` per role or user. `signatureMeaning` goes through `lib/audit.ts` `clampSignatureMeaning` (ruling R7 — the plan's "a longer one is a 500" was stale; the library has clamped every row since 2026-10-03).
  - **Two editors (R10).** `PUT /:id` carries `expectedUpdatedAt` = the `updatedAt` captured when EDITING BEGAN, by ALL THREE editors: the page's Save (`editBase`), Settings (captured when the dialog opens) and Rename (the row the dialog opened on; a 409 re-seeds its fields from the fresh row) (not the live value at Save — a focus / Refresh revalidation would hand Save the other editor's version and the 409 would never fire). The update is conditional on it; a stale save is 409 `DASHBOARD_CHANGED` that writes nothing, and the page keeps the draft until **Reload**. The new stamp is `max(now, expected + 1 ms)` (the version check is a 1 ms window). After a save the page ADOPTS the whole PUT response (document and new `updatedAt`), never only a re-read.
  - **Time window.** `{mode:'relative', period}` (a `PERIOD_PRESETS` value) or `{mode:'fixed', from, to}`, default 24h. Only the trend chart and time-series table follow it, and only when their `options.period` is absent; value cards, the latest table and the alarm table take none (an alarm raised before the window must not vanish while active). The header picker is SESSION state starting at the stored default; Settings owns the stored default. On a built dashboard the in-widget picker's first entry is "Dashboard window".
  - **`alarm_table`**: `SelectionAlarms` through a `scope` prop (D6; with no scope the home panel's query is byte-identical), so the filters, paging and the WHOLE acknowledge flow are the "Alarms in this selection" panel's. Options `{status?}` (its page size is the administered default, as on the home panel), keys `[]` (the schema allows an empty key list for this type only). **On `/` it is drawn only when the viewer also has the `dashboard_alarms` panel** (the server's `resolveLayout` decides) — a built widget never widens what Roles & Access → Panels grants.
  - **Governance on the menu (D1, D2).** The tree group `dashboards` is appended LAST and its visibility is the EXISTING node `dashboard.view` with `nodes: []`: ONE "View Dashboards" toggle covers both menus (nodes stay 56, feature privileges 39), while Roles & Access → Sidebar shows or hides each menu per role. A role with a stored Sidebar list sees "Dashboards" only once it is ticked there; a SUPER_ADMIN sees it at once.
  - **Look (R6).** The list is concept A (a full-width lined table: Title + description, Instruments chip, Widgets, Assigned to chips, Updated date / time, icon actions — `docs/superpowers/concepts/2026-10-29-dashboards/concept-a-list.png`); the dashboard page header is concept C (title, description and source chip "<source> · N in your view" on one line; period chips 15m … 30d + Custom + Refresh; Edit / Settings / Assign top right). The widget grid is whatever the super admin arranges. The built screens are `built-*.png` in the same folder, rendered with the built stylesheet (they were not seen in the operator's browser).
  - **Changes on `/` too, ruled in the ledger:**
    - **R5:** the latest-values, time-series and trend-strip widget tables wear the shared `Table` (padding, band header, lined cells, zebra); they were raw `tbl tbl-grid` with no padding.
    - **The shared `TableHeader` keeps its band on hover** (`[&>tr:hover]:bg-transparent`): a `TableRow` inside a header painted its hover tint over the band under white type — on EVERY banded table header in the app.
    - **R9: PanelGrid drags and resizes only at the `lg` breakpoint** (container > 1200 px). Below it, Arrange / Edit shows "Widen the window (or collapse the sidebar) to move and resize cards — the arrangement is saved in the 12-column layout." Before, a drag at `md` moved the card and was silently thrown away (only `lg` is stored). A 1240 px window with the sidebar open IS `md`. The breakpoint is now the library's `getBreakpointFromWidth` over the width the grid is given (it was state that never left `lg` for a grid mounted at `md`).
    - PanelGrid gained optional `resetLabel` / `saveLabel`: the dashboard page says "Discard changes" / "Save"; `/` keeps "Reset to default" / "Save layout".
    - The home `/` keys each built widget on its definition (`JSON.stringify(w)`), so an edited widget's new defaults (status, page size, period) show without a reload.
  - **[my call] list (spec §11), all the operator's to overturn:** (1) projects share one server, no customer separation; (2) their own "Dashboards" sidebar item on the existing `DASHBOARD_VIEW`, `/` untouched; (3) seeing = view + assignment, only a SUPER_ADMIN sees unassigned ones, no ADMIN exception; (4) building = SUPER_ADMIN by role, never through `DASHBOARD_*` grants; (5) stored in `dashboards.layout`, `dashboard_widgets` left unused, not dropped; (6) one widget contract and one library for `/` and built dashboards; (7) the alarm table in phase 1, the rest in phase 2; (8) ECharts recommended for phase 2's new chart shapes (settled in that plan); (9) `UPDATE_DASHBOARD`, off by default, no remarks; (10) instrument dashboards (phase 3) never replace the trend page or its reports; (11) excluded: control widgets, custom HTML/JS, public dashboards, internet maps; (12) Duplicate copies no assignments; (13) history widgets follow the window, present-state widgets (the alarm table included) take none; (14) on `/` an alarm widget also needs `dashboard_alarms`; (15) a save carries `expectedUpdatedAt`, a stale save is a 409; (16) a widget's own fixed instrument list need not sit inside the dashboard's source — it is still limited to the viewer's scope.
  - **Open questions for the operator (spec §12; none blocks phase 1):** (1) drop the unused, empty `dashboard_widgets` table? (check AWS's row count first); (2) ECharts for the phase 2 charts, or hand-built SVG?
  - **Before the deploy:** read AWS's `dashboards` and `dashboard_assignments` row counts (read-only). Under the new rule an unassigned dashboard there becomes SUPER_ADMIN-only; no screen ever existed, so zero is expected.
  - **Seen in the built render, not fixed (decide):** the alarm table's 11 columns at the lg type size do not fit a full-width card at 1240 — the table scrolls sideways and the sticky Acknowledge column covers "Acknowledged by"; Instrument IDs wrap at their last hyphen. Same component and look as the home "Alarms in this selection" panel, so it is not new; a column trim or the Compact content size is the operator's call. In edit mode a card header carries "Edit widget" (the definition) beside "Edit" (the card style) — the phase 2 wording, on `/` too.
  - **Open minors** are listed in `tasks/todo.md` (dashboard builder phase 1). Phases 2–4: the rest of the widget library (gauge, bars, comparison, pie, alarm counts, status grid, instrument list, text card, floor plan), instrument dashboards per profile with drill-down, and export / import + governed widget downloads.
  - **Tests:** shared `dashboard-document.test.ts`, `dashboard-widgets.test.ts`, `permission-tree.test.ts`, `legacy-maps-derived.test.ts`; API `e2e/dashboards-module.e2e.test.ts`, `e2e/dashboard-source-filters.e2e.test.ts`, `modules/dashboards/__tests__/mass-assignment.test.ts`, `lib/__tests__/uuid-list.test.ts`, `modules/alarms/__tests__/list-query.test.ts`; web `routes/dashboards/__tests__/*` (list, page, draft, settings, assign), `widgets/__tests__/{alarm-table-widget,selection,use-widget-data-source,widget-range}.test.*`, `panel-grid-breakpoint.test.tsx`, `components/ui/__tests__/table.test.tsx`.
  - **PHASE 2 (2026-10-30 → 31; operator: "start phase 2 with echarts") — nine more widget types: `gauge`, `bar_chart`, `comparison_bar`, `pie_chart`, `alarm_counts`, `status_grid`, `instrument_list`, `text_card`, `floorplan`.** Plan `docs/superpowers/plans/2026-10-30-dashboard-builder-phase2.md` (rulings P1–P9); open question (2) above is answered: ECharts. Commits `cc1cce7..` on `data-layer` (plan `ba954f1`; the last are `0b31baf` fix, `38ef8d4` test and the `docs: dashboard builder phase 2` commit). **No migration, model, enum, permission, re-auth action, audit action, config def, sidebar item or `<Route`**; shared type files stay 38, API modules 25; two new routes (`GET /api/alarms/counts`, `GET /api/instruments/telemetry-buckets`) and two new overview fields (`judged`, `lastSeenAt`), all in `docs/recreation/06-api/endpoints.md`; one new web dependency, `echarts`.
    - **One registry (P1).** `WIDGET_TYPE_SPECS` (`@digilog/shared` `dashboard-widgets.ts`) decides each type's keys, window, options and `/` gate; the schema's `superRefine`, the server's layout gate and the Add widget dialog all read it. `WIDGET_TYPES` was APPENDED to, never reordered; every new option is optional; a phase-1 type keeps only the options phase 1 parsed (a new option name on one is STRIPPED, never refused, so no stored widget is dropped and a stored `/` layout parses exactly as before).
    - **ECharts `6.1.0`, exact (no caret) in `apps/web/package.json`.** Its only value import in the build is `routes/dashboard/widgets/charts/echart.tsx` (the four `…-model.ts` files and `lazy-echart.tsx` use `import type { EChartsCoreOption }`, erased from the build) — `echarts/core` with the Gauge / Bar / Pie charts, the Grid / Tooltip / Legend / MarkLine components and the SVG renderer registered once — which is loaded ONLY through `lazy-echart.tsx` (`React.lazy`): nothing imported by `main.tsx`, `widget-panel.tsx` or `routes/dashboard/index.tsx` imports `echarts`. `init` on mount, `setOption(option, {notMerge: true})` per option, `resize()` from a ResizeObserver, `disconnect` + `dispose` on unmount (dashboards stay open all day). Every option starts from `color: [NEUTRAL_HEX]` — never ECharts' palette or theme — with `animation: false`. A chunk that cannot load or a chart that throws prints "Could not load this widget." in its own box (`ChartBoundary`). Every chart decision is a pure `build…Option` / `…Model` (`gauge-model`, `bar-chart-model`, `comparison-model`, `pie-model`), unit-tested; widget tests mock the lazy module and assert the props it was given.
    - **The bundle check — run it after every `npx vite build`:** the ECharts code is its OWN chunk `assets/echart-<hash>.js`, NOT the entry `index-*.js` that `index.html` loads and NOT one of its `modulepreload`s, and that file name IS in `dist/sw.js`'s precache list (Workbox silently skips a file over 2 MiB, and an install may have no internet route). 2026-10-31: `npx vite build --outDir <scratch>` → `assets/echart-BrKMKC8o.js`, 564,419 B, is the ONLY chunk carrying ECharts code; the entry `index-tAXEbgW7.js` (968,677 B) and the two modulepreloads (`vendor-*`, `swr-*`) do not; `sw.js` precaches it — PASS (the hash changes per build; check by the `echart-` prefix).
    - **"Not judged" (P3, Review Focus 1).** The overview's `judged` is the server's: TRUE when the instrument's profile measures temperature or humidity AND maps at least one device key to it. `instrumentLook` (`widgets/instrument-look.ts`) is the ONE mapping of `status` / `reporting` / `judged` to a word and a colour for the status grid, the instrument list and the status pie: not judged + reporting = "Not judged" (neutral), not judged + not reporting = "Offline" — never "No data", never green. An absent `judged` (an older cached response) reads as judged. The readings table and the floor plan are unchanged (profile measurements phase 2 owns them).
    - **Local-time buckets (P5, Review Focus 2).** `GET /api/instruments/telemetry-buckets` bins in the `datetime` config's timezone (default `Asia/Kolkata`; an unknown zone is UTC and the response's `timezone` says so): an hourly edge falls on the local hour, never on :30; a day starts at local midnight, so a reading at 23:00 UTC on an IST install lands in the NEXT local day's bar; a week starts on a local Monday; bucket starts come back as UTC instants. Every value is COMPUTED and says so: the caption under the title ("Hourly average", "Daily maximum", "Weekly reading count") and, in each bar's tooltip, the readings behind it. At most 1,000 buckets — a 400 the widget prints in the server's words.
    - **The `/` gates — a built widget never widens Panels.** On the home dashboard `alarm_table`, `alarm_counts` and a `pie_chart` of `alarm_types` need `dashboard_alarms`, and `floorplan` needs `telemetry_floorplan`; the server's `resolveLayout` drops a gated widget from `widgets` AND from the grid (`widgetPanelGate`, read from the registry). Pinned over HTTP by `e2e/dashboard-widgets.e2e.test.ts` "on / a built widget never widens Panels" (2026-10-31, mutation-checked). On a built dashboard the assignment is the only gate; a viewer without `ALARM_READ` sees "Could not load this widget." on the alarm widgets and the rest of the dashboard draws (Review Focus 4).
    - **History vs present.** Only `bar_chart` follows the dashboard window (`options.period` absent = follow), exactly as the trend chart does; every other new type shows the present and takes no window and no period.
    - **Colours.** A raw key is never green and never "In limit". Bars, comparison bars and the pies' categories take SERIES colours, never verdicts, and draw no limit lines (P4: several instruments' bounds may disagree). **No dashboard series is green (ruling F-I6, final fix wave):** the series palette's slot 3 (`#1baf7a`, 158.5°) is the OK dot's emerald (160°), so the bars and comparison bars draw `DASHBOARD_SERIES_HEX` — that palette with its green replaced IN PLACE by a brown, `#6b4423` (same slots, so a stored colour index keeps its meaning; still six distinct colours, so no cap moved); brown over a teal-blue because it is the farther from everything else on the chart (CIEDE2000 ≥ 30 from every other series and status colour, ≥ 27 under a deuteranopia simulation; a teal near 190° came within 17–19 of the blue series and the No-data slate). The widget dialog's swatches show what a type draws (`keyPaletteFor`). The dashboard's trend widget draws through `TimeSeriesChart`, shared with the trend page and the PDF export, so it, the trend page and every PDF keep `SERIES_COLORS`. Only a MEASURED key on a gauge takes a verdict colour, from `quantityVerdict`, exactly as `keyCell` does. The alarm-type pie leaves out the palette's greens by HUE (`withoutGreens`) and puts the types beyond its colours in ONE neutral "Other" slice whose tooltip lists them; the status pie's Partial slice is the status amber with a stripe, so it never reads as Offline. The pies offer only server-decided distributions (P8): instrument status and active alarms by type, never raw readings.
    - **The gauge ring.** The arc is the reading's position in an ADMINISTERED band; no band = no arc, a tinted track; any breach = a stronger track; one bound (or high ≤ low) still takes its verdict colour. A raw key with no min / max draws the value and a neutral full ring; a measured key with neither bound reads "Not assessed" in neutral. The type steps in px to the ring, so a reading is never clipped.
    - **Bars.** A bucket only partly inside the window is drawn lighter and its tooltip says so (decided from the response's own `from` / `to` / `bucketSeconds`). Hour labels stand LEVEL at a clock stride (1, 2, 3, 4, 6, 8, 12, 24 h …) with the date on the first shown label and at each new day; day and week labels turn or thin by width (`codeAxis`). "No readings for X" (`noReadingsFor`, the ONE wording, shared with the comparison) names the keys none of the widget's instruments returned. The legend's rows are estimated by ONE `legendRows` for both bar widgets (`comparison-model.ts`; `bar-chart-model.ts` re-exports it) and the plot starts below them.
    - **Caps say what they left out (P6):** 24 gauges, 50 comparison instruments, 120 status tiles, 6 bar series — "Showing X of Y …". The text card is plain text, 2,000 characters, no HTML and no markdown (P7).
    - **One rule each for the data.** `widgetPolling` (`lib/polling.ts`, a leaf module so `use-telemetry.ts` can use it without an import cycle; re-exported from `use-widget-data.ts`) is the ONE retry policy of EVERY polling hook on `/` and `/dashboards/:id` — the widget data hooks, `useTelemetryOverview` (the readings table, the floor plan, every widget's instruments, the built dashboard's count; the trend page and the Data Report read it too), `SelectionAlarms` (the home alarms panel and the `alarm_table` widget), the landing's `/api/alarms/summary` and `/api/instruments/activity-summary` (which now poll at the overview's cadence) and `useFloorplans` (`widgetPolling(0)`: retried, never polled) — since the final fix wave (R7-11). A failure is retried at the hook's refresh cadence indefinitely (0 = the configured retry interval), one retry chain per key, and reported through the app's `onError` on the FIRST failure of each key — a key is a request, so a widget on a rolling period (its window moves every minute) reports again each minute of an outage, and N widgets report N times at its start; a refusal (any 4xx except 408 / 429) is never retried and never toasted — the card states it. Spread it FIRST and the hook's own options after, or its `keepPreviousData: true` turns `THIS_REQUEST_ONLY` back on. **This changed phase 1's latest-values widgets too**, which used to freeze after an outage until the window was focused. ONE held-answer rule (`answerState`): the present-state hooks (`useAlarmCounts`, `useWidgetOverview`) and, since the final fix wave (F-I1 / F-I2), every key widget's instruments and latest values (`useWidgetRows`) run `keepPreviousData: false`, so a new scope that is loading or has failed never shows the previous scope's numbers — a failed first load is "Could not load this widget.", never "No instruments in your view" — while a failed refresh of the SAME scope keeps its last answer and says so (`refreshFailed`, on every key widget: no gauge keeps a silent "In limit"); the bar chart compares the held request itself (`heldAnswers`). The landing's Alarms card follows the same rule: no count in hand is a dash on a neutral card, never `?? 0`. One fault ink, `FAULT_INK` (`text-red-600`, `routes/dashboard/status.ts`), on the value cards too.
    - **Trails.** The status grid's tiles, the instrument list's rows and the floor plan carry the dashboard's breadcrumb into the trend page (`trendLinkFor`), and are INERT while the dashboard is being edited (R7-9).
    - **Widget text is HTML-stripped on every write path** — `cleanWidgetText` on `POST` / `PUT` / duplicate of `/api/dashboards` and on both layout PUTs through `checkLayoutWrite` — a title and a text card's text; a widget sent back exactly as stored is kept as stored (re-stripping it would 403 a non-super-admin's arrangement save). Markup in a text card prints as typed.
    - **The floor plan widget draws as the home floor panel does**: fitted to the card's WIDTH, the card body scrolling — NEITHER has ever been contained (`PanelCard`'s content wrapper has no height), and containing it would shrink the readings from ~13 px to ~7–8 px, so do not "fix" it unasked. Start size w 12 h 16; a plan that is gone or refused reads "This floor plan is not available.".
    - **Seen 2026-10-31 (Task 9):** one built dashboard over a profile holding every new type, drawn by real ECharts 6.1.0 — the app's own module set, NOT the full `dist/echarts.min.js`, whose legacy `containLabel` lays grids out differently — in headless Chrome with Inter loaded, at a 1240 px window: `docs/superpowers/concepts/2026-10-29-dashboards/built-p2-dashboard.png` (re-shot in the final fix wave at the same window: the grid is at `md` there, 12 columns since then, so the arrangement is the stored `lg` one — no staircase, the comparison and bar chart side by side, three pies-and-counts thirds in a row; and `built-p2-md-narrow.png` beside it: quarter and third panels at a 960 px container with the longest code, `CWH/RDU/101-01` — nothing scrolls or is cut; the comparison's first turned code reaches 3 px past its chart box into the card's padding, drawn whole). Measured at the smallest panel (Quarter: 262 px of chart): every hour-label stride and every bar legend's rows exactly as estimated, no label clipped or overlapping; the comparison's legend was NOT estimated (four keys wrapped onto the value axis's top label) — fixed in `0b31baf`.
    - **Final fix wave (2026-10-31, after the whole-branch review; rulings F-I1..F-I6 in the SDD ledger):** ONE retry policy now true for every polling hook on `/` and `/dashboards/:id` (R7-11 — see "One rule each for the data"); the key widgets on the one held-answer rule (F-I1 / F-I2); `/` has the built dashboard's per-widget render boundary and one around the Add widget dialog (`widgets/widget-boundary.tsx`, shared by both hosts, I-3); `md` has the SAME 12 columns as `lg` (F-I5, revising R9-3's half-scale idea: `md` is a 900–1,200 px container, at most 25 % narrower than `lg`, so the stored arrangement is drawn exactly — no derivation, no rounding, no staircase; a quarter card is ~205 px wide at 900, above the gauge tile's 160 px minimum; no drag below `lg` and the `lg`-only save guard stay); no dashboard chart series is green (F-I6, see Colours). Found while listing the overview's callers and fixed: a built dashboard's header printed "0 in your view" for a failed overview (`bbc765d`). Commits `bcd3159`, `093802d`, `6fe4e7c`, `d9c89cc`, `f1077ea`, `bbc765d`.
    - **Parked — open, not done:** (1) M9 — a gauge widget at its default size in a narrow panel shows a sliver and its body scrolls; (2) widget titles stored with markup before the stripping are not backfilled (they print as text); (3) on a drill-down the status AND key widgets show "Loading…" while the readings table keeps its old rows — two loading behaviours, accepted by ruling F-I1 (the cost of never drawing the previous scope's answer); (4) the trend page's and the PDF reports' third series colour is still the green — an app-wide swap would change how approved reports render, the operator's call; (5) the dialog does not warn that markup in a title or text is removed at save (M-6 — previewing the server's stripping would reconstruct server logic in the client; the save's 400 states it), and a bar chart on a FIXED past window re-asks the same aggregate every refresh (M-7).
    - **Tests:** shared `dashboard-widgets.test.ts`, `dashboard-layout.test.ts`; API `e2e/dashboard-phase2-data.e2e.test.ts` (`judged`, `lastSeenAt`, the counts), `e2e/telemetry-buckets.e2e.test.ts`, `e2e/dashboard-widgets.e2e.test.ts`, `e2e/dashboards-module.e2e.test.ts`, `lib/__tests__/widget-text.test.ts`; web `routes/dashboard/widgets/__tests__/*` and `widgets/charts/__tests__/*` — one file per process.

- **DEVICE ATTRIBUTES ON EVERY PROTOCOL (2026-10-28, operator: "add for all protocals").** HTTP/HTTPS `POST`/`GET /api/ingest/v1/attributes`; WS/TCP `{"attributes":{...}}` (sole key) reports and `{"subscribe":"attributes"}` gets the set then every change as `{device, attributes, changed, ts}`.
  - **One report path** (`ingestAttributeReport`, now with `transport` + `certificateVerified`) and **one push point** (`publishAttributeDownlink` → `pushAttributeFrame`, BEFORE the MQTT publish, so it works with no broker). `AttributeDownlink.instrumentId` / `gatewayId` are REQUIRED — subscribers are keyed by ID, the target is `gatewayId ?? instrumentId` (the MQTT slot rule).
  - **Every push re-checks** re-authorisation + certificate (`attributeSubscription`'s `check`), so a silent subscriber is still cut off on revocation; a child requiring a certificate is never sent down, nor accepted from, an unverified gateway connection. Subscribe registers FIRST, then sends the snapshot.
  - Out of scope: roster and `children/attributes` (MQTT-only), HTTP long-poll. Tests: `e2e/device-attributes.e2e.test.ts`.

- **BULK UPLOAD UPDATES an Instrument ID that already exists (2026-10-28, operator: "when user doing bulk upload with already exiting instrument ids and like attributes values changed and uploaded then already existed error was coming, there i need like what values are changed those data should update").**
  - **ONE plan, two callers.** `modules/instruments/bulk-plan.ts` `planBulkUpload()` (pure) decides every row — create / update with `{key, column, from, to}` / unchanged / error. `POST /bulk/preview` returns it and writes nothing; `POST /bulk` plans the file AGAIN at commit and writes that. Never take a diff from the browser.
  - **Attributes only, blank keeps.** An existing instrument's identity columns are not applied (one warning when the file carries them); a blank cell never clears a value — removing an attribute keeps its own audited route and remark.
  - **Refused on the row, never moved:** another profile (a profile move is governed — `MEASUREMENTS_DIFFER`), outside the caller's view (the old "already exists" wording, nothing read), no Instrument Update for a change, a cell the role's Attribute Access refuses (the whole row fails, named by its heading).
  - **Remark** = the single attribute routes' rule, once per file: required when a change OVERWRITES a recorded value (an empty stored value counts), never for a first fill; `remarkRequired` comes from the server and the page only reads it. Missing → 400 and nothing written.
  - **Locks**: `applyBulkChanges` takes every attribute lock BEFORE the first `auditLog` (key order). An attribute lock taken after the audit-chain lock can deadlock with a single attribute write. `writeInitialAttributes` (create path) still locks inside its loop — pre-existing; its instrument is brand new.
  - **The template is the heading row ONLY** — its sample row named a real instrument, so every untouched template failed ("already exists") and would now update it. Excel's cleared rows (`,,,`) are skipped by the parser.
  - **Re-uploading an old file proposes reverts** — the review dialog shows them. Tests: `e2e/bulk-update.e2e.test.ts`, `__tests__/bulk-plan.test.ts`, `bulk-create.test.tsx`.

- **WIDGET DATA KEYS — any key an instrument sends, in any widget (2026-10-28, phase 1 of 4 = server only; operator: "… in future new key was came to instrument, how can i see that new key data in dashboard … like in thingsboard").** Spec `docs/superpowers/specs/2026-10-28-widget-data-keys-design.md`.
  - **Ingest already stored every key**; what was missing was a way to name one. `GET /api/instruments/data-keys` lists telemetry keys (latest table) and attribute keys; `POST /api/instruments/latest-values` reads them; `keys` filters both history routes. Module `modules/instruments/data-keys.ts` + child plugin `data-keys-routes.ts`; `keys-param.ts`.
  - **Measured vs raw** is the whole rule, and it is ONE function on the key-naming routes — `resolvedSlotFor` (`data-keys.ts`; NOT yet used by `floorplans/room-history.ts` or `telemetry-aggregate.ts`, which still treat every device key of a slot as that measurement (pre-existing; raised as a follow-up)): measured = the profile maps the key to a slot AND it is the key that slot RESOLVED to on this instrument (or the slot has no reading yet); unit, decimals, bounds, fault flags come from `buildTelemetryOverview()`. Raw = `unit` / `decimals` / `judged` null — shown, never judged, never green; limits/alarms on a new quantity are profile-measurements phase 2. The catalogue, `telemetry-keys` (`slot`), latest-values and the `/:id/telemetry` chart/table annotation all use it — which fixed the trend page charting (and counting breaches for) the wrong one of two device keys. A two-key case in the resolver-agreement e2e pins it. It decides from the LATEST table (every key ever sent), so a device that moved from the preferred key to another resolves to the OLD one — as the overview and alarms already do; local check 2026-10-28 found no such instrument, AWS unchecked.
  - **An empty id list is an empty answer** (200 `[]`) on both routes — a selection can hold nothing.
  - **`value_type` is not "is it a number"** — gateways quote every reading, so `"21.5"` is stored `string`. `numeric` uses `NUMERIC_READING`.
  - **Decided (operator, 2026-10-28):** only a SUPER_ADMIN builds dashboard widgets (the 2026-08-29 Arrange rule stands) and shares them as a role's default; trend-page extra keys are per PROFILE. Phase 2 (dashboard widgets) was built the same day and phase 3 (trend page) on 2026-10-29 — below; phase 4 (downloads) is not built yet.
  - **Tests:** `e2e/data-keys.e2e.test.ts` (24), `__tests__/keys-param.test.ts`, shared `data-keys.test.ts`, the resolver-agreement case in `instrument-telemetry-range.test.ts`.
  - **PHASE 2 — dashboard widgets (2026-10-28, plan `docs/superpowers/plans/2026-10-28-widget-data-keys-phase2.md`).** Arrange → **Add widget** / **Save as role default**, SUPER_ADMIN only; four types in `apps/web/src/routes/dashboard/widgets/`.
    - **Stored in the layout JSON** (`layout.widgets` + items `w:<uuid>`), validated by ONE zod schema (`@digilog/shared` `dashboard-widgets.ts`). Reader forgiving (`normalizeLayout` drops a bad widget with its item), writer strict (`parseLayoutForWrite`, through `checkLayoutWrite` on BOTH layout PUTs). **An omitted `widgets` key keeps the stored row's** — never read it as "none". A widget change by anyone but a SUPER_ADMIN is 403 `WIDGETS_SUPER_ADMIN_ONLY`.
    - **`custom_widgets` is a GATE panel, never a card** — `DASHBOARD_PANEL_KEYS` excludes it or every dashboard gets an empty 12x8 box. A non-super-admin's OWN layout takes the ROLE's widgets below their panels (`resolveLayout(…, { viewerIsSuperAdmin })`): they cannot reach Reset since Arrange became super-admin-only.
    - **Measured = `LatestKeyValue.judged !== null`**, the server's answer. `quantityVerdict` (`set-point.ts`) is the band gauge's rule, called by the gauge and every widget; a faulted reading is not a reading. A raw key is never a status colour; a unit sits beside a number only.
    - **Never cut silently:** latest-values batched in 200s; 60 cards / 6 series (= the palette) / 50 table instruments, the chart and the table counting only instruments that have SENT a key, each with "Showing X of Y". `data-keys` gained `all=true` + `functionalLocationDirect=true`.
    - **The grid hands back geometry only** — `carryStoredFields` keeps each card's `style` through a drag (that was a pre-existing loss). Widget DEFINITIONS never ride on a grid item.
    - Tests: shared `dashboard-widgets.test.ts`, `dashboard-layout.test.ts`; API `e2e/dashboard-widgets.e2e.test.ts`; web `widgets/__tests__/*`, `dashboard-widget-controls.test.tsx`, `use-dashboard-layout.test.tsx`.
  - **PHASE 3 — the trend page's extra keys, per PROFILE (2026-10-29, plan `docs/superpowers/plans/2026-10-29-widget-data-keys-phase3.md`).** `instrument_profiles.display_keys` (≤ 12 TELEMETRY widget keys), written by `PUT /api/instrument-profiles/:id/display-keys` (SUPER_ADMIN, `UPDATE_INSTRUMENT_PROFILE` re-auth, audited, unchanged = no write), read through `coerceProfileDisplayKeys` (corrupt = none) on the profile GET.
    - The trend page reads its instrument's profile, the keys' current values from `latest-values` and their history from the chart / table responses it already fetches (they carry every key). `ExtraKeyCard`, an extra `TrendChartCard` (no download), and `extraColumns` on the Time Series card (RAW value, never the failure word).
    - The Keys pencil (SUPER_ADMIN, page hero) opens `DisplayKeysDialog`: Phase 2's `KeyPicker` over THIS instrument's keys with `refuse` for the two keys the page draws, and the shared `KeyDisplayRows`.
    - **Three traps the review found (fixed 2026-10-29).** The keys are the PROFILE's but the page and the picker are ONE instrument's, so: (1) a stored key may be THIS instrument's temperature / humidity key even though it was not when it was chosen (a sibling's slot key) — the page filters the list against its own resolved slot keys (`shownKeys` in `trend.tsx`), never draws it twice; (2) a stored key this instrument never sent is not in the picker — every row of `KeyDisplayRows` carries **Remove**, the only way out (also in the dashboard's Add widget dialog, which shares the rows); (3) the audit row carries the profile `name` on before / after, or the Audit Trail's `{targetName}` prints nothing.
    - Tests: `e2e/profile-display-keys.e2e.test.ts`; web `extra-keys.test.tsx`, `trend-extra-keys.test.tsx`, `display-keys-dialog.test.tsx`.

- **DEVICE CERTIFICATES — a profile can require each device to prove itself with its OWN client certificate (2026-10-27; operator: "without ssl cert i wont receive any data for only test instrument", then "both https and mqtt and other communication ways also i need to receive data when user used ssl at that time only", "yes client wants it, go ahead, only for testing profile instruments").** Design `docs/superpowers/specs/2026-10-27-device-certificates-design.md`, plan `docs/superpowers/plans/2026-10-27-device-certificates.md`.
  - **Why mutual TLS:** the server CANNOT see whether a device loaded the server's `ca.crt` — that check is inside the device, the connection looks identical either way. A certificate the device PRESENTS is the only thing the server can enforce and prove. Tell anyone who asks for "refuse data sent without SSL" exactly that.
  - **Identity = the certificate's ISSUE ID**, a random 32-hex value in the subject's `serialNumber` and stored on the instrument (`instruments.device_cert_issue_id`); the CN (the code) is informational, so a rename does not break a certificate. Re-issue / revoke replaces / clears the id and every older certificate fails at once (pinning, no CRL). **ONE decision** (`modules/instruments/device-certificate.ts`) for every channel: HTTPS + WebSocket read the issue id from an AUTHORIZED TLS socket (`issueIdFromTlsSocket` — a certificate from another CA is `authorized: false` and counts as none), MQTT from the `cert_subject` EMQX forwards to the auth hook (`""` = none, always on plain 1883; another CA is refused by EMQX at the handshake), raw TCP never has one. A gateway must present its OWN current certificate to report for a child that requires one (HTTPS/WS/TCP: the fan-out drops the child; MQTT: the hook requires it at CONNECT).
  - **The device CA is SEPARATE from the server CA** (`device-ca.pem` / `device-ca.key`, env `DEVICE_CA_CERT_PATH` / `DEVICE_CA_KEY_PATH`; the bundle's `ca.crt` is `TLS_CA_PATH`). The API holds this key to issue from the app (`@peculiar/x509` 2.1.0 + `reflect-metadata`); the server CA key stays root-only. Created ONCE and only ON REQUEST — `scripts/aws/enable-device-certificates.sh` on AWS, `DIGILOG_DEVICE_CERTIFICATES=1` for the `.deb`, `install.ps1 -EnableDeviceCertificates` on Windows — because creating it changes every TLS handshake on 443 / 8883 (a client-certificate REQUEST), which an upgrade must not bring on its own (final review, 2026-10-27); half a pair is refused, never "repaired" — a new device CA cuts off every device carrying a certificate, so back it up with the server CA.
  - **Inert until configured:** without the device CA the API does not request client certificates (`lib/https-options.ts`), EMQX's SSL listener renders `verify_none` as before, and the profile switch is refused (409 `DEVICE_CA_NOT_CONFIGURED`). With it, HTTPS and MQTTS ASK every client for a certificate naming only the device CA but REJECT NOBODY at the handshake (`rejectUnauthorized: false` / `fail_if_no_peer_cert = false`) — browsers, the EMQX auth hook and free profiles connect exactly as before.
  - **Screens:** Instruments → the instrument → **Device certificate** (Issue / Re-issue / Revoke, `INSTRUMENT_UPDATE` + ALWAYS-ON re-auth like the token; the bundle — `client.crt`, `client.key` (PKCS#1), `ca.crt` — downloads ONCE, the key is never kept). Configuration → Instrument Attributes → the profile → **Require device certificate** (SUPER_ADMIN only in the route, reason required, audited on `INSTRUMENT_PROFILE_UPDATED`; the response says how many instruments have no certificate yet).
  - **Evidence:** every refusal is a dead letter on the instrument (Rejected payloads), naming the channel and the reason, at most one per instrument + channel + reason per minute. Audit `DEVICE_CERTIFICATE_ISSUED` (with `replacedIssueId`) / `DEVICE_CERTIFICATE_REVOKED`.
  - **MQTT is judged only at CONNECT.** A switch change, issue or revoke kicks the sessions (`broker-kick.ts`) — a no-op where the EMQX API key is not provisioned; the AWS rollout script provisions it.
  - **Tests:** `device-certificate.test.ts` (decision, subject parsing, limiter), `device-ca*.test.ts`, `https-options.test.ts`, `gateway-fanout.test.ts`; e2e `device-certificate.e2e.test.ts` (routes), `device-certificate-profile-hook.e2e.test.ts` (switch + hook), `device-certificate-channels.e2e.test.ts` (inject / gateway / TCP / ws), and **`device-certificate-tls.e2e.test.ts` — the only REAL TLS test** (`app.inject` never runs a handshake); **`device-certificate-emqx.e2e.test.ts` — through the REAL local EMQX** (a temporary `ssl:dcerte2e` listener with its own listener-level authenticator pointing at the test's API, deleted afterwards; skipped when `EMQX_API_*` is not set): current certificate = CONNACK, none / older = refused; `scripts/linux/tests/render-emqx.test.sh`; web `device-certificate-card.test.tsx`, `routes/config/device-certificates/__tests__/profile-switch.test.tsx`. Mutation-checked: the response schema, the gateway rule, `socket.authorized`, `requestCert`, the render.

- **PROFILE MEASUREMENTS — every key mapping is the instrument PROFILE's (2026-10-26, phase 1 of 3; operator: "temperature and humidity keys assining or limits keys assigning configurations are there right those should be updated instrument profiles wise, each profile can receive different keys", "pressue or other differnet sensors values", "in instrument profiles NLT and MNT attributes and MKT attributes are should be enabled or disabled should come").** Design `docs/superpowers/specs/2026-10-26-profile-measurements-design.md`, plan `docs/superpowers/plans/2026-10-26-profile-measurements-phase1.md`.
  - **Where it lives:** `instrument_profiles.measurements` JSONB (nullable), one entry per measurement — `code`, `deviceKeys`, `decimals {attributeKeys, fallback}`, `high` / `low` `{enabled, limitKeys, enableKeys}` (NMT / NLT), `range {highKeys, lowKeys}`, `offsetKeys`, `mkt {enabled, attributeKeys}`. ONE zod schema (`profileMeasurementsSchema`) and ONE reader (`coerceProfileMeasurements`: NULL or unreadable = `DEFAULT_PROFILE_MEASUREMENTS`, `[]` = measures nothing) in `@digilog/shared`. Registry `measurement_types` (TEMPERATURE °C, HUMIDITY %RH). Migration `20261026120000_profile_measurements` backfilled every profile from THAT install's four config rows (`telemetry-slots`, `alarm-limits`, `sensor-range-alarms`, `sensor-offsets`), read exactly as the loaders read them — checked on two scratch DBs (no rows → shipped defaults; live rows → live values).
  - **ONE server resolver:** `modules/instruments/profile-measurements.ts` (10 s cache, invalidated by every profile write) → `InstrumentSlotConfig` per profile, shaped like the old global configs so consumers swapped only their source: overview, `/:id/telemetry` (trend, Data Report, MKT), telemetry-keys, attributes annotation, aggregate, room history, alarm summary, the evaluator, ingest offsets. It replaced FOUR duplicate readers of the global rows. **No consumer may read those four rows' key lists again** — they are left in `system_config`, unread.
  - **The profile switches are an AND gate** (`enabledBoundsFor`, `isMktOn`): profile NMT/NLT off = the bound is never enforced (withheld from the overview, never raised, an open alarm on it CLEARS); profile on = the instrument's `Enable_*` attribute decides exactly as before (absent = enabled); an empty enable-key list = always on. MKT: profile off = never; on + attribute listed = the instrument's `isMktCalculationEnabled` decides (absent = OFF, unchanged); on + no attribute = always. MKT only on a °C measurement (server-refused otherwise).
  - **Stranded alarms clear** (`alarms/stranded-decide.ts`, evaluator stranded pass): an open LIMIT / RS485 / RANGE alarm on a measurement the instrument's profile no longer has gets `clearedReason: 'MEASUREMENT_REMOVED'` merged into its snapshot, `clearedValue` NULL. Not the renamed-attribute case the limit pass deliberately leaves open — there the measurement is still monitored.
  - **Who:** a measurement change is SUPER_ADMIN-only IN THE ROUTE (`403 SUPER_ADMIN_ONLY`), under re-auth `UPDATE_INSTRUMENT_PROFILE`, with `reason` (`400 REASON_REQUIRED`); an EQUIVALENT list (case-folded; offsets blanked for a non-super-admin, who reads every `offsetKeys` empty) is a no-op for anyone — the page sends it back with the attribute keys. Phase 1 refuses codes beyond TEMPERATURE/HUMIDITY (`MEASUREMENT_NOT_SUPPORTED`). **A non-super-admin may not MOVE an instrument into a profile that measures differently** (`PUT /api/instruments/:id` → `403 MEASUREMENTS_DIFFER`) — otherwise Instrument Update could stop its alarms by moving it. A new profile starts with TEMPERATURE + HUMIDITY, never empty. `POST /api/instrument-profiles/:id/measurement-impact` counts the open alarms a proposal would clear (the editor states it before the save); `GET /api/instrument-profiles/measurement-types`.
  - **Screens:** Configuration → Instrument Attributes has a **Measurements** section per profile (`routes/config/profile-measurements/editor.tsx`, own Save). The four global pages kept only their switches and wording; "Telemetry Keys" became **Dashboard Refresh**.
  - **Two pre-existing defects fixed on the way:** the browser read the SUPER_ADMIN-only `/dynamic/telemetry-slots` for the refresh intervals, so every other role polled on the hardcoded 5 s / 10 s — `GET /api/config/telemetry-slots/refresh` now serves every role; and `use-offset-keys.ts` classified offset keys in the browser from the raw config — `GET /api/instruments/offset-keys` (every profile's, super admin only) now answers. Also: the aggregate trend card drew a limit an instrument switches OFF (now withheld like everywhere else), and the profile PUT/POST response leaked offset keys to a non-super-admin.
  - **Tests:** `profile-measurements.test.ts` (shared, 17; + 3 `isMktOn` cases in `mkt.test.ts`), `modules/instruments/__tests__/profile-measurements.test.ts` (4), `e2e/profile-measurements.e2e.test.ts` (11), `workers/__tests__/alarm-profile-measurements.test.ts` (3), `stranded-decide.test.ts` (4), the web editor (5); every older e2e kept its assertions with only its SETUP moved onto its own fixture profile (`test-support/fixture-measurements.ts`). Mutation-checked: the profile gate, the stranded rule, the response schema, the SUPER_ADMIN check. **A test must never take `instrumentProfile.findFirst()` again** — profiles differ now; three did and failed against a fixture profile reading temperature from `tx`.
  - **Next:** phase 2 (server for any number of measurements — `alarms.metric` enum → text, N-way loops) and phase 3 (screens) per the design.

- **Roles & Access → PERMISSIONS shows what the role HOLDS (2026-10-24, operator: "when permissions are allowed some are not coming to user roles, like instruments creation or functional locations creation").** `GET /api/config/roles/:role` derives every toggle from `roles.permissions` through `privilegeTogglesFromPermissions` (`@digilog/shared`, beside the forward map it inverts): ON iff the role holds the node's GATE — the rule `useCan()` and `requirePermission` apply — and a gateless node iff it holds that node's OWN permissions (`primaryPermissionsOf`: not another node's gate; no configurable node is gateless since `users.delete` left the tab, the rule stays for the next one). **"Holds" is the SERVER's rule everywhere** (`hasEffectivePermission`: X_MANAGE covers X_CREATE/_UPDATE/_DELETE/_VIEW/_READ/_EXPORT) — `useCan`, the sidebar, `RequireRole`, every inline page check and this tab call it, so a button, a menu, a page and the tab can never disagree with the route. **Every toggle on the tab must be able to take effect**: on 2026-10-24 Alarm Rules (deleted — same grants as Alarm Webhooks), Dashboards Create/Manage/Assign (parked module, no screen), Delete Users and Update Field Labels (SUPER_ADMIN-only route / screen) left the tab, and `apps/api/scripts/strip-unused-permissions.ts` stripped those permissions and the never-offered NOTIFICATION_CREATE/_UPDATE/_MANAGE and BACKUP_MANAGE from roles — a permission no toggle maps is one the tab can neither show nor revoke, and X_MANAGE would hold the matching View ON for good. Adding a node: make it configurable only if a non-SUPER_ADMIN can actually reach what it gates. **Export Audit Trail is checked by the server** on both export paths (`assertMayExportReport`), not only by the button. **The Backup toggles open Configuration → Backup by themselves** (guards, sidebar, card; the index skips the access-matrix fetch without CONFIG_READ) — every other Configuration card is still chosen per role on Configuration Access. Two properties pin it: a save of what the tab shows adds only the dependency of something already held, and never DROPS a held permission — the save rebuilds the mapped set from the toggles, so a held permission no ON toggle covers would be silently revoked. **Never "any of the node's `permissions`"**: that set carries the READ dependency, and that rule showed Create / Edit / Delete Instruments ON for a role holding only `INSTRUMENT_READ` (and Delete Audit Record for `AUDIT_READ`) while the user had no button and the route said 403. **The stored `role_configs.permissions` map is NOT read back** — it is only what the last Permissions save sent, and the Sidebar tab's auto-grant, `PUT /api/roles/:name` and the seed all move `roles.permissions` without it. Two traps that follow: (1) **the tab sends its WHOLE map on save**, so any false ON becomes a real grant on the next save — keep the display honest or it escalates; (2) toggles sharing one grant move together (Settings Edit = Edit Instruments = `INSTRUMENT_UPDATE`; the Instruments / Data Report / Settings View pages are all `INSTRUMENT_READ`), which the tab now shows because it re-reads the server after a save. A non-SUPER_ADMIN still cannot grant what it does not hold (API-1): ADMIN holds no `INSTRUMENT_CREATE` / `FUNCTIONAL_LOCATION_*` here, so only SUPER_ADMIN can grant those. A Permissions save also re-adds the sidebar-implied View permission of every enabled sidebar item, so an unticked View bounces back while that menu is enabled. Pinned by `e2e/role-permission-toggles.e2e.test.ts` and the property test in `permission-tree.test.ts`.
  - **A toggle another toggle or a sidebar item HOLDS is shown held, before the save (2026-11-03, operator: "for some permissions, after un-selecting them and saving, those are not updating").** The bounce above is RIGHT — a role that may edit users must read them — and the tab now says so the moment the toggle is un-selected, instead of flipping it back after the save. **The rebuild a save writes is ONE shared function**, `rebuildRolePermissions` in `@digilog/shared` `permission-tree.ts`, with `primaryPermissionsForSidebarItem` and its admin-requests opt-out; the API's `planRolePermissions` calls it, and `roles-components/held-toggles.ts` runs it per render on the tab's own toggles and the role's STORED sidebar items (the PUT sends none), with `currentPermissions: []`, then reads the result back through `privilegeTogglesFromPermissions`. Those are the server's two functions, never a copy. A toggle OFF in the tab but ON in that result renders CHECKED and DISABLED (`data-held`, `aria-disabled`, the caption as its `aria-describedby`) with "Held by …". The caption names every ON toggle and every enabled sidebar item that holds it BY ITSELF. Every `hasEffectivePermission` rule is one permission covering another, so asking each source alone cannot miss a holder; removing one source at a time can, because View Users stays held while any of five Users toggles is on. With every other toggle on, these eleven come back: View Users, View Configuration, View Alarm Webhooks, View Audit Trail, View Instruments, View Functional Locations, View Alarms, View Data Report, View Reports, View Settings, and Edit Settings, which Edit Instruments' `INSTRUMENT_UPDATE` implies. Counters and Enable All count held toggles as on. Disable All looks only at the role's own toggles. The PUT still sends the user's own toggles. **A permission granted outside the tab is named too (same day).** `GET /api/config/roles/:role` returns `permissionsHeld`, the role's raw array, declared in the response schema. It goes only to a ROLE_MANAGE caller, because raw arrays are ROLE_MANAGE's on `GET /api/roles` and this GET needs only CONFIG_READ. The tab passes it as `currentPermissions`, so its view equals the server's exactly. A save keeps every permission no toggle maps, and an unstripped X_MANAGE covers X_VIEW / X_DELETE / X_EXPORT. AWS still owes `strip-unused-permissions`, and the local SUPER_ADMIN still carries several. Such a holder is captioned "Held by a permission granted outside this tab: DASHBOARD_MANAGE". A toggle's OWN grant is never named so: ALARM_RULE_MANAGE is Alarm Webhooks Manage's grant, the save rebuilds it from that toggle, and View Alarm Webhooks is held by the toggle and freed with it. A caller without ROLE_MANAGE gets no `permissionsHeld`, so its tab sees `[]` and such a holder goes unnamed. **Known gap:** un-selecting only a held toggle still asks for a reason, though the save changes nothing. Pinned by `packages/shared/src/types/__tests__/role-permission-rebuild.test.ts` (against the API's former algebra, order included), `held-toggles.test.ts`, `permissions-tab-held.test.tsx`, and the prediction-equals-answer case in `role-permission-toggles.e2e.test.ts`.

- **Instrument VISIBILITY (2026-08-13, project D; extended 2026-08-28).** `instrument_scope` JSONB on **both** `role_configs` and `user_configs`. **`NULL` = inherit (user → role → unrestricted); an empty selection = SEE NOTHING; otherwise = those functional locations (Blocks expanding to their Areas) UNIONED with those explicitly named instruments.** **TWO SHAPES live in that column, permanently:** rows written before 2026-08-28 are a bare `string[]` of location ids; rows since are `{locationIds, instrumentIds}`. Legacy rows are deliberately NEVER migrated, so `normalizeScope()` in `modules/instruments/visibility.ts` is the ONE reader of both — a second `Array.isArray` test anywhere reads a legacy restricted row as "nothing stored", which means UNRESTRICTED. Resolved once in that same module; a user scope REPLACES the role's and can widen it. Enforced **on the query** — the list merges it into the same `where` the count uses, `GET /:id`, `/:id/telemetry`, `/:id/telemetry-keys` and `/:id/dead-letters` apply it in the lookup and 404 (never 403, which would confirm existence), the overview ANDs selection with visibility, and `GET /api/floorplans/:id/rooms/:roomId/history` filters the room's MEMBERSHIP query. `scopeToWhere` emits `{OR: [{functionalLocationId:{in}}, {id:{in}}]}` with **both branches always present** — `{OR: []}` matches nothing in Prisma while `{}` matches everything. **Unassigned instruments are invisible to the LOCATION branch but ARE reachable by being named outright** (changed 2026-08-28 — assigning a freshly commissioned device must not silently do nothing). Writing a NULL needs `Prisma.DbNull`, never `JsonNull`. Admin surface: Config → Roles & Access → Instrument Scope, whose instrument picker reads the deliberately UNSCOPED `GET /api/roles/instrument-scope/instruments` (ROLE_MANAGE) — a scoped picker would let a restricted admin build a scope silently omitting the rest of the plant. `GET /api/floorplans/:id` is knowingly unscoped: it lists instrument identity per room and is fetched ONLY by the Config → Floorplans editor (verified 2026-08-28), not by the dashboard, which uses `GET /api/floorplans` (rooms only). Prove behaviour with `apps/api/scripts/probe-visibility.ts` and `src/e2e/instrument-scope-selection.test.ts`. **Creation is scoped too (2026-10-26):** a limited caller must register an instrument INTO a location it sees (`functionalLocationId` on create / bulk; 400 `LOCATION_REQUIRED` / `LOCATION_OUT_OF_SCOPE`), enforced in `createWithCredential` by reading the new row back through the caller's fragment before the credential and audit row — on AWS a MAINTENANCE user created two instruments with no location and every following request 404'd. Never add the new instrument to the creator's scope instead (silent access-control rewrite). `placeableLocationIds()` is the one rule for the pickers (`placeable` / `placementRequired` on the FL tree). A child's `GET /:id` carries `gatewayCode` + `gatewayVisible`; never look a related instrument up by id from the browser — the gateway is usually in no location. Proof: `src/e2e/instrument-create-scope.e2e.test.ts`.

- **LAYOUT DESIGNER (2026-09-22, operator: "in configurations give one
  configuration prepare layouts. like starts with empty one, draw shapes room
  redesigns and room to room linking, or empty space in between rooms like
  corridor …").** `routes/config/layout-designer/` REPLACED `floorplans.tsx`
  at the same path `/config/floorplans` (a **Layout Designer** card was added
  to the Configuration page; the old page had none). Spec
  `docs/superpowers/specs/2026-09-22-layout-designer-design.md`. Five decisions
  by question: free polygons; replace, not a second editor; links are BOTH an
  opening in a shared wall and a drawn connector; a corridor is a drawn space;
  points BESIDE the box.
  - **`floorplan_rooms.points` is the outline; `x/y/w/h` is its BOUNDING BOX,
    derived by the server on every write.** NULL points = a rectangle, which is
    every existing room and every room `draw-cwh-floorplan.ts` writes — so the
    eight plans, the trace scripts and every box reader (tiles, room history,
    telemetry overview) are untouched. An OMITTED `points` on PUT keeps the
    polygon AND its derived box; only an explicit null flattens it.
  - **Doors name an `edge` on a polygon, a `wall` on a rectangle; `doorEdge()`
    in `@digilog/shared` is the ONE converter** (top/right/bottom/left = edges
    0..3 of the corners top-left, top-right, bottom-right, bottom-left). On the
    web, `doorToEdgeOpening()` ALSO mirrors a bottom/left door's fraction,
    because those two edges run the other way round a clockwise outline — drop
    that and every stored bottom-wall door jumps to the far end of its wall.
  - **Links are a table (`FloorplanRoomLink`, models 36 → 37; `kind` a
    validated string, enums unchanged).** An OPENING is stored ONCE, on
    `fromRoom`'s edge, and mirrored onto the neighbour at render
    (`mirrorOpening`); the API refuses one the rooms' real outlines cannot
    carry (`NOT_ADJACENT`). A CONNECTOR is a dashed centroid-to-centroid line.
    Three routes, three audit actions (103 → 106 / 97 → 100).
  - **The readings tiles lay out in `largestInscribedRect(outline)`**, so an
    L-shaped room never hangs a tile outside a wall; for a rectangle that IS
    the box. The polygon maths is ONE shared module
    (`packages/shared/src/types/floorplan-geometry.ts`) used by the API's
    validation, the designer and the dashboard — do not re-implement any of it
    on either side.
  - Config pages 23 → **22** (`floorplans.tsx` went; the designer is a folder);
    `<Route` count unchanged. **Not seen on screen** — pinned by 8 API e2e, 20
    shared unit, 5 page, 6 tool, 7 snapping and 4 render tests, several
    mutation-checked.
  - **The designer AUTHORS the 2D architectural style (2026-10-05, operator:
    "layout designer feature is should able to create 2d design model"; chose
    full 2D authoring of three).** A plan has a STYLE (Plan panel: Standard /
    2D; a NEW plan is 2D), floor group / label / order and north; five
    structure tools (Column, Equipment, Window, Wall stub, Label) write
    `annotations.{columns,equipment,windows,walls,labels}` — the SAME shape
    the trace scripts write, so the dashboard changed NOTHING (pinned by
    `floorplan-designer-2d.test.tsx`); doors gain hinge / swing / width and a
    Double leaf action (two half-width doors with mirrored hinges, `splitDoor`
    in `@digilog/shared`; no flag). The API's `floorplanSchema` gained
    `annotationsSchema` (bounded; omitted = untouched, given = replaced whole,
    `null` refused — mutation-checked) and the plan audit rows carry a COUNT
    summary (`annotationsSummary`), never the arrays. `segmentOnEdge` snaps a
    window / stub drawn along a wall onto it; a window is stored as the thin
    box the traces store (`WINDOW_DEPTH`). The structure tools show ONLY on a
    2D plan (mutation-checked); the Delete key takes a selected element, never
    the room beside it (mutation-checked). The five script-drawn plans
    (`SCRIPT_DRAWN_PLANS`) stay script-owned and the Plan panel says so. Spec
    `docs/superpowers/specs/2026-10-05-layout-designer-2d-design.md`, plan
    `docs/superpowers/plans/2026-10-05-layout-designer-2d.md`. No count moved.
- **The MQTT client id and topic segment are the instrument CODE (2026-09-04).**
  Operator: "35dd00b3-… this is CWH/RDU/001-00 instrument mqtt client id, i want
  client id as CWH/RDU/001-00". It was the code until 2026-08-07, the UUID from
  then until this change, and the code again now. **No count moved** — no model,
  enum, migration, permission, reauth action, config def, page or route.
  - **`/` is allowed in a code and appears in 100 of 101.** The broker
    substitutes `${clientid}` literally, so `instruments/CWH/RDU/001-00/telemetry`
    is that instrument's exact topic. The bridge therefore subscribes
    `instruments/#` (`+` is exactly one level) and `parseTelemetryTopic` matches a
    FIXED prefix and suffix instead of counting segments. It also receives its
    own retained downlinks and drops them SILENTLY (`isDownlinkTopic`).
  - **The hole the UUID interlude closed is closed at REGISTRATION instead.**
    `instrumentCodeTopicViolation()` in `@digilog/shared` refuses `+`, `#`, NUL,
    and a LAST segment of `telemetry`/`attributes`/`children` — the reserved word
    matters because the bridge reads the topic KIND from the last segment, and a
    child coded `X/telemetry` would have its downlink parsed as telemetry from
    `<gw>/attributes/X`. Applied by the zod schema, `bulk-csv.ts` and the create
    form (which otherwise shows a generic "Could not create" on a 400 whose body
    is a zod flatten). **Do not relax it** — the 2026-08-08 memory's `+` test is
    still the regression test, and it was re-proven live on 2026-09-04.
  - **SUPERSEDED 2026-09-16 — the registration guard was REMOVED at the
    operator's instruction** ("in instrument creation page also same remove
    instrument id restriction popup"; offered "keep the rule, no popup" and
    "derive a safe client id", chose "remove the rule entirely" with the
    consequence stated). `instrumentCodeTopicViolation` and
    `MQTT_RESERVED_TOPIC_SEGMENTS` are gone from `@digilog/shared`;
    `codeSchema` is `z.string().min(1)`; the create form, the CSV importer and
    the Settings editor apply no character rule. **What that costs, stated
    once here and in `codeSchema`'s comment:** an ID containing `+` or `#`
    cannot publish (the broker refuses a wildcard in a publish topic — the
    device fails silently where the form used to fail visibly); under the file
    ACL a `+` client id matches every instrument's topics; and an ID whose last
    segment is a topic keyword can have a child's downlink parsed as that kind
    of message. None of the 101 live codes carries any of these (measured
    before removal). The auth hook's exact-string clientid ↔ code comparison
    is unchanged. The bullet above is history.
  - **One identity, no UUID fallback**, by the operator's choice: a device still
    configured with its UUID is refused at CONNECT (`Not authorized`), where the
    failure is visible, rather than admitted and denied topic by topic.
  - **The auth hook ALSO admits the ingest BRIDGE (2026-09-08)** by
    `MQTT_USERNAME` / `MQTT_PASSWORD` (constant-time compare over SHA-256
    digests; the bridge NAME with a wrong password is a deny, never a
    fall-through to the token path). Why: the `Setup.exe` installer now
    BUNDLES EMQX 5.3.2 (`scripts/build-installer.ps1 -EmqxZip`,
    `scripts/provision-emqx.ps1`, templates in `scripts/emqx/`) and configures
    ONE authenticator, so no dashboard user or API key has to be created on a
    customer machine. The dev box still has its built-in-database user ahead of
    the hook; both work. Pinned by `e2e/mqtt-auth.test.ts`. The installer's
    third service is `emqx` (erlsrv via `emqx.cmd install`); the API does not
    depend on it. `docs/PHARMA_DEPLOYMENT_21CFR.md` §4a is the runbook.
  - **Downlink and roster slots are keyed on codes** (`attributeDownlinkTopic`,
    `childRosterTopic`; the routes resolve the gateway's code). The 102 retained
    UUID-keyed slots on the local broker were cleared and republished code-keyed
    by `scripts/migrate-mqtt-topics-to-code.ts` (dry run by default) — a stranded
    retained slot reads as current state to anyone looking at the broker.
  - **The gateway batch accepts a LIST (2026-09-05):**
    `{"devices":[{"devN":"<code>",…},…]}` beside the code-keyed object.
    `parsePayload` folds the list onto `dev1..devN`; `fanoutDevices` takes a
    string `devN` as the code and strips it from the readings; same child-map
    authorisation, dead-lettered by code. "Instrument id" = the CODE, never the
    UUID. **And a GATEWAY's FLAT payload carrying a string `devN` is a
    one-block batch routed to that child** (`ingest-core.ts`) — the plant
    firmware's one-child-per-message form, found in the data: 110 such
    messages had landed on IOTGW01 itself before this. Keys on the wire are
    `t` / `h` (already in the alias lists).
  - **A THIRD topic per gateway (2026-09-05): the child attribute CHANGE
    EVENT**, `instruments/<gw>/children/attributes` — published only when a
    child's attribute changes (app or device report), NOT retained, carrying
    ONLY the changed key under the child's `devN`
    (`{"gateway","devices":[{"devN","<key>":"<value>"}]}`, `null` =
    removed). Reshaped twice in a day at the operator's direction (whole-set
    retained bundle → changed child's full set → the key alone). Membership
    publishes nothing there; the per-child slots stay retained for state. ACL
    subscribe line widened (boot-only — restarted here, AWS needs the same).
    `LOCAL_SETUP_WINDOWS.md` §9C.1.
  - **RTC sync (2026-09-05):** device publishes `{"method":"getTime"}` on
    `instruments/<code>/rtc-request`; the platform publishes
    `{"unix":<epoch-ms NUMBER, 13 digits>}` — the only key — on the GLOBAL `digilog/rtc/time` — at
    once on a request and every 10 minutes on the boundary (`RTC_TICK_MS`; `startRtcTicker` in
    `app.ts`). Outside `instruments/` on purpose (no bridge echo, one ACL
    grant). `rtc-request` reserved. Three ACL edits; AWS needs them.
  - **`emqx-5.3.2/etc/acl.conf` changed and the broker was restarted**: bridge
    subscribe/publish → `instruments/#`; the 2026-09-03 TEMPORARY TEST GRANT for
    client id `35dd00b3-…` removed. **The AWS broker needs the same edit and
    restart when this deploys, and the one live device (CWH/RDU/001-00, direct
    MQTT) must be reconfigured to its code.** Proven live 2026-09-04: connect as
    code accepted, reading lands, UUID refused, foreign token/code refused,
    foreign topic publish and subscribe refused.
- **A SUPER_ADMIN can DELETE a functional location WITH everything in it
  (2026-10-03, operator: "add delete option for functional locations for
  super admin").** `DELETE /api/functional-locations/:id?cascade=true`:
  the Block's Areas go, every instrument in any of them is UNLINKED (never
  deleted), one `FUNCTIONAL_LOCATION_DELETED` audit row per location naming
  the instruments released, one transaction. Any other role holding
  `FUNCTIONAL_LOCATION_DELETE` keeps the 409 for a non-empty location and
  gets 403 `SUPER_ADMIN_ONLY` for the cascade; an empty location deletes for
  either. **A cascade does NOT rewrite** a role / user `instrument_scope` or
  an alarm-webhook scope that named the location — the stale id grants
  nothing until re-scoped. Web: `routes/functional-locations/
  delete-location.tsx` is the ONE flow (`deletePlan` pure; confirm → re-auth
  → DELETE) behind the trash buttons on the list page's Block cards and Area
  rows and the detail page's Delete. Also fixed: the list page's Arrange
  buttons gated on a nonexistent `functional_locations.update` node (it is
  `.edit`); and `audit_trail.signature_meaning` is `VARCHAR(255)` behind a
  RAW insert, so a meaning over that is a 500 — the order route's listed
  every block name; `boundedMeaning()` in `functional-locations/routes.ts`
  bounds it. **Keep every `signatureMeaning` under 255 characters.** No
  count moved.
- **Instrument grouping — THREE concepts, one job each (2026-08-13).** Do not confuse them: **`FunctionalLocation`** (Block > Area tree, `Instrument.functionalLocationId`) is the AUTHORITATIVE logical grouping; **`roomId`** → `FloorplanRoom` is geometry on a drawn plan and drives the graphical view; **`profileId`** is device type. The free-text `Instrument.block` / `.area` columns are SUPERSEDED — no longer read for grouping, kept only so the migration stays comparable. A Block's instruments are its own PLUS its Areas', resolved by `functional-locations/tree.ts:resolveLocationIds()`; querying `functionalLocationId = :id` directly silently omits the Areas.
- **Config:** **35 definitions** (`apps/api/src/modules/config/defs/*.def.ts`) + auto-discovery (34 → 35 on 2026-10-05: `telemetry-retention.def.ts`, no page — audit DATA-9; 33 → 34 on 2026-10-01: `sensor-offsets.def.ts`, no page), **22** corresponding pages (pages 23 → 22 on 2026-10-05: `alarm-rule-dialog.tsx` deleted, audit WEB-8 — see System Stats; pages 22 → 23 on 2026-10-01: `report-settings.tsx`; defs 32 → 33 on 2026-10-01: `report-downloads.def.ts`, no page; pages 23 → 22 on 2026-09-22: `floorplans.tsx` → the `layout-designer/` folder; both re-derived `ls | wc -l` 2026-09-16: defs 31 → 32 with `attribute-labels.def.ts`, which adds NO page — its Display name column lives on `instrument-attributes.tsx`; earlier defs re-derived 2026-09-07, 30 → 31 with `report-approvers.def.ts`; both re-derived 2026-09-01; defs 29 → 30 that day with `trend-widgets.def.ts`, which adds no page — it renders through the dynamic config page; the page count read 24 here and in System Stats above until then and was **stale, not moved** — `alarm-rules.tsx` went with the 2026-08-31 rule removal and neither line was re-synced. This is the THIRD time this bullet has drifted from the one above it; the duplication itself is the defect it keeps warning about). **This bullet's def count went stale TWICE while the System Stats section above was current — 25 here against 26 then 27 there.** It is the same self-contradiction the 2026-08-29 audit raised as finding M8 for the page count, in the same bullet, and re-syncing only the half that was wrong that day is why it came back. Two live inventory lines for one number is the actual defect; re-derive both from `ls` whenever either moves. Defs 25 → 26 → 27 on 2026-08-31 (`inactivity-alarms.def.ts`, then `rs485-alarms.def.ts` — both render through the dynamic config page, so the page count did not move). Earlier note, still true: the 25 predated `dashboard-cards.tsx` being deleted on 2026-08-28. Defs verified `ls` 2026-08-27, unchanged at 25 — the def and page counts are NOT equal and should not be expected to be: `alarm-webhooks.tsx` is a page with no def (a CRUD module, not a `system_config` row), and several defs render through the dynamic config page with no file of their own. Earlier: pages 25 → 24 the same day — `routes/config/role-assignments.tsx` deleted as dead code: its 7 config defs went in the Phase 0 strip and `system_config` held 0 rows for them, so every section read an unregistered `/api/config/dynamic/<key>` route. Earlier counts VERIFIED by `ls` 2026-08-17 — `alarm-limits.def.ts` added 2026-08-17: super-admin config for the instrument-limit alarm work — an ordered alias list of attribute keys per bound (High/Low Temperature/Humidity Limit), since this install's keys have already drifted; plus a master switch and four status wordings. (It also carried a `severity`
  select until 2026-09-01, when severity stopped being administered anywhere; the
  def count did not move — a setting was removed, not a def.) Renders through the dynamic config page, so no `routes/config/*.tsx` of its own — the page count stays 25. The "23 corresponding pages" recorded here 2026-08-11 was already stale before this change (the live page count was 25, per `apps/web/CLAUDE.md`'s 2026-08-14 verification); it was never re-synced here until now. Earlier: `telemetry-slots.def.ts` added 2026-08-11: which telemetry keys the dashboard reads as temperature and humidity, since ingest stores whatever key a device sends. Renders through the dynamic config page, so no `routes/config/*.tsx` of its own; the Floorplans placement editor IS a page. Earlier counts VERIFIED by `ls` 2026-08-07 — the previous "36 / 34" was inherited from DigiLog and was never true in this fork; `instrument-attributes.def.ts` added 2026-08-07 — the attribute keys the New Instrument form asks for, renders via the dynamic config page so no new `routes/config/*.tsx`)
- [Keys per instrument PROFILE since 2026-10-26 — see PROFILE MEASUREMENTS, top of part 1.] **Display precision (2026-08-19):** decimal places for temperature/humidity come from each
  INSTRUMENT's own attributes — `temp_decimals` / `humid_decimals`, `0` meaning whole numbers —
  NOT from a site-wide setting. The two numbers left in `telemetry-slots` are only the fallback
  for an instrument declaring neither; the two alias lists beside them name the attribute keys.
  Resolution is server-side (`@digilog/shared/telemetry-decimals` + `modules/instruments/decimals.ts`)
  and rides on the telemetry payloads, so nothing in the browser re-derives it. Alarms FREEZE the
  precision onto `ruleSnapshot.decimals` at raise time — a §11 record must read back the way it was
  seen. Counts unchanged: no new def (25), page (25), module (23), model (34) or enum (13).
- **Instrument ATTRIBUTE ACCESS (2026-08-19).** `role_configs.attribute_access` JSONB, nullable.
  **NULL = inherit = the pre-2026-08-19 behaviour (editable iff the role holds `INSTRUMENT_UPDATE`);
  `ALL_EDIT`; `ALL_VIEW`; `SELECTED` + `keys[]`.** Plus `requireReauth` per role. The rule NARROWS
  `INSTRUMENT_UPDATE` and never widens it — a role without it is read-only whatever is stored.
  Editable covers change, add and delete; SELECTED still permits ADDING a new key (it cannot
  overwrite a protected one). Decisions live in `@digilog/shared/attribute-access` and are enforced
  by ONE gate (`modules/instruments/attribute-access.ts`) shared by POST/PUT/DELETE; the panel only
  renders what that allows. **Changing or deleting an attribute now REQUIRES a `reason`** (audit
  `reason` column; a first fill does not). Admin surface until 2026-10-24: Config → Roles & Access → Attribute Access (MOVED — see below).
  **2026-10-24 — PER USER too, and MOVED** (operator: "who can edit which attributes … configurable role wise or
  user wise"). `user_configs.attribute_access` (same shape; migration `20261024120000_user_attribute_access`).
  The user rule and the role rule COMBINE — `effectiveAttributeAccess` in `@digilog/shared`: no user rule = the
  role's; role not configured = ALL_EDIT (user's re-auth still applies); ALL_EDIT either side wins; ALL_VIEW only
  if both; else SELECTED = union of keys (case-folded); `requireReauth` = either. So a user rule only ADDS editing —
  to restrict one person below their role, give them another role. Still needs Edit Instruments on the role.
  `loadAttributeAccess(role, userId)` — `userId` REQUIRED — feeds all four gates and `/attribute-access/me`, so the
  Settings page and the Attributes panel show the combined rule unchanged. Admin: Configuration → **Attribute Edit
  Access** (`/config/attribute-access`, SUPER_ADMIN; Roles tab = the old editor, Users tab = the new one with the
  role's rule, the server-computed combined rule, and a warning when the role lacks Edit Instruments); the Roles &
  Access tab is GONE. `GET /api/roles/attribute-access/users`, `PUT /api/roles/attribute-access/user/:userId`
  (ROLE_MANAGE, UPDATE_ROLE_CONFIG re-auth, `assertCanConfigureUser`). **A reason is REQUIRED on both the role and
  the user save** since this date (the role save took none before).
  After the whole-branch review: a USER rule cannot be View only (it could restrict nothing under combine; 400);
  `requireReauth` is stored and counted only on a rule that grants editing (never on ALL_VIEW); the Users tab lists
  EVERY user with status, so a rule on a locked/disabled account stays visible and revocable; and it warns that a
  user's own rule SURVIVES a role change (nothing clears it).
  Migration `20260819120000_role_attribute_access`, drift guard PASS, applied to both databases.
- **Themes:** 10 preset color themes (Ocean / Sapphire / Emerald / Amethyst / Sunset / Slate / Ruby / Forest / Midnight / Coral)
- **Frontend:** **56** Routes in `main.tsx` (54 → 56 on 2026-10-29: `/dashboards`, `/dashboards/:id`; 53 → 54 on 2026-10-24: `/config/attribute-access`; 52 → 53 on 2026-10-01: `/config/report-settings`; 53 → 52 on 2026-09-19: `/home` removed with the Home sidebar item — re-derived `grep -cE "<Route"`; unchanged on 2026-09-16 — a `/config/attribute-labels` route lived for a few hours and went the same day; 52 → 53 on 2026-09-08: `/settings`, the Settings page; 51 → 52 on 2026-09-07: `/reports`, the report review workflow; 50 → 51 the same day: `/data-report`, the Instrument History widget's own page; re-derived `grep -cE "<Route"` that day. Earlier, re-derived 2026-09-03 — this line read **51** and was ALREADY STALE: the 2026-08-31 alarm-rules removal took it 51 → 50 and re-synced only the System Stats copy above, which is the same duplicate-inventory defect this file keeps warning about. Earlier verified 2026-08-29 — 50 → 51: `/config/export-options` registered, having never been reachable. Earlier verified 2026-08-27 — 49 → 50: new `/config/alarm-webhooks` page; earlier 48 → 49 on 2026-08-24: the `/instruments/:id/trend` page; the "77" was inherited from upstream DigiLog and was never true in this fork; `/config/role-assignments` removed 2026-08-19 as dead code, 49 → 48), **26** custom hooks (25 → 26 on 2026-10-05: `use-row-keys.ts`, stable React keys for editable rows with no id of their own — audit WEB-14; re-derived `ls apps/web/src/hooks/ | wc -l`; 24 → 25 on 2026-10-01: `use-offset-keys.ts`, which keys get the + / - offset input; 23 → 24 the same day: `use-report-downloads.ts`, the ONE reader of the per-type download policy; 22 → 23 on 2026-09-16: `use-attribute-labels.ts`, the ONE browser reader of the attribute display names; earlier 20 → 22, re-derived `ls apps/web/src/hooks/ | wc -l` 2026-09-03 — ALREADY STALE, nothing on 2026-09-03 added a hook; earlier 18 → 20 on 2026-08-29, audit finding M8), **24** lib modules (22 → 24 on 2026-10-31, dashboard builder phase 2: `lib/refusal.ts`, the ONE rule for a refused request, and `lib/polling.ts`, the dashboards' ONE polling and retry policy; 21 → 22 on 2026-10-05: `lib/safe-storage.ts`, the ONE door to `localStorage` / `sessionStorage` — every access goes through it and none can throw, audit WEB-3; re-derived `ls apps/web/src/lib/ | wc -l`; 20 → 21 on 2026-10-01: `lib/report-delivery.ts`, the ONE place a built report is downloaded or requested; 19 → 20 on 2026-09-03: `lib/document-identity.ts`, the browser-tab applier) (`ls apps/web/src/hooks/ | wc -l` / `ls apps/web/src/lib/ | wc -l`, each including its own `__tests__` subfolder as one entry — lib 18 → 19 corrected 2026-08-27: `lib/background-style.ts` landed with the wallpaper work (`764fff5`) and this line was never re-synced; the 2026-08-27 trend-sampling work added NO lib module — the "26 / 30" this file carried for months was never true against the live tree and was never re-verified until now)
- **Queue backend:** graphile-worker (Postgres-backed); **6** worker tasks —
  `notification`, `password_expiry_check`, `session_sweep`,
  `telemetry_partition_maintenance`, `alarm_evaluation`, `alarm_webhook`
  (verified 2026-08-27 against the `taskList` in `apps/api/src/app.ts:458-489`;
  5 → 6 that day). `alarm_webhook` is **event-driven and deliberately has NO
  `crontab.txt` entry** — a scheduled buzz would announce an excursion that has
  already gone. A task identifier with no handler leaks jobs forever, so if you
  ever remove the handler, remove the enqueue with it. This file listed
  "3 tasks (`notification`, `pm_overdue_check`, `session_sweep`)" until then;
  **`pm_overdue_check` does not exist anywhere in the tree** (`grep -r
  pm_overdue_check apps/api/src packages/` → 0 hits) — it was the filter
  domain's PM scheduler and went with that strip. Re-derive from the
  `taskList` literal, never from this line.
- **Tenancy:** **single-tenant, single-site, single-company.** Multi-tenancy was removed 2026-04-30 (`Organization` model + `organizationId` columns + `org-admin`/`tenant-admin` modules dropped). JWT `scope` always stamps `GLOBAL`. The `RoleScope` enum and `AssigneeType` enum are retained but trimmed to one/two values respectively.

## Key API Endpoints and feature notes (part 2)

## Key API Endpoints (instrument dashboard — updated 2026-08-27)
```
GET  /api/instruments/telemetry-overview        — every instrument's current temp + RH, one request.
                                                  Carries THREE placement facts per row and they are
                                                  three DIFFERENT things (2026-09-01):
                                                  `functionalLocationName` (the authoritative Block >
                                                  Area grouping — the dashboard's **Area** column),
                                                  `locationAttribute` (the instrument's own `Location`
                                                  ATTRIBUTE, **not** the superseded `Instrument.location`
                                                  COLUMN of the same name — the **Location** column),
                                                  and `room` (geometry on a drawn plan — **Room**, and
                                                  the visible source of the SET POINT columns).
                                                  Both new fields are DECLARED in the 200 block; a
                                                  field the builder returns and the schema omits is
                                                  stripped silently, which has bitten this endpoint
                                                  five times now.
GET  /api/instruments/telemetry-history?instrumentIds=a,b&from=&to=&limit=&offset=
                                                — (2026-09-05) the merged, paged readings of SEVERAL
                                                  instruments, newest first: the Data Report page's
                                                  history widget. One row per (instrument, instant),
                                                  pivoted in SQL so a page cannot split an instant's
                                                  temperature from its humidity; `values` RAW — the
                                                  slot keys, limits and precision come from
                                                  `telemetry-overview`. Visibility is applied to the
                                                  ID SET (out of scope = absent, never 403). `values`
                                                  is declared `additionalProperties: true` — an object
                                                  schema without it is stripped to `{}` silently.
GET  /api/alarms?search=&from=&to=&type=&status=&severity=&page=&pageSize=&sort=&dir=
                                                — the Alarms page. Filters, counts, sorts and pages
                                                  SERVER-side (2026-08-31); returns `data`, `total`
                                                  and `counts` (the four state counts). `total` is
                                                  DERIVED by summing `counts`, never counted
                                                  separately, and the `status` filter is excluded
                                                  from the count query alone so choosing a box does
                                                  not zero the other three. A bad date or reversed
                                                  range is a 400 by field; an unknown `sort` falls
                                                  back. Legacy `state`/`acknowledged`/`instrumentId`/
                                                  `functionalLocationId`/`limit` still work — `limit`
                                                  is an alias for `pageSize` (ceiling 500) and the
                                                  dashboard panel + trend widget still send it.
                                                  Filter algebra: `modules/alarms/list-query.ts`.
                                                  Rows carry BOTH `locationAttribute` (the
                                                  instrument's own `Location` ATTRIBUTE, which the
                                                  Location column PRINTS since 2026-09-01) and
                                                  `locationName` (the FUNCTIONAL location, which it
                                                  falls back to). Both are SEARCHABLE — a column
                                                  that displays one and searches the other reads as
                                                  a broken search box.
                                                  NOT `roomLabel` — dropped 2026-08-31
                                                  with the column's room line, because every room
                                                  was then coded with its instrument's own code.
                                                  The room CODE is still SEARCHABLE.
                                                  **That premise no longer holds for QC** (see the
                                                  traced-QC-floor note below): its rooms are coded
                                                  `CWH-I/216`..`/233` and labelled with the room
                                                  name, so searching an instrument code no longer
                                                  matches its room there, and a room line WOULD now
                                                  carry information on that floor. Not restored —
                                                  it would be blank on the seven generated plans.
GET  /api/instruments/:id/telemetry?from=&to=&offset=  — per-instrument history, paged (offset added 2026-08-24)
GET  /api/instruments/:id/telemetry?from=&to=&points=N — the CHART path (added 2026-08-27): every
                                                  reading in the range, LTTB-downsampled to N per key
                                                  (1..5000, out of range = 400, never a silent clamp),
                                                  plus `historyTotal` (the TRUE count in range),
                                                  `historySampled`, and `summaries[key]`
                                                  {count, numericCount, min, max, avg, first, last,
                                                   below/above/outOfSpecCount, limitMin, limitMax}
                                                  computed in SQL over EVERY reading in the range.
                                                  `points` omitted = the old paged table path, unchanged.
GET  /api/instruments/:id/telemetry-keys        — distinct telemetry keys this instrument has sent (added 2026-08-24)
GET  /api/floorplans                            — plans + their rooms (rooms now carry `doors` + `grade`, 2026-08-24)
GET  /api/floorplans/:id                        — one plan, rooms, and the instruments in each
POST/PUT/DELETE /api/floorplans[/:id]           — plan CRUD (CONFIG_UPDATE + reauth, audited)
POST/PUT/DELETE /api/floorplans/:id/rooms[/:roomId]  — room CRUD, geometry + limits + `doors`/`grade` validated
PUT  /api/floorplans/:id/rooms/:roomId/instruments   — set room membership wholesale
POST   /api/floorplans/:id/links                — (2026-09-22) link two rooms: OPENING on the shared
                                                  wall (checked against the rooms' real outlines,
                                                  400 NOT_ADJACENT otherwise) or CONNECTOR (409 on a
                                                  duplicate pair); CONFIG_UPDATE + UPDATE_FLOORPLAN_ROOM
                                                  reauth; audited
PUT    /api/floorplans/:id/links/:linkId        — update a link (same checks, audited before/after)
DELETE /api/floorplans/:id/links/:linkId        — delete a link (audited); rooms cascade their links
                                                  Rooms carry `points` (polygon corners, NULL = a
                                                  rectangle) and doors by `edge`; plans carry `links`
                                                  on BOTH reads — all declared in the schemas.
GET  /api/floorplans/:id/rooms/:roomId/history?window=15m|1h|6h|24h|7d  — bucketed above 6h
POST /api/uploads/floorplan                     — plan image (CONFIG_UPDATE)
POST /api/audit/report-export-log               — governed report-download log; reuses `REPORT_GENERATED`.
                                                    PDF (2026-10-01): `reportKind` required; 409
                                                    REPORT_REQUIRES_APPROVAL when the kind is Request; remarks and
                                                    password exactly as configured. Excel: remarks + per-role
                                                    `DOWNLOAD_REPORT` reauth, as before
GET    /api/alarm-webhooks                      — targets + the instrument count each currently resolves to
POST   /api/alarm-webhooks                      — create target (ALARM_RULE_MANAGE + MANAGE_ALARM_WEBHOOK reauth, audited)
GET    /api/alarm-webhooks/:id                  — one target
PUT    /api/alarm-webhooks/:id                  — update target (reauth, audited)
DELETE /api/alarm-webhooks/:id                  — delete target (reauth, audited; REFUSED while deliveries reference it)
POST   /api/alarm-webhooks/:id/test             — test fire (reauth, audited — it makes a real buzzer sound)
GET    /api/alarm-webhooks/:id/deliveries?status= — paged §11 delivery log, filtered server-side
POST   /api/report-reviews                      — raise a report REQUEST (2026-09-07; reshaped 2026-10-01):
                                                    reportKind, reportType, title, requestMeta, dataSnapshot (the
                                                    frozen document), instrumentIds, remarks — NO approver: the
                                                    configured roles + users are frozen onto the row.
                                                    REPORT_REVIEW_READ; password / remarks as the KIND is configured;
                                                    409 REPORT_IS_DIRECT, 400 NO_APPROVER / NO_ELIGIBLE_APPROVER;
                                                    audited; approvers notified per user, scope-filtered
GET    /api/report-reviews?list=queue|mine|approved&page&pageSize — the three lists, party- AND instrument-scoped
                                                    server-side; `mine` = raised by me or my role
GET    /api/report-reviews/:id                  — the full row with its snapshot; 404 (never 403) for a non-party
                                                    (party = signer, SUPER_ADMIN, or requester's role / approver in scope)
POST   /api/report-reviews/:id/approve | reject — assignee only, never the requester — EXCEPT SUPER_ADMIN,
                                                    who may decide ANY pending request, their own included (2026-09-08);
                                                    approve: REPORT_REVIEW_APPROVE + APPROVE_REPORT reauth;
                                                    reject: REPORT_REVIEW_REJECT + REJECT_REPORT reauth
                                                    (two permissions since 2026-10-26);
                                                    one decision (409 on a second); audited; requester notified
POST   /api/report-reviews/:id/download-log     — a party downloading the APPROVED copy; written BEFORE save
GET    /api/config/report-approvers/current     — the administered approvers, every authenticated user; the
                                                    SEVENTH narrow-slice route. `{approverRoles, approverUserCount}`
                                                    — the ACTIVE approvers, users as a COUNT (2026-10-01); both
                                                    empty = no report can be requested
GET    /api/config/report-approvers/candidates  — (2026-10-01) options for the Approver users setting, CONFIG_READ
GET    /api/config/report-approvers/readiness   — (2026-10-24) the toggles each role / user lacks to APPROVE, CONFIG_READ
GET    /api/config/report-downloads/current     — (2026-10-01) per report KIND {mode, remarksRequired,
                                                    passwordRequired}, every authenticated user; read it with
                                                    coerceReportDownloadsResponse, NOT the stored-row reader
```

- **Inactivity alarms — a THIRD alarm source (2026-08-31).** `AlarmSource` gains
  `INACTIVITY` (a new enum VALUE — models stay 36, enums stay 13). Raised
  automatically when an instrument stops reporting, cleared when it starts again,
  with NO rule row: `AlarmRule` can already do `metric: 'OFFLINE'`, but a
  location-targeted rule cannot reach an instrument with no functional location,
  and there is one. Config def `inactivity-alarms` (25 → 26 defs), rendered by the
  dynamic config page so the page count stays 24.
  - **It ships OFF, unlike `alarm-limits`.** `loadInactivityConfig` reads
    `enabled === true` where `loadLimitConfig` reads `enabled !== false`.
    Deliberate and not a style difference: this one failing OPEN raises one alarm
    per silent instrument, which on this installation is 101 in a single pass,
    each with a notification and a webhook fire.
  - **The clear signal is PRESENCE — the INVERSE of the instrument-limit rule**,
    where a missing reading HOLDS an alarm open because absence cannot prove
    recovery. Here absence IS the alarm. A pass copied from the limit pass's shape
    strands every inactivity alarm ACTIVE for good. `inactivity-decide.ts` is
    separate for exactly this reason.
  - The effective raise threshold is the **LATER** of `graceMinutes` and
    `instrument-activity`'s `activeWindowMinutes` — the pass needs both
    conditions, so a grace shorter than the window changes nothing.
  - Never raises for an instrument that has NEVER reported (it was not active) or
    a decommissioned one; an alarm already open on a decommissioned instrument
    still clears if it reports.
  - **The three VALUE columns are administered wordings, added the same day.**
    Generated Value (`No data`) and Cleared Value (`Data resumed`) are cells that
    can hold no number — this alarm is raised by the absence of a reading and
    cleared by the return of telemetry, not by a reading crossing a bound — so
    they carry a word rather than a dash. The **Limit** wording is NOT in the same
    category: it states the threshold the alarm fired against, so it is a template
    with a REQUIRED `{minutes}` token filled from the FROZEN snapshot, and a
    configured string without the token is refused in favour of the default, on
    the server and in the browser both. Cleared Value renders only once
    `clearedAt` is set. Served to all authenticated users by
    `GET /api/config/inactivity-alarms/display-texts`, the same narrow-slice
    pattern as `/alarm-limits/status-texts` and deliberately not folded into it;
    read live, like the four status wordings, while the threshold under them stays
    frozen. Adds no def, page, route, permission or enum.
  - Two hand-authored migrations, SEPARATE because Postgres refuses to use a new
    enum value in the transaction that added it. The second adds
    `alarms_active_inactivity_unique`, a partial unique index Prisma cannot
    express and will propose dropping — do not accept that.
- **RS485 sensor-failure alarms — a FOURTH alarm source (2026-08-31).**
  `AlarmSource` gains `RS485_FAILURE` (a new enum VALUE — models stay 36, enums
  stay 13). Raised when a sensor reports a NON-NUMERIC value on a temperature or
  humidity slot key, cleared when it reports a number again. Config def
  `rs485-alarms` (26 → 27 defs), rendered by the dynamic config page so the page
  count stays 24. Spec:
  `docs/superpowers/specs/2026-08-31-rs485-sensor-failure-alarms-design.md`.
  - **It is the ONLY source that can see this fault.** A failed RS485 probe leaves
    the logger talking, so INACTIVITY sees a reporting instrument, INSTRUMENT_LIMIT
    sees `null` (`toSlot()` discards a non-numeric value and a null is not a
    breach), and the dashboard shows a blank cell. Nothing fired anywhere.
  - **It ships ON, the opposite of `inactivity-alarms`, and the reason is a
    measurement**: every one of the 226,570 retained readings on a slot key in the
    LOCAL database is numeric, so enabling it raises nothing. `loadRs485Config`
    reads `enabled !== false`. **Only `compliance_core_db` was probed — the AWS
    database was not.** Re-derive there before deploying; the query is recorded
    beside `RS485_ALARMS_DEFAULT` in `@digilog/shared`.
  - **Detection is by TYPE, never by parsing — `"23.5"` IS a failure.** The
    dashboard already refuses to plot a quoted number and the limit evaluator
    already treats it as no reading; one definition of "a reading", or the screen
    and the alarm beside it disagree.
  - **The clear signal is a NUMBER and SILENCE HOLDS THE ALARM OPEN** — the
    `limit-decide` rule, and the exact inverse of the inactivity source. A pass
    copied from that one clears every RS485 alarm the moment the broken device
    falls quiet. `rs485-decide.ts` is separate for exactly this reason.
  - **Two alarms, deliberately.** The partial unique index
    `alarms_active_rs485_unique` is on `(instrument_id, metric)`, NOT the
    instrument alone as the inactivity one is — two probes fail independently.
    Two hand-authored migrations again (enum value, then index).
  - **The value columns show ONE administered word, `failureText` (default
    `Error`), NOT the raw text the sensor sent.** The raw-text design lasted a few
    hours on 2026-08-31 and was reversed: the raw text is almost always `NA`, and
    `NA` is what the dashboard already shows for a slot with NO reading, so a dead
    probe and an unwired instrument read identically. **No evidence was lost** —
    the raw value is still frozen on `ruleSnapshot.rawValue` and still named in
    the condition, which every notification and webhook prints beside the value.
    The word appears on the Alarms page, the acknowledge dialog, the trend widget,
    the signed PDF, the dashboard table and tiles, the trend raw table, and the
    `${value}` of every notification and webhook. Served by
    `GET /api/config/rs485-alarms/display-text`; **never default it to a literal
    in browser code** — the only fallback is the shared constant.
  - **Absent readings still say `NA`.** A broken probe and an instrument nobody
    wired up are different faults; that distinction is the point of the word.
  - `OverviewRow.sensorError` (declared in the response schema) is how the
    dashboard knows: both cases leave the numeric slot null, and the browser must
    not re-derive which is which.
  - The Limit column shows the constant `numeric`; Cleared Value is a real
    reading, because this source clears on an actual measurement.
  - `buildTelemetryOverview()` gained `rawSlots` — the slot reading BEFORE the
    numeric filter — so slot resolution happens ONCE and the alarm cannot name a
    different key than the dashboard. Not exposed by the endpoint.
- **Alarm RULES were REMOVED (2026-08-31, operator).** `AlarmRule`,
  `AlarmComparison`, `Alarm.ruleId`, the `/api/alarms/rules` endpoints,
  `alarms/decide.ts`, the rule evaluation pass and the Alarm Rules config page are
  gone. Migration `20260831200000_remove_alarm_rules`, run against **0 rules and
  0 RULE alarms** — verified first, and recorded in the migration, because an
  alarm is a §11 record and is never dropped to tidy a schema.
  - **`ALARM_RULE_READ` / `ALARM_RULE_MANAGE` SURVIVE** — they gate
    `modules/alarm-webhooks`, which has always reused them. Do not remove them as
    dead code; the names are stale, the permissions are not.
  - **`AlarmSource.RULE` survives too** — Postgres cannot drop an enum value
    without recreating a type the `alarms` table depends on. Nothing writes it.
  - Counts: models 36 → **35**, enums 13 → **12**, config pages 24 → **23**,
    routes 51 → **50**.
- **A QUOTED number is a reading (2026-08-31, operator).** `coerceReading()` in
  `@digilog/shared` is the ONE definition of "is this stored value a reading" —
  the dashboard, the limit evaluator, the range check, the trend chart and table,
  and the SQL range summaries all use it. `"23.5"` is 23.5; an empty string,
  `NA`, `25 C`, booleans and objects are not. **This reverses the earlier
  judge-by-type rule, and changing it in fewer places would have been worse than
  either rule alone** — the value would render blank AND raise no alarm.
- **Alarm type NAMES are administered in one place (2026-08-31).** Config def
  `alarm-type-names` (28 → 29 defs), served to all authenticated users by
  `GET /api/config/alarm-type-names/current`. A rename reaches the Type column,
  the Type filter, the trend widget, the signed PDF and `${ruleName}` in every
  notification and webhook — those were four hardcoded lists, and the notification
  one said `TEMPERATURE HIGH limit` where the table said `High Temperature`.
  - **`alarmTypeKeyFor()` in `@digilog/shared` is the ONE mapping** from source +
    metric + limitKind to a type key. The browser and the worker both use it, so a
    row and the email about it cannot disagree.
  - **Read LIVE, not frozen** — a rename re-labels history, which is the point.
    The limit, span, reading and precision stay frozen as always.
  - **A rule alarm keeps its own rule's name**; only the filter's collective
    wording is configurable. `ALARM_TYPE_OPTIONS` is now derived from
    `alarmTypeOptions(names)` — a module-level constant would never see a rename.
- [Keys per instrument PROFILE since 2026-10-26 — see PROFILE MEASUREMENTS, top of part 1.] **Instrument-limit bounds honour a per-bound ENABLE attribute (2026-08-31).**
  `Enable_Temp_NMT` / `Enable_Temp_NLT` / `Enable_Humid_NMT` / `Enable_Humid_NLT`
  gate the four bounds — NMT is the HIGH bound, NLT the LOW one (the plant's
  vocabulary; mapping them the wrong way round silently disables the opposite
  bound). Four alias-list settings on the existing `alarm-limits` def; no count
  moved, no migration.
  - **Why a bound needs a switch separate from its value:** an instrument here
    carries `High Humidity Limit = 0` meaning "not judged", and **a 0 is a real
    bound** — 17 CRITICAL alarms were open at 44-50 %RH against it when this was
    written, on the 16 instruments whose own `Enable_Humid_NMT = 0` already said
    the bound was not in force.
  - **Absent, blank or unreadable = ENABLED.** The safety default: a typo must
    never silence a bound, and one instrument carries no flag. Both `0`/`1` and
    `True`/`False` are accepted — the live data holds both.
  - **A disabled bound is WITHHELD from `telemetry-overview`, not merely
    unenforced (2026-08-31).** `limits` carries `null` for it, so
    `computeInstrumentStatus`, the dashboard table, the floor tiles, the trend
    card and its chart's limit line all stop drawing a bound that can never
    raise — leaving it in painted OUT_OF_SPEC against a bound the evaluator
    ignores. The row also carries `limitEnabled`, which says WHY a bound is
    absent (switched off vs never administered) and must NEVER gate display,
    since `limits` already withholds it; and `limitSource` goes null once no
    bound survives. Pinned by `src/e2e/telemetry-overview.e2e.test.ts`, both
    mapping directions separately.
  - **Switching a bound off also CLEARS an alarm open on it**, which is a
    deliberate departure from "a config change never closes a regulated record".
    Those alarms can never clear on their own (humidity below 0 cannot occur), and
    a permanently red row asserts an excursion that is not real. `raisedAt` and
    `triggeredValue` survive; the acknowledgement is untouched.
  - **A limit or range attribute may carry TEXT beside its number (2026-10-03,
    operator: "text is included in limits and ranges show that text in reports
    and show max and min values, in dashboard show the same text only").**
    `parseLimitValue` takes the FIRST numeric token (`60 (For Reference)` → 60;
    no digits = no limit) — until then anything but a bare number was refused,
    which is how CWH/RDU/101-00's edited `h_hl` silently lost its humidity
    bound everywhere. The NUMBER is enforced, judged, charted and summarised as
    before; the TEXT prints verbatim wherever the bound is quoted —
    `OverviewRow.limitText`, the chart summary's `limitMinText`/`limitMaxText`,
    and the alarm snapshot's `thresholdHighText`/`thresholdLowText`
    (`rangeLowText`/`rangeHighText`) — all server-resolved, declared in the
    schemas, following the bound through every gate (no text for a withheld
    bound). `limitDisplayText` / `resolveLimit().text` in `@digilog/shared` is
    the ONE reader; `boundText` in `routes/dashboard/set-point.ts` the ONE
    browser rule. Notifications, webhooks and the room-detail band stay
    numeric on purpose. No count moved.
- **Sensor RANGE alarms — a FIFTH alarm source (2026-08-31).** `AlarmSource`
  gains `SENSOR_RANGE` (enum VALUE — models stay 36, enums stay 13). Config def
  `sensor-range-alarms` (27 → 28 defs). Raised when a reading falls outside the
  probe's own `High/Low Temperature Range` / `High/Low Humidity Range`
  attributes; Type reads `Temperature Failure` / `Humidity Failure`.
  - **RANGE IS NOT A LIMIT.** Every instrument here carries both:
    `High Temperature Limit` = 25 is the product SPEC, `High Temperature Range`
    = 50 is the hardware's span. Confusing them is the mistake the whole feature
    is written to prevent.
  - **An out-of-range reading is treated as NO READING** (operator, 2026-08-31):
    it raises this alarm, raises NO limit alarm, and **cannot clear an open one**
    — the second follows necessarily from `limit-decide.ts`'s rule that absence
    never proves recovery. A genuine excursion INSIDE the span still raises a
    normal limit alarm; that is separately pinned.
  - **The withholding happens in ONE place** — `telemetry-overview.ts`, where a
    stored value becomes "a reading": `rangeError` is set and the numeric slot is
    nulled. Put the test anywhere else and some consumer will trust a number the
    others rejected.
  - **`OL` is its own configurable word**, separate from RS485's `Error`: a
    saturated probe and a probe sending nonsense need different checks. Served by
    `GET /api/config/sensor-range-alarms/display-text`.
  - Bounds resolve through the SAME `parseLimitKeys`/`resolveLimit` machinery as
    limits — no second resolver to drift. The snapshot freezes the reading, the
    span AND the attribute key each bound came from.
  - `alarms_active_sensor_range_unique` on `(instrument_id, metric)`, two
    hand-authored migrations as always (Postgres refuses a new enum value in the
    transaction that added it).
- **Trend page widget wording is ADMINISTERED, and editable in place
  (2026-09-01).** Config def `trend-widgets` (29 → 30 defs) holds every title,
  subtitle and column heading on `/instruments/:id/trend`, plus a per-widget
  date/time FORMAT override. Served to all authenticated users by
  `GET /api/config/trend-widgets/current`, the **SIXTH** narrow-slice route
  (`/alarm-limits/status-texts`, `/inactivity-alarms/display-texts`,
  `/rs485-alarms/display-text`, `/sensor-range-alarms/display-text`,
  `/alarm-type-names/current`). No migration, no model, no enum, no permission,
  no reauth action, no route, and NO config page — it renders through the dynamic
  config page and gets a `superAdminCards` card, which is not a file under
  `routes/config/`. Pages stay 23.
  - **A pencil in each widget's header edits just that widget**, SUPER_ADMIN only
    (`user?.role === 'SUPER_ADMIN'`, the same check `routes/config/index.tsx`
    makes — not `useCan`, since the gate is the def's own `requiredRole`). Hiding
    it is presentation; the server refusing the PUT is the control, and that is
    tested separately.
  - **The dialog PUTs the WHOLE row, merged.** `/api/config/dynamic/:key`
    REPLACES `configValue` — it does not patch it — so a PUT of one widget's
    fields alone erases the other five. Pinned by a test, and mutation-checked.
  - **`TREND_WIDGET_FIELDS` in `@digilog/shared` is the ONE widget → fields
    mapping.** The def's 31 settings are BUILT from it and the dialog renders from
    it, so a key cannot exist in one and not the other. A test asserts it accounts
    for every label key exactly once.
  - **Blank falls back to the SHIPPED wording, never an empty heading** — the same
    rule as `alarmTypeName()`. No component may default a label to a literal; the
    only fallback is the shared constant. `coerceTrendWidgetTexts()` applies it to
    a malformed RESPONSE too, so a stale server cannot white-screen the trend page
    over a column heading.
  - **Format overrides default to INHERIT, and the TIMEZONE is not overridable.**
    A per-widget zone would let two widgets name different instants for the same
    stored reading — a §11 falsehood, not a display choice. `useDatetimeFormat`
    gained an optional override and `makeDatetimeFormatters` was extracted from
    it; there is still ONE formatter. **An unrecognised format INHERITS rather
    than being passed on**, because `formatDateValue`'s `default:` branch prints
    en-GB, so a stale override would silently render DD/MM/YYYY on a site set to
    MM/DD/YYYY.
  - The format vocabulary is LIFTED from `datetime.def.ts`, not invented — if a
    format is added there, add it to `TREND_WIDGET_DATE_FORMATS` in the same
    commit.
  - The alarms table's **unit legends (`(°C / %RH)`, `(H/m)`) and the H/m tooltip
    are NOT renameable** and survive a rename: they explain the cells, not the
    column's name.
- **The browser TAB is named and iconned from config (2026-09-03).** Two settings
  on the EXISTING `branding` def — `tabTitle` (default `T&RH-Monitoring`) and
  `faviconUrl` — plus `POST /api/uploads/branding-favicon`. **No count moved**: no
  migration, model, enum, permission, reauth action, config def, page or route; the
  same precedent as the four `alarm-limits` enable-attribute settings. The one that
  did move is `apps/web/src/lib/` 19 → 20 (`document-identity.ts`).
  - **`tabTitle` is NOT `appName` and must not be folded into it.** They have always
    been different strings, and `appName` is what the sidebar, header and login card
    print. Note this install had ALREADY set `appName` to `T&RH-Monitoring` while the
    tab still read "Compliance Core" — which is what prompted the request.
  - Applied by `apps/web/src/lib/document-identity.ts`, called from `useBranding()`
    beside the theme effect — the ONE place branding is resolved, and it runs on the
    login page too, so the tab is right before anyone signs in. **A blank value
    leaves the SHIPPED default from `index.html`**, never an empty tab or a
    broken-image icon.
  - **Both `<link>`s are rewritten and the `type` hint with them.** A stale
    `type="image/png"` over an uploaded `.ico` is the mismatch that reads as "I
    uploaded my icon and nothing happened".
  - **The `<link>` is REPLACED, never mutated** — a browser does not reliably
    repaint the tab from an `href` rewrite. A "simplification" back to
    `setAttribute('href', …)` leaves the config saving correctly while the tab keeps
    the old icon, with nothing on screen to explain it. The test asserts element
    IDENTITY, not the attribute, because the attribute assertion passes for the
    version that does not work. `apple-mobile-web-app-title` follows the title too
    — it is a `<meta>`, so "baked at build time" does not cover it.
  - **The card's client-side file check is deliberately LOOSER than the server's.**
    A `.ico` often arrives with an EMPTY `file.type`, so `!file.type.startsWith(...)`
    rejects the exact format the route exists for before the request is made. Only a
    positively-identified non-image is refused; magic bytes are the boundary.
  - **`BRANDING_TAB_TITLE_DEFAULT` in `@digilog/shared` is the ONE default.** No
    component may default the label to a literal (the `alarmTypeName()` precedent);
    `index.html`'s static `<title>` is the one unavoidable hand-kept copy, and it is
    HTML-escaped (`T&amp;RH-Monitoring`) while the config value is not.
  - **The favicon is a PATH, never a data URI** — `backgroundUrl`'s rule and its
    reason: a branding change is audited, and an inlined image lands twice in a §11
    before/after record. Do not raise the 512 cap to `logoUrl`'s 3,000,000.
  - **Its own upload route, deliberately.** `/branding-background` writes to the same
    directory and would have worked; the two differ in what they ACCEPT, and `.ico`
    belongs to favicons alone. `readValidatedImage` gained an `allowed` parameter
    rather than being forked, so the four upload routes cannot drift.
  - **SVG IS REFUSED AND MUST STAY REFUSED** — `/uploads/branding/` is in
    `PUBLIC_GET_PATHS` on the API's own origin, so an SVG favicon would be
    same-origin script execution for anyone holding `CONFIG_UPDATE`. A `.cur`
    renamed `.ico` is refused too (all four ICONDIR magic bytes are matched).
  - **The PWA manifest is NOT driven from config and cannot be** — `vite-plugin-pwa`
    bakes `name`/`short_name`/icons at build time. The INSTALLED app still reads
    DigiLog; only the browser tab is administered.
- **Boolean config settings render as an on/off TOGGLE, not a checkbox
  (2026-08-31, operator).** `components/ui/toggle.tsx`, swapped in at
  `dynamic-config.tsx`'s boolean branch, so it changes EVERY dynamic config page
  — one control style everywhere. `Checkbox` stays for selecting items from a
  list, which the same page still does for dynamic option sets.
- **Alarms page: the counts were window-limited, and are not any more
  (2026-08-31).** The page filtered and counted IN THE BROWSER over
  `?limit=500`, so the four state boxes described the newest 500 alarms while
  reading as plant-wide totals — the same defect shape as the 2026-08-27
  telemetry truncation, a `limit` and a range meeting in one query. All of it
  moved server-side. **Do not reintroduce a client-side count**;
  `filterByQuadrant()` / `quadrantCounts()` were deleted and a comment stands
  where they were. Deliberate departures from the supplied mock (no sparkline or
  "from yesterday" — nothing stores alarm-state history; no row kebab; canonical
  `<Pagination>`; theme-primary table banner rather than hardcoded indigo;
  cleared-unacknowledged stays AMBER, never neutral) are recorded in
  `CHANGELOG.md` with their reasons. Also fixed: the status pill was keyed off
  `severity`, so every pill rendered red on an installation where every alarm is
  CRITICAL.
- **Dashboard: the readings table shows Area and Location — there is NO Room
  column (2026-09-01).** It briefly had all three, and the Room one was removed
  the same day by the operator as a DUPLICATE. The measurement, not the eye:
  the cell's primary text was the instrument's `name`, and `name` WAS
  byte-identical to the `Location` attribute on **100 of the 100** instruments
  that carry one (true when measured; **since 2026-09-04 `name` = `code` on
  every instrument** — operator instruction, applied by
  `scripts/rename-instruments-to-code.ts` with 100 audit rows, so the room now
  lives ONLY in the `Location` attribute); its secondary line was blank on 88 of 101 rows, and on the 12
  traced QC rooms printed the room LABEL — the same room shouted. The room
  NUMBER never rendered at all, because `label` won whenever it existed.
  - **The justification it was kept under had already expired**, which is why it
    survived a redesign: "the SET POINT columns come FROM the room, so without it
    18.0-27.0 has no visible source". Provenance is the `setPointSource()`
    TOOLTIP, and limits resolve from the instrument's own attributes first with
    `limitSource` naming which. **Re-read a column's stated reason before quoting
    it — this one had been false for weeks.**
  - The room stays SEARCHABLE, the same call the Alarms page made: matching more
    than is shown can only return rows the caller could already see. The drawn
    room remains the graphical view's whole subject — it is the COLUMN that went,
    not the concept, which is still one of the three named above.
  - The freed 11% went mostly to Location (13% → 20%), which holds the longest
    text on the row.
  Both fields are resolved SERVER-side and the browser re-derives
  neither: the `Location` attribute comes off the attribute rows the query
  already selects for the limits, so no second query was added. Column widths are
  hand-balanced to 100% and pinned by `columnWidthTotal()`; the `<colgroup>` is
  generated from `COLUMN_GROUPS` so it cannot drift, but the percentages can.
  Empty states are worded APART — "Unassigned" for no functional location (the
  same word the Alarms page uses), "Not set" for an absent attribute. No CSS was
  added: both columns take the existing `tv-h-loc` hue, because the `.tv-*` block
  is deliberately UNLAYERED and a new rule there is not a free edit.
- **REPORT REVIEW WORKFLOW (2026-09-07, operator: "when ever user click on
  download then directly pdf should not download, as per requested time period
  data should go per review once review completed and approved then user and
  approved user can get that approved data in side bar new option there user can
  download reports, who ever requested and approved users electronic signatues
  should come if report was downlaoded").** Spec
  `docs/superpowers/specs/2026-09-07-report-review-workflow-design.md`, plan
  `docs/superpowers/plans/2026-09-07-report-review-workflow.md`. Every PDF
  download in the product (Data Report page card; trend page header, Time
  Series card, both chart cards, alarms widget; Alarms page; Audit Trail PDF)
  now renders the report as before and POSTS it as a REQUEST — the dialog gains
  **Send to** (a user or a role, never SUPER_ADMIN) and its button reads
  *Request approval*; the `DOWNLOAD_REPORT` re-auth is the request's signature.
  Nothing saves. An approver opens the **DRAFT** (watermarked, unsigned) on the
  new **Reports** sidebar page (`/reports`, three lists: For my approval, My
  requests, Approved) and approves or rejects with remarks + password; the
  requester, the approver and SUPER_ADMIN then download the approved copy with
  a **signature TABLE** (since 2026-09-25, operator: "Name, Role, Date & Time
  for both should come side by side" — **Reviewed By** and **Approved By**
  across the top, Name / Role / Date & Time down the left; two "Requested By"
  lines until then). **The ROLE is FROZEN on the record at the act** —
  `report_reviews.requested_by_role` / `decided_by_role`, migration
  `20260925120000_report_review_roles` (nullable columns, no enum; models stay
  37, enums 13; rows older than the column were backfilled from `users` by
  username, the best fact available) — written from `ctx.userRole`, declared
  in the response schema, never looked up live. The Audit
  page's Excel export is not a PDF and stays direct.
  - **The snapshot is the record.** `ReportSnapshot` v2 (`lib/pdf-report.ts`)
    records EVERY drawing call — tables with bold and spans, pairs, titles,
    notes, chart rasters, page breaks — plus the chrome (legend, typography,
    app-name line). The DRAFT and the approved download are both replays
    through the one renderer, so what was reviewed is byte-for-byte what is
    downloaded apart from the watermark and the signature block. Rebuilding
    from parameters after approval could pick up late telemetry or a renamed
    alarm type and produce a document nobody signed. `normaliseSnapshot`
    refuses anything but v2 (no v1 rows exist; that table was dropped in the
    2026-07-18 strip).
  - **Party scoping and one decision** live in `modules/report-reviews/
    service.ts`: `isParty` / `isAssignee` are pure and unit-tested; a non-party
    gets 404; the requester can never decide their own request — the
    two-person control — **EXCEPT SUPER_ADMIN (2026-09-08, operator: "super
    admin should be able to approve own requests or other requests")**.
    `isSelfDecision` is the ONE rule, mirrored by the page's `mayDecide`; the
    consequence, stated when asked for, is that a super admin's own report
    carries the same name on both signature lines. It shipped the other way
    round for one day. The decision is a conditional UPDATE
    on `status = PENDING`, so two approvers cannot both sign (409). Nothing
    deletes a row. Mutation-checked both ways.
  - **Counts:** models 35 → **36**, enums 12 → **13**, modules 24 → **25**,
    permissions 42 → **44**, reauth 48 → **50** (categories 8), audit actions
    98 → **102**, templates 92 → **96** (categories 7), sidebar 13 → **14**,
    routes 51 → **52**, tree groups 12 → **13**, nodes 53 → **55**, feature
    privileges 41 → **43**. No config def, no page under `routes/config/`, no
    worker task. In-app notifications only (the three `REPORT_REVIEW_*`
    `NotificationType` values that survived the strip); email/SMS rules do not
    cover report events.
  - This REPLACES the module removed on 2026-07-18 (tag `pre-domain-strip`),
    without its second review stage. The flag-disabled `SendForReviewButton` on
    the Audit page — retained UI for that removed backend — went with it.
- **Which roles may APPROVE a report is ADMINISTERED (2026-09-07, operator:
  "that approval role should be configurable which role user should be approved
  that role will set by super admin in configurations").** Config def
  `report-approvers` (30 → 31 defs; SUPER_ADMIN-only; renders through the
  dynamic config page, `superAdminCards` card, page count unchanged): one
  `multiselect` of active roles loaded live through `dynamicOptionsSource`
  (`/api/roles/active`) — the mechanism existed and no def used it until now.
  - **`coerceApproverRoles()` in `@digilog/shared` is the ONE reader** of the
    stored row: the server's request check (`report-reviews/service.ts`), the
    narrow-slice route `GET /api/config/report-approvers/current`, and the
    Send-to picker. SUPER_ADMIN is stripped wherever it is read.
  - **Enforced on the REQUEST, server-side.** `POST /api/report-reviews` refuses
    a role outside the list (`ROLE_NOT_APPROVER`), a user whose role is outside
    it (`USER_NOT_APPROVER`), and — with the list EMPTY — every request
    (`NO_APPROVER_ROLE`, message naming the fix). The picker offers only the
    configured roles and the enabled users holding one, and with none configured
    shows the same message and no control; it is presentation, the 400 is the
    control. Mutation-checked (dropping the user-role check fails the e2e).
  - **Ships EMPTY and FAILS CLOSED**, like `inactivity-alarms` and for the same
    kind of reason: a report must not reach an approver nobody appointed.
    Consequence, stated plainly: after deploy NO PDF can be requested until a
    super admin ticks a role once under Configuration → Report Approvers.
  - Approving still needs `REPORT_REVIEW_APPROVE` (rejecting needs `REPORT_REVIEW_REJECT`,
    a separate permission since 2026-10-26) and the request assigned to
    you or your role; the list governs who a request may be SENT to. A pending
    request survives a later config change — it is a record.
  - No migration, model, enum, permission, reauth action, page or sidebar item.
    Not seeded; the e2e pins its own row and restores it first in `afterAll`.
- **REPORT DOWNLOADS ARE CONFIGURED PER TYPE, APPROVERS ARE CONFIGURED, AND
  REQUESTS ARE SCOPED (2026-10-01; see the CHANGELOG entry for the operator's
  words and choices).** This SUPERSEDES the "Send to" half of the two bullets
  above and the "every PDF download is a request" premise.
  - **Configuration → Report Downloads** (def `report-downloads`, 33 defs):
    per KIND — `data-report`, `trend-chart`, `instrument-alarms`, `alarms`,
    `audit-trail` (`REPORT_KINDS` in `@digilog/shared`, NOT the audit
    `reportType` string, which two surfaces share) — mode DIRECT | REQUEST,
    remarks yes/no, password yes/no. Defaults = Request + both on.
    **Two readers, two shapes, never swapped**: `coerceReportDownloads` reads
    the STORED flat row (`alarmsMode`, …); `coerceReportDownloadsResponse` reads
    the narrow route's per-kind JSON. Using the first on the second turns every
    type into Request silently — it shipped that way for an hour.
  - **Server-enforced both ways**: `report-export-log` 409s a PDF whose type is
    Request; `report-reviews` 409s a Direct type; remarks and password demanded
    exactly as configured (`enforceReauthAlways` when Yes — every role — none
    when No; the per-role `DOWNLOAD_REPORT` policy now governs only the Audit
    Excel export). `policyForKind()` runs BEFORE the password check.
  - **No requester-chosen approver.** Approvers = the configured roles AND
    users (`approverUserIds`, new setting), FROZEN onto the row
    (`approver_roles`, `approver_user_ids`; migration
    `20261001120000_report_review_approvers_scope`, also `instrument_ids`).
    Old rows were backfilled from `assignee_role` / `assignee_user_id`, which
    are kept and no longer written. Read ONE shape: the arrays.
  - **Visibility = `isParty`**: SUPER_ADMIN; the requester and the decider
    (unscoped — they signed); otherwise the requester's frozen ROLE or an
    approver, AND `inScope` (the user's instrument scope covers ANY of
    `instrument_ids`; empty = unscoped, the Audit Trail). `mayDecide` = an
    approver in scope. The list SQL (`visibilityWhere` / `scopeWhere`) must
    stay the translation of `isParty` — change both or neither. Notifications
    go per user, scope-filtered, never `forRole`.
  - Web: `lib/report-delivery.ts` `deliverReport()` is the ONE branch on the
    mode (Direct: `logReportExport` THEN `save()`; Request:
    `submitReportForReview` with `reportKind` + `instrumentIds`). The dialog
    takes `kind`, shapes itself from `use-report-downloads.ts`, and collects
    the password itself. Reports page: no View draft; a PENDING row opens its
    snapshot; tab `mine` is labelled **Requests** (mine or my role's).
  - **Applied to both local databases; NOT on AWS until the next deploy.**
  - **Second round, same day:** ONE page, Configuration → **Report Settings**
    (`routes/config/report-settings.tsx`), for both rows — the two cards went;
    the rows did not merge. EIGHT kinds: `data-report` (sidebar page),
    `time-series` (trend card), `trend-header` (trend header), `temperature-trend`,
    `humidity-trend`, `instrument-alarms`, `alarms`, `audit-trail`; a split kind
    reads `inheritsFrom` while its own keys are absent. Each kind is BOUND to
    its audit `reportType` (`reportTypeMatchesKind`); an EMPTY instrument list
    is unscoped only for the Audit Trail (`UNSCOPED_REPORT_TYPE`), otherwise
    unrestricted viewers only; eligible approvers need READ + APPROVE;
    `/report-approvers/current` = active approvers, users as a count.
- [Keys per instrument PROFILE since 2026-10-26 — see PROFILE MEASUREMENTS, top of part 1.] **SENSOR OFFSETS (2026-10-01; CHANGELOG has the operator's words).** An
  instrument's `Temp Off set` / `Humid Off set` attribute (+ adds, - subtracts;
  stored sign-first) is applied to each slot reading AS IT ARRIVES —
  `modules/instruments/load-offsets.ts` `applySensorOffsets`, called before
  BOTH `writeBatch` calls in `ingest-core.ts`. The STORED value is the corrected
  one, which is why no display, report or alarm code changed; do not add a
  read-time correction anywhere, it would apply twice. The device's value is in
  `instrument_telemetry_history.raw_value` (never shown). `offsetReadings` /
  `parseOffsetValue` / `isOffsetAttributeKey` in `@digilog/shared` are the ONE
  implementation. SUPER_ADMIN-only: `offsetKeyTest()` strips them from every
  attribute response, profile key list and the access picker for other roles,
  guards their writes and profile saves, and keeps them off every device
  downlink and device report. The audit trail is NOT filtered. Config def
  `sensor-offsets` (switch + key aliases, 10-second cache). Migration applied
  to both local DBs; AWS needs it and the two profile keys.
- **ATTRIBUTE DISPLAY NAMES (2026-09-16, operator: "for attributes key i need
  key is one thing and that key display name should be configurable").** An
  attribute KEY is the stored identity — what a device writes over MQTT, what
  the CSV importer reads, what an audit row names, what the alarm-limits alias
  lists match on. None of that moved. What moved is the word a PERSON reads
  beside the value. Config def `attribute-labels` (31 → **32** defs;
  SUPER_ADMIN-only; ONE `json` setting `labels: {key: name}`; a `zodSchema`
  refuses a non-map body or an over-long name). **Edited as a Display name
  column beside each key on Configuration → Instrument Attributes** — a
  separate card and page lived for a few hours and went on the operator's
  "dont give as seperate configuration add in instrument attributes
  configuration"; pages stay **23**, routes stay **53**. Served to EVERY
  authenticated user by `GET /api/config/attribute-labels/current` (the EIGHTH
  narrow-slice route), read in the browser by ONE hook,
  `hooks/use-attribute-labels.ts` (22 → **23** hooks). No migration, model,
  enum, permission, reauth action, module or sidebar item.
  - **GLOBAL map, edited per profile.** A key means the same thing wherever it
    appears, so one `attribute-labels` row holds every name; the Instrument
    Attributes page shows and edits the names of the SELECTED profile's keys.
    `mergeLabels()` (exported from `routes/config/instrument-attributes.tsx`,
    pure) writes this profile's rows over the stored map, clears a name on
    blank, carries a name across a key RENAME, and drops the name of a key that
    left this profile unless another profile still lists it. Save PUTs the
    WHOLE map (the dynamic PUT replaces the row) and only when names or keys
    changed; the profile is rewritten only when keys changed.
  - **`coerceAttributeLabels()` / `attributeLabel()` in `@digilog/shared` are
    the ONE reader and the ONE lookup.** Blank falls back to the KEY, never to
    an empty heading (the `alarmTypeName()` rule); lookup folds case, as
    `parseInstrumentAttributeKeys` and the Attributes panel already do. No
    component may default a label to a literal.
  - **Where the name shows — and ONLY the name** (operator: "in instruments
    page or settings page only attributes display names should be display"):
    the New Instrument form's field labels, the Attributes panel (detail page
    and the Settings Edit dialog), the Settings widget tiles, the Attribute
    Access key picker, and the BULK UPLOAD TEMPLATE's column headings. The key
    is not printed beside the name anywhere; it rides in a `title` tooltip on
    the panel and picker labels. **Where the KEY stays:** MQTT payloads, audit
    rows, `Delete <key>` button names and the fill input's `aria-label`, the
    alarm-limits alias lists, and the Add-attribute dialog, which still asks
    for the key because the key is what is stored.
  - **The bulk-upload template carries the profile's ATTRIBUTES, headed by
    display names (2026-09-16, operator: "in bulk upload template only
    attributes display names should come").** Until then the template carried
    NO attribute columns at all (`name,code,instrumentType,…`) and the importer
    read none. Now: the template is built per chosen profile — an `Instrument
    ID` column (the create form's words; operator: "in bulk option in template
    Instrument ID field and Instrument Profile selection dropdown"), then one
    column per key the profile asks for, headed `labelFor(key)`; the Download
    button is disabled until a profile is chosen. The parser normalises an
    `Instrument ID` heading to `code` and still accepts `code` for files
    operators already have. `parseInstrumentCsv(csv,
    attributeColumns)` maps a heading back to the KEY by display name OR by key,
    case-folded, so a file headed by keys still imports; a heading that is
    neither is ignored with ONE whole-file warning (a typo must not become an
    attribute). The route resolves the columns (`bulkAttributeColumns`) and,
    after each instrument's own transaction, `writeInitialAttributes` upserts
    the filled cells with one `INSTRUMENT_ATTRIBUTE_SET` audit row per key (a
    first fill, no remark) and announces each to the device — the single form's
    per-attribute POSTs, without the HTTP. **`name` is no longer a required
    column**: blank or absent = the code, as the create form has filled it since
    2026-08-07; a `name` column given is still honoured. The parser stays pure —
    its tests take the columns as an argument.
  - **`hasCustomPage` is FALSE on the def** — `true` would skip the generic
    `/dynamic/attribute-labels` GET/PUT, which is the endpoint that validates
    against `zodSchema`, enforces `requiredRole` and writes the `CONFIG_CHANGED`
    audit row. `customPagePath` points at `/config/instrument-attributes`, and
    `config/index.tsx` names `attribute-labels` in its hardcoded-key exclusion
    set so the auto-discovered section never offers a second door.
  - Pinned by 11 shared unit tests, 6 API e2e (`attribute-labels.e2e.test.ts`,
    non-admin reads / SUPER_ADMIN-only writes / COERCED read-back asserted key
    by key over HTTP), 7 parser cases + 1 bulk e2e (`bulk-attributes.e2e.test.ts`:
    display-name headings land as attributes stored and audited BY KEY, blank
    cells not written, unknown heading warns once), 5 hook, 4 Instrument
    Attributes page cases (incl. the rename carry-over), 5 bulk-template cases,
    and one case each on the form, panel, Settings and Attribute Access tests.
    Mutation-checked: the case-fold, the response schema's `additionalProperties`,
    and the merge's left-this-profile rule.
  - **WHICH FIELDS THE SETTINGS PAGE SHOWS is administered on the same page
    (2026-09-21, operator: "in settings page what attributes and details should
    display in one configuration page, in that configuration page any attribute
    or any field hide, then that field should not show in the settings page, in
    configuration page give hid/un hide options").** A **Show in Settings**
    toggle per key row and one for the **Instrument ID** tile (the widget's only
    non-attribute field, so it sits above the rows; asked "Instrument ID +
    attributes" or "also Name / Type / Profile / location", the operator took
    the first). Stored as a SECOND setting on the SAME `attribute-labels` row —
    `settingsHidden: {instrumentId: boolean, keys: string[]}`, the HIDDEN set,
    so a key added tomorrow shows until someone switches it off. **No count
    moved**: no def, page, route, hook, permission, migration or enum.
    `coerceSettingsHidden()` / `isHiddenInSettings()` in `@digilog/shared` are
    the ONE reader and lookup (absent, older or malformed = nothing hidden,
    never "hide everything"); the def's zod refuses a bad shape and accepts the
    field's ABSENCE, so an older client's save still lands; the narrow-slice
    route declares both inner keys in its response schema (Fastify strips an
    undeclared one silently — mutation-checked); `useAttributeLabels()` returns
    `settingsHidden` / `isHiddenInSettings(key)` beside `labelFor`, one fetch
    for both so a tile cannot be labelled and hidden from two versions of the
    row. The Settings page filters its tiles and, in Edit, gives a hidden field
    NO input — so nothing on that page can write it; the merge on the
    Instrument Attributes page (`mergeSettingsHidden`, pure, exported) follows
    `mergeLabels`' rules exactly: a row decides its own key, a renamed row
    carries its switch, a key that left this profile drops out UNLESS another
    profile still lists it. **Presentation over the Settings page ONLY** —
    the attribute is still stored, still served by the API, still on the
    instrument detail page, the New Instrument form and the bulk template, and
    Attribute Access still decides who may edit it. A key typed freely on one
    instrument (no profile lists it) has no row here and always shows. Pinned by
    5 shared unit, 3 API e2e, 2 hook, 5 Instrument Attributes page and 3
    Settings page cases; mutation-checked (schema, the Settings filter, the
    left-this-profile rule).
- **The New Instrument form's Instrument ID field carries NO pattern, hint or
  placeholder (2026-09-16, operator: "dont put any instructions, user will
  enter different Instrument ids format so it should not restricted").** The
  browser pattern it carried since the trim (`[A-Za-z0-9._-]`) refused `/`,
  which 100 of 101 codes here carry — so `CWH/RDU/002-00` could not be created
  through the form at all, only by CSV. **Later the same day the server rule
  went too** (operator: "remove instrument id restriction popup") — see the
  SUPERSEDED note under the MQTT client-id bullet for what it costs. There is
  now NO rule on the Instrument ID beyond non-empty and unique. Do not put the
  pattern back. Pinned by `create.test.tsx` (no `pattern`/`title`/
  `placeholder`; a slash code and a `+` code are sent unchanged, no toast).
- **The HOME sidebar item and the Module Guide page are GONE (2026-09-19,
  operator: "remove home feature from side bar from entire application, i dont
  need home option and that related content").** Removed: the `home` entry in
  `SIDEBAR_ITEMS` and in `sidebar.tsx`'s `allNavItems`, the `/home` route and
  `routes/home/` (FlowChart, module-flows, viewer-access, types, 3 test files),
  and its ONLY data source `GET /api/roles/access-matrix` with
  `roleService.getAccessMatrix` / `roleRepository.findActiveWithAccess` (nothing
  else called them — grepped before deleting). Counts: sidebar items 15 → **14**,
  routes 53 → **52**; no permission, reauth action, model, enum, config def,
  module, migration or audit action moved. **0 stored `role_configs` /
  `user_configs` sidebar lists named `home`** (measured before removal, 5 and 4
  rows), so no stored layout is orphaned; a stale id in one would be filtered by
  `allNavItems` anyway.
  - **`home` was the ONLY sidebar item with no `PERMISSION_TREE` group**, and
    `isSidebarItemVisible` fails OPEN for an ungrouped id. `sidebar-visibility
    .test.ts` used it as that example; the case is now a LOCK that every
    `SIDEBAR_ITEMS` id has a group (mutation-checked: an appended ungrouped
    item fails it). `route-guard-coverage.test.ts` lost `/home` from its
    unguarded allow-list.
  - **Every page's root breadcrumb now reads `Dashboard`, not `Home`** (39
    files, one mechanical rename). The crumb always pointed at `/`, which IS
    the dashboard — the trend page had already been corrected on 2026-09-01
    for exactly that mislabel; the word Home would otherwise have survived on
    every page after the feature it named was removed.
  - `docs/superpowers/{specs,plans}/2026-07-06-home-module-guide*` stay as
    history. Restore point: the commit before this note.
- **SETTINGS: one instrument picker, one square widget of its identity,
  placement and attributes (2026-09-08, operator: "in side bar add settings,
  in that page show the instrument details and attributes, there selected user
  role should edit details, view details", then "in a square widget i need
  Instrument ID and value, Area and Value, Building, and all the attribute keys
  and attributes values, these common settings on top user will select
  instrument … what ever instruments assigned to that user, only that
  instruments should come in selection").** `routes/settings/index.tsx` at `/settings`,
  sidebar item `settings`, permission-tree group `settings` with TWO
  configurable nodes — `settings.view` (gate `INSTRUMENT_READ`) and
  `settings.edit` (gate `INSTRUMENT_UPDATE`) — so who may view and who may edit
  is a Roles & Access → Sidebar toggle per role. **No new permission**: it
  shows and changes instruments, so it is governed by the permissions that
  already do. Counts: sidebar items 14 → **15**, routes 52 → **53**, tree
  groups 13 → **14**, nodes 55 → **57**, feature privileges 43 → **45**; no
  permission, reauth action, model, enum, config def, migration or API change.
  - **Removing a key from a profile REMOVES the attribute from that profile's
    instruments (2026-09-16, operator: "when i removed attributes for profile
    in configuration those are not removing for instruments").** The ONE
    exception to "profiles inherit prompts, never values". Case-folded; one
    `INSTRUMENT_ATTRIBUTE_REMOVED` audit row per instrument with the value and
    the remark; device told. `PUT /api/instrument-profiles/:id` refuses such a
    removal without `reason` (`REASON_REQUIRED`, `affected` listed);
    `GET /:id/attribute-usage` is how the page states the consequence first,
    through the remark dialog. Adding a key still back-fills nothing. Also that
    day: keys and display names must be unique IGNORING CASE — the
    `attribute-labels` zod refuses either, and the page flags a duplicate name
    on the row.
  - **A Common settings bar with ONE instrument picker, then ONE full-width widget** (square for an hour, then "remove the square shape, make widget full width")
    of key / value rows: Instrument ID, then every attribute (the server's
    `display` form where given). "Assigned to that user" is the instrument
    scope, applied by the SERVER on `GET /api/instruments`; the picker offers
    exactly what came back. **The picker is a Block → Area → instrument
    CASCADE since 2026-10-03** (operator: "in settings page give
    block/area/instrument wise selection"): the Data Report page's selection
    with the same pure rules (`history-selection.ts`); the scope (Area, else
    Block, else everything) goes to the list route as `functionalLocationId`,
    where the server expands a Block to its Areas — the page walks no tree.
    "All blocks" is the whole scoped list and the only way to reach an
    unassigned instrument. Block, Area and pick are remembered per browser.
    No count moved. **Building and Area are ATTRIBUTES here (100 of
    100 instruments carry both) and print once, as attributes.** A cut that
    also synthesised them from the functional location drew "why area and
    building coming 2 times"; do not add placement rows beside the attributes.
  - **Edit is INLINE (2026-09-16, operator: "when user clicks on edit values
    should be editable but another edit popup was showing and also in settings
    Instrument id should be changable").** Until then Edit opened the
    `AttributesPanel` in a dialog. Now Edit turns the tiles into inputs in
    place — the Instrument ID tile and every attribute tile the role may edit
    (`canEditAttributeKey` over `GET /attribute-access/me`, the panel's own
    source; ALL_VIEW leaves every attribute read-only and the ID still
    editable) — with Save and Cancel in the header. Save asks ONE remark for
    the batch of changed attributes (`RemarkDialog` gained a `changes` list),
    then, inside ONE `reauth.execute('UPDATE_INSTRUMENT_ATTRIBUTE')`, PUTs each
    changed KEY with that reason through the panel's endpoints and — last — the
    new code through `PUT /api/instruments/:id`. The callback is IDEMPOTENT
    (a set of done keys) because the re-auth hook REPLAYS it after a 401.
    Nothing changed writes nothing; the STORED value is edited, never the
    display form; a wildcard ID is refused before any request with the server
    rule's own reason. Details other than the ID still change on the
    Instruments detail page. `settings.edit` shows the buttons — presentation;
    the routes are the control. 13 tests; mutation-checked (no write / no
    wildcard guard each fail).
- **The Instrument ID (code) IS CHANGEABLE (2026-09-16, operator: "in
  settings Instrument id should be changable").** `updateInstrumentSchema`
  gained `code` under the SAME topic rule as create; `PUT /api/instruments/:id
  {code}` renames. It had been deliberately immutable ("baked into MQTT topics
  and the device configuration") — that consequence did not go away, it is
  now handled and stated: **the code is the MQTT client id and every topic
  segment, so the DEVICE must reconnect with the new id** (the auth hook
  refuses the old one from the commit), and `afterCodeChange` in
  `instruments/routes.ts` moves the broker's RETAINED state after the commit —
  the old attribute slot is cleared (empty retained publish) and the complete
  set republished under the new code; a gateway's roster moves and each
  child's slot (which sits UNDER the gateway code) moves with it; a renamed
  child's parent roster is republished by the existing roster pass. Name
  follows the code when it WAS the code (the 2026-09-04 rule) unless a name
  is given alongside. Duplicate → 409 `DUPLICATE_CODE`, wildcard → 400.
  `INSTRUMENT_UPDATED` already diffed `code`, so the audit row carries the
  rename. Pinned by `e2e/instrument-rename.e2e.test.ts` (6, over a captured
  publisher: standalone, child, gateway, duplicate/wildcard, no-op) and the
  re-pointed `instruments.test.ts` case that used to say "never its code".
  No count moved.
  - **The first cut was a TABLE of every instrument with expandable rows and an
    inline details form (`bee0363`, one commit)** and was replaced the same day
    on the operator's restatement. Do not bring the table back as a "second
    view" — the operator wants the widget.
  - The Instruments sidebar item and its pages are untouched. Nothing is
    granted by default — Roles & Access must grant `View Settings` /
    `Edit Settings`.
- **The Instrument History widget is the DATA REPORT PAGE, not a dashboard
  panel (2026-09-07, operator: "in dashboard Instruments history widget was
  there that widget removed there and add one side bar option Data Report, in
  that it should come").** `routes/data-report/index.tsx` mounts
  `routes/instruments/history-widget.tsx` under a page header at `/data-report`;
  sidebar item `data-report` and permission-tree group `data-report` (one node,
  `data_report.view`, gated on the EXISTING `INSTRUMENT_READ` — it shows
  instrument readings) make it a Roles & Access → Sidebar toggle. Counts:
  sidebar items 12 → **13**, routes 50 → **51**, tree groups 11 → **12**, tree
  nodes 52 → **53**, feature privileges 40 → **41**; no permission, reauth
  action, model, enum, config def or migration. The panel key
  `dashboard_history` is OUT of `PANELS` / `DEFAULT_DASHBOARD_LAYOUT` /
  `AUTO_HEIGHT_PANELS` — which is what takes it off the dashboard and off
  Roles & Access → Panels, the `dashboard_trend` precedent; **0 stored layouts
  named it** (role_configs / user_configs / system_config, measured before
  removal). The widget's `embedded` prop and header portal went with the panel
  as dead code; it prints NO title of its own (the page header does). The
  download's dialog name, file name and audit `reportType` read **`Data
  Report`**; rows logged 2026-09-05..07 read `Instrument History` and, being
  §11 records, were not rewritten. The Export Options surface KEY stays
  `instrument-history` (stored per role in `system_config`); only its label
  follows the page.
  **Later the same day:** the download moved OUT of the widget into a
  **Generate Data Report card** above it (`routes/data-report/
  generate-report-card.tsx`, text + one icon, the page's only trigger); the
  selection moved into the page hook `use-history-scope.ts` shared by card and
  widget; and the document lost its cover block — the Data Report prints
  one page per selected instrument (since 2026-11-03 `buildDataReport` in
  `routes/instruments/page-reports.ts`, over the templated builder; `renderDataReports` was deleted), each identical to the trend
  page's Time Series download, audit `reportType` **`Instrument Time Series`**
  (operator: "report should be same report of time series widget"). **And the
  trend page's HEADER "Export as PDF" is now that same Data Report** with the
  interval dialog, not the combined charts document ("in that report trends
  also coming remove those and add interval feature"); `TrendSlot` lost `both`.
  **And an extreme prints only for a bound IN FORCE** ("if Enable_Humid_NLT is
  disabled then dont show RH min in report, if nmt is disabled then dont show
  max … in all data reports"): `extremesCells` in `data-report.ts` follows the
  bound the server resolved (`limits`, already null for a disabled bound), so
  NMT-only instruments print `Temp. Max : 22.9` alone — a deliberate departure
  from `Data Report.pdf`. Never-administered reads as switched off;
  `limitEnabled` still never gates display. **And no report table ever has an
  empty cell** ("if value was not there dont show that boxes", "same for alarm
  report also"): `addTable` body cells may span columns (`SpanCell` in
  `lib/pdf-report.ts`) — the Data Report's lone Max / Min pair and its
  `Interval :` row span the row, a row with nothing to print is omitted; the
  Alarms page's report prints `''` for a switched-off bound (`BOUND_NOT_SHOWN`,
  not a dash; `N/A` unchanged) and DROPS a limit column no row can fill
  (`hiddenLimitColumns`). An `unboxEmpty` flag that hid the empty cell's border
  lasted one commit (`91511e8`) — it left tables with open corners ("table was
  not forming properly"); do not bring it back. **The Trend report's period
  summary follows the same rule** ("same in trends page also"): `Minimum` /
  `Maximum` only for a bound in force, the below / above line only for the
  assessed side(s).
  No count moved. See `apps/web/CLAUDE.md`.
- **The dashboard's selection alarms panel is the SHARED alarm table
  (2026-09-01).** `routes/dashboard/selection-alarms.tsx` was a bespoke `<ul>`;
  it now renders the cells from `routes/alarms/alarm-table.tsx`, the same ones
  the Alarms page and the trend widget use — a THIRD copy would have drifted the
  way the trend widget's copy did. It shows TEN columns plus an action cell
  since 2026-09-25 (operator: "cleared value and cleared time was not there in
  widget"): its query spans EVERY state, not `state=ACTIVE` — so a cleared
  alarm stays on the dashboard with its Cleared time and Cleared Value; only
  Duration and Area are omitted, and the panel is titled "Alarms in this
  selection" (was "Active alarms …"). **Acknowledging IS available and carries the whole
  §11 flow** — the `alarms.acknowledge` gate, the re-auth dialog, `postWithReauth`
  and a revalidation. It shipped without the button earlier the same day,
  correctly, because it had none of those; if one is ever stripped, strip the
  button with it. **Its action column is NOT sticky, and the column count argued
  the other way** — what decides it is that a sticky cell needs an opaque
  background, and this panel is deliberately transparent so the operator's
  PanelCard tint shows. **It is a TABULAR-view panel since 2026-09-22**
  (operator: "in graphical view dont show the alarm widget") — Graphical hides
  it with the readings table; `routes/dashboard/view-panels.ts` is the one rule
  for which panels each view hides, and the hidden set is carried back into any
  layout saved from the other view. Hidden, not removed: still in `PANELS` and
  on Roles & Access → Panels.
- **On `PUT /api/floorplans/:id/rooms/:roomId`, an omitted `doors` key leaves the
  column unchanged; only an explicit `null`/`[]` clears it.** Deliberate §11
  data-loss guard so a client that predates doors can't silently wipe them.
- **Room doors (2026-08-24):** `floorplan_rooms.doors` JSONB, nullable — an
  array of `{wall, offset, width, kind}` normalized against the wall so a door
  stays attached when the room moves. Drawn as real gaps with a swing arc in
  Config → Floorplans; rides the existing `UPDATE_FLOORPLAN_ROOM` reauth/audit
  path — no new permission or reauth action. New pure module
  `apps/web/src/routes/dashboard/room-geometry.ts` does wall splitting, door
  placement and tile layout.
- **Per-instrument tiles (2026-08-24):** each room box on the graphical floor
  view now renders ONE TILE PER INSTRUMENT (code, limits, decimals). This
  fixed a defect: the box previously rendered only `rows[0]`, hiding a room's
  second instrument, including when it was the one breaching a limit.
  **Since 2026-09-22 the reading font FILLS the tile** (was capped at 12 in
  rooms 100-500 wide; `fillFont()` in `room-geometry.ts`, bounded by height,
  width and 26) and the chip tone vocabulary is FOUR colours: green in limit,
  red crossed, **violet for a sensor fault** (`ERROR`, a `ChipTone` beside
  `InstrumentStatus`; was the breach red), amber offline / partial, grey
  `NA` for a slot with no reading — `tileValues()` in `floorplan-view.tsx`
  is the one rule. The instrument ID prints small and FIXED (`TILE_CODE_FONT`),
  and the plan is CONTAINED in its panel rather than setting its scroll height
  (both the same day, operator corrections). No count moved.
- **Cleanroom grade (2026-08-24):** `floorplan_rooms.grade` nullable TEXT
  (`A|B|C|D|CIRCULATION|UTILITY`), zod-validated, deliberately **not** a
  Postgres enum so the vocabulary can grow without a migration — the enum
  count stays at 13. Hue encodes grade, saturation encodes status; design spec
  `docs/superpowers/specs/2026-08-24-graphical-view-visual-design.md`.
- **The QC floor is TRACED, not generated (2026-08-31).** Every other plan comes
  out of `scripts/draw-cwh-floorplan.ts`'s guillotine split, which invents a
  plausible floor from a room count. QC is the one floor we have a drawing of
  (`QC Layout.png`), so its rooms are authored as literal measured coordinates
  in `apps/api/src/modules/floorplans/qc-layout.ts` and the generator is
  bypassed for that area alone. **No count moved** — no model, enum, migration,
  permission, module, config def or route; 23 rows in `floorplan_rooms` changed.
  - **RE-TRACED FROM THE ARCHITECTURAL DRAWING on 2026-09-21** (operator: "in
    layouts folder, in cwh subfolder there is qc layout image check that image
    once" … "and instrument ids should be remain those areas only"). **The
    2026-08-31 trace was taken from `QC Layout.png` at the repo ROOT — tracked
    as `Layouts/CWH/mockups/QC Layout.png` since 2026-10-05, it was ignored by
    `/*.png` until then — which is
    a MOCKUP made from the drawing** (tinted rooms, live readings, a legend,
    landscape 1204x1046, building 1.11 wide-to-tall); **the drawing is
    `Layouts/CWH/QC Layout.png`** (portrait 599x802, building 0.74), and the
    dimension strings written on it add up to the drawing's proportions, not
    the mockup's. Every rectangle and door in `qc-layout.ts` is now measured
    from the drawing; `QC_BUILDING` is `{13,5,591,791}` px and the plan's
    canvas 578x786. **Nothing that identifies a room moved**: codes, names,
    `fch`/`dims`, and all 12 instrument placements are unchanged (verified by
    SQL before and after — each instrument sits in the room of the same code).
    Applied by `draw-cwh-floorplan.ts --only QC --apply`: 23 rooms deleted, 22
    created, one audit row each. What follows in this bullet is kept as
    history; where it names a specific it is the MOCKUP's, and these are the
    corrections:
    - Rooms are 22, not 23: the mockup's **AIRLOCK and SHAFT-W do not exist on
      the drawing** and are gone; **CORRIDOR-08 is now THREE rectangles**
      (`CWH-I/217`, `(2)`, `(3)`) because the CHANGE ROOM's top wall sits
      inside the corridor band and the short piece above it needed its own
      box. Coverage is exactly 1.0 — the table tessellates.
    - **HPLC ROOM HAS TWO DOORS** onto the corridor leg (wall gaps at y
      324..355 and 574..606). The "drawn with NO door" finding below was the
      mockup's, not the drawing's. DISSOLUTION ROOM-I also has a SECOND door;
      SAMPLE DESTRUCTION's door is at the LEFT third of its bottom wall (the
      mockup had it at the right end); SAMPLE PREPARATION's top door is at the
      RIGHT end (the mockup had it at the left).
    - `canvasFor(23)` vs the building no longer "happen to agree" — the
      generator picks a landscape box and the building is portrait. The bypass
      is now load-bearing, not free.
    - The mockup's two airflow arrows are not on the drawing and are gone
      (`airflow: []`). The two `W` water circles and the exhaust arrows are
      still outside the east wall on the drawing too, and are still clipped /
      moved as described below; the pixel numbers there (x=1190, wall 1108)
      are the mockup's.
    - **QC 3 and QC Microbiology are TRACED too (later the same day, operator:
      "do the same for qc 3 and microbiology layouts")** from
      `Layouts/CWH/QC 3 Layout.png` and `Layouts/CWH/Microbiology.png`:
      `qc3-layout.ts` (35 rooms) and `microbiology-layout.ts` (22 rooms) on
      the shared `traced-layout.ts`, registered in the drawing script's
      `TRACED` map (which replaced `TRACED_AREA`). Every instrument sits in the
      room its `Location` attribute names (SQL-verified); `CWH/RDU/051-00`
      "Incubator room" is in the unnumbered INCUBATOR ROOM-01 by judgement.
      Departures are in each file's header — QC 3's L-shaped building carries
      the `GD ENTRY` yard as a UTILITY room; the Microbiology image is CUT OFF
      at the bottom, so its south row's south walls are computed from the
      written depths. Tests: `__tests__/traced-layouts.test.ts`. **Only
      Stability, Module-E, Module-F and Ware House are still generated.**
      **Microbiology's half of this is SUPERSEDED (2026-10-01): it is a polygon
      trace in the 2D architectural style now — see the Microbiology bullet
      below. QC 3 followed the same day, and the `TRACED` map, `traced-layout.ts`
      and `traced-layouts.test.ts` went with it — no floor is a rectangle trace
      any more.**
    - **The corridor pieces DRAW as one space (same day, operator: "corridor
      single line, not divided into separately").** The seam between two
      adjoining CIRCULATION rooms is cut out of the walls by the VIEW
      (`sharedOpenings()` in `apps/web/.../room-geometry.ts`), and a
      continuation piece prints no code or name — see `apps/web/CLAUDE.md`.
      The stored rooms are unchanged: three rectangles, three §11 records.
      **`SHAFT-E` is UTILITY, not CIRCULATION**, or the corridor would open
      into the service band. Re-applied to the local database.
  - **SUPERSEDED the same day: there is ONE QC plan, "CWH — QC", drawn from
    `qc-layout-2.ts` in the 2D ARCHITECTURAL style** (operator chose concept A
    of three in `Layouts/CWH/concepts/`). `scripts/draw-qc-layout-2.ts` redraws
    "CWH — QC" and deleted "CWH — QC Layout-2" (audited); `draw-cwh-floorplan.ts`
    skips QC (`DRAWN_ELSEWHERE`). The style is `annotations.style =
    'architectural'` (declared in the schema); `floorplan-view.tsx` draws such a
    plan with double walls, status-washed rooms, one card per instrument placed
    by `placeCard`, dashed swings and a side panel. The bullet below is history.
  - **"CWH — QC Microbiology" is drawn the same way (2026-10-01, operator:
    "same like qc layout there Microbiology layout image in folder make layout
    as per that image same like qc").** `microbiology-layout.ts` was REWRITTEN
    in place: `Layouts/CWH/Microbiology.png` re-measured as polygons on the wall
    centre lines — 21 rooms (INCUBATOR ROOM-01 is ONE L-shape, no `(2)` piece),
    25 door leaves by measured gap and hinge side, 4 columns, 7 windows.
    **No count moved** — no model, enum, migration, route, config def or page.
    - **`architectural-layout.ts` is the ONE home of the trace types and the
      px → stored conversions** (`ArchLayout`, `edgeDoor`, `archPoints`,
      `archAnnotations`), lifted out of `qc-layout-2.ts` unchanged; QC's output
      was compared byte for byte before and after. A third floor in this style
      is a new `ArchLayout` file plus one line in the script's `LAYOUTS`.
    - **`scripts/draw-architectural-floor.ts --area "<area>" [--apply]`** draws
      it (dry run by default; audited like the other drawing scripts; label /
      grade / meta carried by room code). QC keeps its own
      `draw-qc-layout-2.ts`, which also retires the second QC plan.
      `draw-cwh-floorplan.ts` skips both areas (`DRAWN_ELSEWHERE`).
      **Applied LOCALLY; AWS needs `draw-architectural-floor.ts --area "QC
      Microbiology" --apply` after the next deploy.**
    - **Still true from the first trace:** the image is CUT OFF at the bottom,
      so the south wall (y 660) is computed from the written depths; and
      `CWH/RDU/051-00` sits in the unnumbered INCUBATOR ROOM-01 by judgement.
      Walls draw ~11 px thick against the drawing's 6.
    - **CORRECTED the same day against an OVERLAY (operator: "rooms dooars and
      room lines are some places not matches with image").** The first version
      listed four "deliberate departures"; laid over the drawing at the same
      scale, they were exactly the four mismatches. Now: INCUBATOR ROOM-02 has
      its TWO east walls (the labs' wall x 165 is the room edge and carries the
      door pair; its own partition x 146.5 is a wall stub broken at the doors);
      the emergency exit swings OUT (**new optional door field `swing: 'in' |
      'out'`**, in the body schema AND the response schema — exterior doors
      only); the HPHV sterilizer and the cross-over bench are outlined
      (`annotations.equipment` / `labels`, drawn in the 2D style only).
      **A side-by-side picture is not a comparison: lay the render OVER the
      drawing, half transparent, at the same scale, and look at each wall.**
    - **"CWH — QC 3" is the third floor in this style (same day, operator:
      "do this one also,everything should 100 % matched doors and room lines
      everything").** `qc3-layout.ts` REWRITTEN in place from
      `Layouts/CWH/QC 3 Layout.png`: 31 rooms tiling an L-shaped building (no
      made-up `GD ENTRY` room — the yard is outside and not drawn), 30 doors
      (16 single, 14 double; the two corridor exits open OUT), the three
      weighing areas as open bays and the hot zone's gap into the wet lab as
      leafless openings, 26 columns, 7 windows, the hold area's sliding door
      and two pass boxes outlined. **CORRIDOR-11 runs right round the middle
      block, and an outline cannot have a hole: it is two pieces of ONE code**
      (`CWH-I/235` the U, `CWH-I/235 (2)` the south band), which the view joins
      with no wall. Drawn by `draw-architectural-floor.ts --area "QC 3"`;
      applied LOCALLY (35 rooms out, 31 in, 12 instruments in the same rooms);
      **AWS needs that run.** `vPair` / `hPair` in `architectural-layout.ts`
      make a double door. Checked by overlay on the drawing, tile by tile,
      BEFORE applying. The two LCMS rooms are ~65 units wide, too narrow for a
      14-character ID on one line; the operator's next message was "rooms are
      very small at top", and they now get a `mini` card with the ID on two
      lines (`splitCode`; `chooseCard` scores the smaller of Location and ID).
      The ROOMS were not enlarged then — and WERE two messages later ("rooms
      are very small and those data was showing very small", "increase
      widgth and give legend on below the layout"): **QC 3's north row is
      the ONE place a traced plan leaves its drawing** — 32 px taller, the
      two LCMS rooms 82 px wide, the three glass-ware rooms between them
      narrower (`NORTH_ROW`, `NORTH_X`, `qc3Y` in `qc3-layout.ts`; every
      other wall is the drawing's, the rooms below 32 px lower). The `mini`
      card is drawn at the other cards' sizes so it GROWS with the room
      (ID 8 → 13 units) and is tried last (`NARROW_ROOM_SHAPES`); the same
      rule gave three Microbiology cards a two-line ID. Re-applied locally;
      **AWS needs the QC 3 run again.**
      In the view, same day: a long room NAME wraps to two or three lines
      inside a small room (`placeRoomName` → `lines`, judged on `fit`, not the
      7-unit floor) and a very long Location takes three lines (`splitLabel`).
    - **A LANDSCAPE plan's legend sits UNDER it as a strip (same day,
      operator: "width is small,rooms and text are slightly no space and look
      is not good").** The Microbiology plan is 2.2:1, so the panel's width
      sizes it and the side panel cost a fifth of that. Also: 2D line weights
      scale with the canvas width (QC's 1069 is the reference; never heavier),
      and a tall narrow empty room prints its name up its length. QC is
      unchanged by all three — see `apps/web/CLAUDE.md`. **Later the same
      day the rule became "every 2D plan that is not portrait"**
      (`LEGEND_UNDER_RATIO` 0.9; operator, on QC 3: "give legend on below
      the layout"). On a near-square plan that is a TRADE: the floor panel
      is full width and 880 px tall in every stored layout, so such a plan
      is sized by HEIGHT and the strip costs it some. A taller panel or
      Full screen is what enlarges it.
    - **In FULL SCREEN a 2D plan is laid out to the SCREEN's proportions
      (same day, operator: "QC 3 and QC layouts only there is center of
      the screen not adjusted to full screen").** `fillHeight` in
      `floorplan-view.tsx` picks the viewBox height that makes the drawn
      extent the shape of the measured box; rooms are re-proportioned and
      every card, name and arc is drawn undistorted inside them. The panel
      view keeps the drawing's proportions, byte for byte. **2D style
      only** - the generated floors' fixed tiles break when stretched and
      stay centred. `planExtent` no longer clips drawn content at the
      canvas edge (only its margin stops there). See `apps/web/CLAUDE.md`.
    - **"CWH — Module-E" is the FOURTH floor in this style (same day,
      operator: "do module-e layout also same like qc").**
      `module-e-layout.ts`, traced from `Layouts/CWH/Module-E layout.pdf` —
      a VECTOR PDF, so the walls were READ from the file (PyMuPDF
      `get_drawings()`), not scanned; coordinates are PDF points. 25 rooms:
      the module only (the connecting corridor, staircases and main corridor
      are outside its walls and not drawn); GRANULATION AREA is one
      24-corner room; return ducts and column casings are VOIDS closed by
      stubs; twelve sliding doors are a leafless opening plus an outlined
      bar; two rooms share CWH-I/017 on the drawing, the second is
      `CWH-I/017 (3.5KL BLENDER)`. The 8 instruments sit where their
      `Location` says (031-00 "Blender Area" in the BLENDER AREA by
      judgement); **the drawing's nine numbered sensor marks are NOT these
      instruments** and are not drawn. Applied LOCALLY; **AWS needs
      `draw-architectural-floor.ts --area "Module-E" --apply`.** Only
      Stability, Module-F and Ware House are still generated. In the view:
      a card in an L-shaped room tries the room's other arms
      (`inscribedRects`, shared) when the largest holds no legible card.
    - **THE 2D STYLE'S LOOK IS "VIVID STATUS" (same day, operator: "make those
      layout more professional and beautiful and colorful ui"; chose concept A
      of three, `Layouts/CWH/concepts/look-*.png`).** Paint only, in
      `floorplan-view.tsx` (`ARCH`, `readingPill`): room floors are a gradient
      of the room's status colour, the plate is white (no grid), walls navy
      with a light core, card headers a status gradient, and each reading in
      a pill - a soft tint of the QUANTITY when in limit, SOLID status colour
      with white text otherwise. The legend names the pill colours. The
      standard style is untouched. See `apps/web/CLAUDE.md`.
    - **Two more card shapes, `tall` and `compact`, exist for rooms the design
      cards cannot serve** — tried ONLY when `std` / `wide` print the Location
      under `LEGIBLE_LOC_FONT` (9 units; `chooseCard` in `floorplan-view.tsx`).
      The LAF / BSC rooms are ~100 units wide and printed it at ~6. **Do not
      drop that gate**: without it the compact card wins in mid-size rooms and
      changes QC's cards, whose smallest Location is 9.1. An empty room's name
      steps clear of door swings and columns (`placeRoomName`).
    - **"CWH — Module-F" is TWO floors (2026-10-01, operator: "for module F
      there are 2 layouts ground floor and first floor … give option in
      Module F like Ground Floor and First floor").** `module-f-layout.ts`
      traces BOTH from the vector PDFs `Layouts/CWH/Mod-F Ground floor.pdf` /
      `Mod-F First floor.pdf` (PDF points, PyMuPDF, page stored rotated
      270°): plans "CWH — Module-F — Ground Floor" (the generated plan
      RENAMED, `renamesPlan`) and "— First Floor" (created at the same sort
      order). 16 of 17 instruments placed; **072-00 "3.5KL Blender" is
      deliberately UNPLACED** — no Module-F drawing has that room (Module-E's
      does). **Both floors are DRAWN LARGER than measured** — half as tall
      again, the narrow instrument columns wider — through `enlargeLayout()`
      in `architectural-layout.ts` (the ONE rule: leafless openings stretch,
      hinged doors keep their width and stay beside the nearest wall line,
      columns keep their size); the trace keeps the MEASURED numbers
      (`MODULE_F_*_TRACE`), `MODULE_F_*_LAYOUT` is what is drawn. **A plan
      can be ONE FLOOR of a building** — `annotations.floor {group, label,
      order}` — and say where NORTH is (`annotations.north`, degrees
      clockwise from the top; Module-F: 90); both DECLARED in `planProps`.
      The dashboard lists a building once with a floor switch in its title
      bar (`planEntries`), **offers only the SELECTED location's layouts**
      (`plansForSelection`: the plans holding one of the selection's
      instruments; a selection on no plan says so), and the legend's compass
      turns to the marked north. Cards: drawn OVER outlined plant only when
      illegible clear of it (`chooseCardOverPlant`; the plant layer
      `fp-plant` now sits between walls and cards), `mini` wins a tie on a
      quarter-larger ID and wraps to three lines sooner
      (`CARD_SHAPES[*].three`). The Layout Designer has a **Delete plan**
      button (confirm names the unplaced instruments; the existing audited
      `DELETE /api/floorplans/:id`). The four older 2D floors and Stability
      render byte-identically. `draw-architectural-floor.ts --area "Module-F"`
      draws both; **applied LOCALLY; AWS needs it.** No count moved.
  - **A SECOND QC plan, "CWH — QC Layout-2" (2026-10-01)**, traced from
    `Layouts/CWH/QC Layout-2.png` (the same floor, clean) in
    `qc-layout-2.ts` by `scripts/draw-qc-layout-2.ts`: polygon rooms (the two
    L-shapes, ONE corridor polygon), doors on real edges incl. 4 exterior, and
    a STRUCTURE layer (`columns` / `windows` / `walls` annotations) that the
    dashboard DOES draw. The 12 QC instruments live on it now; "CWH — QC"
    holds none. The dashboard also cuts a neighbour's door out of the shared
    wall (`neighbourDoorOpenings`) — before that, every door gap was drawn over.
    Second pass the same day, against a SCREENSHOT of the real component:
    door arcs were centred on the wrong corner on every plan (sweep flag
    inverted — fixed, tested); doors have a `hinge` (`start`|`end`|`none`);
    doors draw after the tiles; tiles sit in the INSCRIBED rect; a selected
    location draws the whole floor (`roomsToDraw`). Verify floor changes by
    rendering `FloorplanView` and comparing the image, not the numbers.
  - **Room codes on this plan are ROOM numbers (`CWH-I/216`..`/233`), not
    instrument codes**, and `label` carries the room name. That reverses the
    premise recorded against `GET /api/alarms` above — see it for what follows.
  - Wall positions were MEASURED off the PNG (dark-pixel run scan, clustered),
    not eyeballed; doors came from the wall gaps cross-checked against the
    orange swing arcs, isolated by colour. The pixel coordinates are kept in the
    table rather than pre-divided decimals so the next person can re-measure
    against the same image and compare like with like.
  - **Every edge is quoted from one canonical grid, and a test enforces it.**
    The generator got exact tessellation for free — a guillotine cut cannot
    overlap or leave a gap. A hand-traced table only gets it by discipline, so
    `__tests__/qc-layout.test.ts` asserts no two rooms overlap, every edge is
    on the measured grid, coverage is above 95% (0.9694 as written), no door
    overruns its wall, and
    each of the 12 instruments lands in the room `CWH.xlsx` names. Mutation-
    checked: overlapping two rooms fails 2 of them.
  - **Two rooms are knowingly approximate**, because a room is ONE rectangle.
    SAMPLE PREPARATION (`CWH-I/222`) is an L and is stored as its bounding box,
    losing one internal partition — splitting it would have to invent a wall,
    and a false wall says a space is closed when it is open. CORRIDOR-08 IS
    split, into `CWH-I/217` and `CWH-I/217 (2)`, since its two legs read as two
    runs and the drawing dimensions them separately; the `(2)` suffix is the
    precedent already used for SERVICE CORRIDOR.
  - **HPLC ROOM is drawn with NO door** — all four of its walls scan continuous
    in the drawing. Reproduced rather than corrected: inventing a door on a GMP
    plan is inventing a means of escape. Fix the drawing first.
  - **Grades still come from the instrument's own limits**, exactly as the
    generated plans do, so the whole floor reads grade C. The drawing's colours
    encode room FUNCTION, which is not a cleanroom classification — painting an
    office blue to match would make the on-screen "grade" legend lie.
  - **Bypassing `canvasFor(roomCount)` costs nothing here, but check it if the
    room count moves.** That function keeps a ROOM the same size across plans so
    the set reads as one building; the traced plan has to use the building's own
    proportions instead. They happen to agree — `canvasFor(23)` gives a viewBox
    height of 958, the building gives 901.
  - `--only <area>` was added to the script so redrawing one floor does not
    delete and recreate every room on all eight plans; each room is a §11 record
    and re-signing a hundred nobody touched makes the audit trail describe work
    that did not happen.
  - **The rest of the drawing landed the same day** (operator reaffirmed three
    times that they wanted the plan exactly as drawn, not the rooms alone).
    Migration `20260831220000_floorplan_annotations` adds TWO NULLABLE JSONB
    COLUMNS and nothing else — `floorplan_rooms.meta` `{fill, fch, dims}` and
    `floorplans.annotations` `{equipment, hvac, water, airflow, labels}`. Same
    shape as the `doors`/`grade` additions, and for the same reason: a drawing's
    vocabulary grows, and a migration per annotation kind is a tax on
    transcribing one. **Models stay 35, enums stay 12.** NULL on every generated
    plan, which renders exactly as before.
    - **`meta.fill` OVERRIDES the grade hue, and that is safe only because the
      grade legend and tab were both removed on 2026-08-24/27.** The
      draughtsman's colours say what a room is FOR; `grade` says how it is
      classified. Both are stored, and `grade` is still returned and still
      correct. **If a grade legend ever comes back, it must not key off the
      fill** — on this plan they disagree by design.
    - **`fch` and `dims` are transcribed STRINGS, never computed.** The drawing
      is schematic and not to scale, so deriving a size from `w`/`h` would print
      a number the plan does not carry.
    - **Nothing in the annotation layer ever takes a status colour.** An HVAC
      symbol is where a unit is DRAWN; nothing in this install senses one, and
      colouring it would assert a health nobody measured. The whole layer is
      `pointerEvents="none"` so a symbol cannot swallow a click meant for the
      room under it.
    - `tileLayout()` gained a `headerH` parameter. A traced room prints four
      caption lines where a generated one prints one, and the tile grid is sized
      from the leftover — a view that drew four lines into the old 14px header
      would lay the first row of READINGS on top of them.
    - **Three things in the PNG are still deliberately absent.** The `EXHAUST`
      arrows and the two `W` circles are drawn OUTSIDE the building wall (to
      x=1190, past the wall at 1108) and the renderer strokes the viewBox border
      as that wall, so anything beyond it is clipped: the water points were moved
      onto the east wall where they connect, and the external exhaust arrows are
      omitted. `DRAFT COPY` / `EXISTING LAYOUT` are drawing-status stamps, and a
      live monitoring screen captioned DRAFT COPY would be actively misleading
      about the readings on it. And the `2900 x 7240` partition inside SAMPLE
      PREPARATION, as above.
    - Pinned by `src/e2e/floorplan-annotations.e2e.test.ts` — which asserts on
      the JSON that actually LEAVES the route, inner keys individually, because
      Fastify strips undeclared response properties silently and this repo has
      been bitten by that twice. Mutation-checked: dropping `labels[].text` from
      the schema fails it.
- [Keys per instrument PROFILE since 2026-10-26 — see PROFILE MEASUREMENTS, top of part 1.] **MEAN KINETIC TEMPERATURE on the Data Report, per instrument (2026-10-03,
  operator: "isMktcalculationenabled attributes is true then in data report
  mkt value should come, if false … should not come").** `MKT :` prints on
  the `Interval :` row's right half, at the temperature precision, iff the
  SERVER sent `summaries[<temp key>].mkt` on the chart path — which it does
  iff the instrument's `isMktCalculationEnabled` attribute is on
  (`isMktEnabled` in `@digilog/shared`, OFF by default: absent / blank /
  anything else = no figure — the opposite default from the limit enable
  flags, on purpose). ICH Q1A / USP <1150>, ΔH/R = 10,000 K, computed in SQL
  over EVERY reading in the period (`getRangeSummary` → `mktExpMean` →
  `mktFromExpMean`), the same population as Max / Min. Temperature slot only.
  The browser never re-reads the flag or re-derives the figure. Every local
  instrument carries `0`, so nothing prints until one is set to `1`. Shared
  type files 32 → **33** (`mkt.ts`); no other count moved.
- **The Time Series widget's download is the DATA REPORT (2026-09-04)** — built
  to `Data Report.pdf` at the repo root, the way the Alarm Report was built to
  `Alarm Report.pdf`. Pure layout in `routes/instruments/data-report.ts`,
  drawn since 2026-11-03 by `buildDataReport` over the templated builder (`renderDataReport` was deleted). Interval rows are a SCHEDULE anchored on the
  FIRST READING, one slot per interval to the period end, each the FIRST STORED
  READING in it or `NA`, printed NEWEST FIRST (2026-09-05; until then buckets
  were aligned to the period start, oldest first, gaps omitted). Limit crossings
  and the `Error`/`OL` words print bold; the interval is chosen in the download
  dialog. `pdf-report.ts` gained per-report typography (`ReportConfig.typography`,
  `showAppName`, `addTable.bold`) — the Data Report opts up, every other report
  prints as before. Max/Min come from the server's whole-range `summaries`, never
  the printed rows; Block/Area resolve by id through `/api/functional-locations`,
  Location is the attribute. Audit type stays `Instrument Time Series`. See
  `CHANGELOG.md`.
- **Instrument trend page (2026-08-24):** new route `/instruments/:id/trend`
  — period + interval header, latest-value cards, limit-lined charts (reusing
  `TimeSeriesChart`), a raw paged time-series, an alarms widget, and (until
  2026-09-01, when the page was rebuilt) per-user extra telemetry keys in
  `localStorage` — **gone; since 2026-10-29 the extra keys are per PROFILE
  (widget data keys phase 3, above)**. New shared module
  `packages/shared/src/types/telemetry-period.ts` (period presets, interval
  specs, range resolution). Aggregation is an explicit OPT-IN and defaults to
  `raw`: when an interval IS selected the chart averages client-side and says
  so on screen ("Averaged over 5 minutes — the table below shows every
  reading") — a derived point must never look like a stored reading. Wide
  ranges are handled by SELECTION instead, not by averaging — see the
  2026-08-27 note below.
- **Governed report downloads (2026-08-24):** new reauth action
  `DOWNLOAD_REPORT` under a new `Reports` category (46 → 47 reauth actions,
  7 → 8 categories). `POST /api/audit/report-export-log` now requires
  `remarks` and enforces `DOWNLOAD_REPORT` reauth; it reuses the existing
  `REPORT_GENERATED` audit action — no new audit action was added (93/87/7
  unchanged). The Audit Trail export moved onto the same dialog, so every
  report download in the product is now governed.
- **Fixed a pre-existing security gap (2026-08-24):** `GET /:id/telemetry`
  had no instrument-visibility scoping (a bare `findUnique`) while its
  sibling `GET /:id` did — telemetry was readable for instruments outside
  the caller's resolved scope (see the instrument VISIBILITY note above).
  Now scoped the same way: 404 (never 403) when out of scope; callers with
  unrestricted scope are unaffected.
- **Alarm webhook annunciator (2026-08-27).** Alarms now reach a *device* — an
  IP-addressable hooter — as well as a person. Two models,
  `AlarmWebhookTarget` (URL, method, headers, content type, body template,
  success regex, timeout, `fireOn{Raised,Cleared,Acknowledged}`, severities,
  cooldown, scope) and `AlarmWebhookDelivery` (the §11 receipt: ONE ROW PER
  ATTEMPT, success or failure, with the URL and rendered body actually sent).
  Migration `20260827120000_alarm_webhooks`, applied to both databases.
  **No new permission** (reuses `ALARM_RULE_READ` / `ALARM_RULE_MANAGE`) and
  **no new Prisma enum** (`method`/`event`/`status` are validated strings) —
  don't go looking for either.
  - **Keyed off the INSTRUMENT, never the alarm rule.** `Alarm.ruleId` is
    nullable and the `INSTRUMENT_LIMIT` alarms that actually fire here have no
    rule row, so a design hung off `AlarmRule` would annunciate nothing while
    looking correctly configured.
  - **Scope reuses the `instrument_scope` shape — no fourth grouping concept.**
    `scopeLocationIds` (functional locations, a Block expanding to its Areas via
    `resolveLocationIds()`) UNIONED with `scopeInstrumentIds`. Unlike
    `instrument_scope` both are `NOT NULL DEFAULT '[]'`, and **both empty
    matches NOTHING, never everything** — a silent target is a bug someone
    fixes; a plant-wide buzzer gets the feature switched off for good. Several
    targets may match one instrument and all of them fire (local panel plus
    control room) — that is intended.
  - **Cooldown throttles `RAISED` only.** `CLEARED` and `ACKNOWLEDGED` are
    silence signals; rate-limiting the off switch leaves a buzzer sounding for a
    condition that has gone. In-memory per-target map, same single-instance
    caveat as the dispatcher's.
  - **Body rendering is `alarm-webhooks/render-body.ts`, deliberately NOT
    `notification-delivery/template-engine.ts:resolveTemplate()`.** That one
    HTML-escapes `& < > "`, which corrupts a JSON payload — an instrument named
    `Chiller "A" & B` would ship `&quot;A&quot;` and the hooter would reject the
    request intermittently, looking like a network fault. Placeholders come from
    the exported `ALARM_WEBHOOK_VARIABLES`, which the config page's picker
    renders from, so the UI cannot advertise a variable the renderer won't
    produce.
  - **Worker `alarm_webhook`, enqueued `maxAttempts: 1`.** Retry is bounded
    inside the task (3 attempts, ~2s apart) so graphile-worker's exponential
    backoff cannot sound a buzzer twenty minutes after the excursion cleared.
    Event-driven — no `crontab.txt` entry on purpose.
  - The `/config` card is **SUPER_ADMIN-ONLY**, not default-deny — this
    file claimed the latter until 2026-08-27 and it was FALSE.
    `apps/web/src/routes/config/index.tsx` reads
    `const visibleSuperAdminCards = isSuperAdmin ? superAdminCards : []` (the
    delegation allow-list was removed 2026-08-19), and the Alarm Webhooks card
    is in `superAdminCards`. A non-SUPER_ADMIN therefore NEVER sees the card,
    and granting `alarm-webhooks` under Configuration Access will NOT surface
    it. They can still reach `/config/alarm-webhooks` by URL, where the route's
    `RequireRole permissions={[ALARM_RULE_READ]}` admits them. Alarm Rules sits
    in the same array, so the BEHAVIOUR is precedent-consistent — only the
    description was wrong.
  - Instrument-visibility scoping on `/api/alarm-webhooks` is **SPLIT**
    (corrected 2026-08-27; this file previously said the whole module was
    unscoped). The CONFIG routes (`GET /`, `GET /:id`, mutations) are
    deliberately NOT scoped, matching the alarm RULES routes — a half-scoped
    config surface is worse than an unscoped one, because an admin who could
    see only half the plant would build a target that silently omitted the rest
    and could not tell. `GET /:id/deliveries` **IS** scoped: it is not
    configuration, and it returns `requestBody` verbatim, which under the
    default template carries the instrument code and the reading for every
    excursion. Rows whose `alarmId` is NULL (TEST fires) are returned — they
    name no instrument.
  - Outbound stance, on the record: the URL is operator-typed and on their LAN,
    so there is **no allowlist**. The guards are a hard per-request timeout,
    `redirect: 'error'`, no cookies/credentials/session token, and the exact
    URL, body, status and response snippet in the delivery log for every
    attempt.
  - Design spec: `docs/superpowers/specs/2026-08-27-alarm-webhook-annunciator-design.md`.

- **Trend page: wide ranges are SAMPLED, and the range figures are true
  (2026-08-27).** No count moved — no model, enum, permission, reauth action,
  config def, module or route was added. Spec:
  `docs/superpowers/specs/2026-08-27-instrument-trend-page-design.md`.
  - **The bug this fixed.** `GET /:id/telemetry` silently capped at the newest
    1000 readings (`Math.min(limit, 1000)` with `ORDER BY ts DESC`) for ANY
    range. A 7-day or 30-day chart therefore plotted roughly the last DAY while
    the axis claimed a week, and every figure derived from it described that
    slice. The PDF report's own fetch had the same defect. Nothing on screen
    said so — this is the shape of defect to look for whenever a "limit" and a
    "range" meet in one query.
  - **Downsampling is by SELECTION, never by averaging.** `lttb()` in
    `@digilog/shared` (`types/telemetry-downsample.ts`,
    Largest-Triangle-Three-Buckets) returns a subset of the input array —
    every plotted point is a STORED reading at its STORED timestamp, and the
    unit tests assert reference equality (`toBe`) so a refactor that builds new
    objects fails. First and last readings are always kept, or the chart's
    x-extent would disagree with the range asked for. Averaging is a separate,
    opt-in, labelled control and is off by default.
  - **When a chart is showing a subset it SAYS SO on screen** —
    `sampled-note.tsx`: "Showing 2,000 of 28,431 readings." `shown` is the RAW
    READING COUNT, not the number of points after any client-side bucketing;
    quoting the bucket count would understate what the range was read from.
  - **Out-of-limit counts and the readings count come from SQL over the WHOLE
    range** (`telemetry.repository.ts:getRangeSummary`), never from the plotted
    subset, so a sampled chart cannot understate an excursion. **The trend
    PDF's per-slot period summary table — and `trend-summary.ts`, whose only
    consumer it was — were REMOVED on 2026-10-05** (operator: "in trend repots
    remove period summary table"); the server's whole-range figures still
    print on the Data Report (`slotExtremes` over the same `summaries`).
  - **Zoom REFETCHES; it does not magnify.** Drag-selecting a span sets a
    custom range and requests it fresh, so zooming into a sampled 30-day view
    reveals the true raw readings for the narrower window. Magnifying the
    subset already in hand would draw bigger dots and claim a resolution the
    client does not have.
  - **The signed PDF's banner was REWORDED, because fixing the truncation
    turned a true disclosure into a false one.** It used to say the report
    covered "the most recent portion" of the period — true under `ORDER BY ts
    DESC`, false once the rows are spread across the whole range by sampling. A
    disclosure is a §11 claim and goes stale when the thing it discloses is
    fixed; check the wording whenever the data path under it changes.
