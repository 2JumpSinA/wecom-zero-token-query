@echo off
rem ============================================================
rem  Register the WecomCollect scheduled task (optional path).
rem
rem  The collector normally runs INSIDE the fastlane daemon
rem  (commands.json -> collect.enabled=true), so you do NOT need
rem  this task. Use it only if you prefer a system-level task:
rem  in that case set "collect.enabled": false first, otherwise
rem  the two schedulers both collect (harmless, but redundant).
rem
rem  Why a .cmd wrapper: registering a task in the root folder
rem  needs elevation, and this file just relaunches the .ps1 with
rem  a UAC prompt. ASCII-only on purpose (cmd.exe reads a .bat in
rem  the OEM code page; non-ASCII would get mangled).
rem ============================================================
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-collect-task.ps1"
echo.
pause
endlocal
