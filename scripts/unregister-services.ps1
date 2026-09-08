<#
.SYNOPSIS
  Stop and remove the DigiLog Windows services. Run by the uninstaller (elevated).
  Does NOT touch the data directory - the uninstaller decides that separately so
  customer audit records are never destroyed by accident.
  See tasks/EXE-PACKAGING-PLAN.md section 8 (M4/M6).

.PARAMETER PgBin       Bundled Postgres bin dir (for pg_ctl unregister)
.PARAMETER ServiceDir  Where DigiLogAPI.exe (WinSW) lives
.PARAMETER EmqxRoot    Bundled EMQX folder (for emqx.cmd uninstall); skipped if absent
.PARAMETER DryRun      Print commands instead of running them
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$PgBin,
  [Parameter(Mandatory)] [string]$ServiceDir,
  [string]$EmqxRoot,
  [string]$DbService  = 'DigiLogDB',
  [string]$ApiService = 'DigiLogAPI',
  [string]$MqttService = 'emqx',
  [switch]$DryRun
)

$pgctl   = Join-Path $PgBin 'pg_ctl.exe'
$apiExe  = Join-Path $ServiceDir "$ApiService.exe"
$emqxCmd = if ($EmqxRoot) { Join-Path $EmqxRoot 'bin\emqx.cmd' } else { $null }

function Do-Cmd($desc, $exe, [string[]]$argList, [switch]$IgnoreFail) {
  if ($DryRun) {
    Write-Host "[dry-run] $desc" -ForegroundColor Yellow
    Write-Host "          $exe $($argList -join ' ')" -ForegroundColor DarkGray
    return
  }
  Write-Host "==> $desc" -ForegroundColor Cyan
  & $exe @argList
  if ($LASTEXITCODE -ne 0 -and -not $IgnoreFail) { Write-Host "WARN: $desc (exit $LASTEXITCODE)" -ForegroundColor Yellow }
}

# Stop all first (ignore failures - they may already be stopped).
Do-Cmd "stop $ApiService" 'sc.exe' @('stop', $ApiService) -IgnoreFail
Do-Cmd "stop $DbService"  'sc.exe' @('stop', $DbService)  -IgnoreFail
if ($emqxCmd -and (Test-Path $emqxCmd)) {
  Do-Cmd "stop $MqttService" 'sc.exe' @('stop', $MqttService) -IgnoreFail
  Do-Cmd "uninstall $MqttService (emqx.cmd uninstall -> erlsrv remove)" $emqxCmd @('uninstall') -IgnoreFail
}

# Remove the API service via WinSW, then the DB service via pg_ctl.
if (Test-Path $apiExe) {
  Do-Cmd "uninstall $ApiService (WinSW)" $apiExe @('uninstall') -IgnoreFail
} else {
  Do-Cmd "delete $ApiService (sc fallback)" 'sc.exe' @('delete', $ApiService) -IgnoreFail
}
Do-Cmd "unregister $DbService (PostgreSQL)" $pgctl @('unregister','-N',$DbService) -IgnoreFail

Write-Host "`nServices removed. Data directory left intact (uninstaller handles it)." -ForegroundColor Green
exit 0
