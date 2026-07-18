@echo off
title DigiLog - Stopping All Services
color 0C
echo.
echo  ============================================
echo   DigiLog - Stopping All Services
echo  ============================================
echo.

echo [1/4] Stopping Frontend (Vite)...
taskkill /FI "WINDOWTITLE eq DigiLog Web*" /F >NUL 2>&1
echo       Done

echo [2/4] Stopping Backend API...
taskkill /FI "WINDOWTITLE eq DigiLog API*" /F >NUL 2>&1
echo       Done

echo [3/4] Stopping Redis...
taskkill /IM redis-server.exe /F >NUL 2>&1
echo       Done

echo [4/4] Stopping EMQX...
"C:\Users\hello\emqx\bin\emqx.cmd" stop >NUL 2>&1
echo       Done

echo.
echo  All services stopped.
echo.
pause
