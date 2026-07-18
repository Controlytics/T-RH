<#
.SYNOPSIS
  DigiLog pre-uninstall orchestrator. Run elevated by the Inno Setup uninstaller
  BEFORE program files are removed. Stops + removes the Windows services.
  See tasks/EXE-PACKAGING-PLAN.md section 8.

.DESCRIPTION
  CRITICAL: never deletes C:\ProgramData\DigiLog by default. The customer's
  database + uploads + audit records (21 CFR Part 11) live there and must
  survive an uninstall unless the operator explicitly opts in (-PurgeData).
#>
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\Program Files\DigiLog',
  [string]$DataRoot   = 'C:\ProgramData\DigiLog',
  [switch]$PurgeData,
  [switch]$DryRun
)

$pgBin      = Join-Path $InstallDir 'pgsql\bin'
$serviceDir = Join-Path $InstallDir 'service'
$scriptsDir = $PSScriptRoot  # unregister-services.ps1 is co-located

# Hashtable splatting binds by name (array splatting would bind positionally).
$unregArgs = @{ PgBin = $pgBin; ServiceDir = $serviceDir }
if ($DryRun) { $unregArgs['DryRun'] = $true }
& (Join-Path $scriptsDir 'unregister-services.ps1') @unregArgs

# Nightly backup task cleanup (best-effort). Must go: it points at
# {app}\scripts\backup-db.ps1, which the uninstaller is about to delete - a left
# -behind task would fail every night into a status file nobody reads.
# The DUMPS THEMSELVES are data and stay under $DataRoot\backups (see -PurgeData).
if ($DryRun) { Write-Host "[dry-run] unregister scheduled task 'DigiLog Nightly Backup'" -ForegroundColor Yellow }
else {
  Unregister-ScheduledTask -TaskName 'DigiLog Nightly Backup' -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task 'DigiLog Nightly Backup' (existing dumps kept)." -ForegroundColor Gray
}

# Firewall rule cleanup (best-effort)
if ($DryRun) { Write-Host "[dry-run] netsh advfirewall delete rule 'DigiLog API'" -ForegroundColor Yellow }
else { netsh advfirewall firewall delete rule name="DigiLog API" 2>$null | Out-Null }

if ($PurgeData) {
  if ($DryRun) { Write-Host "[dry-run] DESTROY $DataRoot (database + uploads + audit records)" -ForegroundColor Red }
  else { Write-Host "Purging $DataRoot (operator opted in)" -ForegroundColor Red; Remove-Item -Recurse -Force $DataRoot -ErrorAction SilentlyContinue }
} else {
  Write-Host "Data left intact at $DataRoot (database + uploads + audit records preserved)." -ForegroundColor Green
}
exit 0
