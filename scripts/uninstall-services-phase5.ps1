#requires -RunAsAdministrator
<#
.SYNOPSIS
    Stop and remove the DigiLog*-Phase5 NSSM services registered by
    install-services-phase5.ps1.

.DESCRIPTION
    Idempotent - silently skips services that are not installed.
    Does NOT delete the logs/ directory; tail those before re-running install.

    File is intentionally ASCII-only so PS 5.1 tokenises it correctly when
    launched via Start-Process without a UTF-8 BOM.
#>

[CmdletBinding()]
param(
    [string]$NssmPath = $null
)

$ErrorActionPreference = 'Continue'  # uninstall keeps going on partial failures

if (-not $NssmPath) {
    $pinFile = Join-Path (Resolve-Path "$PSScriptRoot\..").Path "nssm-path.txt"
    if (Test-Path $pinFile) { $NssmPath = (Get-Content $pinFile -Raw).Trim() }
}
if (-not $NssmPath -or -not (Test-Path $NssmPath)) {
    $NssmPath = (Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\NSSM.NSSM_*\nssm-*\win64\nssm.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
if (-not $NssmPath -or -not (Test-Path $NssmPath)) {
    throw "NSSM not found."
}

$services = @('DigiLogAPI-Phase5', 'DigiLogWeb-Phase5')
foreach ($name in $services) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Host "[uninstall] $name not installed - skipping" -ForegroundColor DarkGray
        continue
    }
    if ($svc.Status -eq 'Running') {
        Write-Host "[uninstall] Stopping $name" -ForegroundColor Yellow
        & $NssmPath stop $name confirm 2>&1 | Out-Null
    }
    Write-Host "[uninstall] Removing $name" -ForegroundColor Yellow
    & $NssmPath remove $name confirm 2>&1 | Out-Null
}

Write-Host "[uninstall] DONE" -ForegroundColor Green
