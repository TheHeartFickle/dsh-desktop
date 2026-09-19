# 换过应用图标（assets/dsh-impact.png）并重新构建后，跑一次本脚本让 Windows shell 重画图标。
#
# 为什么需要它：exe 里的 PE 图标在构建时就被烧进去了（路线与判据见 docs/reproduce.zh.md R33），
# 但桌面/开始菜单上的快捷方式由 shell 按自己的图标缓存绘制，换图后它仍可能画旧图，重启电脑、
# 重启资源管理器都不一定管用。实测（2026-09-19）：同一个快捷方式在「属性」对话框里已经是新图，
# 桌面上画的还是旧图；跑一次本脚本后桌面立刻变成新图。
#
# 用法（Windows PowerShell 5.1 / PowerShell 7 都可以，不需要管理员）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/refresh-shell-icons.ps1
#
# 做什么：按配置定位产物 exe → 列出指向它的桌面快捷方式 → `ie4uinit.exe -show` → 报告结果。
# 不做什么：不截图、不删图标缓存、不重启 Explorer、不改仓库文件、不动 exe。
# 为什么不走「删 iconcache_*.db + 重启 Explorer」那条路：实测这些 db 被 shell 的其它进程持有，
# 停掉 Explorer 也删不掉（Access denied），而 `ie4uinit.exe -show` 不碰任何文件就能让桌面换图。
#
# 本文件必须带 UTF-8 BOM：Windows PowerShell 5.1 会按 ANSI 解析没有 BOM 的 .ps1，中文全乱。

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repoRoot 'src\build.config.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw "找不到构建配置: $configPath" }

$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$entry = @($config.build | Where-Object { $null -ne $_.artifacts })[0]
if ($null -eq $entry) { throw 'src/build.config.json 缺少 build[].artifacts：无法确定打包产物位置' }

# 产物位置跟着配置走，不写死路径（与 scripts/smoke-packaged.mjs 同一套推导）
$exe = Join-Path $repoRoot (Join-Path $entry.artifacts.to 'win-unpacked\DeepSeek Harness.exe')
if (-not (Test-Path -LiteralPath $exe)) { throw "打包产物不存在: $exe（先跑 node scripts/build.mjs）" }

# 桌面上有哪些快捷方式指向这个 exe：它们才是「看着没变」的那一层
$shortcuts = @()
$wsh = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('CommonDesktopDirectory'))) {
    if ([string]::IsNullOrWhiteSpace($dir)) { continue }
    foreach ($file in @(Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -ErrorAction SilentlyContinue)) {
        if ($wsh.CreateShortcut($file.FullName).TargetPath -ieq $exe) { $shortcuts += $file.FullName }
    }
}
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($wsh)

Write-Output "产物 exe    : $exe"
if ($shortcuts.Count -eq 0) {
    Write-Output '桌面快捷方式: 未找到指向它的快捷方式（仍然刷新 shell）'
}
else {
    foreach ($shortcut in $shortcuts) { Write-Output "桌面快捷方式: $shortcut" }
}

# shell 自带的刷新入口：让它丢掉手上的图标，重新从 exe 读一遍
$ie4uinit = Join-Path $env:SystemRoot 'System32\ie4uinit.exe'
if (-not (Test-Path -LiteralPath $ie4uinit)) {
    Write-Output "结果: 找不到 $ie4uinit，没有做任何改动"
    exit 1
}

Write-Output '刷新 shell 图标 …'
$refresh = Start-Process -FilePath $ie4uinit -ArgumentList '-show' -Wait -PassThru -WindowStyle Hidden
Write-Output ("ie4uinit -show 退出码: {0}" -f $refresh.ExitCode)
if ($refresh.ExitCode -ne 0) {
    Write-Output '结果: 刷新命令非 0 退出，shell 可能没有重画'
    exit 1
}
Write-Output '结果: 已请求 shell 重画图标 —— 桌面/开始菜单上的图标此时应换成 exe 里的新图'
Write-Output '（若某个快捷方式仍是旧图：再跑一次本脚本；仍旧不变就删掉它重新「发送到桌面快捷方式」）'
