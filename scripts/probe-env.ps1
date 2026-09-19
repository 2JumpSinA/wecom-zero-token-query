# probe-env.ps1 - environment check before installing wecom-zero-token-query.
#
# ASCII ONLY on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI/GBK,
# and CJK bytes can contain 0x60 (backtick line continuation), which breaks parsing.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File probe-env.ps1
#         powershell ... -File probe-env.ps1 -PythonExe D:\py\python.exe

param(
    [string]$PythonExe = $env:PYTHON_EXE,
    [string]$InstallDir = ''
)

$ErrorActionPreference = 'Continue'
$ok = 0; $warn = 0; $bad = 0

function Line([string]$status, [string]$name, [string]$detail) {
    $color = switch ($status) { 'PASS' { 'Green' } 'WARN' { 'Yellow' } default { 'Red' } }
    Write-Host ("  [{0}] {1,-22} {2}" -f $status, $name, $detail) -ForegroundColor $color
    switch ($status) { 'PASS' { $script:ok++ } 'WARN' { $script:warn++ } default { $script:bad++ } }
}

Write-Host "`n=== wecom-zero-token-query / environment probe ===" -ForegroundColor Cyan

# ---------------------------------------------------------------- Node
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCmd) { $nodeCmd.Source } else { $null }
if (-not $nodePath) {
    foreach ($p in @('D:\nodejs\node.exe', "$env:ProgramFiles\nodejs\node.exe")) {
        if (Test-Path $p) { $nodePath = $p; break }
    }
}
if ($nodePath) {
    $v = (& $nodePath -v) 2>$null
    $major = 0
    if ($v -match 'v(\d+)') { $major = [int]$Matches[1] }
    if ($major -ge 18) { Line 'PASS' 'Node.js' "$v  ($nodePath)" }
    else { Line 'BAD' 'Node.js' "$v is too old - need 18+  ($nodePath)" }
} else {
    Line 'BAD' 'Node.js' 'not found - install Node 18+ or put node.exe on PATH'
}

# ---------------------------------------------------------------- Python
$pyCandidates = @()
if ($PythonExe) { $pyCandidates += $PythonExe }
$pyCandidates += @(
    (Get-Command python -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source),
    (Get-Command py -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source),
    '<你的 python.exe>'
) | Where-Object { $_ }
$pyFound = $null
foreach ($c in $pyCandidates) {
    if (-not (Test-Path $c)) { continue }
    $pv = (& $c -V) 2>&1
    if ($LASTEXITCODE -eq 0) { $pyFound = $c; Line 'PASS' 'Python' "$pv  ($c)"; break }
}
if (-not $pyFound) { Line 'WARN' 'Python' 'not found - needed only if your data scripts are Python (set PYTHON_EXE)' }

# ---------------------------------------------------------------- network
function Test-Host([string]$name, [string]$hostName, [int]$port = 443) {
    $r = Test-NetConnection -ComputerName $hostName -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($r) { Line 'PASS' $name "$hostName`:$port reachable" } else { Line 'WARN' $name "$hostName`:$port NOT reachable" }
}
Test-Host 'WeCom long link' 'openws.work.weixin.qq.com'
Test-Host 'npm registry'    'registry.npmjs.org'
Test-Host 'PyPI (tsinghua)' 'pypi.tuna.tsinghua.edu.cn'
Test-Host 'PyPI (aliyun)'   'mirrors.aliyun.com'
Test-Host 'GitHub API'      'api.github.com'

# ---------------------------------------------------------------- npm registry config
$npmCmd = if ($nodePath) { Join-Path (Split-Path $nodePath) 'npm.cmd' } else { $null }
if ($npmCmd -and (Test-Path $npmCmd)) {
    $reg = (& $npmCmd config get registry) 2>$null
    Line 'PASS' 'npm registry' "$reg"
} else {
    Line 'WARN' 'npm registry' 'npm.cmd not found next to node.exe'
}

# ---------------------------------------------------------------- scheduled task rights
$probeName = 'FastlaneEnvProbe'
$null = schtasks /create /tn $probeName /tr "cmd /c exit" /sc once /st 23:59 /f 2>&1
if ($LASTEXITCODE -eq 0) {
    $null = schtasks /delete /tn $probeName /f 2>&1
    Line 'PASS' 'task creation' 'can create a scheduled task (needed for the resident watchdog)'
} else {
    Line 'WARN' 'task creation' 'denied - fall back to the Startup folder instead of a scheduled task'
}

# ---------------------------------------------------------------- disk
$targetDrive = if ($InstallDir) { (Split-Path -Qualifier $InstallDir) } else { 'D:' }
$free = (Get-PSDrive -Name $targetDrive.TrimEnd(':') -ErrorAction SilentlyContinue).Free
if ($free) {
    $freeGB = [int]($free / 1GB)
    if ($freeGB -ge 1) { Line 'PASS' 'disk space' "$freeGB GB free on $targetDrive" }
    else { Line 'WARN' 'disk space' "only $freeGB GB free on $targetDrive" }
} else {
    Line 'WARN' 'disk space' "cannot read free space for $targetDrive"
}

# ---------------------------------------------------------------- summary
Write-Host "`n=== summary: PASS $ok / WARN $warn / BAD $bad ===" -ForegroundColor Cyan
if ($bad -gt 0) {
    Write-Host "Fix the BAD lines first - the channel cannot work without them." -ForegroundColor Red
} elseif ($warn -gt 0) {
    Write-Host "WARN lines are usually fine, but a WARN on 'WeCom long link' means the bot can never connect." -ForegroundColor Yellow
} else {
    Write-Host "All good - continue with install.ps1" -ForegroundColor Green
}
Write-Host ''
