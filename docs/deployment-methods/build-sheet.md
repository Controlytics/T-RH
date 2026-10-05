# Installation Build Sheet — compliance-core

**Purpose.** A versioned, per-installation record of *what was actually built*.
Not a procedure — `method-a-native-windows.md` and `DEPLOY-AWS-EC2.md` are the
procedures. This is the evidence of the result.

**Why it exists.** The 2026-08-29 technical audit raised finding **M7**:
production infrastructure had no representation in the repository at all. No
Terraform, no CloudFormation, no Ansible, and `deploy-to-aws.bat` is a
client-side push helper, not provisioning. The consequence is that **the live
environment cannot be rebuilt from this repository**, and for a validated
21 CFR Part 11 system "how the production environment was constructed" is
normally part of IQ evidence.

Full IaC is the better answer and is not what this file is. This is the
minimum that closes the gap: a committed, reviewable record, versioned
alongside the code it runs.

## How to use it

1. Copy this file to `docs/deployment-methods/build-sheets/<environment>-<YYYY-MM-DD>.md`.
2. Fill every field. **Write `UNKNOWN` rather than guessing** — a build sheet
   with a plausible wrong value is worse than one with an admitted gap, because
   the next person will act on it.
3. Commit it. The point is that it is versioned with the code.
4. Re-issue on any change to host, database, certificate, or service
   configuration — not on every application deploy.

---

## 1. Identification

| Field | Value |
|---|---|
| Environment name | |
| Purpose (production / validation / staging / demo) | |
| Built by | |
| Date built | |
| Application version (`git rev-parse HEAD`) | |
| Application branch / tag | |
| Validated system? (Y/N) | |
| If Y — IQ/OQ/PQ reference | |

## 2. Host

| Field | Value |
|---|---|
| Provider (on-prem / EC2 / other) | |
| Instance id or hostname | |
| OS + build | |
| vCPU / RAM / disk | |
| Static IP / DNS name | |
| Time zone and NTP source¹ | |
| Antivirus exclusions applied² | |

¹ The audit trail is timestamped and hash-chained. Clock drift is a §11
problem, not a convenience one.
² The bundled PostgreSQL data directory and the uploads directory. Real-time
scanning on a Postgres data dir causes corruption and stalls.

## 3. Runtime

| Field | Value | Verify with |
|---|---|---|
| Node.js version | | `node --version` (repo needs 20+) |
| npm version | | `npm --version` |
| PostgreSQL version | | `psql --version` (repo targets 18) |
| Postgres data directory | | |
| Postgres port | | default 5432 |
| Required extensions installed | `ltree`, `pgcrypto` | `prisma/sql/extensions.sql` — **`migrate deploy` fails on a bare DB without these** |

## 4. Databases

| Field | Value |
|---|---|
| Application database name | |
| Test database name (if present) | |
| DB role used by the application | |
| Role privileges (must be table OWNER³) | |
| Migration state | `npx prisma migrate status` output attached? |

³ Restore and the audit-delete path use `ALTER TABLE ... DISABLE TRIGGER`,
which requires ownership. `SET session_replication_role` would need
superuser/replication and is deliberately not used.

## 5. Services

Registered by `scripts/register-services.ps1`.

| Field | Value |
|---|---|
| DB service name | default `DigiLogDB` |
| API service name | default `DigiLogAPI` |
| Service account | |
| API service depends on DB service? | must be **yes** |
| Restart on failure | default: restart after 10s |
| Start mode | must be **Automatic** (survives reboot) |
| `NODE_ENV` | must be **production** — it activates every fail-closed guard⁴ |
| Log directory | |
| Log retention | default 32 files × 10 MB ≈ 320 MB |

⁴ With `NODE_ENV=production`: `ALLOWED_ORIGINS` becomes mandatory (throws
without it), `JWT_SECRET` must be ≥32 chars (`VERIFICATION_TOKEN_SECRET` was removed 2026-10-05, audit SEC-5)
(throws otherwise, instead of generating a random per-boot secret that
invalidates every session on restart), Swagger stops being public, and error
responses stop including messages.

## 6. Networking and TLS

| Field | Value |
|---|---|
| API port | default 3001 |
| `API_HTTPS` | |
| Certificate source (mkcert / internal CA / public CA) | |
| Certificate CN / SANs | |
| Certificate expiry | |
| `TLS_KEY_PATH` / `TLS_CERT_PATH` | |
| Root CA distributed to clients? How? | |
| `SERVE_WEB` (API serves the SPA)? | |
| Reverse proxy in front? | If yes, `TRUST_PROXY` **must** be set⁵ |
| Firewall rules opened | |
| MQTT broker host/port (if ingest used) | |
| `INGEST_TCP_PORT` (if used) | |

⁵ `TRUST_PROXY` defaults to **false** on purpose. With no proxy, the first hop
is the client's browser, so a trusted `X-Forwarded-For` would let a caller
forge the IP recorded in the audit trail and used for rate limiting.

## 7. Configuration — presence only

**Record only whether each is SET. Never write a secret value into this file.**

| Variable | Set? | Notes |
|---|---|---|
| `DATABASE_URL` | | |
| `DATABASE_URL_QUEUE` | | |
| `JWT_SECRET` | | ≥32 chars |
| `AUDIT_HARD_DELETE_ENABLED` | `false` | both installers write it (audit DATA-8) |
| `ALLOWED_ORIGINS` | | mandatory in production |
| `AUDIT_CHAIN_KEY` | | enables keyed (V3) audit checksums |
| `AUDIT_CHAIN_KEYED_FROM` | | the out-of-band anchor — **back it up separately from the database** |
| `AUDIT_HARD_DELETE_ENABLED` | | absent = enabled. See §9 |
| `INSTRUMENT_TOKEN_KEY` | | absent = device tokens cannot be revealed |
| `INITIAL_ADMIN_PASSWORD` | | seeding throws without it |
| `UPLOAD_DIR` | | must match the photo writer's root or served images 404 |
| `BACKUP_MAX_ROWS_PER_TABLE` | | default 500,000 |
| `MQTT_*` | | if ingest used |
| `LOG_LEVEL` | | optional; defaults from `NODE_ENV` |

Env file location (`DOTENV_CONFIG_PATH`): ______________________
Backed up? Where? ______________________

## 8. Backup

| Field | Value |
|---|---|
| Scheduled task registered (`register-backup-task.ps1`)? | |
| Schedule | |
| Destination + retention | |
| Off-host copy? | |
| **Restore tested on this build?** | **Date + result:** |

> A backup that has never been restored is a hypothesis. The application's own
> export/restore is covered by `src/e2e/backup-restore.e2e.test.ts`, but that
> proves the code path, not your media or your credentials.
>
> Note the telemetry history table is partitioned and large; the application
> backup loads tables into memory and is guarded by
> `BACKUP_MAX_ROWS_PER_TABLE`. For a deployment with real telemetry volume,
> `pg_dump`/PITR is the appropriate mechanism for that table.

## 9. Compliance decisions taken for this installation

| Decision | Setting | Approved by | Date |
|---|---|---|---|
| Audit hard-delete permitted? (`AUDIT_HARD_DELETE_ENABLED`) | | | |
| `AUDIT_DELETE` permission granted to any role? | | | |
| Keyed audit chain enabled? (`AUDIT_CHAIN_KEY`) | | | |
| Uploads served unauthenticated (photos/branding/floorplans)? | default: yes | | |
| Log retention adequate for diagnostics? | | | |

> The first two belong together. Turning the flag off while leaving the
> permission granted leaves a delete button in the Audit Trail UI that returns
> 403 — the switch is backend-only. Revoke the permission as well.

## 10. Verification performed

| Check | Command | Result |
|---|---|---|
| Migrations applied | `npx prisma migrate status` | |
| Migration safety guard | `npm run check:migrations` | |
| API responds over TLS | `curl -sk --ssl-revoke-best-effort -o /dev/null -w "%{http_code}" https://<host>:3001/api/system-health` (401 is a pass) | |
| Liveness probe | `GET /api/health` returns 200 | |
| Job runner started | `/api/health` reports `jobRunner: running`⁶ | |
| Login works | | |
| Audit chain intact | `GET /api/audit/verify-chain` | |
| Services survive reboot | reboot and re-check | |

⁶ `/api/health` deliberately returns **200 even when the job runner is down**,
because the tablet treats any non-2xx as "server unreachable". Read the
`jobRunner` field; do not rely on the status code. With the runner down,
alarm evaluation, notifications and session sweeps are all dead.

## 11. Sign-off

| Role | Name | Signature | Date |
|---|---|---|---|
| Built by | | | |
| Reviewed by | | | |
| QA approved (validated systems only) | | | |
