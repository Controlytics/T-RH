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

## 1. What you are building

```
        Internet
           │  443
    ┌──────▼──────────────────────────┐
    │ EC2 Windows Server              │   security group: sg-app
    │   DigiLogAPI (WinSW service)    │   in : 443 from 0.0.0.0/0 (or your CIDR)
    │     node dist/app.js            │        3389 from <YOUR_IP>/32 ONLY
    │     SERVE_WEB=true → serves SPA │   out: 5432 to sg-db
    └──────┬──────────────────────────┘
           │ 5432
    ┌──────▼──────────────────────────┐
    │ RDS PostgreSQL 16+              │   security group: sg-db
    │   compliance_core_db            │   in : 5432 from sg-app ONLY
    │   NOT publicly accessible       │   NO public access
    └─────────────────────────────────┘
```

**One process serves everything.** `SERVE_WEB=true` makes the Fastify API serve
the built React SPA, so there is no nginx/IIS and no separate web server. This
is why only one service is registered.

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

Rules — **the database must never be reachable from the internet**:

```powershell
# RDS: accept 5432 ONLY from the app security group
aws ec2 authorize-security-group-ingress --group-id <SG_DB> `
  --protocol tcp --port 5432 --source-group <SG_APP>

# App: HTTPS from users
aws ec2 authorize-security-group-ingress --group-id <SG_APP> `
  --protocol tcp --port 443 --cidr 0.0.0.0/0

# App: RDP from YOUR IP ONLY — never 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id <SG_APP> `
  --protocol tcp --port 3389 --cidr <YOUR_PUBLIC_IP>/32
```

Attach `sg-app` to the instance (keep any SG you already rely on for access):

```powershell
aws ec2 modify-instance-attribute --instance-id i-05a5f520ba20927b6 --groups <SG_APP>
```

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
New-Secret 48    # VERIFICATION_TOKEN_SECRET
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
VERIFICATION_TOKEN_SECRET=<GENERATED>
JWT_EXPIRES_IN=1h
ALLOWED_ORIGINS=https://<YOUR_DNS_NAME>
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

## 8. TLS

Self-signed certs will not work for public access — every user gets a browser
warning and traffic is trivially MITM-able. Two acceptable options:

**A — ALB + ACM (recommended).** Request a public certificate in ACM for your
domain, put an Application Load Balancer in front, terminate TLS at the ALB, and
let it reach the instance on 443. Certificate renewal is automatic.

**B — Certificate on the instance.** Use `win-acme` for a Let's Encrypt cert
directly on the box, writing to the `TLS_KEY_PATH` / `TLS_CERT_PATH` in §6.
Fewer moving parts, but you own renewal.

Either way you need a **DNS name** pointing at the ALB or the instance's Elastic
IP. Allocate an Elastic IP if you go with B — a stopped instance loses its
public IP otherwise.

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
# service up
Invoke-WebRequest https://<YOUR_DNS_NAME>/health -UseBasicParsing

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
- [ ] RDP (3389) is restricted to your IP, not `0.0.0.0/0`
- [ ] RDS is `PubliclyAccessible: false`
- [ ] `/docs` (Swagger) — decide whether to expose it; it publishes a complete
      API map. Recommended: disable in production.
- [ ] `ALLOWED_ORIGINS` matches the real origin

## 11. Known gaps this deployment inherits

Carried over from the security review — none block deployment, all worth
scheduling:

| Item | Detail |
|---|---|
| CSP `script-src 'unsafe-inline'` | Present so Swagger UI can run; neutralises CSP for the origin. Disabling Swagger in production lets you tighten it |
| Audit key not mandatory at boot | An env missing `AUDIT_CHAIN_KEY` still boots unkeyed. §10's SQL check is your safety net until this is made fatal |
| Tail truncation | Deleting the newest audit rows is not detectable by the chain alone. Record `verify-chain`'s `highestPosition` daily to write-once storage |
| Dead `capacitor://localhost` CORS entry | Remove from the allow-list |
| No CI/CD | Deployment is manual; there is no pipeline in the repo |

Full detail: [`recreation/09-security/README.md`](recreation/09-security/README.md).
