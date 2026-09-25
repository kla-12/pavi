@echo off
title Ruflo Public Mobile Tunnel
color 0A
cls
echo ========================================================
echo      RUFLO / PAVI - PUBLIC INTERNET TUNNEL FOR PHONE
echo ========================================================
echo.
echo [*] Starting secure tunnel on port 3000...
echo [*] Make sure the Ruflo server (mobile_launch.bat) is running first!
echo.
echo Tunnel URL will appear below:
echo --------------------------------------------------------
cd /d "%~dp0dashboard"
node ./node_modules/localtunnel/bin/lt.js --port 3000
pause
