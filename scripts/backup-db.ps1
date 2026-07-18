<#
.SYNOPSIS
  DigiLog nightly database backup. Run unattended by the Windows Task Scheduler
  job "DigiLog Nightly Backup", registered by install.ps1 (see section 5b).
  Safe to run by hand for an on-demand dump or to test the job.

.DESCRIPTION
  21 CFR Part 11 §11.10(c) - protection of records. Without this, disk loss costs
  the customer every record back to the last time an operator manually clicked
  Export in-app. Dumps digilog_db to ProgramData\backups and prunes its own old
  dumps so it cannot fill the disk.

  FAILURE MUST BE VISIBLE. A backup job that errors into the void is worse than
  no backup - it manufactures false confidence at inspection. Three signals, in
  the order an operator/auditor will actually find them:
    1. backups\LAST-BACKUP-STATUS.txt - one file, always rewritten, carries
       timestamp + OK/FAIL + path + size + error. A STALE TIMESTAMP is itself
       the alarm (task disabled/deleted/never fired reads exactly the same as
       never-ran, which is the point).
    2. logs\backup.log - append-only history; shows a pattern of failures.
    3. Non-zero exit -> Task Scheduler "Last Run Result" column goes non-0x0.
  We deliberately do NOT use the Windows Event Log: Write-EventLog throws unless
  the source was registered elevated beforehand, so the visibility mechanism
  itself could fail silently. The status file has no such dependency.

  CREDENTIALS: never on a command line. The scheduled task stores no password
  (/ru SYSTEM). The DB password is parsed out of the operator's own digilog.env
  at RUN time and passed to pg_dump via the PGPASSWORD env var of this process -
  same approach as upgrade.ps1. Nothing readable via `schtasks /query /xml`.

  RETENTION: prunes ONLY this job's own `nightly-*.sql` files. The backups dir is
  shared with upgrade.ps1's `pre-upgrade-v*.sql` dumps - a blanket age sweep
  would eat the pre-upgrade dumps, which are the ones worth keeping longest.

.PARAMETER RetainDays  Delete nightly-*.sql older than this. Default 14.
.PARAMETER DryRun      Print the plan without dumping or deleting.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\Program Files\DigiLog',
  [string]$DataRoot   = 'C:\ProgramData\DigiLog',
  [int]$RetainDays    = 14,
  [switch]$DryRun
)

$pgBin     = Join-Path $InstallDir 'pgsql\bin'
$pgDump    = Join-Path $pgBin 'pg_dump.exe'
$configDir = Join-Path $DataRoot 'config'
$envFile   = Join-Path $configDir 'digilog.env'
$backupDir = Join-Path $DataRoot 'backups'
$logDir    = Join-Path $DataRoot 'logs'
$logFile   = Join-Path $logDir 'backup.log'
$statusFile = Join-Path $backupDir 'LAST-BACKUP-STATUS.txt'

# Every exit path goes through Finish so the status file is ALWAYS current -
# including the early credential/binary failures, which are exactly the ones a
# silent job would hide.
function Finish([bool]$ok, [string]$detail, [string]$file, [long]$bytes) {
  $now = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
  $verdict = 'FAIL'
  if ($ok) { $verdict = 'OK' }
  $body = @"
DigiLog database backup
  Result    : $verdict
  Timestamp : $now
  File      : $file
  Size      : $([int]($bytes/1KB)) KB
  Detail    : $detail

If Result is FAIL, or Timestamp is not from last night, the nightly backup is
NOT protecting your records. Check Task Scheduler -> "DigiLog Nightly Backup"
and $logFile, then run this script by hand to see the error.
"@
  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $backupDir, $logDir | Out-Null
    Set-Content -Path $statusFile -Value $body -Encoding ascii
    Add-Content -Path $logFile -Value "$now  $verdict  $file  $([int]($bytes/1KB))KB  $detail" -Encoding ascii
  }
  if ($ok) {
    Write-Host "Backup OK -> $file ($([int]($bytes/1KB)) KB)" -ForegroundColor Green
    exit 0
  }
  Write-Host "BACKUP FAILED: $detail" -ForegroundColor Red
  exit 1
}

Write-Host "DigiLog nightly backup" -ForegroundColor Cyan
if ($DryRun) { Write-Host "  (DRY RUN - no changes)" -ForegroundColor Yellow }

if (-not (Test-Path $pgDump))  { Finish $false "pg_dump.exe not found at $pgDump" '(none)' 0 }
if (-not (Test-Path $envFile)) { Finish $false "no $envFile - is DigiLog installed?" '(none)' 0 }

# Parse DATABASE_URL exactly as upgrade.ps1 does: Prisma keeps ?schema=public,
# which libpq (pg_dump) will not accept, so split the components out.
$dbUrl = ((Get-Content $envFile | Where-Object { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL=','').Trim()
if (-not $dbUrl) { Finish $false "DATABASE_URL not found in $envFile" '(none)' 0 }
if ($dbUrl -notmatch 'postgres(?:ql)?://([^:]+):([^@]+)@([^:/]+):(\d+)/([^?]+)') {
  Finish $false "could not parse DATABASE_URL from $envFile" '(none)' 0
}
$dbUser = $Matches[1]; $dbPass = $Matches[2]; $dbHost = $Matches[3]; $dbPort = $Matches[4]; $dbName = $Matches[5]

$stamp      = (Get-Date -Format 'yyyyMMdd-HHmmss')
$backupFile = Join-Path $backupDir "nightly-$dbName-$stamp.sql"

if ($DryRun) {
  Write-Host "[dry-run] pg_dump $dbName -> $backupFile" -ForegroundColor Yellow
  Write-Host "[dry-run] prune nightly-*.sql older than $RetainDays days in $backupDir" -ForegroundColor Yellow
  exit 0
}

New-Item -ItemType Directory -Force -Path $backupDir, $logDir | Out-Null
Write-Host "==> Dumping $dbName -> $backupFile" -ForegroundColor Cyan
$env:PGPASSWORD = $dbPass
& $pgDump -h $dbHost -p $dbPort -U $dbUser -d $dbName -f $backupFile
$dumpCode = $LASTEXITCODE
$env:PGPASSWORD = $null

# A partial/empty dump is more dangerous than none - it looks like a backup in a
# directory listing. Bin it so nothing can mistake it for a restorable file.
if ($dumpCode -ne 0 -or -not (Test-Path $backupFile) -or (Get-Item $backupFile).Length -eq 0) {
  if (Test-Path $backupFile) { Remove-Item -Force $backupFile -ErrorAction SilentlyContinue }
  Finish $false "pg_dump exited $dumpCode (partial file discarded)" '(none)' 0
}
$size = (Get-Item $backupFile).Length

# Prune AFTER a verified-good dump only - never drop yesterday's good backup on a
# night when today's failed. Scoped to `nightly-*` so upgrade.ps1's
# `pre-upgrade-v*.sql` dumps are never touched.
$cutoff = (Get-Date).AddDays(-$RetainDays)
$stale = Get-ChildItem -Path $backupDir -Filter 'nightly-*.sql' -File -ErrorAction SilentlyContinue |
         Where-Object { $_.LastWriteTime -lt $cutoff }
foreach ($f in $stale) {
  Remove-Item -Force $f.FullName -ErrorAction SilentlyContinue
  Write-Host "    pruned $($f.Name)" -ForegroundColor DarkGray
}

$pruned = 0
if ($stale) { $pruned = @($stale).Count }
Finish $true "pg_dump OK; pruned $pruned nightly dump(s) older than $RetainDays days" $backupFile $size
