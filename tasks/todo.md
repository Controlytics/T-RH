# tasks/todo.md

## 2026-11-03 .. 2026-11-05 — RULE CHAINS (a ThingsBoard-style rule engine) — built, not pushed, not deployed

Operator: "add rule chains how in thingsboard has same add rule chains and what ever rule nodes are in thingsboard those all
should come in this also, and all the nodes functionalities should be come as same", then "skip questions and start". Spec
`docs/superpowers/specs/2026-11-03-rule-chains-design.md`, plan `docs/superpowers/plans/2026-11-03-rule-chains.md`, SDD
ledger and every ruling `.superpowers/sdd/2026-11-03-rule-chains/progress.md`; the rules in `docs/feature-notes.md` RULE CHAINS;
every route in `docs/recreation/06-api/endpoints.md`.

- [x] T1 shared — catalogue (86 = 47 built / 10 later / 29 none), document, permissions, reauth, audit, sidebar, tree, import /
  export, configurationVersion upgrades, CV-3 boundary (`0c1bb61c` `83b736c8` `a4e661ff` `02de0005` `46c91dc9` `c3d1c76a`
  `6740b577` `f1f54f88`)
- [x] T2 API — 4 models, 2 migrations, routes, 2 config defs, credentials masked for every caller (`2dbf3b62` `481a7820`
  `b57c83a0` `8c3553e8`)
- [x] T3 engine — queue, processor, script VM, debug, durable path, emit hooks, stats / test-script / inject (`06532861`
  `8e916ce3` `864d0098` `3112b462` `eece0222` `0b57af6f` `0df7624c` `76a15f10` `738f9e50`)
- [x] T4 filter / flow / transformation nodes (`6ca785d8` `202f9810` `c4179379` `7c2ef9e3`)
- [x] T5 enrichment / action nodes, RULE alarms, ThingsBoard parity TB-P (`f33b2449` `6a2cf576` `b8a17e1f`)
- [x] T6 external nodes, the S-6 target guard, the v3.6.4 / v4.2 ThingsBoard fixtures (`d8631f4d` `a0264c91` `ca591b65`)
- [x] T7 web — list, canvas editor, settings forms, debug panel (`9335a869` `66f08fc5` `995fcd86` `7119d4c4`)
- [x] T8 docs — changelog, feature note, endpoints, package notes, counts, spec superseding notes, CONTRIBUTING row (this entry;
  report `.superpowers/sdd/2026-11-03-rule-chains/task-8-report.md`)
- [x] Engine fix round 3, part 1 — RE-3 `scriptTimeoutMs` max 5,000 ms (`6930fa18`); RE-1 re-entry one generation deep +
  `alarms.createOrUpdate` changed-only (`1cc3d5f4`); RE-2 durable items never evicted, refused at capacity, handed back on
  stop, a refused job rescheduled instead of thrown (`366f9b63`); the e2e on the REAL handlers, RE-1 pinned on the real
  nodes, the `alarms.clear` origin runtime pin (`bcbe2bf3`, re-review I2).
- [x] **Engine fix round 3, the rest** — DONE 2026-11-05 (`a7fce274`, `aef2d5b0`, `398c8004`, `daaaa0ab`, D8-1 `39ddd221`,
  `9d6b6aac`; report `task-3c-report.md`, 39/39 mutants): MQTT 3.1 passthrough + 23-char client id, fail fast on
  a dropped client, delete `services.http.fetch`, `cert.PEM` with ssl off; Generator disable key on the live version;
  getChain-null test; onInit backoff; mutants F1 / F5 / F6; `task-3c-report.md`.
- [x] **Final fix wave** — DONE 2026-11-05 after the three whole-branch reviews (`924fda9f` .. `2b2114b6`, 52 commits; reports
  `fw-api-report.md`, `fw-n1-report.md`, `fw-n2-report.md`, `fw-n3-report.md`; CHANGELOG "RULE CHAINS — final fix wave"; no
  migration, no count moved). Every item below landed, plus review A C1 / M1 / M3 / M6 / M7 / I2 / I3 / I4 / I5, review B
  C-1 (TB-L) / I-1 (AL-1, AL-2) / I-2 (DP-1) / I-3 / I-4 (TS-1) / I-5 / M-1..M-11, review C I-1..I-3, SW-1, SW-2. The
  original list: fold the three template helpers (`transformation/pattern.ts`, `action/support.ts`,
  `external/template.ts`); Delete attributes' `sendAttributesDeletedNotification` / `notifyDevice` (the P-10 treatment, emit
  only when a key was removed); the null-value wording (`Can't parse value: {"t":null}`); the SWEEP of all 47 built nodes'
  default / exported configuration keys against their ThingsBoard configuration classes (Important — an export ThingsBoard
  cannot start is a broken export); S-6 minors (Alibaba 100.100.100.200 / Azure 168.63.129.16 literals, drop `Content-Length` on a
  bodyless request, header mask for `x-auth-key` / `x-access-key` / `x-session-id`, tests for the non-`all` lookup branch, a lane
  released when send throws, numeric URL spellings); the stale `$.values.temperature` JSON-path help in `rule-nodes.ts` (m5).
- [x] Whole-branch review — DONE (`whole-review-a.md`, `-b.md`, `-c.md`; their fixes are the final fix wave).
- [ ] The gate, and a short re-review of the final fix wave: API suite (single fork, test DB), shared suite, every touched web file one per process,
  tsc ×3, `npm run lint`, `npm run db:verify-migrations`.
- [ ] **Operator:** restart the local dev server (`prisma generate` hit EPERM on the Prisma engine DLL while `tsx watch` held it;
  the JS client was regenerated, the engine binary was not).
- [ ] **Operator:** a real-browser check on :5176 of drag from the palette, drag-to-connect and pan / zoom on `/rule-chains/:id`
  (never run here — only headless renders and jsdom).
- [ ] **Deploy (at the operator's word only):** push to `trh`; on AWS `npm ci` (two new exact dependencies: `@xyflow/react`
  12.12.0, `jsonpath-plus` 11.2.1) and `npx prisma migrate deploy` (`20261103180000_alarm_metric_custom`,
  `20261103181000_rule_chains` — the second seeds the root chain only when `rule_chains` is empty; AWS `alarms` rows are
  unaffected); every user reloads; verify-chain after the schema change.
- [ ] Deferred minors (from every review; none blocks): an Unsupported node with no `tbClass` exports its literal type (T1 m4);
  the `secrets.ts` heuristics (the key pattern over-masks `tokenKeyName`, only string leaves are masked, array secrets merge by
  index, a save with an unresolved `"***"` gives no warning, a literal password `***` cannot be stored); the two config defs carry
  no re-auth action (T2-13 — switching the engine OFF needs no password under a re-auth policy; a one-line `reauthAction` if
  wanted) [DONE 2026-11-05: ruling D8-1, `39ddd221`, both carry `UPDATE_CONFIG_PAGE`]; Slack incoming-webhook URL needs a catalogue field; REST URL templating inserts unencoded values (as ThingsBoard);
  Check relation presence reads prisma directly; Rename keys copies before it knows a change; Deduplication makes a started
  engine poll `rule_chains` every 5 s; browser Back is not guarded by the editor's leave guard (needs a data router);
  notification templates may 403 for a MANAGE holder who is not SUPER_ADMIN (untested against a real role); the script hash
  computed per run (cache it, 3b m9); a durable job rescheduled by RE-2 runs twice if the process crashes between the
  re-add and the completion (accepted); Delay's pending count reads graphile's private tables; Calculate delta's history lookup not measured under load;
  `Double.toString` digits match JDK 19+, not verified against a ThingsBoard install's JDK; the PE class in the unknown-class
  test named from memory; node names / configs stored verbatim (escape outside React).
- [ ] **Open after the final fix wave (2026-11-05; from the four fw reports' "Open items" and the ledger's ACCEPTED /
  DOCUMENTED items):**
  - **Operator question — encrypt rule-node credentials at rest?** They are plain text in `rule_chains.document` /
    `rule_nodes.config` and in backups, unlike instrument tokens (review A M9).
  - **Operator question — should the server refuse `RULE_CHAIN_MANAGE` to a role whose instrument view is limited?** A chain
    acts on every instrument whatever its author sees, so the route scoping is defence in depth (fw-api open 5).
  - **P-5** (Math TIME_SERIES stores the UNROUNDED result, as ThingsBoard does) — kept as ruled; listed for the operator.
  - **A worker-thread script pool** — scripts run on the API's event loop, bounded per call (≤ 5 s) and by the 3-strike
    switch-off; a script that runs just under its timeout is never switched off (review A I1, accepted for this build).
  - **M-7 exact id resolution** — the import warns that an id "came with the file" whether or not it resolves here; a DB
    lookup in `import-export.ts` is deferred.
  - **`import-export.test.ts` stand-ins** — its routing / capacity tests still register stand-ins under shipped type ids,
    beside the real-handler acceptance tests (FW-N3 open item 6, accepted).
  - **"Skip Save nodes" OFF** — Save time series can then write an older ingest value back over a newer reading at the same
    instant, audited as a rewrite; the shipped default (skip ON, S-3) prevents it (FW-N2 open 2).
  - **Gson number text** — ThingsBoard's "Can't parse value" text can differ from ours for number text such as 1.50 (FW-N2
    open 5).
  - **The SIIT (`::ffff:0:a.b.c.d`) and 6to4 (`2002::`) spellings** of the refused metadata addresses are not covered
    (task-6b accepted; FW-N3 N3-15).
  - Also recorded, none blocks: a rescheduled durable message can be overtaken by a later one of the same originator (review
    A M4); a device-mediated attribute loop (`notifyDevice` → firmware re-report) escapes RE-1 like m10; the M-5 residual (a
    catastrophic key pattern costs ~100 ms per NEW key name until its 3 run-outs switch it off; a GC pause over 100 ms counts
    as a run-out, never as an answer); a credential stored as `"***"` is not named in the export notes (N3-14); Send to Slack's
    `conversation` could be made required in the strict schema (a default Slack node makes ThingsBoard refuse the exported
    chain — the export note says so); no import warning for an Entity type filter listing a ThingsBoard-only type, or for
    Slack `useSystemSettings: true`; ThingsBoard's default JavaScript evaluator (Nashorn) may not run ES2015+ — UNVERIFIED;
    `Long.parseLong` with Unicode digits and a whitespace-only body template in ThingsBoard — UNVERIFIED; the dev DB holds ~900
    permanently failed graphile jobs from dev restarts (operator's call, not needed).
  - **Deploy owed by this wave** (beside the deploy line above): users reload; restart the dev server; no new migration;
    real-browser check of drag / connect / pan on :5176.
- [ ] "Later" nodes, each a feature first: GPS geofencing filter / events (lat / long keys), Related entity data and Create /
  Delete relation (relations beyond the gateway link), Device state (the activity tracker accepting an event), REST call reply
  (a synchronous REST request route), RPC call request / reply (device RPC), AI request (an AI provider).
- [ ] Docs owed: `apps/web/CLAUDE.md` is over the 150k-char load limit (151,866 before this entry, 153,612 after) — split it
  **[the split is DONE 2026-11-05 — the per-screen sections moved VERBATIM to `docs/web-feature-notes.md` (154,657 → 40,996
  bytes, byte-checked); the counts audit of the other root docs below is still owed]**
  as root `CLAUDE.md` was (2026-10-07); README, PROJECT_SUMMARY, PROJECT_ARCHITECTURE, BACKEND_GUIDE, FRONTEND_GUIDE,
  `docs/index.md` and `future/` carry counts older than this feature (listed in the Task 8 report) — a doc audit pass.

## 2026-11-03 (evening) — DEPLOYED: page reports on templates + Supervisor fix + register-map Test-before-Add + Permissions-tab held toggles

- [x] AWS `ea7dee9 -> c3e9d83` (migration `20261103120000_report_templates_page_kinds` applied; health 200; routes answer under `kind`; chunks carry the new strings), then `c3e9d83 -> d96041c` (Permissions tab shows a held toggle with its holder; `permissionsHeld` on the role GET for ROLE_MANAGE). trh/data-layer = AWS = `d96041cd`.
- [ ] Operator: reload open browsers (an old bundle sends `widgetType=` and gets 400 on widget downloads); verify-chain after the schema change; try a page report download + a template preview on AWS; try un-selecting View Users with Edit Users on (expect a held caption).
- [ ] AWS still owes `strip-unused-permissions` (an unmapped MANAGE grant now shows as "granted outside this tab" until then).
- Deferred minors: see the ledger `.superpowers/sdd/2026-11-03-page-reports-on-templates/progress.md` (logo bytes in every snapshot vs 8 MB body; module-level logo cache; preview PAGE_REPORT_KEYS copy; empty-holders caption guard; register-map hint wording when Add is blocked).

## 2026-11-03 - Page reports on templates (the five page reports drawn from report templates)

Operator: "go ahead with page reports on templates". Spec `docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md`, plan
`docs/superpowers/plans/2026-11-03-page-reports-on-templates.md`, SDD ledger and every ruling in `.superpowers/sdd/2026-11-03-page-reports-on-templates/progress.md`;
the rules are in `docs/feature-notes.md` PAGE REPORTS ON TEMPLATES. **Built, not pushed, not deployed.**

- [x] T1 shared - template kinds, page specs, placeholders 10 to 27, page built-ins (`efc19fcf`, `05d3bc62`)
- [x] T2 API - `kind` column, application-wide kinds, scope rules, read gate, `COLUMN_NOT_FOR_KIND`, migration `20261103120000_report_templates_page_kinds` (`a4333f34`, `4f4057f6`)
- [x] T3 web lib - snapshot v3 for every report, `buildTemplatedReport`, template-lines component and plan hook (`f16a0761`, `09b838b8`, `beceb9e9`)
- [x] T4 web - Data Report, Instrument Trend, Instrument Alarms on templates (`7eff0bc6`, `aef8a3d1`, `d1c257e3`)
- [x] T5 web - Alarm Report and Audit Trail on templates (`f60a2474`, `fd2e4b16`, `907c9ab8`)
- [x] T6 web - Configuration > Report Templates: page-report tabs, application scope, previews (`2c99c4f4`, `a99f3bac`)
- [x] T7 docs - changelog, feature note, endpoints, package notes, counts (this entry)
- [ ] Whole-branch review (controller), then the final fix wave
- [ ] The gate: API suite (single fork, test DB), shared suite, every touched web file one per process, tsc x3, `npm run lint`, `npm run db:verify-migrations`
- [ ] Render-check the five page reports and the Report Templates page in a browser (nothing was rendered in one during the build)
- [ ] Push and deploy ONLY at the operator's word; before deploying read AWS `report_templates` over SSM (expected 0 rows)
- [ ] Deferred minors from the ledger: shared arrays assigned by reference in `TEMPLATE_KIND_SPECS`; logo bytes in every snapshot against the 8 MB body limit; `PAGE_REPORT_KEYS` copied in the preview; DATE / TIME sample columns by id suffix; `kindFromParams` exported from a component file; sample LOW LIMIT above HIGH LIMIT; stale `profileId` in the URL falling back silently; refusal tests loose (either message, no loading case for audit); plan wiring and refusal strings duplicated across the Alarms and Audit pages (a lib helper); `{search}` trimmed on Alarms but not Audit; orphan helpers `AlarmReportScope` / `instrumentAlarmsHeaderPairs` / `periodPairs` and the unread `ScopedInstrument.profileId`; a `before` title note followed by a picture; 84 pre-existing type errors in other API test files that no gate compiles

## 2026-10-31 — TCP/IP (Modbus) instruments, parts 1–2 (the application reads the device)

Operator: "if user selected TCP/IP then in the instrument creation tcp/ip need to integrate, for one
instrument one ip address and port", "go with all recommendations". Spec
`docs/superpowers/specs/2026-10-31-tcpip-instruments-design.md`, plan
`docs/superpowers/plans/2026-10-31-tcpip-instruments-parts-1-2.md`, SDD ledger and every ruling in
`.superpowers/sdd/2026-10-31-tcpip-instruments-parts-1-2/`; the rules are in `docs/feature-notes.md`
TCP/IP INSTRUMENTS. Commits `cf02b4ef..` on `data-layer` after the plan `363c7263`. **Built, not
pushed, not deployed.**

- [x] T1 shared — register map schema, device networks, keys-file converter (`cf02b4ef`)
- [x] T2 API — Modbus TCP client, read planner, decoder; two BAD_RESPONSE sentences (`d5a926fb`, `44882595`)
- [x] T3 API — profiles are Gateway or TCP/IP; migration `20261031120000_tcpip_instruments` (`cc67ae86`)
- [x] T4 API — the instrument's own address and map, no token, Configuration → TCP/IP Reading (`21787106`)
- [x] T5 API — Test connection, nothing stored (`53c874fa`)
- [x] T6 web — the profile chooses Gateway or TCP/IP (`93c67d7b`)
- [x] T7 web — New Instrument TCP/IP connection, register map, Test connection (`4dcd7adc`, `fb299133`)
- [x] T8 — "reporting" follows the read interval; payloads carry the server's `reporting` (`4acab3c8`, `155fa178`)
- [x] T9 API — the Reader, `ModbusPollStatus`, migration `20261031130000_modbus_poll_status`; a storage failure is not the device's; one dead letter per read (`3c6eff79`, `3e07057a`)
- [x] T10 — `GET /:id/modbus-status` and the instrument page's two cards (`6928902f`)
- [x] T11 — bulk upload "IP address" / "Port" and "Copy register map from" (`911bf7b3`)
- [x] T12 — render check at 1240 px with the built stylesheet (two fixes: `42bf00c8` the map's selects keep their width, `6271a889` the map is full width on the instrument page; `built-*.png` in `docs/superpowers/concepts/2026-10-31-tcpip-instruments/`); drift guard as plain commands (empty diff against both DBs); gates; docs
- [ ] Final whole-branch review (controller). Open items carried to it: a device certificate can still be issued to a TCP/IP instrument; Test connection is outside the Reader's per-host:port lock; the status card has no error branch (a failed fetch reads "Checking the connection…" forever); a disabled instrument with a stale `failingSince` reads "Not answering" and hides why it is not read; the audit sentence's `{from}`–`{to}` are raw UTC ISO; a backwards clock step stalls reads; bulk applies an existing row's address and attributes in two transactions. Task 11's review was still running when T12 was dispatched.
- [ ] **Operator:** Configuration → TCP/IP Reading ("Read devices from this server") is **OFF** by default — it is OFF on `compliance_core_db` and `_test` (2026-11-02). Turn it on locally / at a plant install to read devices; **leave it OFF on AWS**.
- [ ] **Operator:** 101-01 (spec §15 Q1) — after the deploy, with reading on where the device is reachable, register it FRESH as a TCP/IP instrument; withdraw the old 101-01 token and disable the old 101-01; then retire the `TCPIP/` desktop tool. Production writes on AWS are the operator's.
- [ ] **Operator:** check Inactivity Alarms on AWS at the deploy — a silent TCP/IP device raises only that alarm, and it ships OFF.
- [ ] **Operator:** "Not judged" (the app's word) vs the concept's "Shown only" in the Judged as column — confirm.
- [ ] OQ: new test cases (spec §10) — register map validation, Test connection success and each failure, address clash, a disabled instrument not read, the interval honoured, the healthy ↔ failing audit rows.
- [ ] Push / deploy only on the operator's word; AWS needs both migrations (`npx prisma migrate deploy`).
- [ ] `AGENTS.md` line 14 still says "38 models / 13 enums" — that line carries the other session's uncommitted permission edit, so it was left for when theirs is committed (39 since 2026-10-31).
- [ ] **Part 3, not started:** the Plant Reader for a server in AWS — `packages/modbus` (move `apps/api/src/modules/modbus/protocol/` unchanged, ruling P1), `apps/plant-reader/`, model `PlantReader`, Configuration → Plant Readers, reauth `MANAGE_PLANT_READER`; decide spec §15 Q3 (should a late reading's excursion raise an alarm?).

## 2026-10-31 — Dashboard builder, phase 2 (nine ECharts widget types)

Operator: "start phase 2 with echarts" (2026-10-30). Plan
`docs/superpowers/plans/2026-10-30-dashboard-builder-phase2.md` (rulings P1–P9); every ruling made
while building is in the DASHBOARDS note, `docs/feature-notes.md` (PHASE 2). Commits `cc1cce7..` on
`data-layer` after the plan `ba954f1` (the other session's `cee35d5` sits between `85f26fc` and
`fb95540` and is not part of this work). **Built, not pushed, not deployed.**

- [x] T1 shared — widget-type registry `WIDGET_TYPE_SPECS`, the nine types, `widgetPanelGate` (`cc1cce7`, `5c20232`)
- [x] T2 API — overview `judged` / `lastSeenAt`; `GET /api/alarms/counts` (`2a59a63`, `d295349`)
- [x] T3 API — `GET /api/instruments/telemetry-buckets`, local-time buckets (`67ea527`, `91cc3b6`, `de9f452`); `echarts` 6.1.0 installed (`667421c`)
- [x] T4 web — ECharts foundation (lazy, SVG), `instrumentLook`, registry wiring (`83c3d65`, `172393e`)
- [x] T5 web — gauge and comparison bars (`b448fb1`, `e2d5114`, `870a613`, `9f1e124`)
- [x] T6 web — bar chart; ONE retry policy for every widget data hook (`503f393`, `e136334`, `e5ada55`)
- [x] T7 web — pie, alarm counts, status grid; ONE held-answer rule (`85f26fc`, `fb95540`)
- [x] T8 web + API — instrument list, text card, floor plan; widget text stripped on every write path (`e2c13fa`, `c003bb8`)
- [x] T9 — one built dashboard with every new type over a profile, real ECharts + Inter in headless Chrome (`built-p2-dashboard.png`); the comparison legend's rows fixed (`0b31baf`); the `/` gates pinned over HTTP (`38ef8d4`); docs; gates (shared 40 files / 600 tests — 39 at HEAD + the other session's untracked `permission-implication.test.ts`; web 76 files / 1,050 tests one per process, then a second sweep of the 65 test files of phase-2 modules outside those folders: 789 tests, 0 failed (`trend-chart-strip` exited 1 only at teardown when the low-memory kill hit it — re-run alone in review: 3/3, exit 0); API 19 files / 291 tests one at a time; `npm run lint` in shared, API and web; `vite build` + the bundle check PASS)
- [x] Final whole-branch review (controller): 6 Important + 7 Minor, ruled F-I1..F-I6 (`.superpowers/sdd/2026-10-30-dashboard-builder-phase2/`)
- [x] Final fix wave (`bcd3159`, `093802d`, `6fe4e7c`, `d9c89cc`, `f1077ea`, `bbc765d` + the docs commit): ONE retry policy for every polling hook on `/` and `/dashboards/:id` (R7-11, `lib/polling.ts`; the landing summaries poll, the Alarms card never prints a 0 it does not have); the key widgets on the one held-answer rule; per-widget render boundaries on `/`; `md` = 12 columns (no staircase); no dashboard chart series is green (brown `#6b4423` in place of slot 3); a built dashboard never prints "0 in your view" for a failed overview (found while listing the overview's callers)
- [ ] Push / deploy only on the operator's word; the push must name the other session's commits on the branch too
- [ ] Parked (operator's call): the trend page's and the PDF reports' third series colour is still the green — an app-wide swap changes how approved reports render
- [ ] Parked M9: a gauge widget at its default size in a narrow panel shows a sliver and its body scrolls
- [ ] Parked: widget titles stored with markup before the stripping are not backfilled (they print as text)
- [ ] Parked (accepted, F-I1): on a drill-down the status AND key widgets show "Loading…" while the readings table keeps its old rows — tell the operator
- [ ] Parked M-6 / M-7: no "markup is removed at save" hint in the widget dialog; a bar chart on a fixed past window re-asks the same aggregate every refresh
- [ ] Render-check method gap: the built CSS names its fonts `/assets/…`, which a `file://` page cannot load — Chrome PNGs before 2026-10-31 were probably in a fallback face; inline the fonts (Task 9's `shoot9.py` does)

## 2026-10-29 — Dashboard builder, phase 1 (many named dashboards, alarm table)

Operator: "… like in thingsboard i need same feature like different dashboards creation and different
types of widgtes …" → "yes proceed" to the playback → "do best one" (look). Spec
`docs/superpowers/specs/2026-10-29-dashboard-builder-design.md`, plan
`docs/superpowers/plans/2026-10-29-dashboard-builder-phase1.md` (rulings D1–D6), feature
note DASHBOARDS in `docs/feature-notes.md` (the behavioural rulings R5–R10). The run's SDD ledger was
deleted when the run closed; every ruling it held (R1–R12) was reported to the operator.
Commits `6a4ddf1..796d218` on `data-layer` (base `6ec4de5`).

- [x] T1 shared — `dashboard-document.ts` (strict / forgiving readers, source, window, diff), `alarm_table` type, re-auth `UPDATE_DASHBOARD` (`6a4ddf1`)
- [x] T2 API — `telemetry-overview` `profileId` / `instrumentIds`; `/api/alarms` `instrumentIds` / `profileId` / `functionalLocationDirect` (`52c474f`)
- [x] T3 API — `/api/dashboards` rewritten, 13 → 7 routes; fix round 1 (`ee7e1f2`, `cec2304`, `5d9a98d`)
- [x] T4 concept images (3 × list + page); operator: "do best one" → list A, page header C (R6)
- [x] T5 web — widgets follow a dashboard source / window; alarm table widget (`ce3e21f`)
- [x] T6 web — Dashboards sidebar page: list, new, rename, duplicate, delete (`7e06f14`)
- [x] T7 web — dashboard page: view, edit, save; R5 tables; TableHeader hover; R9 grid; fix round 1 (`10b7973`, `4678938`, `0ff333d`, `65d1ff2`, `4438003`)
- [x] T8 web — Settings and Assign dialogs (`f47db71`)
- [x] T9 — built render at 1240 (`built-*.png`), list row-action icons fixed (`50441b9`), docs, gates
- [x] Final whole-branch review → one fix wave (`796d218`): R10 on Settings and Rename (capture at open; a Rename 409 re-seeds), a scoped alarm table prints "Could not load this widget." on a 403, "Dashboard window" label, direct-only non-uuid location → 400, a `null` source's 400 says "use Settings", `UPDATE_DASHBOARD` comment placement; re-review clean. Full API suite last ran at T9 (3285); the fix wave ran its covering files (4 API, 9 web, 2 shared) + lint ×3.
- [ ] Parked (R11): an assigned viewer can see the NAME of a profile / location outside their own scope (source chip) and the source / widget instrument ids in the document — no readings, no codes; a super admin chose the assignment.
- [x] **Pushed + DEPLOYED 2026-10-30** (operator: "push and deploy in aws"): `trh/data-layer` `e46b57d..656725b`; the box's own script over SSM → `/root/deploy-20261030.log`: lockfile unchanged, 4 builds, no pending migrations, `DEPLOYED 656725b`, health 200. Post-checks on the box: `GET /api/dashboards` without a token → 401, the built chunks carry "New dashboard" and `alarm_table`. Re-verified first on the final tree: shared 571, API 3287 / 253 files, exit 0.
- [x] **AWS, read-only, BEFORE the deploy (2026-10-30, `BEGIN READ ONLY`):** `dashboards` 0, `dashboard_assignments` 0, `dashboard_widgets` 0 — nothing became SUPER_ADMIN-only; dropping `dashboard_widgets` would lose no AWS rows.
- [ ] **AWS, still owed from 2026-10-24:** `scripts/strip-unused-permissions.ts --apply` (operator) — the dashboard write routes no longer read `DASHBOARD_*` grants, so this is no longer a dashboard risk, but it is still owed.
- [ ] Operator questions (spec §12): drop the unused `dashboard_widgets` table? (AWS row count first); ECharts or hand-built SVG for phase 2? — ECharts (operator 2026-10-30: "start phase 2 with echarts").
- [ ] Operator decision (seen in the built render): the alarm table's 11 columns at the large type scroll sideways in a full-width card at 1240 and the sticky Acknowledge column covers "Acknowledged by" (same as the home panel) — trim columns / Compact size?
- [x] Phase 2 (built 2026-10-31 — the section above) — the rest of the widget library: gauge, bar chart over time (`GET /api/instruments/telemetry-buckets`), comparison bars, pie (server-decided distributions only), alarm counts (`GET /api/alarms/counts`), status grid, instrument list, text card, floor plan; chart library settled in that plan
- [ ] Phase 3 — instrument dashboards: `kind` `INSTRUMENT` bound to a profile (migration), instrument picker, drill-down from fleet widgets, "Start from this profile"; the trend page stays the governed record view
- [ ] Phase 4 (separate approval) — JSON export / import; governed widget downloads via a `REPORT_KINDS` entry
- [ ] Deferred minors (from the ledger; none blocks phase 1):
  - [ ] shared: `WIDGET_ALARM_STATUSES` sits between `WIDGET_TYPES` and `type WidgetType`; `readDashboardDocument` stamps version 1 on anything (no forward-version signal); a fixed window accepts only Z-suffixed datetimes; tests: no alarm gate on `resolveLayout`'s fromRole branch, no "appears twice" refusal case, the `diffWidgets` reorder test shuffles top-level keys only
  - [ ] API: `list-query.ts` duplicates `UUID_RE` from `lib/uuid-list.ts`; `/api/alarms` `profileId` validated twice (a schema 400 body, not `VALIDATION_ERROR`; `?profileId=` empty is a schema 400); the overview 400 body has no `field`; e2e gaps — `profileId` and `functionalLocationDirect` with the scoped OPERATOR, the 201-id cap on `/api/alarms`, an unknown `profileId` on alarms; `afterAll` `.catch(() => {})` (repo pattern); widgets the forgiving reader drops vanish unaudited on the next save (legacy / hand-edited rows only); case 9's `dashboardAssignment.count === 0` tests nothing; the mass-assignment RED was an import failure
  - [ ] web: the widget dialog's section numbers read 1, 2, 4 for an alarm table; `window` parameters shadow the global; `import type { WIDGET_ALARM_STATUSES }` mid-block in `selection-alarms.tsx`; stale "four renderers / four sections" comments; `autoHeightIds` `||` chain; loose `/of\s*7/` match; nested-ternary selector precedence untested; `use-dashboard-draft` duplicates the home placement rule (can drift), `autoRows` / `reportHeight` and the fallback band header copied; "· 0 in your view" on a failed overview; `Svg` / `PATHS` imported from the list route module; latest-values value cells `whitespace-nowrap` on `/` too; widget key `JSON.stringify(w)` is key-order sensitive; a failed preview discards in-dialog edits; an un-Applied custom window editor is dropped on Save / Enter; a stored location id no longer in the tree shows "Choose a block" while Save re-sends it; a Settings save resets the session window even when the window was not edited; users fetched `status=ENABLED` (a disabled-but-assigned user is kept); test gaps — list onError / onCancel / a rejected write / LoadError, page reauth onCancel / non-409 toast / Keep editing / `?edit=1` removal
  - [ ] seen in T9 (pre-existing, app-wide, not fixed): five surfaces seed their page size with `useState(defaultLimit)` (`selection-alarms`, `alarms`, `audit`, `alarms-widget`, `reports`), so on a cold load before `/api/config/pagination/current` arrives they open at the hook's fallback 20 and never take the administered limit; in edit mode a card header shows "Edit widget" beside "Edit" (card style) — the phase 2 wording; the trend axis prints the time only over 24 h ("19:08 … 19:08")

## 2026-10-26 — Profile measurements (each profile defines what it measures and its keys)

Operator: "temperature and humidity keys … limits keys … should be updated instrument
profiles wise, each profile can receive different keys" → "pressue or other differnet
sensors values" → "proceed and also in instrument profiles NLT and MNT attributes and MKT
attributes … enabled or disabled should come". Design:
`docs/superpowers/specs/2026-10-26-profile-measurements-design.md`. Three phases, each shippable.

- [x] Inventory (alarm engine, API read side, web) + design doc
- [x] Builder check on the design; fold answers; plan (`docs/superpowers/plans/2026-10-26-profile-measurements-phase1.md`)
- [x] Phase 1 — per-profile keys for TEMPERATURE/HUMIDITY, NMT/NLT/MKT switches, SUPER_ADMIN gate, one resolver, config pages trimmed, refresh-403 + offset-keys fixes, profile editor section (9 task commits + 1 bug-fix commit, local, NOT pushed)
- [ ] Phase 2 — server for N measurements (registry CRUD, alarms.metric → text, worker, overview measurements[], aggregate/room-history/telemetry by code, MKT, report kind, type options)
- [ ] Phase 3 — screens for N measurements (table, floor tiles, room detail, trend page, Data/Alarm reports, settings), legacy two-slot fields removed
- [ ] Docs (CHANGELOG, feature note, counts), memory
- [ ] AWS: push + deploy only when the operator asks

## 2026-10-24 — Every permission toggle does what it says (button = page = sidebar = route = tab)

Operator: "when permissions are allowed some are not coming to user roles" →
false-ON fix; then "update all the permissions properly". Decisions (asked):
dead toggles removed AND their unused permissions stripped from roles (audited);
Backup toggles alone open Backup; no bulk grant; ONE commit at the end.

- [x] Permissions tab shows what the role holds (gate rule; `privilegeTogglesFromPermissions`)
- [x] One resolver: `hasEffectivePermission` in useCan / sidebar / RequireRole / inline checks / the tab
- [x] Tree: remove Alarm Rules nodes; Dashboards create/manage/assign, Delete Users, Field IDs not configurable; snapshot + count
- [x] Server enforces Export Audit Trail (Excel log + PDF request/direct)
- [x] Backup toggles alone open Configuration → Backup (guards, sidebar, card, no access-matrix fetch without CONFIG_READ); page text
- [x] Strip unused permissions from roles (script, dry run, audited; BACKUP_MANAGE → BACKUP_EXPORT); default roles updated
- [x] Tests (property tests in effective terms, e2e, web) + mutation checks; no-op-save probe on real roles
- [x] Docs (CHANGELOG, feature note, counts), memory, ONE commit (not pushed)
- [x] AWS deployed `5e49636` (2026-10-24; migrations applied, health 200). Strip DRY RUN reviewed on AWS (ADMIN only).
- [ ] AWS: `scripts/strip-unused-permissions.ts --apply` — operator to run (refused from here) BEFORE anyone saves role permissions
- [ ] AWS: then Roles & Access → Permissions → QA → tick "Approve / Reject Reports" (no role on AWS can approve a report today)

## 2026-10-01 — Report download modes, configured approvers, scoped requests

Operator (several messages): remove Send-to from the request dialog; approvers
(several roles and/or users) set in Configuration; the requester's ROLE and the
approver roles/users can all view + download; only approvers approve; no View
draft (a pending row opens its tables like an approved one); a request is seen
only by users whose instrument scope covers ANY of its instruments; a per
report-type setting Direct / Request, remarks required yes/no, password
required yes/no — for ALL report types incl. the Audit Trail PDF. Defaults =
today's behaviour (Request, remarks on, password on). Existing requests keep
their assignee.

- [x] shared: `report-downloads.ts` (kinds, policy coercer) + approver users in `report-approvers.ts` + tests
- [x] migration: `report_reviews.approver_roles / approver_user_ids / instrument_ids` (+ backfill), both DBs
- [x] API: `report-downloads` def + narrow route; approver users setting + candidates route
- [x] API: report-reviews service — frozen approvers, one visibility predicate (+ scope), per-user notify, mode/remarks/password rules
- [x] API: report-export-log honours the per-type mode/remarks/password
- [x] API e2e
- [x] web: dialog (no picker, mode-aware, password field), hook, 5 call sites, Alarms sends instrument ids
- [x] web: Reports page — no View draft, pending rows expand, Send to = frozen approvers, tab for role requests
- [x] web tests; tsc; vite build
- [x] docs: CLAUDE.md counts, CHANGELOG, memory

Found on the way: the web hook read the narrow route with the stored-row reader (every type read as Request) — fixed with `coerceReportDownloadsResponse`. Not done: AWS migration (next deploy); not seen on screen.

## 2026-09-18 — Replace the AWS Windows instance with Ubuntu 24.04

Operator: "make this instance into ubuntu" (i-0be63a2077d4a82e0). Decisions taken
(AskUserQuestion): keep RDS; git clone + build like Windows (not the .deb);
terminate the Windows instance right after cutover; install EMQX and open
1883/8883; a NEW deploy key that the operator adds to GitHub.

Measured before starting: RDS holds 2 users, 6 roles, 42 audit rows
(checksum_version 3), 0 instruments, and 3 applied migrations — two of them
from the Data Injection programme removed on 2026-08-04, whose tables (7 tables,
2 enums; 1 + 18 seed rows) block `20260804120000_instruments_p1`.

- [x] RDS snapshot `compliance-core-db-pre-ubuntu-20260918`
- [x] Security group: 1883 + 8883 from 0.0.0.0/0
- [x] Launch `i-0b13dae53e9113f1d` (Ubuntu 24.04, t3.medium, 30 GB gp3, same subnet/SG/profile)
- [x] Env file assembled from the Documents backup → SSM SecureString `/compliance-core/ubuntu/digilog.env`
- [x] `scripts/aws/provision-ubuntu.sh keygen` → operator adds the deploy key on GitHub
- [x] `scripts/aws/provision-ubuntu.sh install` (clone, node, emqx, certs, env, build, units; API NOT started)
- [x] Cutover: stop DigiLogAPI on Windows → repair SQL → migrate deploy → start digilog-api → move EIP
- [x] Verify: /api/health 200, login, /api/audit/verify-chain intact, EMQX up, 1883 reachable
- [x] Delete the SSM parameter
- [x] AMI `ami-0d30b88d19a9c4b9a` of the Windows instance
- [x] Terminate the Windows instance (confirmed; AMI kept)
- [x] `deploy-to-aws.bat` → new instance id + AWS-RunShellScript; delete `scripts/deploy-on-instance.ps1`
- [x] Docs: CHANGELOG, `docs/deployment-methods/aws-ubuntu-instance.md`, memory, Documents runbook banners

Cutover findings: `. digilog.env` breaks on the `&` in the RDS URL (load line by line);
`tsc` writes dist/ 750/640 as root (chmod a+rX after build). Both fixed in the scripts.
verify-chain on Ubuntu: intact, 45 rows, 0 anomalies. GitHub deploy key added via
`gh repo deploy-key add` after two manual attempts never registered it.

## 2026-09-18 — Local data copied into RDS

- [x] Snapshot `compliance-core-db-pre-datacopy-20260918`
- [x] Dump (public, data-only, inserts) → scp over SSM SSH → one-transaction truncate+load with count guards
- [x] Uploads (2 files) + local INSTRUMENT_TOKEN_KEY onto the box
- [x] Audit sequence defect (setval 5354 rode in the dump) repaired: one row renumbered → 48; verify-chain intact, 50 rows
- [x] Temp bucket deleted (never used — upload denied as exfiltration; SSM SSH used instead); both SSM parameters deleted

## 2026-10-03 — Strict technical audit (read-only)

- [x] Six parallel read-only reviews (security, API correctness, data/§11, web, ingest/alarms, docs/tooling); lead re-derived 36 findings incl. every HIGH
- [x] Report: `docs/audit/2026-10-03-technical-audit.md` — 105 findings, 16 runtime HIGH + 4 docs HIGH, health 70/100 (Aug 74)
## 2026-10-03 — Fix all audit findings (operator: "fix all the issues")

HIGH (runtime), in the report's §3 order — one commit each:
- [x] F1  INGEST-1/2: ensurePartitions at boot + installers; bounded cron fill; writeBatch failure → dead letter
- [x] F2  API-1: role-config save asserts caller privilege; API-2: scope/panel bodies required
- [x] F3  DATA-1 backup chain verifier field set; DATA-5 secrets stripped from backups; DATA-12 restore creates partitions
- [x] F4  DATA-4: seed never resets an existing role's permissions
- [x] F5  DATA-3 user_role → 50; API-4 central signature_meaning bound in auditLog + FL name bound + FL audit in tx
- [x] F6  API-3: FL PUT serializer + e2e
- [x] F7  API-5/8/9/10: visibility on attribute read, instrument writes, pickers, FL detail; profile cascade gate
- [x] F8  API-6: public admin-request audit row as SYSTEM
- [x] F9  INGEST-4 double clear; INGEST-3 range coercion; INGEST-5/6/8/16 timestamps, null, clearedValue
- [x] F10 SEC-1 _currentPassword strip before early return; SEC-2 config PUT via verifyReauthPassword
- [x] F11 WEB-1 SA password boxes; WEB-4 `/` guard; WEB-5 `/users` guard; WEB-2 chart axis format
- [x] F12 DOCS-2 untrack gitlink; DOCS-3 stale scripts + scripts tsconfig in lint; DOCS-14 phantom deps; DOCS-17 tracked pdfs
MEDIUM/LOW sweeps (per module, after the HIGHs):
- [x] S1 ingest mediums/lows (7, 9–15, 17, 18) — commit `b9dff2b` (dead-letter prune rides the retention batch)
- [x] S2 API mediums/lows — api-b half (SEC-3, SEC-7, API-17, API-19, API-20 subset, DATA-11 + Layout Designer reason) commit `22dd58a`; api-a half (7, 12–16, 18, 20 rest, DATA-13 + the session-cache eviction and the Permissions-tab reason gate) commit `4d1e936`. `e2e/instruments.test.ts` re-run alone: 39/39 (the 6 reds were cross-process contention)
- [x] S3 data mediums/lows (6, 7, 9, 10, 14, 15, 16, 18 + API-19 report-reviews) — commit `7015818`; DATA-8 in S4, DATA-11 in S2b, DATA-13 in S6, DATA-17 in F12
- [x] S4 security mediums/lows 4, 5, 6 + DATA-8 — commit `c0faa0e` (SEC-3 / SEC-7 are in the api-b sweep)
- [x] S5 web mediums/lows (3, 6–17; 18 closed as non-defect) + System Health flags + SEC-7 prompts + bulk-create gate — commit `3ff8d7c`; full web run 141 files one at a time, all exit 0 (two pre-existing time-bomb/default assertions fixed)
- [x] S6 docs (1, 4–13, 15, 16, 18–23) + counts re-derived + stale verify-route refs — commit `8738373`
- [x] Final: web 141/141 files, api 208/208 files (4 reds fixed in `40ebab7`), shared 33/33, queue 4/4 — each file alone by exit code; api lint + web tsc clean; CHANGELOG batches 12–18; memory ledger; NOT pushed — the operator decides

- [x] Fix order in §3 of the report: partitions at boot + batch-loss dead letter → role-config privilege check + required scope body → backup verifier/secrets → seed permission reset → user_role width + central signature bound → FL PUT serializer → visibility on attribute read + writes → public admin-request attribution → alarm double-clear + range coercion → reauth strip/lockout → SA password boxes, `/` and `/users` guards, chart axis format
- [ ] Operator decisions needed: untrack the dangling `.claude/worktrees/ui-redesign-stage2` gitlink; whether instrument WRITE routes are meant to be unscoped; hard-delete default off in installer env

## 2026-10-12 — fix every finding in docs/audit/2026-10-12-application-review.md
Six fixers in worktrees (own test DB each: compliance_core_db_test_{auth,alarms,audit,ingest,floor}); lead merges, owns registries/CHANGELOG/counts, then deps + full test run + deploy.
- [x] Floorplans/FL/draw scripts (item 1 first: room limits carried)
- [x] Alarms/notifications/webhooks (items 2, 3 + mediums)
- [x] Auth/users/roles/LDAP (items 4, 5 + mediums, SEC-8)
- [x] Audit/reports/config/backup (item 8 + mediums; hard-delete default = operator decision)
- [x] Instruments/ingest (item 9 = operator decision + mediums)
- [x] Web outside floorplans (items 6, 7 + mediums)
- [x] Lead: build-deb prisma generate, deploy rollback ordering, bat text, doc drift
- [ ] Lead: deps (fastify, adm-zip, sanitize-html, nodemailer), full serial test run, CHANGELOG, counts
- [ ] Deploy to AWS; hand operator the post-deploy writes

## 2026-10-26 — AWS: "Load Error" / "Instrument not found" on Instruments (scoped creator)
Cause (read-only RDS + journal): MAINTENANCE user 101011 (user scope = 2 locations) created
CWH/RDU/001-01 and CWH/RDU/201-00 with no functional location -> outside their own scope ->
attribute POSTs, GET /:id, telemetry, children all 404. Separately every child detail page
looks up its gateway by id; IOTGW01 has no location -> 404 toast for every scoped viewer.
- [x] API: createWithCredential refuses an instrument the caller could not see (in-tx, before credential/audit); visibility REQUIRED arg; bulk passes it
- [x] API: create + bulk accept functionalLocationId (exists check; bulk pre-checks once)
- [x] API: FL tree flags `placeable` per node + top-level `placementRequired` (server-decided)
- [x] API: GET /:id returns gatewayCode + gatewayVisible (declared in the schema)
- [x] Web: Functional location picker on New Instrument + Bulk Upload; detail drops the gateway fetch
- [x] Tests: e2e (scoped create 400/201, bulk, tree flags, gateway code) mutation-checked; web create/bulk/detail
- [x] Docs: CHANGELOG, feature-notes visibility note, endpoints.md
- [x] Push to trh (`ac56a54`), deploy over SSM (`5e49636 -> ac56a54`, no migration, no npm ci), health 200; dist greps confirm the fix is live
- [ ] Hand operator: place or delete CWH/RDU/001-01 and CWH/RDU/201-00 (no attributes saved)

## 2026-10-28 — Device attributes on every protocol

- [x] HTTP/HTTPS POST + GET `/api/ingest/v1/attributes`; WS/TCP report + subscribe/push; panel tabs; e2e 10 + unit; 9 mutations killed; affected ingest e2e green.
- [ ] Not seen on a real device or in the operator's browser; not pushed, not deployed (AWS also needs the panel + routes; no broker change).
- [ ] Full API suite not re-run (the last run was killed for low memory) — on request.
- Out of scope, stated: roster + `children/attributes` stay MQTT-only; no HTTP long-poll; a rename does not re-send the set to a WS/TCP subscriber (MQTT's republish goes straight to the broker).

## 2026-10-28 — Bulk upload updates an Instrument ID that already exists

- [x] Reproduced "Instrument ID error every upload": the template's sample row `CWH/RDU/001-00` exists (local DB + the operator's saved template). Template = heading only. Also fixed, same symptom, reproduced on a test file only: Excel's cleared rows `,,,` → "Instrument ID is required"; the parser skips separator-only rows.
- [x] `bulk-plan.ts` (one plan) + `POST /bulk/preview` + `/bulk` updates with one remark; review dialog on the page. e2e 15, unit 20 + 3, page 5 new; 16 API + 6 page mutations killed.
- [ ] Not seen in the operator's browser (no session of my own) — operator to try an upload with a changed value.
- [ ] Not pushed, not deployed.
- Follow-up (pre-existing): `writeInitialAttributes` locks each key inside its loop, after the audit-chain lock (deadlock-shaped; a brand-new instrument makes it unlikely).
- Follow-up (pre-existing): bulk attribute VALUES are not HTML-stripped, while the single attribute POST strips them (`sanitizeStrings`). Left alone: stripping would blank a value like `<5`, and React escapes on render.

## 2026-10-28 — Widget data keys: any key an instrument sends, in any widget

Spec `docs/superpowers/specs/2026-10-28-widget-data-keys-design.md`; phase 1 plan `docs/superpowers/plans/2026-10-28-widget-data-keys-phase1.md`.

- [x] Phase 1 T1 shared contract (`data-keys.ts`)
- [x] Phase 1 T2 `GET /api/instruments/data-keys` + `telemetry-keys` gains `numeric` / `measurement`
- [x] Phase 1 T3 `POST /api/instruments/latest-values` (overview's own bounds)
- [x] Phase 1 T4 `keys` on the history routes + docs + full API suite
- [x] Phase 1 review fix pass (`35df40e`): empty id list = 200 `[]`; one `resolvedSlotFor` rule on the key-naming routes (fixed the trend page charting the wrong one of two device keys); HTTPS-ingest e2e; `lastSeenAt` / measurement asserted. Full API suite 245 files / 3194 green.
- [ ] Follow-up (operator's call): route `floorplans/room-history.ts` and `telemetry-aggregate.ts` through `resolvedSlotFor` — both still take every device key of a slot.
- [ ] Follow-up (operator's call): a device that moved from the preferred device key to another resolves to the STALE key in the overview / alarms / trend (latest table keeps every key). Local: none (102 instruments). Check AWS read-only before deploying phase 1.
- Phase 1 deferred minors: latest-values reads value/ts separately from the overview's flags (one poll can mix them; use `rawSlots`); an unresolved slot gives every listed device key the bounds; a padded device key (" t") is catalogued but unrequestable (requests trim); no Area-scoped OPERATOR case in `data-keys.e2e`; latest-values loads every attribute row when any attribute key is asked, `loadMeasurementTypes` uncached per poll; POST JSON schema has no `maxItems`; test hygiene (orphan history rows, unchecked DELETEs, a restore outside `finally`); `UUID_RE` duplicates `/telemetry-history`'s regex; `measurement` is `{code,name,unit}` (spec said `typeId`) — phase 3 keys off `code`; `apps/api/CLAUDE.md` entry order.
- Phase 1 rulings: `getDistinctKeys` stays on history; no `take` on Block/profile selectors; attribute SQL in the repository; an unreported slot's keys keep their bounds; a blank attribute reads as absent; `lastSeenAt` by an extra query; phase 2 must page selections over 200 and handle mixed-profile device keys for one card.
- [x] Phase 2 dashboard widgets (SUPER_ADMIN builds, Save as role default, `custom_widgets` panel) — plan `docs/superpowers/plans/2026-10-28-widget-data-keys-phase2.md`, 9 tasks, ledger `.superpowers/sdd/2026-10-28-widget-data-keys-phase2/progress.md`; rendered with the built CSS in headless Chrome; NOT seen in the operator's browser; pushed + DEPLOYED to AWS `2e56f6a` 2026-10-29 (before its suite and review finished, at the operator's word); its review fix pass `0abb5e5` is local
- [ ] Phase 2 follow-ups (operator's call): a value card / column over a mixed-profile selection lists `t` and `temperature` as two keys (P2-5); chart period / zoom are not remembered (P2-6)
- [x] Phase 3 trend page extra keys per profile (migration `display_keys`) — plan `docs/superpowers/plans/2026-10-29-widget-data-keys-phase3.md`, 5 tasks, ledger `.superpowers/sdd/2026-10-29-widget-data-keys-phase3/progress.md`; NOT seen in the operator's browser; AWS gets the migration on the next deploy (nothing by hand)
- [x] Phase 3 review fix pass (`c0d79f0`), each RED -> GREEN: the audit row names the profile; a key that IS the page's own temperature / humidity key is not drawn twice; Remove on every key row (Keys dialog + Add widget dialog). Gates: API 251 files / 3262, shared 549, web 176 files one per process, lint x3, db:verify-migrations PASS.
- [x] Pre-existing red found by that run: `detail-token-reveal.test.tsx` red since `8717b93` (two POST commands) — test fixed `aabb069`, product unchanged.
- Phase 3 deferred minors: picker allows 20 keys, a profile holds 12 (Save refuses the 13th); "1 text readings" not pluralised; an extra chart with no numbers says "No data available"; the dialog's empty-catalogue message tests the filtered list; a whitespace-only label is stored (blank heading); audit beforeValue is the coerced stored value; no e2e for 404 / re-auth on the PUT; `shownKeys` not memoised; labels not HTML-stripped (rendered as text).
- [ ] Phase 4 downloads (separate approval)
- [ ] Push to trh / deploy — operator's call

## 2026-10-27 — Device certificates: a profile can require each device's own certificate

Spec `docs/superpowers/specs/2026-10-27-device-certificates-design.md`, plan `docs/superpowers/plans/2026-10-27-device-certificates.md`.

- [x] T1 decision + subject parsing + rate-limited refusal dead letters
- [x] T2 migration (both DBs), identity / child map carry the facts, device CA availability
- [x] T3 issuing (`@peculiar/x509` 2.1.0, `reflect-metadata` 0.2.2), openssl-strict verified
- [x] T4 issue / re-issue / revoke routes + audit actions (98 -> 100 / 111 -> 113)
- [x] T5 profile switch + EMQX hook
- [x] T6 HTTPS (real-TLS e2e) / WebSocket / TCP / gateway fan-out
- [x] T7 EMQX template, provisioning (Linux + Windows), AWS rollout script, local broker reconfigured
- [x] T8 web: certificate card + profile switch
- [x] T9 docs + counts (CHANGELOG, feature note, CLAUDE x3, AGENTS, endpoints, runbooks)
- [ ] Push to trh, deploy (lockfile moved -> npm ci; one migration), then `enable-device-certificates.sh` dry run -> --apply (operator-confirmed)
- [ ] In the app on AWS: issue `Test`'s certificate, switch "Testing Profile" ON (reason), device engineer loads client.crt + client.key (Quectel seclevel 2) and retests
## 2026-11-03 — Widget reports: gate finished, PUSHED + DEPLOYED

- [x] 12 formerly-red API files + `report-templates.e2e` + `instrument-attribute-permission.e2e` green one at a time (14 files). Root cause of the 65 reds: RB0001 aged into the 90-day password expiry on 2026-11-02 → 403 PASSWORD_EXPIRED; `vitest.global-setup.ts` now stamps `passwordChangedAt` (UNCOMMITTED, with the Supervisor fix).
- [x] Touched web files 65/65 (pages-hero timed out at 5 s under load, green alone 3.1 s).
- [x] Pushed `90632e8f..ea7dee92` to `trh/data-layer`; deployed over SSM, log `/root/deploy-20261103.log`: migration applied, health 200. Post-checks: routes 401 unauth, CSP as intended (m10 verified), bundle chunks present.
- [ ] Operator: reload open browsers (PWA cache); verify-chain after the schema change; try a widget's Download report + the preview iframe on AWS in a real browser.
- [ ] Still UNCOMMITTED: the Supervisor Instrument-ID fix (`INSTRUMENT_ATTRIBUTE_UPDATE`, since 2026-10-30) + the global-setup password stamp — the gate ran on the tree WITH them.

- ## Widget reports (2026-11-02): parked m9 — a key outside the profile's measurements / displayKeys cannot be a collapsed key: column (prints in the long form only); extend the catalogue if a profile needs it.
