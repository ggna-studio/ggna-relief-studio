@echo off
setlocal
cd /d "%~dp0"
title Dung GGNA Relief Studio
echo Dung web va GPU do phien GGNA nay mo. Tac vu anh dang chay se dung.
"engine\python_embeded\python.exe" -B -X utf8 -s "app\ggna_server.py" stop
if errorlevel 1 pause
endlocal
