# wecom-fastlane watchdog: keep the data-query bot connected.
#
# Design: a SHORT-LIVED check, started by Task Scheduler every minute.
#   - no long-lived loop, so there is no mutex to leak and no abandoned-mutex
#     failure mode (the DSH watchdog needed both fixes; this one avoids the
#     problem entirely by being stateless);
#   - Task Scheduler's default MultipleInstances=IgnoreNew prevents overlap.
#
# Health = THREE things agreeing (every one of them was learned from a real miss
# on 2026-09-19, when the daemon stayed dead for minutes while this script
# happily reported "healthy"):
#   1) a daemon process exists - and ONLY a real daemon: the command line must
#      end at fastlane.mjs with NO extra arguments, because --selftest/--check/
#      --routes are one-shot runs whose command line also contains the string
#      "fastlane.mjs" (a --selftest run was once mistaken for the daemon);
#   2) logs\heartbeat.txt is fresh. The daemon writes it ONLY while the
#      WebSocket is authenticated, so a live process with a stale heartbeat
#      means "connected then lost the connection";
#   3) the pid inside that heartbeat is the SAME process found in (1). Without
#      this, a leftover heartbeat from a dead instance plus any unrelated live
#      process still looked healthy.
#
# DANGER, learned the hard way: never match processes by "node.exe with
# fastlane.mjs somewhere in the command line". The agent harness runs our own
# commands through a node wrapper whose command line quotes this very filter
# text, so a loose match targets the harness itself - and killing it takes the
# harness down. Hence the anchored match, plus runner.js/powershell exclusion.
#
# ASCII ONLY: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI/GBK, and CJK
# bytes can contain 0x60 (backtick line continuation) which breaks parsing.

$ErrorActionPreference = 'Continue'

# 目录取脚本自己所在的位置：整个目录可以搬到任何路径，不用改这一行
$root = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$log = Join-Path $root 'logs\watchdog.log'
$heartbeat = Join-Path $root 'logs\heartbeat.txt'
$pidFile = Join-Path $root 'logs\fastlane.pid'
$launcher = Join-Path $root 'start-hidden.vbs'
$staleSeconds = 240

function Write-Log([string]$text) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    try {
        Add-Content -Path $log -Value ("[" + $stamp + "] " + $text) -Encoding UTF8
    } catch {
        # Logging must never be the reason the watchdog dies.
    }
}

# keep the watchdog log from growing without bound
try {
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
        Move-Item -Force $log ($log + '.1')
    }
} catch { }

function Get-Candidate([int]$thePid) {
    if ($thePid -le 0) { return $null }
    $c = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $thePid) -ErrorAction SilentlyContinue
    if (-not $c) { return $null }
    if ($c.Name -ne 'node.exe') { return $null }
    if (-not $c.CommandLine) { return $null }
    if ($c.CommandLine -notmatch 'fastlane\.mjs"?\s*$') { return $null }
    return $c
}

# 1) the process: prefer the pid the daemon wrote itself, then fall back to a
#    strictly anchored scan (no extra arguments, never the harness runner).
$proc = $null
if (Test-Path $pidFile) {
    $filePid = 0
    try { $filePid = [int]((Get-Content $pidFile -Raw).Trim()) } catch { $filePid = 0 }
    $proc = Get-Candidate $filePid
}
if (-not $proc) {
    $scan = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            ($_.CommandLine -match 'fastlane\.mjs"?\s*$') -and
            ($_.CommandLine -notmatch 'runner\.js') -and
            ($_.CommandLine -notmatch 'powershell')
        })
    if ($scan.Count -gt 0) { $proc = $scan[0] }
}

# 2) + 3) the heartbeat: fresh, and written by that same process
$hbPid = 0
$hbAge = 999999
if (Test-Path $heartbeat) {
    try {
        $hbText = Get-Content $heartbeat -Raw
        if ($hbText -match 'pid=(\d+)') { $hbPid = [int]$Matches[1] }
        $hbAge = [int]((Get-Date) - (Get-Item $heartbeat).LastWriteTime).TotalSeconds
    } catch { }
}

if ($proc -and ($hbAge -lt $staleSeconds) -and ($hbPid -eq $proc.ProcessId)) {
    exit 0
}

if ($proc) {
    Write-Log ("restarting: pid " + $proc.ProcessId + " alive but heartbeat pid=" + $hbPid + " age=" + $hbAge + "s")
    try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
    } catch {
        Write-Log ("kill failed for pid " + $proc.ProcessId + ": " + $_.Exception.Message)
    }
    Start-Sleep -Seconds 2
} else {
    Write-Log ("starting (no daemon process; heartbeat pid=" + $hbPid + " age=" + $hbAge + "s)")
}

try {
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') `
        -ArgumentList ('//nologo "' + $launcher + '"') -WindowStyle Hidden
} catch {
    Write-Log ('launch failed: ' + $_.Exception.Message)
    exit 1
}

# Give it a few seconds, then report what actually happened instead of assuming.
Start-Sleep -Seconds 10
$after = $null
if (Test-Path $pidFile) {
    $afterPid = 0
    try { $afterPid = [int]((Get-Content $pidFile -Raw).Trim()) } catch { $afterPid = 0 }
    $after = Get-Candidate $afterPid
}
if ($after) {
    Write-Log ('started, pid ' + $after.ProcessId)
} else {
    Write-Log 'launch was issued but no daemon process is visible afterwards'
}
