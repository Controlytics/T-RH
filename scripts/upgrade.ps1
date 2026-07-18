<#
.SYNOPSIS
  DigiLog UPGRADE orchestrator (v(N) -> v(N+1)). Run elevated by the Inno Setup
  installer AFTER the new program files are copied, when a prior install exists.
  See tasks/EXE-PACKAGING-PLAN.md section 8 (M6).

.DESCRIPTION
  Data-safety first (21 CFR Part 11): the customer's database + uploads live in
  C:\ProgramData\DigiLog and are NEVER touched destructively. The only schema
  change is forward-only `prisma migrate deploy` (records each step in
  _prisma_migrations); no db push, ever.

  Sequence:
    1. Validate a prior install exists (digilog.env + an initialised DB cluster).
    2. Ensure the DB service is up (needed for the backup + migrate).
    3. Stop the API service (the installer normally already did, before copying
       the new files over the running exe; this is defensive).
    4. pg_dump the app database to ProgramData\backups\pre-upgrade-<ver>-<ts>.sql.
       FATAL if the backup fails - we do not migrate an audited DB unbacked.
    5. Apply schema: migrate deploy + idempotent seed (shared apply-schema.ps1;
       same node-only path as fresh install). Admin password is a throwaway - the
       seed's superadmin upsert never overwrites an existing password.
    6. Start the API service; health check.

  Secrets (digilog.env) are PRESERVED, never regenerated - regenerating would
  invalidate live sessions and every outstanding offline-replay grant.

  ROLLBACK on failure is manual (documented, not automated): restore the
  pre-upgrade dump and reinstall the previous program version. This script tells
  the operator exactly which dump to restore.

.PARAMETER Version   Version string used in the backup filename (from the installer).
.PARAMETER DryRun    Print the plan without executing.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\Program Files\DigiLog',
  [string]$DataRoot   = 'C:\ProgramData\DigiLog',
  [int]$ApiPort = 3000,
  [string]$Version = 'unknown',
  [string]$DbService  = 'DigiLogDB',
  [string]$ApiService = 'DigiLogAPI',
  [int]$BackupRetainDays = 14,
  [switch]$DryRun
)

$pgBin     = Join-Path $InstallDir 'pgsql\bin'
$nodeExe   = Join-Path $InstallDir 'runtime\node.exe'
$apiDir    = Join-Path $InstallDir 'runtime\api'
$configDir = Join-Path $DataRoot 'config'
$envFile   = Join-Path $configDir 'digilog.env'
$dbDir     = Join-Path $DataRoot 'db'
$backupDir = Join-Path $DataRoot 'backups'
$pgDump    = Join-Path $pgBin 'pg_dump.exe'
$pgReady   = Join-Path $pgBin 'pg_isready.exe'

Write-Host "DigiLog UPGRADE orchestrator (-> v$Version)" -ForegroundColor Cyan
Write-Host "  InstallDir : $InstallDir"
Write-Host "  DataRoot   : $DataRoot"
if ($DryRun) { Write-Host "  (DRY RUN - no changes)" -ForegroundColor Yellow }
Write-Host ""

# 1. Validate a prior install. Missing pieces => this is not an upgrade; bail so
#    the caller runs the fresh install path instead of half-migrating nothing.
if (-not (Test-Path $envFile)) {
  Write-Host "FATAL: no existing $envFile - this is not an upgrade. Run install.ps1 (fresh)." -ForegroundColor Red; exit 1
}
if (-not (Test-Path (Join-Path $dbDir 'PG_VERSION'))) {
  Write-Host "FATAL: no initialised DB cluster at $dbDir - cannot upgrade. Manual review needed." -ForegroundColor Red; exit 1
}

# Parse DATABASE_URL from the preserved env file. Prisma keeps ?schema=public,
# which libpq (pg_dump) does not accept, so we pass the full URL to prisma but
# split components out for pg_dump.
$dbUrl = ((Get-Content $envFile | Where-Object { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=','').Trim()
if (-not $dbUrl) { Write-Host "FATAL: DATABASE_URL not found in $envFile" -ForegroundColor Red; exit 1 }
if ($dbUrl -notmatch 'postgres(?:ql)?://([^:]+):([^@]+)@([^:/]+):(\d+)/([^?]+)') {
  Write-Host "FATAL: could not parse DATABASE_URL from $envFile" -ForegroundColor Red; exit 1
}
$dbUser = $Matches[1]; $dbPass = $Matches[2]; $dbHost = $Matches[3]; $dbPort = $Matches[4]; $dbName = $Matches[5]

# 2. Ensure the DB service is up (leave it running for backup + migrate).
if (-not $DryRun) {
  & $pgReady -h $dbHost -p $dbPort | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "==> Starting $DbService (was not accepting connections)" -ForegroundColor Cyan
    sc.exe start $DbService | Out-Null
    foreach ($i in 1..30) { & $pgReady -h $dbHost -p $dbPort | Out-Null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 1 }
    & $pgReady -h $dbHost -p $dbPort | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "FATAL: $DbService did not accept connections; aborting before any change." -ForegroundColor Red; exit 1 }
  }
}

# 3. Stop the API service (defensive; the installer stops it before copying files).
if ($DryRun) { Write-Host "[dry-run] sc stop $ApiService" -ForegroundColor Yellow }
else { Write-Host "==> Stopping $ApiService" -ForegroundColor Cyan; sc.exe stop $ApiService | Out-Null; Start-Sleep -Seconds 2 }

# 4. Back up the DB BEFORE any schema change. Non-negotiable for an audited system.
$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss')
$backupFile = Join-Path $backupDir "pre-upgrade-v$Version-$stamp.sql"
if ($DryRun) {
  Write-Host "[dry-run] pg_dump $dbName -> $backupFile" -ForegroundColor Yellow
} else {
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Write-Host "==> Backing up $dbName -> $backupFile" -ForegroundColor Cyan
  $env:PGPASSWORD = $dbPass
  & $pgDump -h $dbHost -p $dbPort -U $dbUser -d $dbName -f $backupFile
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $backupFile) -or (Get-Item $backupFile).Length -eq 0) {
    Write-Host "FATAL: pre-upgrade backup failed. NO schema change applied. Aborting." -ForegroundColor Red; exit 1
  }
  Write-Host "    backup OK ($([int]((Get-Item $backupFile).Length/1KB)) KB)" -ForegroundColor DarkGray
}

# 5. Apply schema (forward-only migrate deploy + idempotent seed). Shared with
#    fresh install so the two paths can never drift. Throwaway admin pw (upsert
#    never overwrites the existing superadmin password).
if ($DryRun) {
  Write-Host "[dry-run] apply-schema.ps1 (migrate deploy + seed) against $dbName" -ForegroundColor Yellow
} else {
  $throwaway = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 20 | ForEach-Object { [char]$_ })
  & (Join-Path $PSScriptRoot 'apply-schema.ps1') -NodeExe $nodeExe -ApiDir $apiDir -DatabaseUrl $dbUrl -AdminPassword $throwaway
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FATAL: schema apply failed. The DB may be partially migrated." -ForegroundColor Red
    Write-Host "ROLLBACK: restore $backupFile and reinstall the previous DigiLog version." -ForegroundColor Yellow
    exit 1
  }
}

# 5b. (Re-)register the nightly DB backup task. Idempotent, and NOT only an
#     install-time concern: the installer's [Run] section invokes THIS script
#     directly on upgrade (never install.ps1), so this is the only place a
#     customer upgrading from a build that predates the backup feature can pick
#     it up. Also refreshes the definition if paths/retention changed.
$btArgs = @{ InstallDir = $InstallDir; DataRoot = $DataRoot; RetainDays = $BackupRetainDays }
if ($DryRun) { $btArgs['DryRun'] = $true }
& (Join-Path $PSScriptRoot 'register-backup-task.ps1') @btArgs

# 6. Start the API service + health check.
if ($DryRun) { Write-Host "[dry-run] sc start $ApiService; poll http://localhost:$ApiPort/api/health" -ForegroundColor Yellow; exit 0 }
Write-Host "==> Starting $ApiService" -ForegroundColor Cyan
sc.exe start $ApiService | Out-Null
$ok = $false
foreach ($i in 1..30) {
  try { $r = Invoke-WebRequest "http://localhost:$ApiPort/api/health" -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch {}
  Start-Sleep -Seconds 1
}
if ($ok) {
  Write-Host "`nUpgrade to v$Version complete. API healthy at http://localhost:$ApiPort" -ForegroundColor Green
  Write-Host "Pre-upgrade backup retained: $backupFile" -ForegroundColor Gray
  exit 0
} else {
  Write-Host "`nWARN: API did not report healthy within 30s after upgrade." -ForegroundColor Yellow
  Write-Host "Migrations applied + backup at $backupFile. Check $DataRoot\logs, then restart $ApiService." -ForegroundColor Yellow
  exit 1
}
