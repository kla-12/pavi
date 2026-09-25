@echo off
title Ruflo Mobile & Web Launcher
color 0B
cls
echo ========================================================
echo       RUFLO / PAVI - PHONE & WEB LAUNCH PAD
echo ========================================================
echo.

:: Detect local IPv4
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
    set IP=%%a
    goto :ip_found
)
:ip_found
:: Trim leading space
set IP=%IP: =%

echo [*] Local IP detected: %IP%
echo.

:: Step 1: Start Ollama if available
echo [*] Checking Ollama AI status...
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% == 0 (
    echo [OK] Ollama is active.
) else (
    where ollama >nul 2>&1
    if %errorlevel% == 0 (
        echo [*] Starting Ollama in background...
        start "Ollama Server" /min cmd /c "ollama serve"
        timeout /t 5 /nobreak > nul
    ) else (
        echo [!] Ollama not found in PATH (Skip if using remote cloud models).
    )
)
echo.

:: Step 2: Start Dashboard Server
cd /d "%~dp0dashboard"
if not exist "node_modules\" (
    echo [*] Installing dependencies (first run only)...
    call npm install
)

echo [*] Starting Ruflo Server on port 3000...
start "Ruflo Dashboard Server" cmd /k "title Ruflo Server Logs && node server.js"
timeout /t 4 /nobreak > nul

cls
echo ========================================================
echo       RUFLO / PAVI IS RUNNING SUCCESSFULLY!
echo ========================================================
echo.
echo  [LAPTOP / PC DASHBOARD]:
echo    http://localhost:3000
echo.
echo  [PHONE / MOBILE ACCESS (Same Wi-Fi)]:
echo    http://%IP%:3000/mobile
echo.
echo  [PHONE LOGIN PIN]:
echo    123456
echo.
echo --------------------------------------------------------
echo  PHONE ME KAISE CHALAYE:
echo  1. Phone ko apne laptop wale SAME WI-FI se connect karein.
echo  2. Phone ke Chrome ya Safari me ye link open karein:
echo     http://%IP%:3000/mobile
echo  3. Pin poocha jaye to "123456" dalein.
echo  4. Browser menu me "Add to Home Screen" par tap karein taaki
echo     ye ek app (PWA) ki tarah aapki screen par aa jaye.
echo --------------------------------------------------------
echo.
echo Opening laptop dashboard now...
start "" "http://localhost:3000"

pause
