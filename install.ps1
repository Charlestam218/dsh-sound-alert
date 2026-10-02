<#
  dsh-sound-alert —— 安装脚本（PowerShell）

  作用：把本插件装进一个 DSH profile：
    1. 在 <profile>\node_modules\ 下建立指向本包目录的 junction（软链安装，
       改源码立即生效；加 -Copy 改为拷贝安装）；
    2. 把本包写进 <profile>\package.json 的 dependencies 与 dsh.profile.bundles。

  用法（默认装官方桌面端 profile）：
    pwsh -File install.ps1
    pwsh -File install.ps1 -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"
    pwsh -File install.ps1 -Copy        # 拷贝安装，不用 junction

  注意：官方桌面端 profile 由 Electron 客户端独占管理，`dsh plugin --profile desktop`
  会被 CLI 拒绝，所以这里直接按插件管理器的等价步骤手工安装。
#>
[CmdletBinding()]
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [switch]$Copy
)

$ErrorActionPreference = 'Stop'

$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageName = 'dsh-sound-alert'
$PackageJson = Join-Path $SourceDir 'package.json'
$ClientEntry = Join-Path $SourceDir 'lib\client.js'
$HostEntry = Join-Path $SourceDir 'lib\index.js'

Write-Host "== dsh-sound-alert 安装 ==" -ForegroundColor Cyan
Write-Host "源目录  : $SourceDir"
Write-Host "profile : $ProfileDir"

foreach ($file in @($PackageJson, $ClientEntry, $HostEntry)) {
  if (-not (Test-Path -LiteralPath $file)) { throw "插件文件缺失：$file" }
}
if (-not (Test-Path -LiteralPath $ProfileDir)) { throw "profile 目录不存在：$ProfileDir" }

$nodeModules = Join-Path $ProfileDir 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) { New-Item -ItemType Directory -Path $nodeModules | Out-Null }
$target = Join-Path $nodeModules $PackageName

# 1) 安装包体
if (Test-Path -LiteralPath $target) {
  $item = Get-Item -LiteralPath $target -Force
  Write-Host "已存在，先移除：$($item.FullName)$(if ($item.LinkType) { " (LinkType=$($item.LinkType))" })"
  # 只删链接本身，避免误删被链接的源目录内容
  if ($item.LinkType) { [System.IO.Directory]::Delete($item.FullName) } else { Remove-Item -LiteralPath $target -Recurse -Force }
}

if ($Copy) {
  Copy-Item -LiteralPath $SourceDir -Destination $target -Recurse -Force
  $spec = 'file:' + ($SourceDir -replace '\\', '/')
  Write-Host "已拷贝安装" -ForegroundColor Green
} else {
  New-Item -ItemType Junction -Path $target -Target $SourceDir | Out-Null
  $spec = 'link:' + ($SourceDir -replace '\\', '/')
  Write-Host "已软链安装（junction）" -ForegroundColor Green
}

# 2) 写 profile 清单
$manifestPath = Join-Path $ProfileDir 'package.json'
$backupPath = Join-Path $ProfileDir 'package.json.dsh-sound-alert.bak'
if (-not (Test-Path -LiteralPath $backupPath)) { Copy-Item -LiteralPath $manifestPath -Destination $backupPath -Force }

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($null -eq $manifest.dependencies) { $manifest | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{}) }
$manifest.dependencies | Add-Member -MemberType NoteProperty -Name $PackageName -Value $spec -Force

$bundles = @()
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) { $bundles = @($manifest.dsh.profile.bundles) }
if ($bundles -notcontains $PackageName) { $bundles += $PackageName }
if ($null -eq $manifest.dsh) { $manifest | Add-Member -MemberType NoteProperty -Name dsh -Value ([pscustomobject]@{}) }
if ($null -eq $manifest.dsh.profile) { $manifest.dsh | Add-Member -MemberType NoteProperty -Name profile -Value ([pscustomobject]@{}) }
$manifest.dsh.profile | Add-Member -MemberType NoteProperty -Name bundles -Value $bundles -Force

$json = $manifest | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "清单已更新：$manifestPath" -ForegroundColor Green
Write-Host "  dependencies.$PackageName = $spec"
Write-Host "  dsh.profile.bundles += $PackageName"
Write-Host ""
Write-Host "生效方式：DSH 侧启用 HMR 时会自动重载；若没有立即生效，重启 DSH 客户端。" -ForegroundColor Yellow
Write-Host "自检：浏览器控制台执行 dshSoundAlert.state()，或看 $env:USERPROFILE\.dsh\.dsh-sound-alert.log" -ForegroundColor Yellow
