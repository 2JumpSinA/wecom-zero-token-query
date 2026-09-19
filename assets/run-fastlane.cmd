@echo off
rem ============================================================
rem  wecom-fastlane launcher
rem  ASCII-only on purpose: cmd.exe reads a .bat in the OEM code page
rem  (GBK here), so multi-byte comments get mangled and can swallow the CR,
rem  merging the next command into the rem line and breaking the script.
rem
rem  Usage: run-fastlane.cmd                 start the daemon (visible)
rem         run-fastlane.cmd --check         self-check, no network
rem         run-fastlane.cmd --routes        show per-group command routing
rem         run-fastlane.cmd --selftest      run commands locally, nothing sent
rem         run-fastlane.cmd --list          list the command table
rem  Hidden start: start-hidden.vbs
rem ============================================================
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
if not exist "logs" mkdir "logs"

rem Prefer the node on PATH; fall back to the usual install locations.
set "NODE="
for %%I in (node.exe) do if not defined NODE set "NODE=%%~$PATH:I"
if not defined NODE if exist "D:\nodejs\node.exe" set "NODE=D:\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE set "NODE=node"

"%NODE%" "%ROOT%\fastlane.mjs" %*
set "RC=%ERRORLEVEL%"
echo [launcher] %DATE% %TIME% exit=%RC% >> "logs\launcher.log"
endlocal & exit /b %RC%
