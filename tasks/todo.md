# tasks/todo.md

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
- [~] S5 web mediums/lows (3, 6–17; 18 closed as non-defect) + System Health flags + SEC-7 prompts + bulk-create gate — verified per file; full web run in progress; COMMIT PENDING
- [~] S6 docs (1, 4–13, 15, 16, 18–23) + counts re-derived + stale verify-route refs — COMMIT PENDING after S5
- [ ] Final: full web + api + shared test runs, tsc, CHANGELOG, memory

- [x] Fix order in §3 of the report: partitions at boot + batch-loss dead letter → role-config privilege check + required scope body → backup verifier/secrets → seed permission reset → user_role width + central signature bound → FL PUT serializer → visibility on attribute read + writes → public admin-request attribution → alarm double-clear + range coercion → reauth strip/lockout → SA password boxes, `/` and `/users` guards, chart axis format
- [ ] Operator decisions needed: untrack the dangling `.claude/worktrees/ui-redesign-stage2` gitlink; whether instrument WRITE routes are meant to be unscoped; hard-delete default off in installer env
