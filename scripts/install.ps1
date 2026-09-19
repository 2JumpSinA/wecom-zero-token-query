# install.ps1 - one-shot installer for the wecom-zero-token-query skill.
#
# ASCII ONLY on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI/GBK,
# and CJK bytes can contain 0x60 (backtick line continuation) which breaks parsing.
#
# What it does:
#   1. copies assets/ into the target directory
#   2. creates commands.json from the example (never overwrites an existing one)
#   3. writes secret.txt when -Secret is supplied
#   4. optionally installs the SDK dependency
#   5. runs --check and prints the result
#   6. registers the minute-by-minute watchdog task (through wscript, so no window flash)
#   7. runs the task once and shows the heartbeat
#
# Usage:
#   .\install.ps1 -Target D:\wecom-fastlane -BotId aibXXXX -Secret <secret>
#   .\install.ps1 -Target D:\wecom-fastlane -BotId aibXXXX -SkipTask -SkipNpm

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$BotId,
    [string]$Secret = '',
    [string]$TaskName = 'WecomFastlane',
    [switch]$SkipTask,
    [switch]$SkipNpm
)

$ErrorActionPreference = 'Stop'
$assets = Join-Path $PSScriptRoot '..\assets'
$assets = (Resolve-Path $assets).Path

function Step([string]$msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 0. checks
Step "0/7 environment"
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
    foreach ($p in @('D:\nodejs\node.exe', "$env:ProgramFiles\nodejs\node.exe")) {
        if (Test-Path $p) { $node = @{ Source = $p }; break }
    }
}
if (-not $node) { throw "Node.js not found. Install Node 18+ first (or put node.exe on PATH)." }
Ok "node = $($node.Source)"

if ($BotId -notmatch '^aib') { Warn "botId usually starts with 'aib' - double-check the value" }

# ---------------------------------------------------------------- 1. copy assets
Step "1/7 copy runtime into $Target"
New-Item -ItemType Directory -Force -Path $Target | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Target 'logs') | Out-Null
Get-ChildItem $assets -File | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $Target $_.Name) -Force
}
Ok "copied $((Get-ChildItem $assets -File).Count) files"

# ---------------------------------------------------------------- 2. commands.json
Step "2/7 config file"
$cfg = Join-Path $Target 'commands.json'
if (Test-Path $cfg) {
    Ok "commands.json already exists - kept as is"
} else {
    Copy-Item (Join-Path $Target 'commands.example.json') $cfg -Force
    $raw = Get-Content $cfg -Raw -Encoding UTF8
    $raw = $raw -replace '"botId"\s*:\s*"[^"]*"', ('"botId": "' + $BotId + '"')
    [System.IO.File]::WriteAllText($cfg, $raw, (New-Object System.Text.UTF8Encoding($false)))
    Ok "commands.json created from the example and botId filled in"
    Warn "still needs: allowedUsers / allowedChats / groups / commands[]"
}

# ---------------------------------------------------------------- 3. secret
Step "3/7 robot secret"
$secFile = Join-Path $Target 'secret.txt'
if ($Secret) {
    [System.IO.File]::WriteAllText($secFile, $Secret.Trim(), (New-Object System.Text.UTF8Encoding($false)))
    Ok "secret.txt written (UTF-8 without BOM, single line)"
} elseif (Test-Path $secFile) {
    Ok "secret.txt already exists - kept as is"
} else {
    Warn "no secret yet. Put the robot secret into $secFile (one line, UTF-8 without BOM),"
    Warn "or set the environment variable WECOM_FASTLANE_SECRET."
}

# ---------------------------------------------------------------- 4. dependency
Step "4/7 SDK dependency"
if ($SkipNpm) {
    Warn "skipped (-SkipNpm)"
} else {
    $local = Join-Path $Target 'node_modules\@wecom\aibot-node-sdk'
    if (Test-Path $local) {
        Ok "already present in node_modules"
    } else {
        Push-Location $Target
        try {
            $out = & npm install @wecom/aibot-node-sdk --no-audit --no-fund 2>&1
            if ($LASTEXITCODE -eq 0) { Ok "npm install done" }
            else { Warn "npm install failed (offline or mirror issue). The daemon can also load the SDK from DSH_HOME if present. Output tail:"; $out | Select-Object -Last 3 | ForEach-Object { "      $_" } }
        } catch {
            Warn "npm not available: $($_.Exception.Message)"
        } finally {
            Pop-Location
        }
    }
}

# ---------------------------------------------------------------- 5. self check
Step "5/7 self check (no network)"
& (Join-Path $Target 'run-fastlane.cmd') --check

# ---------------------------------------------------------------- 6. scheduled task
Step "6/7 resident watchdog task"
if ($SkipTask) {
    Warn "skipped (-SkipTask). Start it manually with start-hidden.vbs when ready."
} else {
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $vbs = Join-Path $Target 'watchdog-hidden.vbs'
    $tr = 'wscript.exe //nologo ' + $vbs
    $r = schtasks /create /tn $TaskName /tr $tr /sc minute /mo 1 /f /rl LIMITED 2>&1
    if ($LASTEXITCODE -eq 0) { Ok "task '$TaskName' registered (every 1 minute, wscript, no window flash)" }
    else { Warn "task creation failed: $r" }
}

# ---------------------------------------------------------------- 7. start + verify
Step "7/7 start and verify"
if (-not $SkipTask) {
    schtasks /run /tn $TaskName | Out-Null
    Start-Sleep -Seconds 12
}
$hb = Join-Path $Target 'logs\heartbeat.txt'
if (Test-Path $hb) {
    $age = [int]((Get-Date) - (Get-Item $hb).LastWriteTime).TotalSeconds
    Ok "heartbeat: $(Get-Content $hb -Raw)".Trim()
    Ok "written ${age}s ago (healthy = under 240s)"
} else {
    Warn "no heartbeat yet. Check logs\fastlane.log; the usual cause is a missing/wrong secret."
}

Write-Host "`n--- next steps ---" -ForegroundColor Cyan
Write-Host "  1. edit $cfg : allowedUsers / allowedChats / groups / commands[]"
Write-Host "  2. run: run-fastlane.cmd --routes    (verify per-group routing)"
Write-Host "  3. run: run-fastlane.cmd --selftest  (run every command locally, nothing is sent)"
Write-Host "  4. @ the robot in the group and try one command"
Write-Host "  5. see references/05-排查手册.md if anything misbehaves"
