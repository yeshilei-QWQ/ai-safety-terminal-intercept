@echo off
rem ASTI autostart runner. Called by asti-hidden.vbs, or run manually.
rem Logs to %USERPROFILE%\.asti\asti.log
setlocal
set "REPO=%~dp0.."
set "LOGDIR=%USERPROFILE%\.asti"
set "LOG=%LOGDIR%\asti.log"
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1

cd /d "%REPO%"
echo [%date% %time%] asti starting (node=%NODE%) >> "%LOG%"
"%NODE%" src\cli\index.ts run --port 8787 >> "%LOG%" 2>&1
echo [%date% %time%] asti exited, errorlevel=%errorlevel% >> "%LOG%"
