@echo off
rem AgentFlow: double-click this file. It starts the server and opens the app in your browser.
rem Everything runs on THIS computer. Data is kept in data\db.json (backups in data\backups). No online service is needed.
rem Close this window (or press Ctrl+C) to stop the app.
cd /d "%~dp0"
title AgentFlow

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org , then double-click this file again.
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=3000
echo Starting AgentFlow on http://localhost:%PORT% ...
echo Sign in with a demo account from README.md, for example super@agentflow.test / AgentFlow#2026
echo.
if not "%AF_NO_BROWSER%"=="1" start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"
node server.js
echo.
echo AgentFlow stopped. If this was not expected, read the message above (for example "address already in use" means set another port: set PORT=3100 and run again).
pause
