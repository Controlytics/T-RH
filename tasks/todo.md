# tasks/todo.md

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
- [ ] Final whole-branch review (controller) — then push / deploy only on the operator's word; the push must name the other session's commits on the branch too
- [ ] Parked R7-11: the readings table, floor plan and alarms panel on `/` and `/dashboards/:id` are not on `widgetPolling` — they still stop polling after an outage until the window is focused
- [ ] Parked: series palette slot 3 is a green a raw key can take (app-wide since phase 1, distinct from the OK green)
- [ ] Parked M9: a gauge widget at its default size in a narrow panel shows a sliver and its body scrolls
- [ ] Parked: widget titles stored with markup before the stripping are not backfilled (they print as text)
- [ ] Operator decision: at `md` (a 900–1,200 px container — a 1240 px window) react-grid-layout's own derivation staircases third-width panels down the page, `/` included; a half-scale `md` layout is the candidate fix
- [ ] Two loading behaviours on a drill-down: the status widgets show "Loading…" while the readings table keeps its old rows (final review to judge)
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
