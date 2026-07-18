@echo off
:: ============================================================================
:: start-digilog.bat - DEV-MODE launcher for DigiLog on Windows
:: ============================================================================
::
:: This is the LOCAL DEVELOPMENT launcher: it runs the API in `tsx watch`
:: mode (auto-reload on source changes) and the frontend in `vite dev` mode
:: against `apps/web/src` (HMR enabled).
::
:: For a managed-service production-style deploy on Windows, see:
::   - DEPLOY-WINDOWS.md  - install-on-target.ps1 + the NSSM stopgap in section 7
::   - scripts/install-services-phase5.ps1  - registers DigiLogAPI-Phase5 +
::                                            DigiLogWeb-Phase5 NSSM services
::
:: Resolves paths relative to this .bat file, so it works whether the repo
:: is checked out at C:\Users\hello\... or anywhere else.
:: ============================================================================
setlocal enabledelayedexpansion
if not "%~1"=="wrapped" (
    cmd /k ""%~f0" wrapped"
    exit /b
)

:: Repo root = directory containing this .bat (with trailing backslash stripped)
set REPO_ROOT=%~dp0
if "%REPO_ROOT:~-1%"=="\" set REPO_ROOT=%REPO_ROOT:~0,-1%

title DigiLog - Starting All Services
color 0A
echo.
echo  ============================================
echo   DigiLog - Starting Dev Services
echo   Repo: %REPO_ROOT%
echo  ============================================
echo.

:: --- 0. Rebuild @digilog/shared (permissions, sidebar items, reauth actions) ---
:: These live as compiled TypeScript constants in packages\shared\dist and are
:: bundled into BOTH the API (read by tsx) and the Web build (bundled by Vite).
:: Editing the source .ts does NOTHING until dist is recompiled, which is why a
:: newly-added permission or sidebar item "doesn't show up". Rebuild on every
:: launch so that can't happen. Non-fatal: if it fails to compile, the apps run
:: on the LAST good build and we print the error to fix.
echo [0/5] Rebuilding @digilog/shared (permissions, sidebar items, reauth)...
pushd "%REPO_ROOT%\packages\shared"
call npm run build
if errorlevel 1 (
    echo       [WARN] @digilog/shared failed to compile - apps will run on the
    echo              LAST good build. Fix the TS error above, then re-run.
) else (
    echo       @digilog/shared rebuilt OK
)
popd

:: --- 1. Redis (Memurai) is now OPTIONAL ---
:: Phase 2 of windows-friendly-rewrite moved the job queue to graphile-worker
:: on Postgres, so Redis is no longer required for queue work. It's still used
:: for non-queue pub/sub (WS events, RPC routing, pipeline tracer); the API
:: silently degrades when those subscribers can't connect. So we WARN if it's
:: missing rather than FATAL.
echo [1/5] Checking Redis (Memurai - optional)...
redis-cli -p 6379 ping >NUL 2>&1
if errorlevel 1 (
    net start Memurai >NUL 2>&1
    timeout /t 2 /nobreak >NUL
    redis-cli -p 6379 ping >NUL 2>&1
    if errorlevel 1 (
        echo       [WARN] Memurai not responding on 6379. WS pub/sub + pipeline
        echo              tracing will degrade. Queue work still runs on Postgres.
        echo              To install: winget install Memurai.MemuraiDeveloper
    ) else (
        echo       Memurai started OK
    )
) else (
    echo       Memurai OK
)

:: --- 2. MQTT broker (Mosquitto if USE_MOSQUITTO=true, else legacy EMQX) ---
set USE_MOSQUITTO=
for /f "tokens=2 delims==" %%a in ('findstr /B /I "USE_MOSQUITTO=" "%REPO_ROOT%\apps\api\.env" 2^>nul') do set USE_MOSQUITTO=%%a

if /i "%USE_MOSQUITTO%"=="true" (
    echo [2/5] Starting Mosquitto MQTT Broker [USE_MOSQUITTO=true]...
    sc query mosquitto | findstr /I "RUNNING" >NUL 2>&1
    if !ERRORLEVEL! == 0 (
        echo       Mosquitto already running - skipping
    ) else (
        net start mosquitto >NUL 2>&1
        if !ERRORLEVEL! == 0 (
            echo       Mosquitto started on port 1883
        ) else (
            echo       [WARN] Mosquitto failed to start. Run elevated:
            echo              powershell -ExecutionPolicy Bypass -File scripts\install-mosquitto.ps1
        )
    )
) else (
    echo [2/5] Skipping Mosquitto - USE_MOSQUITTO is not set to true.
    echo       Legacy EMQX webhook auth is still wired in mqtt-auth-routes.ts;
    echo       the API will run without MQTT ingest until you flip USE_MOSQUITTO=true
    echo       in apps\api\.env.
)

:: --- 3. PostgreSQL (required) ---
echo [3/5] Checking PostgreSQL...
"C:\Program Files\PostgreSQL\18\bin\pg_isready.exe" -h localhost -p 5432 >NUL 2>&1
if %ERRORLEVEL%==0 (
    echo       PostgreSQL running on port 5432
) else (
    echo       [WARN] PostgreSQL is NOT running on 5432.
    echo              Start it via services.msc - service: postgresql-x64-18
    echo              The API will refuse to boot without it.
)

:: --- 4. Backend API in dev mode (tsx watch) ---
echo [4/5] Starting Backend API (Fastify, dev/tsx watch)...
start "DigiLog API" cmd /k "cd /d ""%REPO_ROOT%\apps\api"" && title DigiLog API - Port 3000 HTTPS && set API_HTTPS=true&&npx tsx watch src/app.ts"
timeout /t 8 /nobreak >NUL
echo       API starting on https://localhost:3000

:: --- 5. Frontend in dev mode (vite --host) ---
echo [5/5] Starting Frontend (Vite dev server)...
:: Kill any existing process on 5175 so we don't double-bind
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5175" ^| findstr "LISTENING"') do (
    echo       Killing existing Vite process PID %%a ...
    taskkill /F /PID %%a >NUL 2>&1
)
timeout /t 2 /nobreak >NUL
start "DigiLog Web" cmd /k "cd /d ""%REPO_ROOT%\apps\web"" && title DigiLog Web - Port 5175 && npx vite --host"
timeout /t 5 /nobreak >NUL
echo       Frontend starting on https://localhost:5175

:: --- Wait for API health ---
echo.
echo  Waiting for API to respond on /api/health...
set API_READY=0
for /L %%i in (1,1,40) do (
    if !API_READY! == 0 (
        curl -sk -f https://localhost:3000/api/health >NUL 2>&1
        if !ERRORLEVEL! == 0 (
            set API_READY=1
            echo       API is ready!
        ) else (
            timeout /t 3 /nobreak >NUL
        )
    )
)
if !API_READY! == 0 (
    echo       [WARN] API did not respond within 120s. Check the API window for errors.
)

:: --- Wait for Vite dev server ---
echo  Waiting for Frontend to respond on /...
set VITE_READY=0
for /L %%i in (1,1,30) do (
    if !VITE_READY! == 0 (
        curl -sk -f https://localhost:5175/ >NUL 2>&1
        if !ERRORLEVEL! == 0 (
            set VITE_READY=1
            echo       Frontend is ready!
        ) else (
            timeout /t 2 /nobreak >NUL
        )
    )
)

:: Extra settle time for tsx watch to finish compilation
timeout /t 3 /nobreak >NUL

:: --- Done ---
echo.
echo  ============================================
echo   All dev services started!
echo  ============================================
echo.
echo   Frontend:  https://localhost:5175
echo   API:       https://localhost:3000
echo   Swagger:   https://localhost:3000/docs
echo   Mosquitto: tcp://localhost:1883 (no web dashboard - use POST /api/internal/mqtt/refresh-acl)
echo   Login:     superadmin / Admin@123
echo.
echo  ============================================
echo.

start https://localhost:5175

echo Press any key to exit this window (services keep running)...
pause >NUL
