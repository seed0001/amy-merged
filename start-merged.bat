@echo off
rem The merged Amy: new champ's body with the Python Amy as her brain. No language model (BRAIN=amy).
rem Her Mind page opens in the browser once she's up: http://localhost:3100/mind.html
rem Dashboard: http://localhost:3100   Her memory for now: brain\data\amy-chat.db (a test memory).
rem She uses the same Discord login as the live new champ Amy: never run both at once.
rem She runs in a loop, so she can be restarted from her dashboard (POST /api/restart) and comes back on her own.
rem Close this window to stop her completely.
title Amy merged (no LLM)
cd /d "%~dp0body"
set BRAIN=amy
set AMY_BRAIN_DB=data/amy-chat.db
rem CHAMP_SUPERVISED tells her she will be brought back, so she may restart herself.
set CHAMP_SUPERVISED=1

rem ---- Her Mind page opens once she's up ----
start "" /min cmd /c "timeout /t 8 /nobreak >nul & start http://localhost:3100/mind.html"

:run
echo [*] Starting the merged Amy... (close this window to quit completely)
node src/index.js
echo [!] She stopped. Starting her again in 3 seconds - close the window to quit.
timeout /t 3 /nobreak >nul
goto run
