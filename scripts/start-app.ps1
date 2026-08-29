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
      6  Ports free  (BEFORE anything writes to node_modules - see below)
      7  npm workspaces installed
      8  packages/shared + packages/queue built
      9  Prisma client generated
      10 Extensions (ltree, pgcrypto) applied
      11 Migrations deployed
      12 Seeded (only if the users table is empty)
      13 TLS certs present when API_HTTPS=true
      14 Start API + web, wait for health, open browser

    The port check runs BEFORE npm install / shared build / prisma generate.
    A previously-started API holds an open handle on
    node_modules\.prisma\client\query_engine-windows.dll.node, and Windows
    refuses the rename `prisma generate` performs - so a re-run while the app
    was up used to die at step 8 with a bare EPERM instead of the actionable
    "port in use, run stop-app.bat". Same reasoning for npm install.

.PARAMETER WebPort
    Port for the Vite dev server. Fixed, not auto-selected: defaults to
    WEB_PORT from apps/api/.env, else 5175. If it is busy the script stops
    rather than silently drifting to the next free port - a moving URL breaks
    bookmarks, and on a machine with two checkouts it is how you end up looking
    at the other one.

.PARAMETER SkipBrowser
    Do not open the browser when the stack is up.

.PARAMETER Restart
    Stop this checkout's own API/web first, then start.

    Without it a second run stops at "API port already in use" and starts
    NOTHING - correct, but unhelpful when what you meant was "pick up my code
    changes". It also clears the most common failure downstream: a running
    `tsx watch` holds node_modules\.prisma\client\query_engine-windows.dll.node,
    so `prisma generate` fails EPERM and the script dies before launching
    anything.

    Only ever stops processes whose command line or working directory is inside
    THIS repo - scripts\stop-app.ps1 owns that scoping and this reuses it rather
    than duplicating the rule, so a sibling checkout on a neighbouring port is
    left alone.
#>
[CmdletBinding()]
param(
    [int]$WebPort = 0,
    [switch]$SkipBrowser,
    [switch]$Restart
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

# ---------------------------------------------------------------- 6. ports
# Deliberately BEFORE npm install / shared build / prisma generate. A running
# API keeps an open handle on node_modules\.prisma\client\query_engine-*.dll.node
# and Windows will not let `prisma generate` rename over it, so an already-up
# stack used to fail three steps later with a bare EPERM. Fail here instead,
# where the cause and the fix are both obvious.
Step "Checking ports"
function Test-PortBusy([int]$Port) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return ($null -ne $c)
}
function Get-PortOwner([int]$Port) {
    $owner = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $owner) { return '(unknown)' }
    $proc = Get-Process -Id $owner.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) { return "$($proc.ProcessName) (PID $($proc.Id))" }
    return "PID $($owner.OwningProcess)"
}

# -Restart stops this checkout's own processes BEFORE the port checks below, so
# the checks then see genuinely free ports and a leftover of our own can never
# be reported as "someone else owns this port".
if ($Restart) {
    Info "Restart requested - stopping this checkout's services first"
    $stopScript = Join-Path $PSScriptRoot 'stop-app.ps1'
    if (Test-Path $stopScript) {
        & $stopScript | Out-Null
        # Windows releases a listening socket a moment after the owner exits;
        # checking immediately can still see it bound.
        Start-Sleep -Seconds 2
        Ok "Previous instance stopped"
    } else {
        Warn "stop-app.ps1 not found - continuing without stopping anything"
    }
}

if (Test-PortBusy $ApiPort) {
    Die "API port $ApiPort is already in use by $(Get-PortOwner $ApiPort)." @(
        "This checkout is probably already running.",
        "",
        "  Restart it with your latest code:   start-app.bat -Restart",
        "  Just stop it:                       stop-app.bat",
        "",
        "If a DIFFERENT application owns that port, change PORT in apps\api\.env."
    )
}
Ok "API port $ApiPort free"

# Fixed, never auto-incremented. -WebPort wins, else WEB_PORT from apps/api/.env,
# else 5175. Two checkouts on one machine must each PIN their own port: silently
# drifting 5175 -> 5176 is how you end up testing the sibling checkout.
if ($WebPort -eq 0) {
    if ($EnvMap['WEB_PORT']) { $WebPort = [int]$EnvMap['WEB_PORT'] } else { $WebPort = 5175 }
}
if (Test-PortBusy $WebPort) {
    Die "Web port $WebPort is already in use by $(Get-PortOwner $WebPort)." @(
        "Stop it first:  stop-app.bat",
        "Or pin a different one:  start-app.bat -WebPort 5180",
        "To make that permanent, set WEB_PORT in apps\api\.env."
    )
}
Ok "Web port $WebPort free"

# ---------------------------------------------------------------- 7. npm install
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

# ---------------------------------------------------------------- 8. build shared packages
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

# ---------------------------------------------------------------- 9. prisma client
Step "Generating Prisma client"
# Skip when the generated client is already newer than the schema. Regenerating
# rewrites query_engine-windows.dll.node, which fails with EPERM if ANY node
# process has it open - and on Windows that includes processes this script does
# not own (a test run, an editor's TS server, a sibling checkout sharing the
# node_modules). Not rewriting an already-current client removes the whole
# failure mode from the common re-run path.
$schemaFile = Join-Path $RepoRoot 'apps\api\prisma\schema.prisma'
$clientIdx  = Join-Path $RepoRoot 'node_modules\.prisma\client\index.js'
$clientFresh = (Test-Path $clientIdx) -and (Test-Path $schemaFile) -and
               ((Get-Item $clientIdx).LastWriteTime -ge (Get-Item $schemaFile).LastWriteTime)

if ($clientFresh) {
    Ok "Prisma client already current (schema unchanged)"
} else {
    Push-Location (Join-Path $RepoRoot 'apps\api')
    $genOut = & npx prisma generate 2>&1
    $genOk = ($LASTEXITCODE -eq 0)
    Pop-Location
    if (-not $genOk) {
        $text = ($genOut | Out-String)
        if ($text -match 'EPERM') {
            # Name the real cause. "Run it manually" is useless advice here -
            # run by hand it fails identically until the holder is stopped.
            Die "prisma generate could not replace the query engine (EPERM - file locked)." @(
                "A running Node process is holding node_modules\.prisma\client\query_engine-windows.dll.node.",
                "Usual suspects: an API started outside this script (tsx watch), a vitest run,",
                "or an editor TypeScript server.",
                "",
                "  1. start-app.bat -Restart     (stops this checkout, then starts)",
                "  2. If it persists:  powershell -Command ""Get-Process node | Stop-Process -Force""",
                "  3. Re-run start-app.bat"
            )
        }
        Write-Host $text
        Die "prisma generate failed." @("See the output above, then:  cd apps\api && npx prisma generate")
    }
    Ok "Prisma client ready"
}

# ---------------------------------------------------------------- 10. extensions
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

# ---------------------------------------------------------------- 11. migrations
Step "Applying database migrations"
Push-Location (Join-Path $RepoRoot 'apps\api')
& npx prisma migrate deploy
$migOk = ($LASTEXITCODE -eq 0)
Pop-Location
if (-not $migOk) { Die "prisma migrate deploy failed." @("Review the output above. Do NOT use 'prisma db push' on a populated database.") }
Ok "Schema up to date"

# ---------------------------------------------------------------- 12. seed
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

# ---------------------------------------------------------------- 13. TLS certs
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
