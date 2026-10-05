# Deploying compliance-core to AWS (EC2 Windows + RDS PostgreSQL)

**Target:** EC2 instance `i-05a5f520ba20927b6` (Windows Server) + Amazon RDS for PostgreSQL.

> **Status of this document.** Every command below is written to be run by you,
> because the assistant that produced it had no AWS credentials, no AWS CLI, and
> no key pair for the instance — it could not reach AWS to verify anything.
> Treat this as a reviewed plan, not a tested procedure. Values you must
> substitute are written `<LIKE_THIS>`.

---

## 0. Before you start — read this

This is a **21 CFR Part 11 system holding regulated audit records**. Three
consequences that change how you should approach the move:

1. **Moving a validated system to new infrastructure is a re-qualification
   event.** If this installation is validated, IQ/OQ/PQ needs revisiting. That
   is a QA decision, not a technical one.
2. **The audit chain key must be generated at install and backed up separately
   from the database.** See §6. Losing it makes every keyed audit row
   permanently unverifiable; the `audit_trail_no_delete` trigger means you
   cannot clean them up afterwards.
3. **RDS widens who can reach the database.** The keyed HMAC chain
   (fixed 2026-07-25) is what makes DB-level tampering detectable. Do not deploy
   to RDS without it.

## 1. What you are building — PRIVATE, VPN-only

**Decision (2026-07-25): no public domain. The application is not reachable from
the internet.** Users connect over VPN. This preserves the on-premises threat
model the system was designed and validated against, and it is the more
defensible posture for 21 CFR Part 11 records.

```
   Users ──VPN──►  AWS Client VPN endpoint
                          │  (VPN client CIDR, e.g. 10.100.0.0/22)
                          ▼
    ┌─────────────────────────────────┐
    │ EC2 Windows Server              │   security group: sg-app
    │   NO public IP                  │   in : 443  from <VPN_CIDR> ONLY
    │   DigiLogAPI (WinSW service)    │        3389 from <VPN_CIDR> ONLY
    │     node dist/app.js            │   out: 5432 to sg-db
    │     SERVE_WEB=true → serves SPA │
    └──────┬──────────────────────────┘
           │ 5432
    ┌──────▼──────────────────────────┐
    │ RDS PostgreSQL 16+              │   security group: sg-db
    │   compliance_core_db            │   in : 5432 from sg-app ONLY
    │   NOT publicly accessible       │
    └─────────────────────────────────┘
```

**One process serves everything.** `SERVE_WEB=true` makes the Fastify API serve
the built React SPA, so there is no nginx/IIS and no separate web server. This
is why only one service is registered.

**What the private choice buys you**, beyond the obvious:

- **No ALB, no ACM, no public certificate, no DNS.** Self-signed certs are
  acceptable again (§8) because the trust boundary is the VPN, not the browser's
  public CA list.
- **No public 443**, so the CSP `unsafe-inline` and exposed Swagger findings drop
  from "internet-facing risk" to "authenticated-network risk".
- **No Elastic IP needed** — nothing addresses the instance publicly.

**What it does not buy you.** VPN is perimeter control, not a substitute for the
application's own controls. Everything else in this runbook still applies: the
audit chain key (§6), `ALLOWED_ORIGINS` (§6), a real initial admin password
(§7), and RDS reachable only from the app SG (§3).

## 2. Prerequisites on your workstation

```powershell
winget install Amazon.AWSCLI
aws configure          # access key, secret, default region
aws sts get-caller-identity          # confirms credentials work
```

Confirm the instance and note its VPC/subnet — everything else must live in the
same VPC:

```powershell
aws ec2 describe-instances --instance-ids i-05a5f520ba20927b6 `
  --query "Reservations[].Instances[].{State:State.Name,Type:InstanceType,VPC:VpcId,Subnet:SubnetId,AZ:Placement.AvailabilityZone,PublicIp:PublicIpAddress,Platform:Platform}" `
  --output table
```

If this errors, the region is wrong — add `--region <REGION>`.

## 3. Security groups

Create them **before** the RDS instance; the DB group is referenced at creation.

```powershell
$VPC = "<VPC_ID_FROM_STEP_2>"

# app tier
aws ec2 create-security-group --group-name compliance-core-app `
  --description "compliance-core EC2" --vpc-id $VPC
# → note GroupId as sg-app

# db tier
aws ec2 create-security-group --group-name compliance-core-db `
  --description "compliance-core RDS" --vpc-id $VPC
# → note GroupId as sg-db
```

Rules. **Nothing here opens a port to the internet** — `0.0.0.0/0` must not
appear in any rule below.

```powershell
$VPN_CIDR = "<VPN_CLIENT_CIDR>"     # e.g. 10.100.0.0/22 — see section 3a

# RDS: accept 5432 ONLY from the app security group
aws ec2 authorize-security-group-ingress --group-id <SG_DB> `
  --protocol tcp --port 5432 --source-group <SG_APP>

# App: HTTPS from the VPN only
aws ec2 authorize-security-group-ingress --group-id <SG_APP> `
  --protocol tcp --port 443 --cidr $VPN_CIDR

# App: RDP from the VPN only
aws ec2 authorize-security-group-ingress --group-id <SG_APP> `
  --protocol tcp --port 3389 --cidr $VPN_CIDR
```

Attach `sg-app` to the instance. **Do this only once VPN access is confirmed
working** — if the instance currently has a public-IP SG that is how you reach
it, replacing that SG will lock you out.

```powershell
aws ec2 modify-instance-attribute --instance-id i-05a5f520ba20927b6 --groups <SG_APP>
```

Then remove the public IP so the host is genuinely unreachable:

```powershell
# confirm what is currently attached before changing anything
aws ec2 describe-instances --instance-ids i-05a5f520ba20927b6 `
  --query "Reservations[].Instances[].{PublicIp:PublicIpAddress,SGs:SecurityGroups[].GroupId}" --output table
```

A public IPv4 auto-assigned at launch cannot be detached in place — you either
disassociate an Elastic IP, or recreate the instance in a private subnet. If
recreating is not acceptable right now, leaving the public IP with **no inbound
rules permitting it** is an acceptable interim: the address exists but nothing
listens to the internet. Note it as a deviation and close it later.

### 3a. The VPN itself

Three options, in descending order of fit for this system:

| Option | When it fits |
|---|---|
| **AWS Client VPN** | Individual users on laptops. Certificate or AD/SSO auth. Per-endpoint-hour + per-connection cost. Cleanest for a handful of named operators. |
| **Site-to-Site VPN** | The site already has a hardware VPN appliance and users are on a corporate LAN. Extends the existing network — often the best fit for a pharma site that already has one. |
| **Bastion + SSM Session Manager** | Admin access only, not an end-user path. Good for you to administer the box; not how operators would use the app. |

Whichever you choose, `<VPN_CLIENT_CIDR>` above is the address range assigned to
connected clients, and it must be routable to the instance's subnet.

> **If the site already has a Site-to-Site VPN, use it.** It avoids a second
> credential set for operators and keeps access governance where the site's
> existing SOPs already cover it — which matters for validation.

## 4. RDS PostgreSQL

```powershell
aws rds create-db-instance `
  --db-instance-identifier compliance-core-db `
  --db-instance-class db.t3.small `
  --engine postgres `
  --engine-version 16.4 `
  --master-username ccadmin `
  --master-user-password "<STRONG_PASSWORD>" `
  --allocated-storage 50 `
  --storage-type gp3 `
  --storage-encrypted `
  --backup-retention-period 30 `
  --no-publicly-accessible `
  --vpc-security-group-ids <SG_DB> `
  --db-subnet-group-name <YOUR_DB_SUBNET_GROUP> `
  --deletion-protection
```

Choices that matter here, and why:

| Flag | Why |
|---|---|
| `--storage-encrypted` | Regulated records at rest |
| `--backup-retention-period 30` | Audit rows can never be recreated. **Backup cadence is an audit-completeness decision, not just availability** — see §9 |
| `--no-publicly-accessible` | The DB is reachable only from the app SG |
| `--deletion-protection` | Guards against destroying the audit trail with one command |

Wait for it and capture the endpoint:

```powershell
aws rds wait db-instance-available --db-instance-identifier compliance-core-db
aws rds describe-db-instances --db-instance-identifier compliance-core-db `
  --query "DBInstances[0].Endpoint.Address" --output text
```

## 5. Create the database and extensions

From the EC2 instance (it is the only thing that can reach RDS). Install the
PostgreSQL **client** there, then:

```powershell
$env:PGPASSWORD = "<MASTER_PASSWORD>"
$RDS = "<RDS_ENDPOINT>"

psql -h $RDS -U ccadmin -d postgres -c "CREATE DATABASE compliance_core_db;"
psql -h $RDS -U ccadmin -d compliance_core_db -f prisma\sql\extensions.sql
```

`extensions.sql` creates `ltree` and `pgcrypto`. **This must happen before
`migrate deploy`** — the migration baseline *uses* both but does not create
them, so a bare database fails without this step. Verify:

```powershell
psql -h $RDS -U ccadmin -d compliance_core_db -c "\dx"
```

> If `ltree` is unavailable on your RDS engine version, check whether it is
> still needed — it is a leftover from a removed hierarchy feature and is a
> documented removal candidate. Do not skip `pgcrypto`: `gen_random_uuid()`
> defaults depend on it.

## 6. Application config — the part that must not be rushed

On the instance, create the service env file (default path
`C:\ProgramData\DigiLog\config\digilog.env`). **Generate real random values:**

```powershell
function New-Secret([int]$bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  -join ($b | ForEach-Object { $_.ToString('x2') })
}
New-Secret 48    # JWT_SECRET
New-Secret 48    # AUDIT_CHAIN_KEY
```

```ini
DATABASE_URL=postgresql://ccadmin:<PASSWORD>@<RDS_ENDPOINT>:5432/compliance_core_db?schema=public
NODE_ENV=production
PORT=443
API_HTTPS=true
TLS_KEY_PATH=C:\ProgramData\DigiLog\certs\server.key
TLS_CERT_PATH=C:\ProgramData\DigiLog\certs\server.crt
SERVE_WEB=true
WEB_DIST_DIR=C:\Program Files\DigiLog\web
UPLOAD_DIR=C:\ProgramData\DigiLog\uploads
JWT_SECRET=<GENERATED>
# VERIFICATION_TOKEN_SECRET — no longer read (removed 2026-10-05, audit SEC-5)
AUDIT_HARD_DELETE_ENABLED=false
JWT_EXPIRES_IN=1h
ALLOWED_ORIGINS=https://<PRIVATE_IP_OR_INTERNAL_NAME>
AUDIT_CHAIN_KEY=<GENERATED>
AUDIT_CHAIN_KEYED_FROM=0
```

### Non-negotiables

- **`ALLOWED_ORIGINS` must be set.** Production boot deliberately fails without
  it. Set it to the exact origin users type — not `*`.
- **`AUDIT_CHAIN_KEY` + `AUDIT_CHAIN_KEYED_FROM=0`.** `0` is correct here
  because the database is empty, so *every* row must be keyed. Both are
  required: the key alone leaves the chain forgeable via a version downgrade.
- **Back up this file separately from the database.** If the RDS snapshot and
  the key are stored together, an actor with the snapshot has both. Put the key
  in AWS Secrets Manager or an offline store.
- **Never commit it.** It is not in the repo and must not be.

## 7. Deploy the application

On the instance:

```powershell
# 1. build (or copy a build from CI)
npm ci
npm run build -w @digilog/shared
npm run build -w @digilog/queue
cd apps\web ; npx vite build ; cd ..\..
npx tsc -p apps\api\tsconfig.json

# 2. schema + seed against RDS (reuses the tested shared path)
powershell -File scripts\apply-schema.ps1 `
  -ApiDir "C:\Program Files\DigiLog\api" `
  -DatabaseUrl "postgresql://ccadmin:<PASSWORD>@<RDS_ENDPOINT>:5432/compliance_core_db?schema=public" `
  -AdminPassword "<STRONG_INITIAL_ADMIN_PASSWORD>"
```

`apply-schema.ps1` runs `migrate deploy` then the seed, and is the same step the
Windows installer uses — so the two paths cannot drift.

> **`-AdminPassword` must be a real strong password.** The seed refuses to run
> without one precisely so no default credential reaches an install. Do not use
> `Admin@123` on an internet-reachable host. The account is forced to change it
> at first login.

### Register the service

`scripts/register-services.ps1` registers **two** services (`DigiLogDB` +
`DigiLogAPI`) because it assumes a bundled local Postgres. With RDS you want
only `DigiLogAPI`. Either add a skip-DB switch to that script, or register the
API alone with WinSW using the same XML shape it generates. Point
`DOTENV_CONFIG_PATH` at the env file from §6.

## 8. TLS — self-signed, on the instance

With no public domain and VPN-only access, a public CA certificate is neither
available nor needed: there is no public DNS name to issue one against, and the
trust boundary is the VPN. **Self-signed is the correct choice here** — the same
model the on-premises product already uses.

TLS still stays **on**. It protects credentials and audit data on the wire
*inside* the VPN, and `API_HTTPS=true` in §6 assumes it.

Generate a cert on the instance whose SAN covers how users will actually reach
it — the private IP, and any internal DNS name if the site has one:

```powershell
# on the EC2 instance, using the repo's existing mkcert-style flow
mkcert -key-file C:\ProgramData\DigiLog\certs\server.key `
       -cert-file C:\ProgramData\DigiLog\certs\server.crt `
       <PRIVATE_IP> <INTERNAL_DNS_NAME_IF_ANY> localhost 127.0.0.1
```

> **The SAN list matters.** Browsers reject a certificate that does not name the
> host as typed. If operators will browse to `https://10.0.1.42`, that IP must
> be in the SAN — a CN-only cert will fail.

**Distribute the root CA to client machines**, otherwise every operator sees a
warning and is trained to click through security prompts — a genuinely bad habit
in a regulated environment:

- Windows clients: import `rootCA.pem` into *Trusted Root Certification
  Authorities* (Local Machine), ideally pushed by Group Policy.
- Record the CA fingerprint in your deployment documentation.

**Set `ALLOWED_ORIGINS` (§6) to exactly what users type**, e.g.
`https://10.0.1.42` or `https://compliance.internal.example`. It is not optional
— production boot fails without it.

**Renewal:** self-signed certs do not auto-renew. Note the expiry date and put a
reminder in your maintenance calendar; an expired cert takes the application
offline for every user at once.

## 9. Backups and recovery

RDS automated backups cover the database. What they do **not** cover:

- **`digilog.env`** (the audit chain key). Back it up separately.
- **`UPLOAD_DIR`** (profile photos). Sync to S3 or include in an instance backup.

**A recovery caveat specific to this system:** restoring `audit_trail` from a
snapshot restores a *valid* chain, but rows written after the snapshot are lost.
Because the chain is positional, a partial restore cannot be merged with newer
rows. Your backup interval is therefore the maximum audit history you are
willing to lose — treat it as a compliance parameter.

## 10. Post-deployment verification

```powershell
# service up (from a VPN-connected machine)
Invoke-WebRequest https://<PRIVATE_IP_OR_INTERNAL_NAME>/health -UseBasicParsing

# audit chain intact AND keyed  ← the one that matters
# log in, then:
#   GET /api/audit/verify-chain   → intact: true, anomalies: []
```

Then confirm rows are actually keyed:

```sql
SELECT checksum_version, count(*) FROM audit_trail GROUP BY checksum_version;
-- every row should be 3, NOT NULL.
-- NULL means AUDIT_CHAIN_KEY was not loaded → stop and fix before going live.
```

Also verify:

- [ ] `superadmin` first login forces a password change
- [ ] **No security-group rule anywhere contains `0.0.0.0/0`**
- [ ] 443 and 3389 accept the VPN CIDR only
- [ ] RDS is `PubliclyAccessible: false`
- [ ] App is NOT reachable from a non-VPN network (verify by disconnecting)
- [ ] Root CA imported on client machines — no browser warning on normal use
- [ ] Certificate SAN covers the host as users actually type it
- [ ] `ALLOWED_ORIGINS` matches that exact origin
- [ ] `/docs` (Swagger) — lower risk now it is VPN-only, but still publishes a
      complete API map to anyone on the VPN. Disable in production if you can.

## 11. Known gaps this deployment inherits

Carried over from the security review — none block deployment, all worth
scheduling:

| Item | Detail |
|---|---|
| CSP `script-src 'unsafe-inline'` | Present so Swagger UI can run; neutralises CSP for the origin. Lower severity now the app is VPN-only, but disabling Swagger in production still lets you tighten it |
| Audit key not mandatory at boot | An env missing `AUDIT_CHAIN_KEY` still boots unkeyed. §10's SQL check is your safety net until this is made fatal |
| Tail truncation | Deleting the newest audit rows is not detectable by the chain alone. Record `verify-chain`'s `highestPosition` daily to write-once storage |
| Dead `capacitor://localhost` CORS entry | Remove from the allow-list |
| No CI/CD | Deployment is manual; there is no pipeline in the repo |

Full detail: [`recreation/09-security/README.md`](recreation/09-security/README.md).
