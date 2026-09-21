# Register the WecomCollect scheduled task = run "fastlane.mjs --collect" every
# 10 minutes with no console window (via collect-hidden.vbs).
#
# WHY THIS FILE EXISTS BUT IS NOT THE DEFAULT
#   The collector normally runs inside the fastlane daemon
#   (commands.json -> collect.enabled=true): the daemon is already resident, so
#   that path needs no elevation, no extra process and no console window, and it
#   lives inside the watchdog/heartbeat mechanism we already trust.
#   This script is the alternative: a system-level task that keeps collecting
#   even while the daemon is down.
#   If you register it, set "collect.enabled": false in commands.json first --
#   otherwise both schedulers collect (harmless, just redundant requests).
#
# WHY IT COPIES WecomFastlane's XML
#   Instead of hand-building trigger/settings objects (PowerShell 5.1 cannot
#   express "repeat forever" cleanly: -RepetitionDuration rejects MaxValue), we
#   clone the watchdog task's XML and change only name / interval / action.
#   That inherits the settings already proven on this machine:
#   MultipleInstances=IgnoreNew (no overlapping runs), LogonType=InteractiveToken.
#
# ASCII ONLY on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.

$ErrorActionPreference = 'Stop'

$taskName = 'WecomCollect'
$template = 'WecomFastlane'
$root = 'D:\dsh-app\wecom-fastlane'
$vbs = Join-Path $root 'collect-hidden.vbs'

# 1) elevation: a task in the root folder cannot be registered unelevated
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Not elevated. Relaunching with a UAC prompt (click Yes)...'
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath) `
        -Verb RunAs
    exit 0
}

# 2) sanity: the pieces the task will call must exist
if (-not (Test-Path $vbs)) { throw "missing launcher: $vbs" }
if (-not (Test-Path (Join-Path $root 'fastlane.mjs'))) { throw "missing fastlane.mjs in $root" }

# 3) clone the watchdog task, change only what must change
$xml = Export-ScheduledTask -TaskName $template
$xml = $xml -replace '<URI>\\WecomFastlane</URI>', '<URI>\WecomCollect</URI>'
$xml = $xml -replace '<Interval>PT1M</Interval>', '<Interval>PT10M</Interval>'
$xml = $xml -replace '<StartBoundary>[^<]+</StartBoundary>', ('<StartBoundary>{0}</StartBoundary>' -f (Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss'))
$xml = $xml -replace '<Date>[^<]+</Date>', ('<Date>{0}</Date>' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'))
$xml = $xml -replace 'watchdog-hidden\.vbs', 'collect-hidden.vbs'

Register-ScheduledTask -TaskName $taskName -Xml $xml -Force | Out-Null

# 4) report what actually got registered instead of assuming
$task = Get-ScheduledTask -TaskName $taskName
Write-Host ''
Write-Host ("registered : {0}" -f $task.TaskName)
Write-Host ("state      : {0}" -f $task.State)
Write-Host ("action     : {0} {1}" -f $task.Actions[0].Execute, $task.Actions[0].Arguments)
Write-Host ("interval   : {0}" -f $task.Triggers[0].Repetition.Interval)
Write-Host ("runs as    : {0}" -f $task.Principal.UserId)
Write-Host ''
Write-Host 'Run it once now to verify:'
Write-Host ("  schtasks /run /tn {0}" -f $taskName)
Write-Host 'Then check the result (0 = collected):'
Write-Host ("  schtasks /query /tn {0} /v /fo LIST" -f $taskName)
