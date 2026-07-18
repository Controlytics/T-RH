<#
.SYNOPSIS
  Apply the DigiLog schema to an existing database: `migrate deploy` + seed.
  This is the ONE step shared by fresh install (provision-db.ps1) and upgrade
  (upgrade.ps1) so the two paths can never drift.
  See tasks/EXE-PACKAGING-PLAN.md section 8 (M6).

.DESCRIPTION
  CUSTOMER-SAFE: runs with ONLY the bundled node.exe. `tsx` and the `prisma` CLI
  are devDependencies in dev but `prisma` is a runtime dependency for the bundle,
  so on a customer machine (npm ci --omit=dev) we invoke:
    migrate: node <node_modules>/prisma/build/index.js migrate deploy
    seed:    node prisma/seed.mjs           (esbuild-bundled by build-bundle.ps1)
  `npx prisma` / `npx tsx` are NOT available on a customer box (only node.exe is
  bundled). In DEV, where seed.mjs / a local prisma may be absent, this falls back
  to `npx prisma` / `npx tsx` automatically so the same script serves both.

  DATABASE_URL is passed EXPLICITLY (-DatabaseUrl) and set into the process env,
  which takes precedence over any prisma-loaded .env, so this always targets the
  intended database.

  Extensions (ltree/pgcrypto) are NOT applied here: on a fresh install
  provision-db.ps1 applies them as the cluster superuser BEFORE the DB is
  populated; on an upgrade they already exist. See EXE-PACKAGING-PLAN.md M0.

.PARAMETER NodeExe        node.exe to run prisma/seed with (default 'node' on PATH)
.PARAMETER ApiDir         The apps/api dir (runtime/api on a customer box) holding
                          prisma/schema.prisma, prisma/seed.mjs, package.json.
.PARAMETER DatabaseUrl    Full postgres connection string for the target DB.
.PARAMETER AdminPassword  INITIAL_ADMIN_PASSWORD for the seed. On upgrade pass a
                          throwaway value: the seed's superadmin upsert never
                          overwrites an existing password (seed.ts update branch).
.PARAMETER DryRun         Print the plan without executing.
#>
[CmdletBinding()]
param(
  [string]$NodeExe = 'node',
  [Parameter(Mandatory)] [string]$ApiDir,
  [Parameter(Mandatory)] [string]$DatabaseUrl,
  [Parameter(Mandatory)] [string]$AdminPassword,
  [switch]$DryRun
)

if (-not (Test-Path $ApiDir)) { Write-Host "ApiDir not found: $ApiDir" -ForegroundColor Red; exit 1 }

# Resolve the prisma CLI entry (build/index.js). Check the api dir's own
# node_modules first, then the sibling runtime node_modules (bundle layout:
# runtime\api + runtime\node_modules). Null => dev machine without a local
# prisma install => fall back to `npx prisma`.
$prismaCli = @(
  (Join-Path $ApiDir 'node_modules\prisma\build\index.js'),
  (Join-Path (Split-Path $ApiDir -Parent) 'node_modules\prisma\build\index.js')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$seedMjs = Join-Path $ApiDir 'prisma\seed.mjs'
$seedTs  = Join-Path $ApiDir 'prisma\seed.ts'

Write-Host "Apply schema (migrate deploy + seed)" -ForegroundColor Cyan
Write-Host "  ApiDir : $ApiDir"
Write-Host "  Node   : $NodeExe"
Write-Host "  Prisma : $(if ($prismaCli) { $prismaCli } else { 'npx prisma (dev fallback)' })"
Write-Host "  Seed   : $(if (Test-Path $seedMjs) { $seedMjs } else { 'npx tsx prisma/seed.ts (dev fallback)' })"
if ($DryRun) { Write-Host "  (DRY RUN - no changes)" -ForegroundColor Yellow }

if ($DryRun) {
  Write-Host "[dry-run] cd $ApiDir; DATABASE_URL=<hidden> migrate deploy; INITIAL_ADMIN_PASSWORD=<hidden> seed" -ForegroundColor Yellow
  exit 0
}

Push-Location $ApiDir
try {
  # Explicit env wins over any .env prisma might load.
  $env:DATABASE_URL = $DatabaseUrl

  Write-Host "==> prisma migrate deploy" -ForegroundColor Cyan
  if ($prismaCli) { & $NodeExe $prismaCli migrate deploy } else { npx prisma migrate deploy }
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: migrate deploy (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }

  Write-Host "==> seed" -ForegroundColor Cyan
  $env:INITIAL_ADMIN_PASSWORD = $AdminPassword
  if (Test-Path $seedMjs)      { & $NodeExe $seedMjs }
  elseif (Test-Path $seedTs)   { npx tsx prisma/seed.ts }
  else { Write-Host "FAILED: no seed.mjs or seed.ts in $ApiDir\prisma" -ForegroundColor Red; exit 1 }
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: seed (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
}
finally { Pop-Location }

Write-Host "Schema applied (migrate deploy + seed OK)." -ForegroundColor Green
exit 0  # explicit so callers reading $LASTEXITCODE see success
