<#
.SYNOPSIS
  Registers the "DigiLog Nightly Backup" Windows Task Scheduler job, which runs
  backup-db.ps1 every night. Called by install.ps1 (fresh) AND upgrade.ps1
  (refresh) - see .DESCRIPTION for why both.

.DESCRIPTION
  21 CFR Part 11 §11.10(c). Idempotent (-Force replaces any existing definition),
  so it is safe to call on every install and every upgrade.

  BOTH callers, deliberately: the Inno Setup [Run] section invokes upgrade.ps1
  DIRECTLY on the upgrade path (it never routes through install.ps1), so
  registering only from install.ps1 would leave every customer upgrading from a
  build that predates this feature with no backup job - while §4 of
  PHARMA_DEPLOYMENT_21CFR.md still tells their QA that the installer configured
  one. Registering from upgrade.ps1 too closes that.

  Register-ScheduledTask, not schtasks.exe: schtasks takes the whole command as
  ONE /TR string, so the space in "C:\Program Files\DigiLog" must survive two
  rounds of quote-escaping (PowerShell's native-arg handling, then schtasks' own
  parse). These cmdlets pass Execute + Argument as separate .NET strings - no
  shell parse, nothing to mis-escape. Same Task Scheduler either way.

  Runs as SYSTEM: a service account with NO stored password, so the task
  definition holds nothing sensitive (schtasks /query /xml exposes nothing). The
  DB password is never passed here - backup-db.ps1 reads it from digilog.env at
  run time.

  NON-FATAL by design: a backup job that fails to register must not block an
  install/upgrade, but it MUST be loud - see the WARN block.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\Program Files\DigiLog',
  [string]$DataRoot   = 'C:\ProgramData\DigiLog',
  [int]$RetainDays    = 14,
  [string]$AtTime     = '01:30',
  [switch]$DryRun
)

$backupScript = Join-Path $InstallDir 'scripts\backup-db.ps1'
$taskName     = 'DigiLog Nightly Backup'
$taskArgs     = "-NoProfile -ExecutionPolicy Bypass -File `"$backupScript`" " +
                "-InstallDir `"$InstallDir`" -DataRoot `"$DataRoot`" -RetainDays $RetainDays"

if ($DryRun) {
  Write-Host "[dry-run] register task '$taskName' (daily $AtTime, SYSTEM, retain $RetainDays days)" -ForegroundColor Yellow
  Write-Host "[dry-run]   powershell.exe $taskArgs" -ForegroundColor Yellow
  exit 0
}

$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
$trigger   = New-ScheduledTaskTrigger -Daily -At $AtTime
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
# StartWhenAvailable: a machine that was off at $AtTime still backs up on next
# boot instead of silently skipping the night.
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force -ErrorAction SilentlyContinue | Out-Null

# Verify by READ-BACK, not by the cmdlet's own return - registration is the whole
# point of this script, so "assume it worked" is exactly the false confidence the
# backup job is meant to eliminate.
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Write-Host "==> Registered '$taskName' (daily $AtTime -> $DataRoot\backups, keep $RetainDays days)" -ForegroundColor Cyan
  exit 0
}
Write-Host "WARN: could not register '$taskName'. DigiLog will run, but there are NO" -ForegroundColor Yellow
Write-Host "      automatic DB backups - do not sign off IQ until this is fixed." -ForegroundColor Yellow
Write-Host "      Register manually (elevated):" -ForegroundColor Yellow
Write-Host "      powershell.exe $taskArgs" -ForegroundColor Yellow
exit 0
