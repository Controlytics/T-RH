<#
.SYNOPSIS
  Build pipeline that produces DigiLog-Setup-<ver>.exe. Run on a BUILD MACHINE
  (needs Inno Setup 6 + internet for the bundled binaries).
  See tasks/EXE-PACKAGING-PLAN.md section 4 + M5.

.DESCRIPTION
  Stages everything the installer ships into <OutDir>\stage, then compiles the
  Inno Setup script. Steps:
    1. build the app bundle (scripts/build-bundle.ps1)
    2. clean-room production deps (npm ci --omit=dev in an isolated checkout)
    3. stage runtime/ (scripts/stage-runtime.ps1)
    4. stage pgsql/  (portable PostgreSQL binaries)
    5. stage service/ (WinSW-x64.exe)
    6. stage scripts/ (provision/register/install/uninstall)
    7. ISCC -> Setup.exe

  Prerequisites (the build machine provides these; not committed to the repo):
    -NodeZip   path to node-vXX-win-x64.zip      (ABI must match the native build)
    -PgZip     path to postgresql-18-...-windows-x64-binaries.zip
    -WinswExe  path to WinSW-x64.exe              (github.com/winsw/winsw releases)
    -Iscc      path to ISCC.exe                   (Inno Setup 6)

  This script is authored + structured here; a full run requires those external
  binaries + Inno Setup and is performed on the build machine.

.PARAMETER AppVersion  Version stamped into the installer + filename
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$NodeZip,
  [Parameter(Mandatory)] [string]$PgZip,
  [Parameter(Mandatory)] [string]$WinswExe,
  [string]$Iscc = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
  [string]$AppVersion = '0.1.0',
  [string]$OutDir,
  # --- Code signing (M7). Optional: omit -Sign to build an UNSIGNED installer
  #     (SmartScreen/AV will warn on customer machines - see the acceptance
  #     runbook). Supply EITHER a PFX file (-CertPath [+ -CertPassword]) OR a
  #     cert already in the Windows store (-CertSubject "CN=..."). -TimestampUrl
  #     is an RFC3161 server so signatures stay valid after the cert expires. ---
  [switch]$Sign,
  [string]$CertPath,
  [string]$CertPassword,
  [string]$CertSubject,
  [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'dist' }
$stage    = Join-Path $OutDir 'stage'
$cleanDir = Join-Path $OutDir 'cleanroom'

function Step($name, $block) {
  Write-Host "==> $name" -ForegroundColor Cyan
  & $block
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $name (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
}

# Locate signtool.exe from the newest installed Windows SDK (not bundled - it
# ships with the Windows 10/11 SDK on the build machine).
function Find-SignTool {
  $roots = @("${env:ProgramFiles(x86)}\Windows Kits\10\bin", "$env:ProgramFiles\Windows Kits\10\bin")
  foreach ($r in $roots) {
    if (Test-Path $r) {
      $st = Get-ChildItem $r -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } |
            Sort-Object FullName -Descending | Select-Object -First 1
      if ($st) { return $st.FullName }
    }
  }
  return $null
}

# Authenticode-sign one file with SHA-256 + RFC3161 timestamp. Fails hard if
# signing was requested but cannot proceed (a silently-unsigned "signed" build
# is worse than an openly unsigned one).
function Sign-File($signtool, $file) {
  $common = @('sign', '/fd', 'sha256', '/tr', $TimestampUrl, '/td', 'sha256')
  if ($CertPath)         { $common += @('/f', $CertPath); if ($CertPassword) { $common += @('/p', $CertPassword) } }
  elseif ($CertSubject)  { $common += @('/n', $CertSubject) }
  else { Write-Host "FAILED: -Sign requires -CertPath (PFX) or -CertSubject (store cert)." -ForegroundColor Red; exit 1 }
  & $signtool @common $file
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: signtool on $file (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
  Write-Host "    signed: $(Split-Path $file -Leaf)" -ForegroundColor DarkGray
}

# Fresh staging
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage, $cleanDir | Out-Null

# 1. Build the app (shared/queue/api/web)
Step "Build app bundle" { & (Join-Path $PSScriptRoot 'build-bundle.ps1') }

# 2. Clean-room production deps. We do `npm ci --omit=dev` in an isolated tree so
#    the live repo node_modules (with dev deps) is never disturbed. git archive
#    gives a pristine checkout; then we build the workspace packages there too.
Step "Clean-room npm ci --omit=dev" {
  Push-Location $repoRoot
  try {
    if (Test-Path (Join-Path $cleanDir '.git-archive')) { Remove-Item -Recurse -Force (Join-Path $cleanDir '.git-archive') }
    git archive --format=tar HEAD | tar -x -C $cleanDir
    Push-Location $cleanDir
    npm ci --omit=dev
    # Generate the Prisma CLIENT (.prisma/client/index.js). `npm ci --omit=dev`
    # does NOT reliably run @prisma/client's generate postinstall in a monorepo
    # clean-room (it can't find apps/api/prisma/schema.prisma on its own), and
    # without the generated client `node prisma/seed.mjs` throws "@prisma/client
    # did not initialize yet" on the customer box. `prisma` is a prod dep now, so
    # it is present here. This is separate from the query-engine .node (staged by
    # stage-runtime) and from the schema engine (used only by migrate deploy).
    if ($LASTEXITCODE -eq 0) { node node_modules/prisma/build/index.js generate --schema apps/api/prisma/schema.prisma }
    Pop-Location
  } finally { Pop-Location }
}

# 3. Extract portable node.exe
$nodeTmp = Join-Path $OutDir 'node-extract'
if (Test-Path $nodeTmp) { Remove-Item -Recurse -Force $nodeTmp }
Expand-Archive -Path $NodeZip -DestinationPath $nodeTmp -Force
$nodeExe = (Get-ChildItem $nodeTmp -Recurse -Filter 'node.exe' | Select-Object -First 1).FullName

# 4. Stage runtime/ (uses the clean-room production node_modules)
Step "Stage runtime" {
  & (Join-Path $PSScriptRoot 'stage-runtime.ps1') `
    -NodeExe $nodeExe -NodeModulesSrc (Join-Path $cleanDir 'node_modules') `
    -RepoRoot $repoRoot -OutDir (Join-Path $stage 'runtime')
}

# 5. Stage pgsql/ (portable PostgreSQL binaries)
Write-Host "==> Stage pgsql" -ForegroundColor Cyan
$pgTmp = Join-Path $OutDir 'pg-extract'
if (Test-Path $pgTmp) { Remove-Item -Recurse -Force $pgTmp }
Expand-Archive -Path $PgZip -DestinationPath $pgTmp -Force
# EDB zip extracts to a 'pgsql' subfolder
$pgRoot = (Get-ChildItem $pgTmp -Recurse -Directory -Filter 'bin' | Where-Object { Test-Path (Join-Path $_.FullName 'initdb.exe') } | Select-Object -First 1).Parent.FullName
Copy-Item $pgRoot (Join-Path $stage 'pgsql') -Recurse -Force

# 6. Stage service/ + scripts/
Write-Host "==> Stage service + scripts" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'service'), (Join-Path $stage 'scripts') | Out-Null
Copy-Item $WinswExe (Join-Path $stage 'service\WinSW-x64.exe') -Force
# apply-schema.ps1 is shared by provision-db (fresh) + upgrade; upgrade.ps1 drives
# the upgrade [Run] entry. BOTH must ship or fresh install AND upgrade break.
# NAMED LIST, not a glob - anything omitted here silently does not ship, and the
# orchestrators call siblings with `& (Join-Path ...)`, which THROWS on a missing
# file rather than degrading. register-backup-task.ps1 + backup-db.ps1 are the
# nightly-backup pair (21 CFR §11.10(c)); both install.ps1 and upgrade.ps1 invoke
# the former, which invokes the latter nightly. Add new sibling scripts HERE.
foreach ($s in 'provision-db.ps1','apply-schema.ps1','register-services.ps1','unregister-services.ps1','install.ps1','upgrade.ps1','uninstall.ps1','register-backup-task.ps1','backup-db.ps1') {
  Copy-Item (Join-Path $PSScriptRoot $s) (Join-Path $stage 'scripts') -Force
}
Copy-Item (Join-Path $repoRoot 'apps\api\prisma\sql') (Join-Path $stage 'runtime\api\prisma\sql') -Recurse -Force -ErrorAction SilentlyContinue

# 7. Compile the installer
Write-Host "==> Compile installer (ISCC)" -ForegroundColor Cyan
if (-not (Test-Path $Iscc)) { Write-Host "Inno Setup not found at $Iscc - install Inno Setup 6 to compile. Staging is ready at $stage." -ForegroundColor Yellow; exit 0 }
& $Iscc "/DStageDir=$stage" "/DAppVersion=$AppVersion" (Join-Path $repoRoot 'installer\DigiLog.iss')
if ($LASTEXITCODE -ne 0) { Write-Host "ISCC failed" -ForegroundColor Red; exit 1 }
$setupExe = Join-Path $OutDir "DigiLog-Setup-$AppVersion.exe"

# 8. Code sign the finished Setup.exe (M7). Skipped unless -Sign is passed; when
#    skipped the installer is unsigned and SmartScreen/AV will warn (expected -
#    see the clean-VM acceptance runbook). To sign a build later, re-run with
#    -Sign -CertPath <pfx> -CertPassword <pw>  (or -CertSubject "CN=...").
if ($Sign) {
  Write-Host "==> Code sign Setup.exe" -ForegroundColor Cyan
  $signtool = Find-SignTool
  if (-not $signtool) { Write-Host "FAILED: -Sign requested but signtool.exe not found (install the Windows 10/11 SDK)." -ForegroundColor Red; exit 1 }
  if (-not (Test-Path $setupExe)) { Write-Host "FAILED: Setup.exe not found to sign: $setupExe" -ForegroundColor Red; exit 1 }
  Sign-File $signtool $setupExe
  Write-Host "`nInstaller built + SIGNED: $setupExe" -ForegroundColor Green
} else {
  Write-Host "`nInstaller built (UNSIGNED - SmartScreen/AV will warn): $setupExe" -ForegroundColor Yellow
  Write-Host "  To sign: re-run with -Sign -CertPath <pfx> -CertPassword <pw> (or -CertSubject 'CN=...')." -ForegroundColor Gray
}
