@echo off
setlocal
cd /d "%~dp0"
title GGNA Relief Studio - Web Local
if not exist "engine\python_embeded\python.exe" (
 echo Chua giai nen day du bo GGNA. Hay giai nen toan bo ZIP truoc.
 pause
 exit /b 1
)
"engine\python_embeded\python.exe" -B -X utf8 -s "app\ggna_server.py" start
if errorlevel 1 pause
endlocal
