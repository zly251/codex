#Requires -Version 5.1
<#
一键打包 dist\求职助手.exe（Node SEA 单文件 exe）：
  1. 校验基础 node.exe（自动检测 JOB_AGENT_NODE、项目目录 node.exe 或 PATH 中的 node.exe，也可用 -NodeExe 指定）存在并输出其版本
  2. 安全停止本项目旧实例（进程名 + ExecutablePath 双重校验，不误杀同名程序）
  3. 生成/更新 packaging\job-agent.ico（与托盘图标视觉一致）
  4. esbuild 打包 packaging/entry.cjs -> dist/sea-entry.cjs，server.mjs -> dist/sea-server.cjs，
     并自动生成 tesseract worker 打包产物 dist/sea-worker.cjs
  5. 使用 $NodeExe 执行 --experimental-sea-config 生成 dist/sea-prep.blob
  6. 复制 $NodeExe 为 dist\求职助手.exe
  7. rcedit 设置 job-agent.ico 图标和 ProductName/FileDescription=求职助手
     （在 postject 之前执行，避免处理注入后的大文件卡住）
  8. postject 注入 NODE_SEA_BLOB
  9. patch PE subsystem -> 2（GUI，不弹控制台），并收尾断言 subsystem 已是 2
 10. 复制到当前用户桌面 Desktop\求职助手.exe（不写死本机路径）

任一步失败立即报错退出（$ErrorActionPreference=Stop + LASTEXITCODE 检查）。
构建前会安全停止本项目正在运行的旧实例：进程名为“求职助手.exe”且 ExecutablePath 是
dist\ 或当前用户桌面下的同名 exe；端口 3456 占用者同样校验进程名和路径后才停止，不会误杀其他程序。

用法：npm run build:exe   （等价于 powershell -File scripts/build-exe.ps1）
#>
[CmdletBinding()]
param(
  [string]$NodeExe = "",
  [switch]$SkipDesktopCopy,
  [switch]$SkipStopRunning
)

$ErrorActionPreference = "Stop"
# $PSScriptRoot 在部分执行环境下为空，这里做多重回退
if (-not $PSScriptRoot) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
  $scriptDir = $PSScriptRoot
}
if (-not $scriptDir) {
  $scriptDir = (Get-Location).Path
}
$ProjectRoot = Split-Path -Parent $scriptDir
Set-Location -LiteralPath $ProjectRoot

if (-not $NodeExe) {
  if ($env:JOB_AGENT_NODE) { $NodeExe = $env:JOB_AGENT_NODE }
  $localNode = Join-Path $ProjectRoot "node.exe"
  if (-not $NodeExe -and (Test-Path -LiteralPath $localNode)) { $NodeExe = $localNode }
  if (-not $NodeExe) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $NodeExe = $cmd.Source }
  }
}

$AppName = "求职助手"
$ExeName = "$AppName.exe"
$DistExe = Join-Path $ProjectRoot "dist\$ExeName"
$DesktopExe = Join-Path $env:USERPROFILE "Desktop\$ExeName"
$IconFile = Join-Path $ProjectRoot "packaging\job-agent.ico"
$Fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

function Write-Step([string]$message) {
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "命令执行失败(exit=$LASTEXITCODE): $Command $($Arguments -join ' ')"
  }
}

# ---------- 0. 校验基础 node.exe（SEA blob / rcedit / patch 统一使用它，不走 PATH） ----------
if (-not (Test-Path -LiteralPath $NodeExe)) {
  throw "找不到基础 node.exe，请设置 JOB_AGENT_NODE、在项目目录放置 node.exe、把 node 加入 PATH，或用 -NodeExe 指定"
}
Write-Step "基础 node.exe: $NodeExe"
$nodeVersion = & $NodeExe --version
if ($LASTEXITCODE -ne 0) {
  throw "无法执行 $NodeExe --version"
}
Write-Host "    Node 版本: $nodeVersion"

# ---------- 0.5 安全停止本项目旧实例（进程名 + ExecutablePath 双重校验，不误杀同名程序） ----------
function Test-IsOurExeProcess {
  param([object]$Proc)
  if (-not $Proc -or -not $Proc.ExecutablePath) { return $false }
  $ep = $Proc.ExecutablePath
  if ([System.IO.Path]::GetFileName($ep) -ine $ExeName) { return $false }
  $distDir = Join-Path $ProjectRoot "dist"
  return (
    $ep -ieq $DistExe -or
    $ep -ieq $DesktopExe -or
    [System.IO.Path]::GetDirectoryName($ep) -ieq $distDir
  )
}

if (-not $SkipStopRunning) {
  $ownProcesses = @()
  # 按进程名过滤（全量获取后比较 Name，避免 WQL 内嵌中文），再校验 ExecutablePath 必须是 dist\ 或桌面下的同名 exe
  $byName = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ieq $ExeName })
  foreach ($p in $byName) {
    if (Test-IsOurExeProcess $p) { $ownProcesses += $p }
  }
  # 端口 3456 占用者同样校验进程名和路径后才停止
  $listener = Get-NetTCPConnection -State Listen -LocalPort 3456 -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($listener) {
    $listenerProc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (Test-IsOurExeProcess $listenerProc) {
      $ownProcesses += $listenerProc
    }
  }
  $ownProcesses = $ownProcesses | Sort-Object ProcessId -Unique
  foreach ($p in $ownProcesses) {
    Write-Step "停止旧实例 PID=$($p.ProcessId) ($($p.Name))"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    # 等待进程真正退出（最多 5 秒），避免残留文件句柄导致后续 Copy-Item 失败
    Wait-Process -Id $p.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
  }
}

# ---------- 1. 生成/更新图标 ----------
Write-Step "生成/更新 packaging\job-agent.ico"
$iconScript = Join-Path $ProjectRoot "packaging\generate-app-icon.ps1"
try {
  & $iconScript
} catch {
  throw "图标生成失败: $($_.Exception.Message)"
}
if (-not (Test-Path -LiteralPath $IconFile)) {
  throw "图标文件未生成: $IconFile"
}

# ---------- 2. esbuild 打包 ----------
Write-Step "esbuild 打包 packaging\entry.cjs -> dist\sea-entry.cjs"
Invoke-Native npx.cmd esbuild packaging/entry.cjs --bundle --platform=node --format=cjs --outfile=dist/sea-entry.cjs
Write-Step "esbuild 打包 server.mjs -> dist\sea-server.cjs"
Invoke-Native npx.cmd esbuild server.mjs --bundle --platform=node --format=cjs --outfile=dist/sea-server.cjs
Write-Step "esbuild 打包 tesseract worker -> dist\sea-worker.cjs"
Invoke-Native npx.cmd esbuild node_modules/tesseract.js/src/worker-script/node/index.js --bundle --platform=node --format=cjs --outfile=dist/sea-worker.cjs

# sea-config.json 还引用了 dist\sea-worker.cjs（worker/worker.cjs 资产），生成后再确认存在
$workerBundle = Join-Path $ProjectRoot "dist\sea-worker.cjs"
if (-not (Test-Path -LiteralPath $workerBundle)) {
  throw "esbuild 未生成 $workerBundle（sea-config.json 的 worker/worker.cjs 资产）"
}

# ---------- 3. 生成 sea blob（统一使用 $NodeExe，不依赖 PATH 里的 node） ----------
Write-Step "生成 dist\sea-prep.blob（使用 $NodeExe）"
Invoke-Native $NodeExe --experimental-sea-config sea-config.json

# ---------- 4. 复制 node.exe ----------
if (-not (Test-Path -LiteralPath $NodeExe)) {
  throw "找不到基础 exe: $NodeExe"
}
Write-Step "复制 $NodeExe -> dist\$ExeName"
Copy-Item -LiteralPath $NodeExe -Destination $DistExe -Force

# ---------- 5. rcedit 设置图标与版本信息（在 postject 之前，避免处理注入后的大文件卡住） ----------
Write-Step "rcedit 设置图标与版本信息"
$rceditLib = Join-Path $ProjectRoot "node_modules\rcedit"
if (-not (Test-Path -LiteralPath (Join-Path $rceditLib "lib\rcedit.js"))) {
  throw "未找到 rcedit 包: $rceditLib"
}
$runner = Join-Path $env:TEMP "job-agent-rcedit-runner.cjs"
@'
// 临时 runner：调用 rcedit 的 Node API 设置图标与版本信息（避免命令行中文编码问题）
const rcedit = require(process.argv[2]);
const exe = process.argv[3];
const icon = process.argv[4];
const productName = process.argv[5];
(async () => {
  await rcedit(exe, {
    icon: icon,
    'version-string': {
      ProductName: productName,
      FileDescription: productName,
      CompanyName: productName,
    },
    'file-version': '0.1.0.0',
    'product-version': '0.1.0.0',
  });
  console.log('[rcedit] icon and version info applied: ' + exe);
})().catch((err) => {
  console.error('[rcedit] failed: ' + (err && err.stack || err));
  process.exit(1);
});
'@ | Set-Content -LiteralPath $runner -Encoding UTF8
try {
  Invoke-Native $NodeExe $runner $rceditLib $DistExe $IconFile $AppName
} finally {
  Remove-Item -LiteralPath $runner -Force -ErrorAction SilentlyContinue
}

# ---------- 6. postject 注入 ----------
Write-Step "postject 注入 NODE_SEA_BLOB"
Invoke-Native npx.cmd postject "dist\$ExeName" NODE_SEA_BLOB "dist\sea-prep.blob" --sentinel-fuse $Fuse

# ---------- 7. patch PE subsystem -> GUI ----------
Write-Step "patch PE subsystem -> 2 (GUI)"
Invoke-Native $NodeExe "scripts\patch-pe-gui.cjs" "dist\$ExeName"

# ---------- 7b. 收尾断言：再次读取 PE subsystem，必须已是 2 (GUI) ----------
Write-Step "断言 PE subsystem == 2 (GUI)"
$patchOut = & $NodeExe "scripts\patch-pe-gui.cjs" "dist\$ExeName" 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "PE subsystem 断言失败（patch-pe-gui 退出码 $LASTEXITCODE）: $patchOut"
}
if (("$patchOut" -notmatch 'subsystem 2 -> 2')) {
  throw "PE subsystem 断言失败（before 不是 2）: $patchOut"
}
Write-Host "    $patchOut"

# ---------- 8. 复制到桌面 ----------
if (-not $SkipDesktopCopy) {
  $desktopDir = Split-Path -Parent $DesktopExe
  if (-not (Test-Path -LiteralPath $desktopDir)) {
    Write-Warning "找不到桌面目录 $desktopDir，跳过桌面复制（产物保留在 dist\）"
  } else {
    Write-Step "复制到桌面 $DesktopExe"
    Copy-Item -LiteralPath $DistExe -Destination $DesktopExe -Force
  }
}

$exeSize = (Get-Item -LiteralPath $DistExe).Length
Write-Host ""
Write-Host "[build-exe] 完成: $DistExe ($exeSize bytes)" -ForegroundColor Green
