@echo off
rem The tagger: a local model tags a fair sample of the corpus on all ten layers (tag.py, scheme.py).
rem Close this window to stop it. Run this file again and it carries on where it stopped.
title Tagging (gemma4:12b)
cd /d "%~dp0"
python tag.py --model gemma4:12b --lines 5000
pause
