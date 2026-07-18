<#
.SYNOPSIS
  Migration drift guard — proves `prisma migrate deploy` reproduces the live
  schema exactly. Run before every release and in CI.

.DESCRIPTION
  Why this exists (see tasks/EXE-PACKAGING-PLAN.md §2.2):
  The naive check `prisma migrate diff --from-migrations --to-schema-datamodel`
  ALWAYS reports drift here, because the baseline migration is a pg_dump that is
  a *superset* of schema.prisma (it carries triggers / functions / sequences /
  a partial unique index the datamodel cannot express). So instead of comparing
  migrations-to-datamodel, this guard:

    1. builds a throwaway scratch DB purely from migrations (extensions first,
       then `prisma migrate deploy`), then
    2. diffs that fresh DB against the *live* reference DB.

  An empty diff means: a customer fresh-install (which is exactly step 1)
  reproduces the reference schema bit-for-bit. A non-empty diff means someone
  changed schema.prisma and the dev DB without writing a migration — that delta
  is printed and the script exits 1.

.PARAMETER ReferenceUrl
  The "known-good" DB to compare against. Defaults to DATABASE_URL from
  apps/api/.env (your dev DB).

.PARAMETER PsqlPath
  Path to psql.exe. Defaults to the PostgreSQL 18 install location.

.EXAMPLE
  pwsh scripts/verify-migrations.ps1
#>
[CmdletBinding()]
param(
  [string]$ReferenceUrl,
  [string]$PsqlPath = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
)

# NOTE: do NOT set $ErrorActionPreference='Stop' globally. On Windows PowerShell
# 5.1, a native command (npx/prisma) writing to stderr — e.g. Prisma's harmless
# "package.json#prisma is deprecated" warning — gets wrapped as a terminating
# NativeCommandError under Stop, which would abort this script even on success.
# We gate on $LASTEXITCODE explicitly and use `throw` (always terminating) for
# real failures instead.
$repoRoot = Split-Path -Parent $PSScriptRoot
$apiDir   = Join-Path $repoRoot 'apps\api'
$envFile  = Join-Path $apiDir '.env'

# ─── Resolve the reference DATABASE_URL ──────────────────────────────────────
if (-not $ReferenceUrl) {
  if (-not (Test-Path $envFile)) { throw "No -ReferenceUrl and no $envFile to read DATABASE_URL from." }
  $line = Select-String -Path $envFile -Pattern '^\s*DATABASE_URL\s*=' | Select-Object -First 1
  if (-not $line) { throw "DATABASE_URL not found in $envFile" }
  $ReferenceUrl = ($line.Line -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"')
}

# ─── Parse the URL → connection parts (postgresql://user:pass@host:port/db?...) ─
if ($ReferenceUrl -notmatch '^postgres(?:ql)?://([^:]+):([^@]+)@([^:/]+):(\d+)/([^?]+)') {
  throw "Could not parse ReferenceUrl: $ReferenceUrl"
}
$pgUser = $Matches[1]; $pgPass = $Matches[2]; $pgHost = $Matches[3]; $pgPort = $Matches[4]; $refDb = $Matches[5]
$scratchDb = "${refDb}_driftcheck"
$scratchUrl = "postgresql://${pgUser}:${pgPass}@${pgHost}:${pgPort}/${scratchDb}?schema=public"

if (-not (Test-Path $PsqlPath)) { throw "psql not found at $PsqlPath (override with -PsqlPath)" }
$env:PGPASSWORD = $pgPass
$extensionsSql = Join-Path $apiDir 'prisma\sql\extensions.sql'

function Invoke-Psql([string]$db, [string]$sql) {
  & $PsqlPath -h $pgHost -p $pgPort -U $pgUser -d $db -v ON_ERROR_STOP=1 -qtAc $sql
  if ($LASTEXITCODE -ne 0) { throw "psql failed (db=$db): $sql" }
}

Write-Host "==> Migration drift guard" -ForegroundColor Cyan
Write-Host "    reference DB : $refDb"
Write-Host "    scratch DB   : $scratchDb"

try {
  # 1. Fresh scratch DB
  Write-Host "==> Creating scratch DB..." -ForegroundColor Cyan
  Invoke-Psql 'postgres' "DROP DATABASE IF EXISTS $scratchDb;"
  Invoke-Psql 'postgres' "CREATE DATABASE $scratchDb OWNER $pgUser;"

  # 2. Extensions BEFORE deploy (baseline uses ltree/pgcrypto but does not create them)
  Write-Host "==> Applying extensions.sql..." -ForegroundColor Cyan
  & $PsqlPath -h $pgHost -p $pgPort -U $pgUser -d $scratchDb -v ON_ERROR_STOP=1 -q -f $extensionsSql
  if ($LASTEXITCODE -ne 0) { throw "Failed applying extensions.sql" }

  # 3. Build schema purely from migrations
  Write-Host "==> prisma migrate deploy (scratch)..." -ForegroundColor Cyan
  Push-Location $apiDir
  try {
    $env:DATABASE_URL = $scratchUrl
    & npx prisma migrate deploy
    if ($LASTEXITCODE -ne 0) { throw "migrate deploy failed against scratch DB" }

    # 4. Diff fresh scratch vs reference.
    # Capture stdout (the success stream) only — stderr carries the deprecation
    # warning and must NOT be merged in (no 2>&1 / 2>$null, which trips PS 5.1).
    Write-Host "==> Diffing scratch vs reference..." -ForegroundColor Cyan
    $diff = & npx prisma migrate diff --from-url $scratchUrl --to-url $ReferenceUrl --script
    if ($LASTEXITCODE -ne 0) { throw "migrate diff failed (exit $LASTEXITCODE)" }
  }
  finally { Pop-Location }

  $diffText = ($diff -join "`n")
  if ($diffText -match 'This is an empty migration') {
    Write-Host "`nPASS: migrations reproduce the reference schema exactly." -ForegroundColor Green
    $exit = 0
  } else {
    Write-Host "`nFAIL: schema drift detected. The reference DB has changes with no migration behind them:" -ForegroundColor Red
    Write-Host $diffText
    Write-Host "`nFix: hand-author a migration for this delta (see EXE-PACKAGING-PLAN.md §2.1b), or revert the un-migrated schema.prisma change." -ForegroundColor Yellow
    $exit = 1
  }
}
finally {
  # 5. Always clean up the scratch DB
  Write-Host "==> Dropping scratch DB..." -ForegroundColor Cyan
  & $PsqlPath -h $pgHost -p $pgPort -U $pgUser -d 'postgres' -qtAc "DROP DATABASE IF EXISTS $scratchDb;" | Out-Null
}

exit $exit
