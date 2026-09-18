# tasks/todo.md

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
