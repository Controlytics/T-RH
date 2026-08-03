@echo off
REM ===========================================================================
REM  compliance-core - stop all dev services
REM
REM  Stops whatever this checkout started (API + web dev server), identified by
REM  listening port AND by the process belonging to this repo folder - so a
REM  second checkout running on neighbouring ports is left alone.
REM
REM  PostgreSQL is deliberately left running: it is a shared Windows service.
REM ===========================================================================

setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-app.ps1" %*

echo.
pause
endlocal
