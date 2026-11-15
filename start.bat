@echo off
REM Double-click this file to start the info-gap chatbot.
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env" >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
pause
