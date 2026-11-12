@echo off
rem The tagging studio: open http://localhost:8790 to watch. Close this window to stop the studio (tagging keeps going).
title Tagging Studio
cd /d "%~dp0"
python studio.py --port 8790
pause
