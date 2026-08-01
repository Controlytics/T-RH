@echo off
REM ===========================================================================
REM  compliance-core - deploy a branch to the AWS instance
REM
REM  It pushes nothing. It tells the SERVER to fetch a branch from origin,
REM  rebuild, and restart. So the order is always:
REM      1. git push          (from your machine)
REM      2. deploy-to-aws.bat (this file)
REM
REM  BRANCH SELECTION - read this before deploying
REM  ---------------------------------------------
REM  This deploys the branch you are CURRENTLY ON locally, and shows you which
REM  one before doing anything. Override it by passing a name:
REM
REM      deploy-to-aws.bat                    deploy the current local branch
REM      deploy-to-aws.bat final-user-management    deploy a specific branch
REM
REM  Why it works this way: the branch used to be hard-defaulted inside
REM  scripts\deploy-on-instance.ps1. After the 2026-08-01 split that default
REM  (final-user-management) became a FROZEN BACKUP, so a double-click would
REM  have silently deployed month-old code and reported success. The branch is
REM  now always explicit and always shown.
REM
REM  Requires: aws login (credentials expire every few hours).
REM ===========================================================================

setlocal
cd /d "%~dp0"
set "AWS=C:\Program Files\Amazon\AWSCLIV2\aws.exe"
set "INSTANCE=i-0be63a2077d4a82e0"

if not exist "%AWS%" (
    echo   FAILED: AWS CLI not found at %AWS%
    echo   Install it:  winget install Amazon.AWSCLI
    pause & exit /b 1
)

REM ---- work out which branch to deploy ------------------------------------
set "BRANCH="
if not "%~1"=="" (
    set "BRANCH=%~1"
) else (
    for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
)

if "%BRANCH%"=="" (
    echo   FAILED: could not determine the branch.
    echo   Pass one explicitly:  deploy-to-aws.bat ^<branch-name^>
    pause & exit /b 1
)

REM ---- refuse to deploy something the server cannot fetch ------------------
git ls-remote --exit-code --heads origin "%BRANCH%" >nul 2>&1
if errorlevel 1 (
    echo.
    echo   FAILED: branch "%BRANCH%" does not exist on origin.
    echo   The server pulls from origin, so push it first:
    echo.
    echo       git push -u origin %BRANCH%
    echo.
    pause & exit /b 1
)

REM ---- warn if local has commits that were never pushed --------------------
set "AHEAD=0"
for /f "delims=" %%a in ('git rev-list --count origin/%BRANCH%..%BRANCH% 2^>nul') do set "AHEAD=%%a"

echo.
echo   ===================================================
echo    DEPLOY TO PRODUCTION
echo   ===================================================
echo.
echo     branch    %BRANCH%
echo     instance  %INSTANCE%
echo     target    https://13.204.15.17
echo.
if not "%AHEAD%"=="0" (
    echo     WARNING: %AHEAD% local commit^(s^) on %BRANCH% are NOT pushed.
    echo              The server pulls from origin, so those will NOT deploy.
    echo.
)
echo     The server will fetch this branch, rebuild, run any pending database
echo     migrations, and restart the service. A failed build stops BEFORE the
echo     restart, leaving the previous version running.
echo.
set /p "CONFIRM=  Deploy %BRANCH% to production? (y/N) "
if /i not "%CONFIRM%"=="y" (
    echo.
    echo   Cancelled. Nothing was sent.
    echo.
    pause & exit /b 0
)

echo.
echo   Checking AWS credentials...
"%AWS%" sts get-caller-identity --query Account --output text >nul 2>&1
if errorlevel 1 (
    echo.
    echo   NOT SIGNED IN ^(or the session expired^).
    echo   Run this first, then re-run deploy:
    echo.
    echo       "%AWS%" login
    echo.
    pause & exit /b 1
)

echo   Sending deploy command to %INSTANCE% ...
for /f "delims=" %%i in ('""%AWS%" ssm send-command --instance-ids %INSTANCE% --document-name AWS-RunPowerShellScript --timeout-seconds 3600 --parameters "commands=[\"& C:\\app\\compliance-core\\scripts\\deploy-on-instance.ps1 -Branch %BRANCH%\"]" --query "Command.CommandId" --output text"') do set "CMDID=%%i"

if "%CMDID%"=="" (
    echo   FAILED to send the command.
    pause & exit /b 1
)

echo   command id: %CMDID%
echo   Building on the server - this takes 1-4 minutes...
echo.

:WAIT
timeout /t 15 /nobreak >nul
for /f "delims=" %%s in ('""%AWS%" ssm get-command-invocation --command-id %CMDID% --instance-id %INSTANCE% --query "Status" --output text 2>nul"') do set "ST=%%s"
echo      status: %ST%
if "%ST%"=="InProgress" goto WAIT
if "%ST%"=="Pending" goto WAIT

echo.
echo   ---------------- server output ----------------
"%AWS%" ssm get-command-invocation --command-id %CMDID% --instance-id %INSTANCE% --query "StandardOutputContent" --output text
echo   -----------------------------------------------

if not "%ST%"=="Success" (
    echo.
    echo   DEPLOY FAILED ^(%ST%^). Error output:
    "%AWS%" ssm get-command-invocation --command-id %CMDID% --instance-id %INSTANCE% --query "StandardErrorContent" --output text
    echo.
    echo   The previous version is still running - a failed build does not
    echo   restart the service.
    pause & exit /b 1
)

echo.
echo   Done.  Deployed %BRANCH% to https://13.204.15.17
echo.
pause
endlocal
