<#
.SYNOPSIS
    One-command deploy for the AWS instance. Pull, build, restart, verify.

.DESCRIPTION
    Runs ON the server (C:\app\compliance-core). Intended to be invoked from a
    laptop via SSM:

        aws ssm send-command --instance-ids i-0be63a2077d4a82e0 \
          --document-name AWS-RunPowerShellScript \
          --parameters commands=["& C:\app\compliance-core\scripts\deploy-on-instance.ps1"]

    Why this exists: the manual sequence is pull -> npm ci -> build shared ->
    build queue -> build web -> tsc api -> restart. Forgetting the build step is
    silent: `git pull` updates SOURCE, but the service runs COMPILED output
    (apps/api/dist, apps/web/dist), so the app keeps serving the old code with
    no error to explain why. This script makes that impossible to get wrong.

    Safe to re-run. Every step reports, and any failure stops the deploy BEFORE
    the service is restarted — so a broken build leaves the previous working
    version running rather than taking the app down.

.PARAMETER Branch      Branch to deploy. Default: final-user-management.
.PARAMETER SkipInstall Skip npm ci even if the lockfile changed.
.PARAMETER Force       Deploy even when already up to date.
#>
[CmdletBinding()]
param(
    [string]$Branch = 'final-user-management',
    [switch]$SkipInstall,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$AppDir  = 'C:\app\compliance-core'
$Service = 'DigiLogAPI'
$env:Path = "C:\Program Files\nodejs;C:\Program Files\Git\cmd;$env:Path"
$env:GIT_SSH_COMMAND = 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -i C:/Windows/System32/config/systemprofile/.ssh/id_ed25519'

$step = 0
function Step($m) { $script:step++; Write-Host "" ; Write-Host ("[{0}] {1}" -f $script:step, $m) -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    OK   $m" -ForegroundColor Green }
function Info($m) { Write-Host "    ..   $m" -ForegroundColor Gray }
function Die($m) {
    Write-Host ""
    Write-Host "  DEPLOY FAILED: $m" -ForegroundColor Red
    Write-Host "  The service was NOT restarted - the previous version is still running." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "  =============================================" -ForegroundColor White
Write-Host "   compliance-core deploy   branch: $Branch" -ForegroundColor White
Write-Host "  =============================================" -ForegroundColor White

Set-Location $AppDir

# ---------------------------------------------------------------- 1. pull
Step "Fetching $Branch"
$before = (& git rev-parse HEAD).Trim()
& git fetch --depth 1 origin $Branch 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Die "git fetch failed. Is the deploy key still valid?" }
& git reset --hard "origin/$Branch" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Die "git reset failed." }
$after = (& git rev-parse HEAD).Trim()

if ($before -eq $after -and -not $Force) {
    Ok "Already up to date at $($after.Substring(0,7)) - nothing to deploy."
    Write-Host ""
    Write-Host "  Use -Force to rebuild anyway." -ForegroundColor Gray
    Write-Host ""
    exit 0
}
Ok "$($before.Substring(0,7)) -> $($after.Substring(0,7))"
Info (& git log -1 --format='%s')

# ---------------------------------------------------------------- 2. deps
Step "Dependencies"
# Only reinstall when the lockfile actually moved - npm ci on this box takes
# ~2.5 min and is pure waste when nothing changed.
$lockChanged = $Force -or ((& git diff --name-only $before $after) -match 'package-lock\.json')
if ($SkipInstall) {
    Info "skipped (-SkipInstall)"
} elseif ($lockChanged) {
    Info "package-lock.json changed - running npm ci (a few minutes)..."
    & npm ci --no-audit --no-fund 2>&1 | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) { Die "npm ci failed." }
    # npm >= 11 blocks lifecycle scripts, so Prisma's postinstall never runs.
    Info "regenerating Prisma client (npm blocks the postinstall)"
    Push-Location "$AppDir\apps\api"
    & npx prisma generate 2>&1 | Out-Null
    $g = $LASTEXITCODE; Pop-Location
    if ($g -ne 0) { Die "prisma generate failed." }
    Ok "dependencies + prisma client"
} else {
    Ok "lockfile unchanged - skipping npm ci"
}

# ---------------------------------------------------------------- 3. migrations
Step "Database migrations"
Push-Location "$AppDir\apps\api"
$env:DOTENV_CONFIG_PATH = 'C:\ProgramData\DigiLog\config\digilog.env'
Get-Content 'C:\ProgramData\DigiLog\config\digilog.env' | ForEach-Object {
    $i = $_.IndexOf('='); if ($i -gt 0) { [Environment]::SetEnvironmentVariable($_.Substring(0,$i), $_.Substring($i+1), 'Process') }
}
& npx prisma migrate deploy 2>&1 | Select-Object -Last 3
$m = $LASTEXITCODE; Pop-Location
if ($m -ne 0) { Die "prisma migrate deploy failed. Schema NOT changed, service NOT restarted." }
Ok "schema up to date"

# ---------------------------------------------------------------- 4. build
Step "Building"
& npm run build -w '@digilog/shared' 2>&1 | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) { Die "@digilog/shared build failed." }
Ok "shared"

& npm run build -w '@digilog/queue' 2>&1 | Select-Object -Last 1
if ($LASTEXITCODE -ne 0) { Die "@digilog/queue build failed." }
Ok "queue"

Push-Location "$AppDir\apps\web"
& npx vite build 2>&1 | Select-Object -Last 2
$w = $LASTEXITCODE; Pop-Location
if ($w -ne 0) { Die "web build failed." }
if (-not (Test-Path "$AppDir\apps\web\dist\index.html")) { Die "web build produced no dist/index.html." }
Ok "web SPA"

& npx tsc -p apps/api/tsconfig.json 2>&1 | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { Die "API TypeScript compile failed." }
if (-not (Test-Path "$AppDir\apps\api\dist\app.js")) { Die "API build produced no dist/app.js." }
Ok "API"

# ---------------------------------------------------------------- 5. restart
Step "Restarting $Service"
Restart-Service $Service -Force
Start-Sleep -Seconds 20
$svc = Get-Service $Service
if ($svc.Status -ne 'Running') { Die "$Service is $($svc.Status) after restart. Check C:\ProgramData\DigiLog\logs\." }
Ok "$Service running"

# ---------------------------------------------------------------- 6. verify
Step "Verifying"
$listening = $false
foreach ($i in 1..30) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $a = $c.BeginConnect('127.0.0.1', 443, $null, $null)
        if ($a.AsyncWaitHandle.WaitOne(1000, $false) -and $c.Connected) { $c.EndConnect($a); $listening = $true; break }
    } catch { } finally { $c.Close() }
    Start-Sleep -Seconds 1
}
if (-not $listening) { Die "nothing listening on 443 after restart. Check C:\ProgramData\DigiLog\logs\." }
Ok "listening on 443"

Write-Host ""
Write-Host "  =============================================" -ForegroundColor Green
Write-Host "   DEPLOYED   $($after.Substring(0,7))" -ForegroundColor Green
Write-Host "  =============================================" -ForegroundColor Green
Write-Host "   https://13.204.15.17" -ForegroundColor White
Write-Host ""
Write-Host "   Verify the audit chain after any schema change:" -ForegroundColor Gray
Write-Host "     log in, then GET /api/audit/verify-chain -> intact:true" -ForegroundColor Gray
Write-Host ""
