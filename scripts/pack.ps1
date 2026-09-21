# pack.ps1 - 打一个干净的、可分发的技能 zip。
#
# 为什么需要它：手工 Compress-Archive 会把 logs/、__pycache__/、.session.json 一起打进去
# （今天就发生过，包里混进了自检日志）。这个脚本只放该放的东西。
#
# 用法： powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack.ps1
#        powershell ... -File scripts\pack.ps1 -OutDir D:\some\where
#        默认输出到**仓库的上一级目录** —— 分发物放仓库外面，别让打包脚本把自己打进去

[CmdletBinding()]
param(
    [string]$OutDir = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
$zip = Join-Path $OutDir ("wecom-zero-token-query-skill-v{0}.zip" -f $version)

# 这些不该进包：版本库、日志、缓存、构建产物，以及**任何 zip**。
# zip 必须排除：如果打包输出落在仓库里，下一轮就会把上一个包打进去 —— 2026-09-21 真发生过（包里有包）。
$exclude = @('.git', 'logs', '__pycache__', 'node_modules', '_versions', '.session.json')
$staging = Join-Path $env:TEMP ('pack-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $staging | Out-Null

Get-ChildItem $root -Force | Where-Object {
    ($exclude -notcontains $_.Name) -and ($_.Name -notlike '*.zip') -and ($_.Name -notlike '*.bundle')
} | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $staging $_.Name) -Recurse -Force
}

# 再清一遍深层垃圾
Get-ChildItem $staging -Recurse -File | Where-Object {
    $_.Name -like '*.bak' -or $_.Name -eq '.session.json' -or $_.Name -like '*.pyc'
} | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $staging -Recurse -Directory | Where-Object { $_.Name -eq '__pycache__' } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $staging -Recurse -Force

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
$count = (Get-ChildItem $root -Recurse -File | Where-Object {
    $_.FullName -notmatch '\\(\.git|logs|__pycache__|_versions)\\' -and
    $_.Name -ne '.session.json' -and $_.Name -notlike '*.zip' -and $_.Name -notlike '*.bundle'
}).Count
Write-Host ("打包完成: {0}  ({1} KB / {2} 个文件，版本 {3})" -f $zip, $size, $count, $version) -ForegroundColor Green
