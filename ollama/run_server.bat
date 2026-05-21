@echo off
set "OLLAMA_MODELS=%~dp0models"
cd /d "%~dp0"
ollama.exe serve
