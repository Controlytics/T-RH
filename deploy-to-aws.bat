@echo off
REM ===========================================================================
REM  compliance-core - deploy a branch to the AWS instance (Ubuntu, since 2026-09-18)
REM
REM  Double-click, or run from a terminal:
REM      deploy-to-aws.bat            deploys the branch you are CURRENTLY on
REM      deploy-to-aws.bat <branch>   deploys that branch
REM
REM  It pushes nothing: it tells the SERVER to fetch origin/<branch>, then
REM  rebuild, migrate and restart (scripts/aws/deploy-on-ubuntu.sh). So:
REM      1. git push          (from your machine)
REM      2. deploy-to-aws.bat (this file)
REM
REM  Requires: aws login (credentials expire every few hours).
REM ===========================================================================

setlocal
set "AWS=C:\Program Files\Amazon\AWSCLIV2\aws.exe"
set "INSTANCE=i-0b13dae53e9113f1d"
set "APP_URL=https://13.204.15.17"

if not exist "%AWS%" (
    echo   FAILED: AWS CLI not found at %AWS%
    echo   Install it:  winget install Amazon.AWSCLI
    pause & exit /b 1
)

REM ---- which branch ---------------------------------------------------------
set "BRANCH=%~1"
if "%BRANCH%"=="" (
    for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
)
if "%BRANCH%"=="" (
    echo   FAILED: could not determine the branch. Pass it: deploy-to-aws.bat ^<branch^>
    pause & exit /b 1
)
if "%BRANCH%"=="final-user-management" (
    echo   REFUSED: final-user-management is a FROZEN backup, not a deployable branch.
    pause & exit /b 1
)

REM The laptop pushes to "trh" (Controlytics/T-RH) since 2026-10-06; "origin" here is the
REM FROZEN old repo. The server's own "origin" is T-RH, so trh is what it deploys.
set "REMOTE=trh"
git ls-remote --exit-code --heads %REMOTE% "%BRANCH%" >nul 2>&1
if errorlevel 1 (
    echo   REFUSED: %REMOTE% has no branch "%BRANCH%". Push it first:  git push -u %REMOTE% %BRANCH%
    pause & exit /b 1
)
git fetch -q %REMOTE% "%BRANCH%" >nul 2>&1
for /f "delims=" %%n in ('git rev-list --count "%REMOTE%/%BRANCH%..%BRANCH%" 2^>nul') do set "UNPUSHED=%%n"
if not "%UNPUSHED%"=="" if not "%UNPUSHED%"=="0" (
    echo   WARNING: %BRANCH% has %UNPUSHED% commit^(s^) not on %REMOTE%. The server deploys what is on GitHub.
)

echo.
echo   Branch to deploy:  %BRANCH%
echo   Instance:          %INSTANCE%   (%APP_URL%)
set /p "GO=  Continue? [y/N] "
if /i not "%GO%"=="y" ( echo   Cancelled. & exit /b 1 )

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

REM cmd.exe cannot pass bracket/quote JSON inline to the AWS CLI (it mangles the
REM quotes), so the --parameters value is written to a small JSON file first.
set "PARAMFILE=%TEMP%\cc-deploy-params.json"
> "%PARAMFILE%" echo {"commands":["/opt/digilog/app/scripts/aws/deploy-on-ubuntu.sh --branch %BRANCH%"]}

echo   Sending deploy command to %INSTANCE% ...
for /f "delims=" %%i in ('""%AWS%" ssm send-command --instance-ids %INSTANCE% --document-name AWS-RunShellScript --timeout-seconds 3600 --parameters "file://%PARAMFILE%" --query "Command.CommandId" --output text"') do set "CMDID=%%i"

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
echo   Done.  %APP_URL%
echo.
pause
endlocal
