# The AWS instance: Ubuntu 24.04 (since 2026-09-18)

**Status: LIVE.** `https://13.204.15.17` is served by EC2 `i-0b13dae53e9113f1d`
(Ubuntu 24.04, t3.medium, ap-south-1b) against RDS `compliance-core-db`
(PostgreSQL 16). It replaced the Windows Server 2025 instance
`i-0be63a2077d4a82e0`, which was terminated the same day at the operator's
instruction ("make this instance into ubuntu" — an instance cannot change OS,
so a new one took over the Elastic IP). Decisions taken by the operator: keep
RDS; git clone + build like the Windows box (not the `.deb`); EMQX on the box
with 1883/8883 open; a fresh read-only deploy key; nothing copied from the
Windows box ("i dont need windows files or data, in ubuntu freshly install
from git").

## Connect

```bash
alias aws='"/c/Program Files/Amazon/AWSCLIV2/aws.exe"'   # not on PATH in Git Bash
aws login                                                 # browser approval; expires in hours
aws ssm start-session --target i-0b13dae53e9113f1d        # a root-capable shell (sudo -i)
```

No SSH port is open; SSM is the only way in (as on Windows). Key pair
`user_mgt` is attached but unused.

## Layout on the box

Mirrors the `.deb` installer ([method-c-ubuntu-deb.md](method-c-ubuntu-deb.md))
so the runbooks agree — except the PROGRAM is a git clone rebuilt in place and
the DATABASE is RDS.

| Path | What |
|---|---|
| `/opt/digilog/app` | git clone of the deployed branch, built in place (`apps/api/dist`, `apps/web/dist`) |
| `/opt/digilog/node` | portable Node 24 (official tarball); symlinked into `/usr/local/bin` |
| `/opt/digilog/emqx` | EMQX 5.3.2 (ubuntu22.04 build), config rendered from `scripts/emqx/` via the symlink `/opt/digilog/emqx-templates` |
| `/etc/digilog/digilog.env` | every secret and setting (`EnvironmentFile=`), `0640 root:digilog` |
| `/etc/digilog/certs` | local CA + server cert (SAN: localhost, 127.0.0.1, private IP, **13.204.15.17**) |
| `/var/lib/digilog/{uploads,emqx}` | the only places the app writes |
| `/etc/systemd/system/digilog-api.service` | `scripts/aws/digilog-api.service` — port 443 via `CAP_NET_BIND_SERVICE`, hardened |
| `/etc/systemd/system/digilog-emqx.service` | `scripts/linux/systemd/digilog-emqx.service`, unchanged |

Secrets: `DATABASE_URL` (RDS, `sslmode=require&uselibpqcompat=true`),
`JWT_SECRET`, `AUDIT_CHAIN_KEY` + `AUDIT_CHAIN_KEYED_FROM=0` are the SAME
values the Windows box used — the audit chain (keyed from row 0) verifies
unchanged. `INSTRUMENT_TOKEN_KEY` and the `MQTT_*` / `EMQX_*` keys were
generated on the box. The full file is ALSO in
`C:\Users\hello\Documents\compliance-core-deployment\` on the operator's
laptop — losing `AUDIT_CHAIN_KEY` makes every audit row permanently
unverifiable.

## Deploying a code change — NOTHING is automatic

```bash
git push                     # from the laptop
deploy-to-aws.bat            # deploys the branch you are CURRENTLY on (asks y/N)
deploy-to-aws.bat <branch>   # or name one; final-user-management is refused
```

`deploy-to-aws.bat` sends `scripts/aws/deploy-on-ubuntu.sh --branch <b>` over
SSM. That script fetches, runs `npm ci` only if the lockfile moved (stopping
the service for it), `prisma migrate deploy`, builds shared / queue / web /
api, restarts `digilog-api` and requires `GET /api/health` → 200. Any failure
exits BEFORE the restart, so a broken build leaves the previous version
serving. **SSM "Success" means the command ran; read the output.**

## Operating it

```bash
systemctl status digilog-api digilog-emqx
journalctl -u digilog-api -f
sudo -u digilog /opt/digilog/emqx/bin/emqx_ctl status
# repair the broker config from a root shell:
. /opt/digilog/app/scripts/linux/digilog-lib.sh && DIGILOG_API_PORT=443 digilog_provision_emqx && systemctl restart digilog-emqx
```

Ports: **443** HTTPS (web + API), **1883** MQTT, **8883** MQTTS (self-signed —
devices must trust `/etc/digilog/certs/rootCA.pem`), 18083 EMQX dashboard on
loopback only. Security group `sg-058348c5dba72f08e`: 443, 1883, 8883 from
anywhere; 3389 from one IP is a leftover of the Windows box.

## Rebuilding from nothing

`scripts/aws/provision-ubuntu.sh` — two phases, idempotent, run over SSM
(`AWS-RunShellScript`, as root): `keygen` (packages, AWS CLI v2, a fresh
ed25519 deploy key printed for GitHub → Settings → Deploy keys, read-only;
`gh repo deploy-key add` does it from the laptop) then `install` (clone, Node,
EMQX, user, certs, env from the SSM SecureString `/compliance-core/ubuntu/digilog.env`
— which is DELETED after a successful install, so put it back first —
dependencies, build, units; broker started, API left stopped). The env file
must carry the SAME `AUDIT_CHAIN_KEY`; the RDS snapshot
`compliance-core-db-pre-ubuntu-20260918` is the last state before this move.

## The one-time database repair (2026-09-18)

RDS was last migrated on 2026-08-01 from `final-user-management` and still
carried two migrations from the Data Injection programme removed on
2026-08-04. Their tables blocked `20260804120000_instruments_p1`.
`scripts/aws/rds-repair-orphaned-data-injection.sql` (run once through
`scripts/aws/run-sql.cjs`, one transaction) dropped 7 tables + 2 enums holding
1 + 18 seed rows and the 2 history rows; the receipt is in the file. Then 35
migrations applied. `audit_trail` was never touched.
