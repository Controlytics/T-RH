<#
.SYNOPSIS
  Stop and remove the DigiLog Windows services. Run by the uninstaller (elevated).
  Does NOT touch the data directory - the uninstaller decides that separately so
  customer audit records are never destroyed by accident.
  See tasks/EXE-PACKAGING-PLAN.md section 8 (M4/M6).

.PARAMETER PgBin       Bundled Postgres bin dir (for pg_ctl unregister)
.PARAMETER ServiceDir  Where DigiLogAPI.exe (WinSW) lives
.PARAMETER DryRun      Print commands instead of running them
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$PgBin,
  [Parameter(Mandatory)] [string]$ServiceDir,
  [string]$DbService  = 'DigiLogDB',
  [string]$ApiService = 'DigiLogAPI',
  [switch]$DryRun
)

$pgctl  = Join-Path $PgBin 'pg_ctl.exe'
$apiExe = Join-Path $ServiceDir "$ApiService.exe"

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

# Stop both first (ignore failures - they may already be stopped).
Do-Cmd "stop $ApiService" 'sc.exe' @('stop', $ApiService) -IgnoreFail
Do-Cmd "stop $DbService"  'sc.exe' @('stop', $DbService)  -IgnoreFail

# Remove the API service via WinSW, then the DB service via pg_ctl.
if (Test-Path $apiExe) {
  Do-Cmd "uninstall $ApiService (WinSW)" $apiExe @('uninstall') -IgnoreFail
} else {
  Do-Cmd "delete $ApiService (sc fallback)" 'sc.exe' @('delete', $ApiService) -IgnoreFail
}
Do-Cmd "unregister $DbService (PostgreSQL)" $pgctl @('unregister','-N',$DbService) -IgnoreFail

Write-Host "`nServices removed. Data directory left intact (uninstaller handles it)." -ForegroundColor Green
exit 0
