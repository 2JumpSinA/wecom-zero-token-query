' Launch the snapshot collector (fastlane.mjs --collect) with NO console window.
'
' Why VBS instead of pointing the task straight at node.exe: node.exe is a
' console-subsystem program, so Task Scheduler flashes a black window every
' run -- the same reason watchdog-hidden.vbs exists. wscript.exe is a
' GUI-subsystem host: it never creates a console, and window style 0 hides the
' one the child would otherwise create.
'
' Why it WAITS (True) and propagates the exit code: a fire-and-forget Run makes
' the task report "finished, result 0" instantly, which proves nothing. Waiting
' keeps LastTaskResult equal to the collector's real exit code (0 = all sources
' collected, 1 = at least one failed), so the health check can trust it.
'
' ASCII ONLY on purpose: Windows Script Host reads a BOM-less .vbs as ANSI, so
' CJK comments would turn into mojibake (same lesson as the .ps1 files).
Option Explicit

Dim sh, fso, root, q, node, rc
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)

node = "D:\nodejs\node.exe"
If Not fso.FileExists(node) Then node = "node"

rc = sh.Run(q & node & q & " " & q & root & "\fastlane.mjs" & q & " --collect", 0, True)

WScript.Quit rc
