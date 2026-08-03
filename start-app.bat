@echo off
REM ===========================================================================
REM  compliance-core - one-click launcher
REM
REM  Double-click this file. It verifies every dependency, repairs what it
REM  safely can, then starts the API and the web dev server.
REM
REM  Safe to run repeatedly - every step is skipped when already satisfied.
REM
REM  Optional:
REM     start-app.bat -WebPort 5180      use a specific web port
REM     start-app.bat -SkipBrowser       do not open the browser
REM
REM  The real logic lives in scripts\start-app.ps1. Batch cannot reliably
REM  parse DATABASE_URL, poll an HTTPS endpoint, or inspect Windows services,
REM  so this file is a thin launcher for that script.
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

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-app.ps1" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo   Startup did not complete cleanly ^(exit code %RC%^).
    echo.
    pause
)

endlocal
exit /b %RC%
