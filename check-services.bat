@echo off
setlocal enabledelayedexpansion
title DigiLog - Service Health Check
color 0F

REM ============================================================
REM  DigiLog - On-Premise Service Health Check
REM  Double-click to run. No admin needed (read-only checks).
REM  Shows: (1) Windows services  (2) Ports  (3) API health
REM
REM  Healthy = service RUNNING + port LISTENING + health 200.
REM  If your install used different service names, edit the
REM  KNOWN_SERVICES line below.
REM ============================================================

echo.
echo ============================================================
echo    DigiLog - On-Premise Service Health Check
echo    %date%  %time%
echo ============================================================
echo.

REM ---------- 1. WINDOWS SERVICES ----------
echo [1/4]  DIGILOG / DATABASE SERVICES  (the ones this app needs)
echo ------------------------------------------------------------

REM Auto-discover any service whose NAME contains digilog or postgres
set "FOUND=0"
for /f "tokens=2 delims=:" %%N in ('sc query state^= all ^| findstr /I "SERVICE_NAME" ^| findstr /I "digilog postgres"') do (
    set "SVC=%%N"
    set "SVC=!SVC: =!"
    set "FOUND=1"
    sc query "!SVC!" | findstr /I "RUNNING" >nul 2>&1
    if !errorlevel!==0 (
        echo    [ RUNNING ]   !SVC!
    ) else (
        echo    [ STOPPED ]   !SVC!   ^<-- not running
    )
)
if "!FOUND!"=="0" (
    echo    [ ! ] No DigiLog/PostgreSQL services found by name.
    echo          Either not installed as services, or named differently.
    echo          Open services.msc and look for your names, then edit this file.
)
echo.

REM ---------- 2. PORTS ----------
echo [2/4]  PORTS  ( LISTENING = the app is actually accepting connections )
echo ------------------------------------------------------------
call :checkport 3000 "API      (Fastify backend)"
call :checkport 5432 "Postgres (database)"
call :checkport 5175 "Web      (frontend)"
echo.

REM ---------- 3. API HEALTH ENDPOINT ----------
echo [3/4]  API HEALTH ENDPOINT
echo ------------------------------------------------------------
where curl >nul 2>&1
if !errorlevel!==0 (
    for /f %%H in ('curl -sk -o NUL -w "%%{http_code}" https://localhost:3000/api/health 2^>NUL') do set "CODE=%%H"
    if "!CODE!"=="200" (
        echo    [ OK ]    https://localhost:3000/api/health  returned 200
    ) else (
        if "!CODE!"=="000" (
            echo    [ DOWN ]  API not responding  ^(no reply^) - service stopped or crashed
        ) else (
            echo    [ WARN ]  https://localhost:3000/api/health  returned !CODE!
        )
    )
) else (
    echo    curl not found on this machine - skipping health probe.
)
echo.

REM ---------- 4. ALL RUNNING WINDOWS SERVICES ----------
echo [4/4]  ALL RUNNING WINDOWS SERVICES  (everything currently started)
echo ------------------------------------------------------------
net start
echo.

echo ============================================================
echo    Legend:  RUNNING + LISTENING + 200  =  healthy
echo    - Service STOPPED?  -^> services.msc, right-click, Start
echo    - Port not up?      -^> the service is stopped or crashed
echo    - Health not 200?   -^> check logs\DigiLogAPI-Phase5.err.log
echo    NOTE: the PM cron / job queue runs INSIDE the API service.
echo          If the API is RUNNING, the background jobs run too.
echo ============================================================
echo.
pause
exit /b 0

REM ---------- helper: check a listening TCP port ----------
REM  NOTE: status is built in a variable and echoed OUTSIDE any (..) block
REM  on purpose - the description text contains ")" which would otherwise
REM  break a parenthesized if/else. Do not "simplify" this back into an
REM  if ( echo ) else ( echo ) form.
:checkport
set "PSTATUS=[ not up    ]"
netstat -ano | findstr ":%~1 " | findstr /I "LISTENING" >nul 2>&1
if !errorlevel!==0 set "PSTATUS=[ LISTENING ]"
echo    !PSTATUS!   port %~1   - %~2
exit /b 0
