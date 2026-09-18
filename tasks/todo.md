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
- [ ] `scripts/aws/provision-ubuntu.sh keygen` → operator adds the deploy key on GitHub
- [ ] `scripts/aws/provision-ubuntu.sh install` (clone, node, emqx, certs, env, build, units; API NOT started)
- [ ] Cutover: stop DigiLogAPI on Windows → repair SQL → migrate deploy → start digilog-api → move EIP
- [ ] Verify: /api/health 200, login, /api/audit/verify-chain intact, EMQX up, 1883 reachable
- [ ] Delete the SSM parameter
- [ ] AMI of the Windows instance, then terminate (ask once more first)
- [ ] `deploy-to-aws.bat` → new instance id + AWS-RunShellScript; delete `scripts/deploy-on-instance.ps1`
- [ ] Docs: CHANGELOG, `docs/deployment-methods/method-d-aws-ubuntu.md`, memory, Documents runbook lines
