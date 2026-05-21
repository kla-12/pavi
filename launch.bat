@echo off
title Ruflo V3.5 Launch Pad
echo 🌊 Launching Ruflo v3.5: Enterprise AI Orchestration Platform...
echo.

:: ── Step 1: Start Ollama if not already running ─────────────────────────
echo [*] Checking if Ollama is running...
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel% == 0 goto :ollama_ok

echo [*] Ollama not detected. Starting Ollama...

if exist "%~dp0ollama\ollama.exe" (
    echo [*] Starting local Ollama...
    start "Ollama Server" "%~dp0ollama\run_server.bat"
    goto :ollama_started
)

where ollama >nul 2>&1
if %errorlevel% neq 0 goto :ollama_missing

echo [*] Starting system Ollama...
start "Ollama Server" cmd /c "ollama serve"

:ollama_started
echo [*] Waiting for Ollama to boot (8s)...
timeout /t 8 /nobreak > nul
echo [✓] Ollama started.
goto :ollama_done

:ollama_ok
echo [✓] Ollama is already running on port 11434.
goto :ollama_done

:ollama_missing
echo [!] WARNING: Ollama is not installed or not in PATH, and local Ollama was not found.
echo [!] Install from https://ollama.com — skipping for now.
goto :ollama_done

:ollama_done
echo.

:: ── Step 2: Navigate to dashboard ───────────────────────────────────────
cd /d "%~dp0dashboard"

if not exist "node_modules\" (
    echo [!] node_modules not found. Running npm install...
    call npm install
)

:: ── Step 3: Start the server ────────────────────────────────────────────
echo [*] Starting Backend Server on port 3000...
start "Ruflo Backend" cmd /c "node server.js"

echo [*] Waiting for server to initialize (5s)...
timeout /t 5 /nobreak > nul

:: ── Step 4: Open the Dashboard ──────────────────────────────────────────
echo [*] Opening Dashboard in browser...
start "" "http://localhost:3000"

echo.
echo ✅ Ruflo is now running!
echo    Ollama:    http://127.0.0.1:11434
echo    Dashboard: http://localhost:3000
echo.
echo You can close this window, but keep the "Ruflo Backend" and "Ollama Server" windows open.
pause
