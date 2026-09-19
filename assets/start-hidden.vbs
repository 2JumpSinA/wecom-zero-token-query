' Launch run-fastlane.cmd with NO visible console window.
'
' Why: a scheduled task or a double-click whose action is a .bat gets a
' console window. wscript.exe is a GUI-subsystem host, never creates a
' console, and window style 0 keeps the child cmd.exe hidden too.
' Fire-and-forget (False) on purpose: the daemon is long-lived, so the
' launcher must not sit and wait for it.
Option Explicit

Dim sh, fso, root, q
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root

q = Chr(34)
sh.Run "cmd.exe /c " & q & q & root & "\run-fastlane.cmd" & q & q, 0, False
