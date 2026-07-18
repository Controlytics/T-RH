<#
.SYNOPSIS
  Assemble the self-contained runtime/ folder the installer ships: portable
  node.exe + compiled backend + production node_modules + built web UI.
  See tasks/EXE-PACKAGING-PLAN.md section 4 step 5 (M2/M5).

.DESCRIPTION
  Inputs MUST already be built (run scripts/build-bundle.ps1 first) and a
  PRODUCTION node_modules must exist (the build pipeline does `npm ci --omit=dev`
  in a clean checkout - never against the live repo). This script only copies +
  arranges; it does not install dependencies.

  Output tree (-OutDir):
    runtime\node.exe
    runtime\api\dist, runtime\api\prisma, runtime\api\package.json
    runtime\web\dist
    runtime\queue\crontab.txt
    runtime\node_modules\...            (production deps)
    runtime\node_modules\@digilog\shared\{dist,package.json}   (dereferenced)
    runtime\node_modules\@digilog\queue\{dist,package.json}    (dereferenced)

  The @digilog/* entries in a workspace node_modules are Windows JUNCTIONS into
  packages/. A naive copy ships dangling links, so we EXCLUDE @digilog from the
  bulk copy and re-create shared + queue as real folders from their built dist.
  (apps/api only depends on @digilog/shared + @digilog/queue.)

.PARAMETER NodeExe         Portable node.exe to bundle (ABI must match native build)
.PARAMETER NodeModulesSrc  Production node_modules (from `npm ci --omit=dev`)
.PARAMETER DryRun          Print the plan without copying
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$NodeExe,
  [Parameter(Mandatory)] [string]$NodeModulesSrc,
  [string]$RepoRoot,
  [Parameter(Mandatory)] [string]$OutDir,
  [switch]$DryRun
)

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$apiDist   = Join-Path $RepoRoot 'apps\api\dist'
$apiPrisma = Join-Path $RepoRoot 'apps\api\prisma'
$apiPkg    = Join-Path $RepoRoot 'apps\api\package.json'
$webDist   = Join-Path $RepoRoot 'apps\web\dist'
$crontab   = Join-Path $RepoRoot 'packages\queue\crontab.txt'
$sharedDist= Join-Path $RepoRoot 'packages\shared\dist'
$sharedPkg = Join-Path $RepoRoot 'packages\shared\package.json'
$queueDist = Join-Path $RepoRoot 'packages\queue\dist'
$queuePkg  = Join-Path $RepoRoot 'packages\queue\package.json'

# Pre-flight: every input must exist (fail loud, not a half-staged runtime).
$required = @{
  'node.exe'=$NodeExe; 'node_modules src'=$NodeModulesSrc; 'api/dist'=$apiDist;
  'web/dist'=$webDist; 'shared/dist'=$sharedDist; 'queue/dist'=$queueDist
}
foreach ($k in $required.Keys) {
  if (-not (Test-Path $required[$k])) { Write-Host "Missing input: $k -> $($required[$k]) (run build-bundle.ps1 first)" -ForegroundColor Red; exit 1 }
}

function Copy-Tree($src, $dst, $extra) {
  if ($DryRun) { Write-Host "[dry-run] robocopy $src $dst /E $extra" -ForegroundColor Yellow; return }
  $args = @($src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') + ($extra -split ' ' | Where-Object { $_ })
  robocopy @args | Out-Null
  if ($LASTEXITCODE -ge 8) { Write-Host "robocopy failed ($LASTEXITCODE): $src -> $dst" -ForegroundColor Red; exit 1 }
}

Write-Host "Staging runtime -> $OutDir" -ForegroundColor Cyan
if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

# node.exe
if ($DryRun) { Write-Host "[dry-run] copy $NodeExe -> $OutDir\node.exe" -ForegroundColor Yellow }
else { Copy-Item $NodeExe (Join-Path $OutDir 'node.exe') -Force }

# backend + web + queue crontab
Copy-Tree $apiDist   (Join-Path $OutDir 'api\dist')   ''
Copy-Tree $apiPrisma (Join-Path $OutDir 'api\prisma') ''
Copy-Tree $webDist   (Join-Path $OutDir 'web\dist')   ''
if ($DryRun) {
  Write-Host "[dry-run] copy api/package.json, queue/crontab.txt" -ForegroundColor Yellow
} else {
  Copy-Item $apiPkg (Join-Path $OutDir 'api\package.json') -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'queue') | Out-Null
  if (Test-Path $crontab) { Copy-Item $crontab (Join-Path $OutDir 'queue\crontab.txt') -Force }
}

# production node_modules - EXCLUDE the @digilog junctions (dereferenced below)
Copy-Tree $NodeModulesSrc (Join-Path $OutDir 'node_modules') "/XD `"$NodeModulesSrc\@digilog`""

# @digilog/shared + @digilog/queue as REAL folders (dist + package.json)
foreach ($w in @(@{n='shared';d=$sharedDist;p=$sharedPkg}, @{n='queue';d=$queueDist;p=$queuePkg})) {
  $dest = Join-Path $OutDir "node_modules\@digilog\$($w.n)"
  Copy-Tree $w.d (Join-Path $dest 'dist') ''
  if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $dest | Out-Null; Copy-Item $w.p (Join-Path $dest 'package.json') -Force }
}

# Prisma staging sanity checks - BOTH are fatal (a missing artifact = broken install):
#  1. the generated CLIENT (.prisma/client/index.js) - without it the app + seed
#     throw "@prisma/client did not initialize yet" (run prisma generate in the
#     clean-room; build-installer.ps1 does this after npm ci --omit=dev).
#  2. the native query engine (*.node) - the app cannot talk to Postgres without it.
if (-not $DryRun) {
  $clientIdx = Join-Path $OutDir 'node_modules\.prisma\client\index.js'
  if (-not (Test-Path $clientIdx)) {
    Write-Host "FAILED: generated Prisma client missing ($clientIdx). Run 'prisma generate' in the clean-room before staging." -ForegroundColor Red; exit 1
  }
  $engine = Get-ChildItem (Join-Path $OutDir 'node_modules\.prisma\client') -Filter '*.node' -ErrorAction SilentlyContinue
  if (-not $engine) {
    Write-Host "FAILED: Prisma query engine (.node) not found in staged node_modules - the app will fail to start." -ForegroundColor Red; exit 1
  }
  Write-Host "  Prisma client + engine present: $($engine.Name)" -ForegroundColor DarkGray
}

Write-Host "Runtime staged at $OutDir" -ForegroundColor Green
exit 0
