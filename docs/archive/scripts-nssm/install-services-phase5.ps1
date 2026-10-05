#requires -RunAsAdministrator
<#
.SYNOPSIS
    Register DigiLogAPI-Phase5 and DigiLogWeb-Phase5 as NSSM-managed Windows
    services.

.DESCRIPTION
    Closes the only Phase 5+ open item in PHASE_5_RECENT_WORK.md section 12:
    a managed Windows-service launcher that registers the API as a Windows
    service with restart policies, log rotation, and boot persistence.

    Uses NSSM (https://nssm.cc) - the same stopgap documented in
    DEPLOY-WINDOWS.md section 7.

    Registers two services scoped to THIS worktree (note the -Phase5 suffix
    so they do not collide with services the main repo install might create):

      - DigiLogAPI-Phase5 -> node apps/api/dist/app.js
                             (cwd apps/api/, https://localhost:3000)
      - DigiLogWeb-Phase5 -> node apps/web/node_modules/vite/bin/vite.js
                             preview --port 5175 --host
                             (cwd apps/web/, https://localhost:5175)

    Both services:
      - AppExit Default = Restart  (auto-restart on crash)
      - Start = SERVICE_AUTO_START (boot persistence)
      - AppStdout / AppStderr -> logs/<service>.log (online tails work)
      - AppRotateFiles=1, AppRotateBytes=10MB (log rotation)
      - AppEnvironmentExtra = NODE_ENV=production
      - DependOnService = postgresql-x64-18 (API only, will not start
        before PG)

.NOTES
    Idempotent - if a service already exists it is stopped and removed first.
    NSSM path read from ./nssm-path.txt (written by the deploy session).

    File is intentionally ASCII-only so PS 5.1 tokenises it correctly when
    launched via Start-Process without a UTF-8 BOM.
#>

[CmdletBinding()]
param(
    [string]$Worktree = (Resolve-Path "$PSScriptRoot\..").Path,
    [string]$NssmPath = $null
)

$ErrorActionPreference = 'Stop'

# 1. Resolve NSSM
if (-not $NssmPath) {
    $pinFile = Join-Path $Worktree "nssm-path.txt"
    if (Test-Path $pinFile) {
        $NssmPath = (Get-Content $pinFile -Raw).Trim()
    }
}
if (-not $NssmPath -or -not (Test-Path $NssmPath)) {
    $NssmPath = (Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\NSSM.NSSM_*\nssm-*\win64\nssm.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
}
if (-not $NssmPath -or -not (Test-Path $NssmPath)) {
    throw "NSSM not found. Install via: winget install NSSM.NSSM"
}
Write-Host "[install] NSSM: $NssmPath" -ForegroundColor Cyan

# 2. Resolve paths
$nodeExe   = (Get-Command node -ErrorAction Stop).Source
$apiCwd    = Join-Path $Worktree "apps\api"
$apiEntry  = Join-Path $apiCwd   "dist\app.js"
$webCwd    = Join-Path $Worktree "apps\web"
$viteCli   = Join-Path $webCwd   "node_modules\vite\bin\vite.js"
$logsDir   = Join-Path $Worktree "logs"

foreach ($path in @($apiEntry, $viteCli)) {
    if (-not (Test-Path $path)) {
        throw "Required artifact missing: $path. Run npm run build first."
    }
}
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }

Write-Host "[install] Worktree: $Worktree" -ForegroundColor Cyan
Write-Host "[install] node:     $nodeExe"  -ForegroundColor Cyan
Write-Host "[install] logs:     $logsDir"  -ForegroundColor Cyan

# 3. Service definitions
$services = @(
    @{
        Name        = 'DigiLogAPI-Phase5'
        DisplayName = 'DigiLog API (worktree phase5-verification)'
        Description = 'Fastify API on https://localhost:3000. Worktree-scoped service for the Phase 5 verification branch; remove with: nssm remove DigiLogAPI-Phase5 confirm'
        Exe         = $nodeExe
        Args        = "`"$apiEntry`""
        Cwd         = $apiCwd
        DependOn    = 'postgresql-x64-18'
        StdoutLog   = Join-Path $logsDir 'DigiLogAPI-Phase5.out.log'
        StderrLog   = Join-Path $logsDir 'DigiLogAPI-Phase5.err.log'
    },
    @{
        Name        = 'DigiLogWeb-Phase5'
        DisplayName = 'DigiLog Web (worktree phase5-verification)'
        Description = 'Vite preview serving compiled apps/web/dist on https://localhost:5175. Worktree-scoped service; remove with: nssm remove DigiLogWeb-Phase5 confirm'
        Exe         = $nodeExe
        Args        = "`"$viteCli`" preview --port 5175 --host"
        Cwd         = $webCwd
        DependOn    = $null
        StdoutLog   = Join-Path $logsDir 'DigiLogWeb-Phase5.out.log'
        StderrLog   = Join-Path $logsDir 'DigiLogWeb-Phase5.err.log'
    }
)

# 4. Idempotent install
foreach ($svc in $services) {
    $name = $svc.Name

    # Stop and remove if it already exists (idempotent re-run)
    $existing = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "[install] Service $name exists - stopping and removing first" -ForegroundColor Yellow
        if ($existing.Status -eq 'Running') {
            & $NssmPath stop $name confirm 2>&1 | Out-Null
        }
        & $NssmPath remove $name confirm 2>&1 | Out-Null
        Start-Sleep -Seconds 1
    }

    Write-Host "[install] Installing $name" -ForegroundColor Green
    & $NssmPath install $name $svc.Exe $svc.Args
    & $NssmPath set     $name AppDirectory          $svc.Cwd
    & $NssmPath set     $name DisplayName           $svc.DisplayName
    & $NssmPath set     $name Description           $svc.Description
    & $NssmPath set     $name Start                 SERVICE_AUTO_START
    & $NssmPath set     $name AppExit Default       Restart
    & $NssmPath set     $name AppRestartDelay       3000
    & $NssmPath set     $name AppStdout             $svc.StdoutLog
    & $NssmPath set     $name AppStderr             $svc.StderrLog
    & $NssmPath set     $name AppRotateFiles        1
    & $NssmPath set     $name AppRotateOnline       1
    & $NssmPath set     $name AppRotateBytes        10485760
    & $NssmPath set     $name AppStdoutCreationDisposition 4
    & $NssmPath set     $name AppStderrCreationDisposition 4
    & $NssmPath set     $name AppEnvironmentExtra   "NODE_ENV=production"
    if ($svc.DependOn) {
        & $NssmPath set $name DependOnService       $svc.DependOn
    }
}

Write-Host ""
Write-Host "[install] DONE. Services registered:" -ForegroundColor Green
foreach ($svc in $services) {
    Write-Host ("  - {0}" -f $svc.Name) -ForegroundColor Green
}
Write-Host ""
Write-Host "Start them with:" -ForegroundColor Cyan
Write-Host "  Start-Service DigiLogAPI-Phase5,DigiLogWeb-Phase5"
Write-Host "Inspect with:" -ForegroundColor Cyan
Write-Host "  Get-Service Digi*-Phase5"
Write-Host ("  Get-Content {0}\DigiLogAPI-Phase5.out.log -Tail 50" -f $logsDir)
Write-Host "Remove cleanly with scripts\uninstall-services-phase5.ps1" -ForegroundColor Cyan
