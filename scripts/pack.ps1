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

# 这些不该进包：版本库、日志、缓存、构建产物、**任何 zip**，
# 以及**只在本机存在的部署态数据**：凭据（secret.txt / webhooks.json / commands.json /
# .access_token.json / .env）与采集结果（snapshots/、history/、runtime/）。
# 教训（2026-10-20 发版前审计）：顶层按名字排除抓不到 assets\webhooks.json 这种**嵌套**文件，
# 所以下面除了排除项，还有一段「按文件名递归清理」+「打包后逐条目断言」。
# zip 必须排除：如果打包输出落在仓库里，下一轮就会把上一个包打进去 —— 2026-09-21 真发生过（包里有包）。
$exclude = @(
    '.git', 'logs', '__pycache__', 'node_modules', '_versions',
    'snapshots', 'history', 'runtime',
    '.session.json', 'secret.txt', 'commands.json', 'webhooks.json',
    '.access_token.json', '.env', '.env.local'
)

# 递归清理与打包断言共用（按**文件名**匹配，任意层级）
$sensitiveFileNames = @(
    'secret.txt', 'commands.json', 'webhooks.json', '.access_token.json',
    '.session.json', '.env', '.env.local'
)
$sensitiveDirNames = @(
    'snapshots', 'history', 'runtime', 'logs', '__pycache__', 'node_modules', '_versions'
)

$staging = Join-Path $env:TEMP ('pack-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $staging | Out-Null

Get-ChildItem $root -Force | Where-Object {
    ($exclude -notcontains $_.Name) -and ($_.Name -notlike '*.zip') -and ($_.Name -notlike '*.bundle')
} | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $staging $_.Name) -Recurse -Force
}

# 再清一遍深层垃圾（含嵌套的凭据文件 —— 顶层按名字排除抓不到 assets\webhooks.json）
Get-ChildItem $staging -Recurse -File -Force | Where-Object {
    ($sensitiveFileNames -contains $_.Name) -or
    ($_.Name -like '*.bak*') -or ($_.Name -like '*.pyc') -or
    ($_.Name -like '*.zip') -or ($_.Name -like '*.bundle')
} | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $staging -Recurse -Directory -Force | Where-Object {
    $sensitiveDirNames -contains $_.Name
} | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $staging -Recurse -Force

# 打包后自证：zip 条目里出现任何敏感文件名/目录就删包并失败。
# 「静默把密钥打进包」比「打包失败」危险得多，所以这里必须 throw。
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipHandle = [System.IO.Compression.ZipFile]::OpenRead($zip)
try { $entries = @($zipHandle.Entries | ForEach-Object { $_.FullName }) }
finally { $zipHandle.Dispose() }
$leaked = @($entries | Where-Object {
    $parts = $_ -split '[\\/]'
    $leaf = $parts[-1]
    ($sensitiveFileNames -contains $leaf) -or
    (@($parts | Where-Object { $sensitiveDirNames -contains $_ }).Count -gt 0) -or
    ($leaf -like '*.bak*') -or ($leaf -like '*.pyc')
})
if ($leaked.Count -gt 0) {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    throw ("打包失败：zip 里出现了不该发布的内容 -> " + ($leaked -join ', '))
}

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
$count = $entries.Count
Write-Host ("打包完成: {0}  ({1} KB / {2} 个文件，版本 {3})" -f $zip, $size, $count, $version) -ForegroundColor Green
Write-Host ("自证通过：zip 内无凭据文件、无采集结果、无备份/缓存（已核对 {0} 个条目）" -f $count) -ForegroundColor Green
