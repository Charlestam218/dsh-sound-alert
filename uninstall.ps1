<#
  dsh-sound-alert —— 卸载脚本（PowerShell）

  作用：把本插件从一个 DSH profile 里摘干净：
    1. 从 <profile>\package.json 的 dsh.profile.bundles 与 dependencies 移除；
    2. 删除 <profile>\node_modules\dsh-sound-alert（链接或拷贝都只删这一处）。

  用法：
    pwsh -File uninstall.ps1
    pwsh -File uninstall.ps1 -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"
#>
[CmdletBinding()]
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-sound-alert'

Write-Host "== dsh-sound-alert 卸载 ==" -ForegroundColor Cyan
Write-Host "profile : $ProfileDir"

$manifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "找不到 profile 清单：$manifestPath" }

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
  $bundles = @($manifest.dsh.profile.bundles) | Where-Object { $_ -ne $PackageName }
  $manifest.dsh.profile | Add-Member -MemberType NoteProperty -Name bundles -Value $bundles -Force
}
if ($manifest.dependencies -and ($manifest.dependencies.PSObject.Properties.Name -contains $PackageName)) {
  $manifest.dependencies.PSObject.Properties.Remove($PackageName)
}

$json = $manifest | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))

$target = Join-Path (Join-Path $ProfileDir 'node_modules') $PackageName
if (Test-Path -LiteralPath $target) {
  $item = Get-Item -LiteralPath $target -Force
  if ($item.LinkType) { [System.IO.Directory]::Delete($item.FullName) } else { Remove-Item -LiteralPath $target -Recurse -Force }
  Write-Host "已删除：$target" -ForegroundColor Green
}

Write-Host "清单已更新：$manifestPath" -ForegroundColor Green
Write-Host "重启 DSH 客户端后彻底生效。" -ForegroundColor Yellow
