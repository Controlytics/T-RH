@echo off
REM ===========================================================================
REM  compliance-core - restart
REM
REM  Stops whatever THIS checkout is running, then starts it again. Use this
REM  after pulling or after changing code the API does not hot-reload.
REM
REM  Why this exists as its own file:
REM
REM  Running start-app.bat while the app is already up correctly refuses -
REM  "API port 3001 is already in use" - and starts nothing. That is the right
REM  answer to "start", and the wrong answer to what people usually mean, which
REM  is "pick up my changes". Worse, a running `tsx watch` holds
REM  node_modules\.prisma\client\query_engine-windows.dll.node, so the
REM  prisma generate step fails EPERM and the script dies before it launches
REM  anything at all - leaving you with nothing running and a puzzling error.
REM
REM  This is exactly start-app.bat -Restart. It is a separate file only so it
REM  can be double-clicked.
REM
REM  It stops ONLY processes belonging to this repository folder, so a second
REM  checkout on neighbouring ports keeps running. PostgreSQL is left alone -
REM  it is a shared Windows service.
REM ===========================================================================

setlocal
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
    echo.
    echo   FAILED: Windows PowerShell was not found on PATH.
    echo   This launcher needs it. Repair your Windows installation
    echo   or run the steps in LOCAL_SETUP_WINDOWS.md by hand.
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-app.ps1" -Restart %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo   Restart did not complete cleanly ^(exit code %RC%^).
    echo.
    pause
)

endlocal
exit /b %RC%
