<#
.SYNOPSIS
  Build the single-process DigiLog bundle: compiled backend that also serves the
  built web UI. The output runs with one command and no Vite — the foundation
  for the customer Setup.exe (see tasks/EXE-PACKAGING-PLAN.md M1).

.DESCRIPTION
  Produces:
    apps/api/dist/   — compiled backend (entry: dist/app.js)
    apps/web/dist/   — built React UI (served by the backend when SERVE_WEB=true)
    packages/shared/dist, packages/queue/dist — workspace deps

  After building, run the whole app from one process:

    $env:SERVE_WEB='true'; $env:API_HTTPS='false'; node apps/api/dist/app.js

  then open http://localhost:3000. Requires PostgreSQL running and a valid
  apps/api/.env (DATABASE_URL etc.).

.PARAMETER SkipWeb
  Skip the (slow) `vite build` and reuse the existing apps/web/dist.
#>
[CmdletBinding()]
param([switch]$SkipWeb)

# Gate on $LASTEXITCODE explicitly; don't use Stop (native stderr would abort).
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Step($name, $block) {
  Write-Host "==> $name" -ForegroundColor Cyan
  & $block
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $name (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
}

Step "Build @digilog/shared" { npm run build -w @digilog/shared }
Step "Build @digilog/queue"  { npm run build -w @digilog/queue }
Step "Compile backend (tsc)" { npx tsc -p apps/api/tsconfig.json }

# Precompile the DB seed to a self-contained ESM file the CUSTOMER runtime can run
# with just node.exe. tsx is a devDependency and is pruned by `npm ci --omit=dev`,
# so `tsx prisma/seed.ts` cannot run on a customer machine. esbuild bundles seed.ts
# + its local ./default-roles import into prisma/seed.mjs, keeping @prisma/client +
# bcrypt (native runtime deps that survive the prune) external. The installer runs
# `node prisma/seed.mjs` from runtime/api. See EXE-PACKAGING-PLAN.md M6 / apply-schema.ps1.
Step "Precompile DB seed (esbuild -> prisma/seed.mjs)" {
  npx esbuild apps/api/prisma/seed.ts --bundle --platform=node --format=esm --packages=external --outfile=apps/api/prisma/seed.mjs
}

if ($SkipWeb) {
  Write-Host "==> Skipping web build (reusing apps/web/dist)" -ForegroundColor Yellow
  if (-not (Test-Path "apps/web/dist/index.html")) {
    Write-Host "FAILED: -SkipWeb but apps/web/dist/index.html is missing. Run without -SkipWeb." -ForegroundColor Red
    exit 1
  }
} else {
  Step "Build web UI (vite build)" { npm run build -w @digilog/web }
}

Write-Host "`nBundle built." -ForegroundColor Green
Write-Host "Run the single-process app with:" -ForegroundColor Green
Write-Host "  `$env:SERVE_WEB='true'; `$env:API_HTTPS='false'; node apps/api/dist/app.js" -ForegroundColor Gray
Write-Host "  then open http://localhost:3000   (PostgreSQL must be running)" -ForegroundColor Gray
