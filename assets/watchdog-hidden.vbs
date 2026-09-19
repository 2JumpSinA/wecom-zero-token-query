' Launch the fastlane watchdog with NO console window.
'
' Why this file exists: a scheduled task whose action is powershell.exe gets a
' console window, and -WindowStyle Hidden does NOT prevent that first flash -
' the console is created before PowerShell can hide it. wscript.exe is a
' GUI-subsystem host: it never creates a console at all, and window style 0
' hides the PowerShell window it starts.
'
' Why it WAITS (True) and propagates the exit code: if we fire and forget, the
' task reports "finished" instantly and LastTaskResult always shows 0 - a
' number that proves nothing. Waiting keeps the task honestly "Running" while
' the check runs, and makes LastTaskResult the watchdog's real exit code.
Option Explicit

Dim sh, fso, root, q, rc
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)

rc = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & q & root & "\fastlane-watchdog.ps1" & q, 0, True)

WScript.Quit rc
