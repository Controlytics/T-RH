@echo off
REM ===========================================================================
REM  compliance-core - stop all dev services
REM
REM  Stops whatever this checkout started (API + web dev server), identified by
REM  listening port AND by the process belonging to this repo folder - so the
REM  sibling DigiLog checkout on 3000 / 5175 is left alone.
REM
REM  Run this before `prisma generate` or `npm ci`: a live dev server holds
REM  node_modules\.prisma\client\query_engine-windows.dll.node open, and both
REM  commands fail with EPERM while it does. `prisma generate` fails in a
REM  particularly nasty way - it leaves the OLD client in place, whose looser
REM  types can mask real type errors.
REM
REM  PostgreSQL is deliberately left running: it is a shared Windows service.
REM ===========================================================================

setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-app.ps1" %*

echo.
pause
endlocal
