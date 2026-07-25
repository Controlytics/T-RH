@echo off
REM ===========================================================================
REM  compliance-core - deploy the current branch to the AWS instance
REM
REM  Double-click, or run from a terminal. It pushes nothing: it tells the
REM  SERVER to pull whatever is already on origin/final-user-management, then
REM  rebuild and restart.
REM
REM  So the order is always:
REM      1. git push          (from your machine)
REM      2. deploy-to-aws.bat (this file)
REM
REM  Requires: aws login (credentials expire every few hours).
REM ===========================================================================

setlocal
set "AWS=C:\Program Files\Amazon\AWSCLIV2\aws.exe"
set "INSTANCE=i-0be63a2077d4a82e0"

if not exist "%AWS%" (
    echo   FAILED: AWS CLI not found at %AWS%
    echo   Install it:  winget install Amazon.AWSCLI
    pause & exit /b 1
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
for /f "delims=" %%i in ('""%AWS%" ssm send-command --instance-ids %INSTANCE% --document-name AWS-RunPowerShellScript --timeout-seconds 3600 --parameters "commands=[\"& C:\\app\\compliance-core\\scripts\\deploy-on-instance.ps1\"]" --query "Command.CommandId" --output text"') do set "CMDID=%%i"

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
echo   Done.  https://13.204.15.17
echo.
pause
endlocal
