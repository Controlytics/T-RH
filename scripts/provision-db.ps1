<#
.SYNOPSIS
  Provision a PRIVATE, isolated PostgreSQL cluster for DigiLog and load the app
  schema + seed. This is what the customer installer runs against the bundled
  Postgres binaries so the customer needs no pre-installed database.
  See tasks/EXE-PACKAGING-PLAN.md section 7 (M3).

.DESCRIPTION
  Idempotent-safe: refuses to clobber a non-empty data dir. Steps:
    1. initdb a fresh cluster (scram auth, UTF8) in -DataDir
    2. pin port + listen_addresses=localhost in postgresql.conf
    3. start the cluster (standalone process; M4 turns this into a service)
    4. create the app role + database
    5. apply prisma/sql/extensions.sql (ltree + pgcrypto) BEFORE migrate
    6. prisma migrate deploy
    7. seed (requires INITIAL_ADMIN_PASSWORD)
    8. verify (roles + superadmin user present)

  Connection details are written to -EnvOut as a DATABASE_URL the API can load.

.PARAMETER PgBin     Dir containing initdb.exe/pg_ctl.exe/postgres.exe/psql.exe
.PARAMETER DataDir   Target cluster data directory (must be empty/absent)
.PARAMETER Port      TCP port for this private cluster (default 5433)
.PARAMETER AppDb / AppRole / AppPassword   The application database + login
.PARAMETER SuperPassword   Password for the cluster bootstrap superuser
.PARAMETER AdminPassword   INITIAL_ADMIN_PASSWORD for the app seed
.PARAMETER ApiDir    apps/api (for prisma schema, extensions.sql, seed)
.PARAMETER NodeExe   node.exe to run prisma/seed with (default: 'npx'/'node' on PATH)
.PARAMETER StopWhenDone   Stop the cluster after provisioning (installer leaves
                          it for the service in M4; the test stops it)
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$PgBin,
  [Parameter(Mandatory)] [string]$DataDir,
  [int]$Port = 5433,
  [string]$AppDb = 'digilog_db',
  [string]$AppRole = 'digilog',
  [Parameter(Mandatory)] [string]$AppPassword,
  [Parameter(Mandatory)] [string]$SuperPassword,
  [Parameter(Mandatory)] [string]$AdminPassword,
  [Parameter(Mandatory)] [string]$ApiDir,
  [string]$NodeExe = 'node',
  [string]$LogDir,
  [string]$EnvOut,
  [switch]$StopWhenDone
)

# Gate on $LASTEXITCODE; never ErrorActionPreference=Stop with native stderr.
$initdb = Join-Path $PgBin 'initdb.exe'
$pgctl  = Join-Path $PgBin 'pg_ctl.exe'
$psql   = Join-Path $PgBin 'psql.exe'
foreach ($e in @($initdb,$pgctl,$psql)) { if (-not (Test-Path $e)) { Write-Host "Missing $e" -ForegroundColor Red; exit 1 } }
if ((Test-Path $DataDir) -and (Get-ChildItem $DataDir -Force -ErrorAction SilentlyContinue)) {
  Write-Host "Refusing to clobber non-empty data dir: $DataDir" -ForegroundColor Red; exit 1
}
if (-not $LogDir) { $LogDir = Join-Path (Split-Path $DataDir -Parent) 'logs' }
New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null
$pgLog = Join-Path $LogDir 'postgres.log'
$dbUrl = "postgresql://${AppRole}:${AppPassword}@localhost:${Port}/${AppDb}?schema=public"

function Run($exe, $argList, $desc) {
  Write-Host "==> $desc" -ForegroundColor Cyan
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $desc (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
}

# 1. initdb - scram auth, UTF8. Superuser password via temp pwfile.
$pwFile = Join-Path $LogDir '.initpw.tmp'
Set-Content -Path $pwFile -Value $SuperPassword -NoNewline -Encoding ascii
try {
  Run $initdb @('-D', $DataDir, '-U', 'postgres', '--auth=scram-sha-256', "--pwfile=$pwFile", '-E', 'UTF8') 'initdb (fresh cluster)'
} finally {
  Remove-Item $pwFile -Force -ErrorAction SilentlyContinue
}

# 2. Pin port + localhost-only in postgresql.conf
$conf = Join-Path $DataDir 'postgresql.conf'
Add-Content -Path $conf -Value "`n# --- DigiLog installer overrides ---`nport = $Port`nlisten_addresses = 'localhost'`n"

# 3. Start the cluster
Run $pgctl @('-D', $DataDir, '-l', $pgLog, '-w', 'start') "start cluster on :$Port"

$env:PGPASSWORD = $SuperPassword
function Psql($db, $sql) {
  & $psql -h localhost -p $Port -U postgres -d $db -v ON_ERROR_STOP=1 -qtAc $sql
  if ($LASTEXITCODE -ne 0) { Write-Host "psql failed: $sql" -ForegroundColor Red; & $pgctl -D $DataDir stop -m fast | Out-Null; exit 1 }
}

try {
  # 4. App role + database (CREATE ROLE is idempotent-guarded)
  Write-Host "==> create role + database" -ForegroundColor Cyan
  Psql 'postgres' "DO `$`$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='$AppRole') THEN CREATE ROLE $AppRole LOGIN PASSWORD '$AppPassword'; END IF; END `$`$;"
  $exists = Psql 'postgres' "SELECT 1 FROM pg_database WHERE datname='$AppDb';"
  if (-not $exists) { Psql 'postgres' "CREATE DATABASE $AppDb OWNER $AppRole;" }

  # 5. Extensions BEFORE migrate (baseline uses ltree/pgcrypto, doesn't create them)
  Write-Host "==> apply extensions.sql" -ForegroundColor Cyan
  & $psql -h localhost -p $Port -U postgres -d $AppDb -v ON_ERROR_STOP=1 -q -f (Join-Path $ApiDir 'prisma\sql\extensions.sql')
  if ($LASTEXITCODE -ne 0) { Write-Host "extensions failed" -ForegroundColor Red; & $pgctl -D $DataDir stop -m fast | Out-Null; exit 1 }

  # 6 + 7. migrate deploy + seed via the shared, customer-safe apply-schema step
  #        (bundled node.exe only; npx/tsx dev fallback). Fresh + upgrade both go
  #        through apply-schema.ps1 so they can never drift. See EXE-PACKAGING-PLAN M6.
  & (Join-Path $PSScriptRoot 'apply-schema.ps1') -NodeExe $NodeExe -ApiDir $ApiDir -DatabaseUrl $dbUrl -AdminPassword $AdminPassword
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: apply-schema" -ForegroundColor Red; & $pgctl -D $DataDir stop -m fast | Out-Null; exit 1 }

  # 8. Verify
  $roleCount = Psql $AppDb "SELECT count(*) FROM roles;"
  $adminCount = Psql $AppDb "SELECT count(*) FROM users WHERE username='superadmin';"
  Write-Host "`nProvisioned OK - roles=$roleCount, superadmin=$adminCount, db=$AppDb @ :$Port" -ForegroundColor Green
  if ($EnvOut) { Set-Content -Path $EnvOut -Value "DATABASE_URL=$dbUrl" -Encoding ascii; Write-Host "Wrote $EnvOut" }
}
finally {
  if ($StopWhenDone) {
    Write-Host "==> stopping cluster (StopWhenDone)" -ForegroundColor Cyan
    & $pgctl -D $DataDir stop -m fast | Out-Null
  }
}
exit 0  # explicit success so callers reading $LASTEXITCODE are not misled by stale codes
