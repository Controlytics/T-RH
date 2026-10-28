# tasks/todo.md

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

## 2026-10-28 — Widget data keys: any key an instrument sends, in any widget

Spec `docs/superpowers/specs/2026-10-28-widget-data-keys-design.md`; phase 1 plan `docs/superpowers/plans/2026-10-28-widget-data-keys-phase1.md`.

- [x] Phase 1 T1 shared contract (`data-keys.ts`)
- [x] Phase 1 T2 `GET /api/instruments/data-keys` + `telemetry-keys` gains `numeric` / `measurement`
- [x] Phase 1 T3 `POST /api/instruments/latest-values` (overview's own bounds)
- [x] Phase 1 T4 `keys` on the history routes + docs + full API suite
- [ ] Phase 2 dashboard widgets (SUPER_ADMIN builds, Save as role default, `custom_widgets` panel)
- [ ] Phase 3 trend page extra keys per profile (migration `display_keys`)
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
