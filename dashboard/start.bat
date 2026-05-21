@echo off
title Pavi Dashboard Server
echo Starting Pavi Dashboard Server...
echo Please do not close this window while using the dashboard.

:: ── Start ngrok tunnel (exposes port 3000 publicly for mobile QR access) ──
echo Starting ngrok tunnel on port 3000...
where ngrok >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    start "" /b cmd /c "ngrok http 3000 --log=stdout > nul 2>&1"
    echo ngrok started. Waiting for tunnel to be ready...
    timeout /t 4 /nobreak > nul
    echo Ngrok tunnel should be active. Scan the QR in the Mobile Connect tab.
) else (
    echo [WARN] ngrok not found in PATH. Install from https://ngrok.com/download
    echo        Mobile QR will use LAN IP as fallback.
)

:: Start the server in background, wait 3 seconds for it to bind, then open browser
start /b node server.js
timeout /t 3 /nobreak > nul
echo Server should be ready. Opening browser...
start "" "http://localhost:3000"

:: Keep the window open so you can see logs / errors
node server.js