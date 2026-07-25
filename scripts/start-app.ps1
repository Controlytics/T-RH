<#
.SYNOPSIS
    One-click launcher for compliance-core. Verifies every dependency, repairs
    what it safely can, then starts the API and web dev servers.

.DESCRIPTION
    Invoked by start-app.bat. Safe to run repeatedly - every step is idempotent
    and skipped when already satisfied.

    Steps:
      1  Node.js + npm present
      2  PostgreSQL service running
      3  psql available
      4  Read apps/api/.env  (DATABASE_URL, PORT, API_HTTPS)
      5  Database exists (created if not)
      6  npm workspaces installed
      7  packages/shared + packages/queue built
      8  Prisma client generated
      9  Extensions (ltree, pgcrypto) applied
      10 Migrations deployed
      11 Seeded (only if the users table is empty)
      12 TLS certs present when API_HTTPS=true
      13 Ports free
      14 Start API + web, wait for health, open browser

.PARAMETER WebPort
    Port for the Vite dev server. Defaults to 5175, auto-incrementing if busy.

.PARAMETER SkipBrowser
    Do not open the browser when the stack is up.
#>
[CmdletBinding()]
param(
    [int]$WebPort = 0,
    [switch]$SkipBrowser
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# ---------------------------------------------------------------- output helpers
$script:StepNo = 0
function Step($msg) {
    $script:StepNo++
    Write-Host ""
    Write-Host ("[{0,2}] {1}" -f $script:StepNo, $msg) -ForegroundColor Cyan
}
function Ok($msg)   { Write-Host "     OK   $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "     ..   $msg" -ForegroundColor Gray }
function Warn($msg) { Write-Host "     WARN $msg" -ForegroundColor Yellow }
function Die($msg, $fix) {
    Write-Host ""
    Write-Host "  FAILED: $msg" -ForegroundColor Red
    if ($fix) {
        Write-Host ""
        Write-Host "  How to fix:" -ForegroundColor Yellow
        foreach ($line in $fix) { Write-Host "    $line" -ForegroundColor Yellow }
    }
    Write-Host ""
    Read-Host "  Press Enter to close"
    exit 1
}

Write-Host ""
Write-Host "  ===================================================" -ForegroundColor White
Write-Host "   compliance-core  -  starting all services" -ForegroundColor White
Write-Host "  ===================================================" -ForegroundColor White
Write-Host "   repo: $RepoRoot" -ForegroundColor DarkGray

# ---------------------------------------------------------------- 1. Node.js
Step "Checking Node.js and npm"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Die "Node.js is not installed (or not on PATH)." @(
        "winget install OpenJS.NodeJS.LTS",
        "",
        "Then CLOSE this window and run start-app.bat again so PATH refreshes."
    )
}
$nodeVer = (& node --version).TrimStart('v')
$nodeMajor = [int]($nodeVer.Split('.')[0])
if ($nodeMajor -lt 20) {
    Die "Node.js $nodeVer is too old. This project needs Node 20 or newer." @(
        "winget install OpenJS.NodeJS.LTS"
    )
}
Ok "Node v$nodeVer"

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Die "npm not found on PATH." @("Reinstall Node.js: winget install OpenJS.NodeJS.LTS") }
Ok "npm v$(& npm --version)"

# ---------------------------------------------------------------- 2. PostgreSQL service
Step "Checking PostgreSQL service"
$pg = Get-Service | Where-Object { $_.Name -like 'postgresql*' } | Select-Object -First 1
if (-not $pg) {
    Die "No PostgreSQL service found on this machine." @(
        "winget install PostgreSQL.PostgreSQL.18",
        "",
        "During install set the 'postgres' superuser password and keep port 5432.",
        "Then run scripts/provision-db.ps1 to create the app role and database."
    )
}
if ($pg.Status -ne 'Running') {
    Info "Service '$($pg.Name)' is $($pg.Status) - starting it (needs admin)..."
    try {
        Start-Service $pg.Name -ErrorAction Stop
        Start-Sleep -Seconds 2
        Ok "Started $($pg.Name)"
    } catch {
        Die "Could not start PostgreSQL service '$($pg.Name)'." @(
            "Right-click start-app.bat and choose 'Run as administrator',",
            "or start it manually:",
            "    net start $($pg.Name)"
        )
    }
} else {
    Ok "$($pg.Name) is running"
}

# ---------------------------------------------------------------- 3. psql
Step "Locating psql"
$psql = Get-Command psql -ErrorAction SilentlyContinue
if ($psql) {
    $PsqlExe = $psql.Source
} else {
    $found = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue |
             Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $found) {
        Die "psql.exe not found." @(
            "Add the PostgreSQL bin folder to PATH, e.g.:",
            "    C:\Program Files\PostgreSQL\18\bin"
        )
    }
    $PsqlExe = $found.FullName
}
Ok $PsqlExe

# ---------------------------------------------------------------- 4. .env
Step "Reading apps/api/.env"
$EnvPath = Join-Path $RepoRoot 'apps\api\.env'
if (-not (Test-Path $EnvPath)) {
    $example = Join-Path $RepoRoot 'apps\api\.env.example'
    if (Test-Path $example) {
        Copy-Item $example $EnvPath
        Warn "apps/api/.env was missing - copied from .env.example."
        Warn "Open it and set DATABASE_URL / JWT_SECRET before going further."
    } else {
        Die "apps/api/.env is missing and there is no .env.example to copy." @(
            "Create apps/api/.env with at least DATABASE_URL, PORT and JWT_SECRET."
        )
    }
}

$EnvMap = @{}
foreach ($line in (Get-Content $EnvPath)) {
    $t = $line.Trim()
    if ($t.Length -eq 0) { continue }
    if ($t.StartsWith('#')) { continue }
    $idx = $t.IndexOf('=')
    if ($idx -lt 1) { continue }
    $k = $t.Substring(0, $idx).Trim()
    $v = $t.Substring($idx + 1).Trim().Trim('"').Trim("'")
    $EnvMap[$k] = $v
}

$DatabaseUrl = $EnvMap['DATABASE_URL']
if (-not $DatabaseUrl) { Die "DATABASE_URL is not set in apps/api/.env." @("Add e.g.  DATABASE_URL=postgresql://user:pass@localhost:5432/compliance_core_db?schema=public") }

# app.ts reads PORT (API_PORT is legacy/unused)
$ApiPort = 3000
if ($EnvMap['PORT']) { $ApiPort = [int]$EnvMap['PORT'] }
$ApiHttps = ($EnvMap['API_HTTPS'] -eq 'true')
$ApiScheme = 'http'
if ($ApiHttps) { $ApiScheme = 'https' }

$m = [regex]::Match($DatabaseUrl, '^postgres(?:ql)?://([^:/@]+):([^@]*)@([^:/]+):(\d+)/([^?]+)')
if (-not $m.Success) { Die "Could not parse DATABASE_URL." @("Expected: postgresql://USER:PASS@HOST:PORT/DBNAME?schema=public") }
$DbUser = $m.Groups[1].Value
$DbPass = $m.Groups[2].Value
$DbHost = $m.Groups[3].Value
$DbPort = $m.Groups[4].Value
$DbName = $m.Groups[5].Value

Ok "database  $DbName on ${DbHost}:${DbPort} (user $DbUser)"
Ok "api       ${ApiScheme}://localhost:$ApiPort"

$env:PGPASSWORD = $DbPass   # consumed by psql; never printed

function Invoke-Psql([string]$Database, [string]$Sql) {
    $out = & $PsqlExe -U $DbUser -h $DbHost -p $DbPort -d $Database -tAc $Sql
    return $out
}

# ---------------------------------------------------------------- 5. database exists
Step "Checking database '$DbName'"
$exists = Invoke-Psql 'postgres' "select 1 from pg_database where datname='$DbName'"
if ($LASTEXITCODE -ne 0) {
    Die "Cannot connect to PostgreSQL as '$DbUser'." @(
        "Verify the credentials in apps/api/.env, or provision the role:",
        "    powershell -File scripts\provision-db.ps1"
    )
}
if ($exists -notmatch '1') {
    Info "Database does not exist - creating it..."
    & $PsqlExe -U $DbUser -h $DbHost -p $DbPort -d postgres -c "CREATE DATABASE `"$DbName`"" | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "Could not create database '$DbName'." @("Create it manually, then re-run.") }
    Ok "Created $DbName"
} else {
    Ok "Present"
}

# ---------------------------------------------------------------- 6. npm install
Step "Checking npm dependencies"
$needInstall = $false
if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) { $needInstall = $true }
else {
    $lock = Join-Path $RepoRoot 'package-lock.json'
    $stamp = Join-Path $RepoRoot 'node_modules\.package-lock.json'
    if ((Test-Path $lock) -and (Test-Path $stamp)) {
        if ((Get-Item $lock).LastWriteTime -gt (Get-Item $stamp).LastWriteTime) { $needInstall = $true }
    }
}
if ($needInstall) {
    Info "Installing workspace dependencies (this can take a few minutes)..."
    & npm install
    if ($LASTEXITCODE -ne 0) { Die "npm install failed." @("Check the output above, then re-run.") }
    Ok "Dependencies installed"
} else {
    Ok "Up to date"
}

# ---------------------------------------------------------------- 7. build shared packages
Step "Building shared packages"
if (-not (Test-Path (Join-Path $RepoRoot 'packages\shared\dist'))) {
    Info "Building @digilog/shared..."
    & npm run build -w @digilog/shared
    if ($LASTEXITCODE -ne 0) { Die "Failed to build @digilog/shared." $null }
    Ok "@digilog/shared built"
} else { Ok "@digilog/shared present" }

if (-not (Test-Path (Join-Path $RepoRoot 'packages\queue\dist'))) {
    Info "Building @digilog/queue..."
    & npm run build -w @digilog/queue
    if ($LASTEXITCODE -ne 0) { Die "Failed to build @digilog/queue." $null }
    Ok "@digilog/queue built"
} else { Ok "@digilog/queue present" }

# ---------------------------------------------------------------- 8. prisma client
Step "Generating Prisma client"
Push-Location (Join-Path $RepoRoot 'apps\api')
& npx prisma generate | Out-Null
$genOk = ($LASTEXITCODE -eq 0)
Pop-Location
if (-not $genOk) { Die "prisma generate failed." @("Run it manually:  cd apps\api && npx prisma generate") }
Ok "Prisma client ready"

# ---------------------------------------------------------------- 9. extensions
Step "Applying required PostgreSQL extensions"
# The migration baseline USES ltree + pgcrypto but does not CREATE them, so a
# bare database fails `migrate deploy` without this step.
$extSql = Join-Path $RepoRoot 'apps\api\prisma\sql\extensions.sql'
if (Test-Path $extSql) {
    & $PsqlExe -U $DbUser -h $DbHost -p $DbPort -d $DbName -f $extSql | Out-Null
} else {
    Invoke-Psql $DbName 'CREATE EXTENSION IF NOT EXISTS ltree; CREATE EXTENSION IF NOT EXISTS pgcrypto;' | Out-Null
}
Ok "ltree + pgcrypto"

# ---------------------------------------------------------------- 10. migrations
Step "Applying database migrations"
Push-Location (Join-Path $RepoRoot 'apps\api')
& npx prisma migrate deploy
$migOk = ($LASTEXITCODE -eq 0)
Pop-Location
if (-not $migOk) { Die "prisma migrate deploy failed." @("Review the output above. Do NOT use 'prisma db push' on a populated database.") }
Ok "Schema up to date"

# ---------------------------------------------------------------- 11. seed
Step "Checking seed data"
$userCount = Invoke-Psql $DbName "select count(*) from users"
if ($LASTEXITCODE -ne 0) { $userCount = '0' }
if ([int]$userCount -eq 0) {
    Info "No users found - seeding initial data..."
    # prisma/seed.ts deliberately THROWS when INITIAL_ADMIN_PASSWORD is unset,
    # so that no hardcoded default credential can reach an install. Do not
    # silently paper over that: ask, and only fall back in development.
    $adminPw = $EnvMap['INITIAL_ADMIN_PASSWORD']
    if (-not $adminPw) {
        Write-Host ""
        Warn "INITIAL_ADMIN_PASSWORD is not set in apps\api\.env."
        Warn "The seed refuses to run without one (no default credential may ship)."
        Write-Host ""
        $entered = Read-Host "     Enter a password for the initial 'superadmin' account"
        if ($entered) {
            $adminPw = $entered
        } elseif ($EnvMap['NODE_ENV'] -eq 'development') {
            $adminPw = 'Admin@123'
            Warn "Nothing entered - using the documented DEV default 'Admin@123'."
            Warn "You will be forced to change it at first login."
        } else {
            Die "No initial admin password supplied and NODE_ENV is not 'development'." @(
                "Set INITIAL_ADMIN_PASSWORD in apps\api\.env, then re-run."
            )
        }
    }
    Push-Location (Join-Path $RepoRoot 'apps\api')
    $env:INITIAL_ADMIN_PASSWORD = $adminPw
    & npx prisma db seed
    $seedOk = ($LASTEXITCODE -eq 0)
    Pop-Location
    if (-not $seedOk) { Die "Seeding failed." @("Run manually: cd apps\api && npx prisma db seed") }
    Ok "Seeded (login: superadmin)"
} else {
    Ok "$userCount user(s) already present - not reseeding"
}

# ---------------------------------------------------------------- 12. TLS certs
Step "Checking TLS certificates"
if ($ApiHttps) {
    $key = Join-Path $RepoRoot 'certs\server.key'
    $crt = Join-Path $RepoRoot 'certs\server.crt'
    if ((-not (Test-Path $key)) -or (-not (Test-Path $crt))) {
        Die "API_HTTPS=true but certs\server.key / server.crt are missing." @(
            "Either generate them with mkcert:",
            "    mkcert -key-file certs\server.key -cert-file certs\server.crt localhost 127.0.0.1",
            "or set API_HTTPS=false in apps\api\.env to run over plain HTTP."
        )
    }
    Ok "certs/server.key + server.crt present"
} else {
    Ok "API_HTTPS=false - not required"
}

# ---------------------------------------------------------------- 13. ports
Step "Checking ports"
function Test-PortBusy([int]$Port) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return ($null -ne $c)
}

if (Test-PortBusy $ApiPort) {
    $owner = Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $pname = '(unknown)'
    if ($owner) {
        $proc = Get-Process -Id $owner.OwningProcess -ErrorAction SilentlyContinue
        if ($proc) { $pname = "$($proc.ProcessName) (PID $($proc.Id))" }
    }
    Die "API port $ApiPort is already in use by $pname." @(
        "Either stop that process (stop-app.bat), or change PORT in apps\api\.env."
    )
}
Ok "API port $ApiPort free"

if ($WebPort -eq 0) {
    $WebPort = 5175
    while ((Test-PortBusy $WebPort) -and ($WebPort -lt 5200)) { $WebPort++ }
}
if (Test-PortBusy $WebPort) { Die "Web port $WebPort is in use." @("Pass a free one:  start-app.bat -WebPort 5180") }
Ok "Web port $WebPort free"

# ---------------------------------------------------------------- 14. launch
Step "Starting services"

# CRITICAL: vite.config.ts defaults its /api proxy to https://localhost:3000.
# This repo's .env sets PORT=3001, so without API_PROXY_TARGET every request
# from the browser would 404 against the wrong (or a sibling checkout's) API.
$ApiTarget = "${ApiScheme}://localhost:$ApiPort"

$apiDir = Join-Path $RepoRoot 'apps\api'
$webDir = Join-Path $RepoRoot 'apps\web'

Info "API  -> $ApiTarget"
Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/k', "title compliance-core API && cd /d `"$apiDir`" && npx tsx watch src/app.ts" `
    -WindowStyle Normal

Info "Web  -> https://localhost:$WebPort   (proxying /api to $ApiTarget)"
Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/k', "title compliance-core WEB && cd /d `"$webDir`" && set WEB_PORT=$WebPort&& set API_PROXY_TARGET=$ApiTarget&& npx vite --host" `
    -WindowStyle Normal

# ---------------------------------------------------------------- wait for health
Write-Host ""
Write-Host "     Waiting for the API to come up..." -ForegroundColor Gray

# Readiness is tested with a raw TCP connect, NOT Invoke-WebRequest.
#
# Two reasons:
#   1. The dev cert is self-signed and -SkipCertificateCheck is PowerShell 7+
#      only; this script runs under Windows PowerShell 5.1.
#   2. /health answers 401 when unauthenticated. Under PS 5.1 that surfaces as
#      a terminating WebException whose .Response is NOT populated (unlike
#      PS 7), so "treat any HTTP status as up" silently never fires.
#
# A successful TCP connect proves the listener is bound, which is exactly the
# question being asked. The port was verified free in step 13, so anything
# listening on it now is the process we just launched.
function Test-Listening([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $async.AsyncWaitHandle.WaitOne(1000, $false)
        if ($ok -and $client.Connected) { $client.EndConnect($async); return $true }
        return $false
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

$up = $false
foreach ($i in 1..90) {
    if (Test-Listening $ApiPort) { $up = $true; break }
    Start-Sleep -Seconds 1
}

$webUp = $false
if ($up) {
    foreach ($i in 1..30) {
        if (Test-Listening $WebPort) { $webUp = $true; break }
        Start-Sleep -Seconds 1
    }
}

Write-Host ""
if ($up -and $webUp) {
    Write-Host "  ===================================================" -ForegroundColor Green
    Write-Host "   compliance-core is RUNNING" -ForegroundColor Green
    Write-Host "  ===================================================" -ForegroundColor Green
} elseif ($up) {
    Write-Host "  ---------------------------------------------------" -ForegroundColor Yellow
    Write-Host "   API is up, but the web server did not bind in 30s." -ForegroundColor Yellow
    Write-Host "   Check the 'compliance-core WEB' window for errors." -ForegroundColor Yellow
    Write-Host "  ---------------------------------------------------" -ForegroundColor Yellow
} else {
    Write-Host "  ---------------------------------------------------" -ForegroundColor Yellow
    Write-Host "   Services launched, but the API did not bind port" -ForegroundColor Yellow
    Write-Host "   $ApiPort within 90s." -ForegroundColor Yellow
    Write-Host "   Check the 'compliance-core API' window for errors." -ForegroundColor Yellow
    Write-Host "  ---------------------------------------------------" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "   App      https://localhost:$WebPort" -ForegroundColor White
Write-Host "   API      $ApiTarget" -ForegroundColor White
Write-Host "   Swagger  $ApiTarget/docs" -ForegroundColor White
Write-Host ""
Write-Host "   Login    superadmin" -ForegroundColor White
Write-Host ""
Write-Host "   Two console windows were opened (API and WEB)." -ForegroundColor DarkGray
Write-Host "   Close them, or run stop-app.bat, to shut everything down." -ForegroundColor DarkGray
Write-Host ""

if ($ApiHttps) {
    Write-Host "   NOTE: the certificate is self-signed, so the browser will warn" -ForegroundColor DarkGray
    Write-Host "   once for each of the two origins. Accept both." -ForegroundColor DarkGray
    Write-Host ""
}

if (-not $SkipBrowser) {
    Start-Process "https://localhost:$WebPort"
}

Write-Host "   This window can be closed." -ForegroundColor DarkGray
Write-Host ""
