#Requires -Version 5.1
param([switch]$SelfTest)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataRoot = Join-Path $ProjectRoot "portable"
$ServerPort = 3456
if ($env:JOB_AGENT_PORT) { $ServerPort = [int]$env:JOB_AGENT_PORT }
$ServerUrl = "http://127.0.0.1:$ServerPort"

$ServerExe = Join-Path $ProjectRoot "dist\求职助手.exe"
if (-not (Test-Path -LiteralPath $ServerExe)) {
  $distDir = Join-Path $ProjectRoot "dist"
  $candidate = Get-ChildItem -LiteralPath $distDir -Filter "*.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch "^(debug|test|gui)" } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($candidate) { $ServerExe = $candidate.FullName }
}

$script:NotifyIcon = $null
$script:StateTimer = $null
$script:StatusItem = $null
$script:OpenItem = $null
$script:StartItem = $null
$script:StopItem = $null
$script:RestartItem = $null
$script:LastState = "unknown"
$script:Busy = $false

function Get-JobAgentPid {
  $conn = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq $ServerPort } |
    Select-Object -First 1
  if ($conn) { return [int]$conn.OwningProcess }
  return $null
}

function Test-JobAgentApi {
  $client = New-Object System.Net.Http.HttpClient
  try {
    $client.Timeout = [TimeSpan]::FromSeconds(2)
    $response = $client.GetAsync("$ServerUrl/api/stats").Result
    $ok = $response.IsSuccessStatusCode
    $response.Dispose()
    return $ok
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-JobAgentState {
  $serverProcessId = Get-JobAgentPid
  if (-not $serverProcessId) { return "stopped" }
  if (Test-JobAgentApi) { return "running" }

  $processInfo = Get-Process -Id $serverProcessId -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($processInfo -and $processInfo.ProcessName -ieq "求职助手") { return "starting" }
  return "occupied"
}

function Start-JobAgentService {
  if ($script:Busy) { return $false }
  if ((Get-JobAgentState) -ne "stopped") { return $false }
  if (-not (Test-Path -LiteralPath $ServerExe)) {
    throw "未找到求职助手.exe"
  }

  $logDir = Join-Path $ProjectRoot "data"
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  $stdoutLog = Join-Path $logDir "tray-service.out.log"
  $stderrLog = Join-Path $logDir "tray-service.err.log"

  $envOverrides = @{
    "JOB_AGENT_NO_OPEN" = "1"
    "PORT" = [string]$ServerPort
    "JOB_AGENT_DATA_DIR" = $DataRoot
  }
  $previousEnv = @{}
  foreach ($name in $envOverrides.Keys) {
    $previousEnv[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }

  try {
    foreach ($name in $envOverrides.Keys) {
      [Environment]::SetEnvironmentVariable($name, $envOverrides[$name], "Process")
    }
    $proc = Start-Process -FilePath $ServerExe `
      -WorkingDirectory $ProjectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog `
      -PassThru
    if (-not $proc) { throw "启动失败" }
  } finally {
    foreach ($name in $previousEnv.Keys) {
      [Environment]::SetEnvironmentVariable($name, $previousEnv[$name], "Process")
    }
  }

  $script:LastState = "starting"
  return $true
}

function Stop-JobAgentService {
  if ($script:Busy) { return $false }
  $serverProcessId = Get-JobAgentPid
  if (-not $serverProcessId) { return $false }

  $script:Busy = $true
  try {
    Stop-Process -Id $serverProcessId -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline) {
      if (-not (Get-JobAgentPid)) { break }
      Start-Sleep -Milliseconds 200
    }
    $script:LastState = "stopped"
  } finally {
    $script:Busy = $false
  }
  return $true
}

function Restart-JobAgentService {
  if ($script:Busy) { return $false }
  if ((Get-JobAgentState) -ne "stopped") {
    [void](Stop-JobAgentService)
    Start-Sleep -Milliseconds 800
  }
  return Start-JobAgentService
}

function Show-TrayBalloon([string]$title, [string]$message) {
  if ($script:NotifyIcon) {
    $script:NotifyIcon.ShowBalloonTip(
      2500,
      $title,
      $message,
      [System.Windows.Forms.ToolTipIcon]::Info)
  }
}

function Set-TrayState([string]$state) {
  $blocked = $script:Busy
  $label = switch ($state) {
    "running"  { "服务运行中" }
    "stopped"  { "服务已停止" }
    "starting" { "服务启动中" }
    "occupied" { "端口被其他进程占用" }
    default    { "正在检查" }
  }

  if ($script:NotifyIcon) {
    $script:NotifyIcon.Text = "求职助手 - $label"
  }
  if ($script:StatusItem) {
    $script:StatusItem.Text = "状态：$label"
  }
  if ($script:OpenItem) {
    $script:OpenItem.Enabled = (-not $blocked) -and ($state -eq "running")
  }
  if ($script:StartItem) {
    $script:StartItem.Enabled = (-not $blocked) -and ($state -eq "stopped")
  }
  if ($script:StopItem) {
    $script:StopItem.Enabled = (-not $blocked) -and ($state -in @("running", "starting"))
  }
  if ($script:RestartItem) {
    $script:RestartItem.Enabled = (-not $blocked) -and ($state -eq "running")
  }
}

function Update-TrayState {
  if ($script:Busy) { return $script:LastState }
  $state = Get-JobAgentState
  $script:LastState = $state
  Set-TrayState $state
  return $state
}

function New-JobAgentIcon {
  $bitmap = New-Object System.Drawing.Bitmap(32, 32)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $font = $null
  $format = $null
  $bgBrush = $null
  $textBrush = $null

  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $bgBrush = New-Object System.Drawing.SolidBrush(
      [System.Drawing.Color]::FromArgb(255, 79, 106, 245))
    $graphics.FillEllipse($bgBrush, 1, 1, 30, 30)

    $font = New-Object System.Drawing.Font(
      "Microsoft YaHei UI",
      15,
      [System.Drawing.FontStyle]::Bold,
      [System.Drawing.GraphicsUnit]::Pixel)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $bounds = New-Object System.Drawing.RectangleF(0, 0, 32, 32)
    $graphics.DrawString("求", $font, $textBrush, $bounds, $format)

    $hIcon = $bitmap.GetHicon()
    return [System.Drawing.Icon]::FromHandle($hIcon)
  } finally {
    if ($textBrush) { $textBrush.Dispose() }
    if ($format) { $format.Dispose() }
    if ($font) { $font.Dispose() }
    if ($bgBrush) { $bgBrush.Dispose() }
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

if ($SelfTest) {
  $selfLog = Join-Path $ProjectRoot "tmp\selftest.log"
  $selfLogDir = Split-Path -Parent $selfLog
  if (-not (Test-Path -LiteralPath $selfLogDir)) {
    New-Item -ItemType Directory -Path $selfLogDir -Force | Out-Null
  }
  Remove-Item -LiteralPath $selfLog -Force -ErrorAction SilentlyContinue

  function Write-TestLog([string]$message) {
    Write-Output $message
    Add-Content -LiteralPath $selfLog -Value $message -Encoding UTF8
  }

  try {
    Write-TestLog ("server_exe=" + $ServerExe)
    $initialState = Get-JobAgentState
    Write-TestLog ("initial=" + $initialState)
    if ($initialState -ne "stopped") { exit 4 }

    [void](Start-JobAgentService)
    $deadline = (Get-Date).AddSeconds(25)
    do {
      Start-Sleep -Milliseconds 500
      $state = Get-JobAgentState
    } while ($state -in @("stopped", "starting") -and (Get-Date) -lt $deadline)
    Write-TestLog ("started=" + $state)
    if ($state -ne "running") { exit 2 }

    [void](Restart-JobAgentService)
    $restartDeadline = (Get-Date).AddSeconds(25)
    do {
      Start-Sleep -Milliseconds 500
      $state = Get-JobAgentState
    } while ($state -in @("stopped", "starting") -and (Get-Date) -lt $restartDeadline)
    Write-TestLog ("restarted=" + $state)
    if ($state -ne "running") { exit 5 }

    [void](Stop-JobAgentService)
    $stopDeadline = (Get-Date).AddSeconds(8)
    do {
      Start-Sleep -Milliseconds 200
      $state = Get-JobAgentState
    } while ($state -ne "stopped" -and (Get-Date) -lt $stopDeadline)
    Write-TestLog ("stopped=" + $state)
    if ($state -ne "stopped") { exit 3 }

    Write-TestLog "selftest=ok"
    exit 0
  } catch {
    Write-Error $_
    Write-TestLog ("error=" + $_.Exception.Message)
    exit 1
  } finally {
    $cleanupPid = Get-JobAgentPid
    if ($cleanupPid) {
      Stop-Process -Id $cleanupPid -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 800
    }
    $afterCleanup = Get-JobAgentPid
    Write-TestLog ("cleanup=" + $(if ($afterCleanup) { "failed" } else { "ok" }))
  }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:OpenItem = New-Object System.Windows.Forms.ToolStripMenuItem("打开控制台")
$sep1 = New-Object System.Windows.Forms.ToolStripSeparator
$script:StartItem = New-Object System.Windows.Forms.ToolStripMenuItem("启动服务")
$script:StopItem = New-Object System.Windows.Forms.ToolStripMenuItem("停止服务")
$script:RestartItem = New-Object System.Windows.Forms.ToolStripMenuItem("重启服务")
$sep2 = New-Object System.Windows.Forms.ToolStripSeparator
$script:StatusItem = New-Object System.Windows.Forms.ToolStripMenuItem("状态：正在检查")
$script:StatusItem.Enabled = $false
$sep3 = New-Object System.Windows.Forms.ToolStripSeparator
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem("退出托盘")

[void]$menu.Items.Add($script:OpenItem)
[void]$menu.Items.Add($sep1)
[void]$menu.Items.Add($script:StartItem)
[void]$menu.Items.Add($script:StopItem)
[void]$menu.Items.Add($script:RestartItem)
[void]$menu.Items.Add($sep2)
[void]$menu.Items.Add($script:StatusItem)
[void]$menu.Items.Add($sep3)
[void]$menu.Items.Add($exitItem)

$script:OpenItem.Add_Click({
  if ((Get-JobAgentState) -eq "running") {
    Start-Process $ServerUrl
  }
})

$script:StartItem.Add_Click({
  if ($script:Busy) { return }
  try {
    if (Start-JobAgentService) {
      Show-TrayBalloon "求职助手" "后台服务正在启动"
      Update-TrayState
    } else {
      Update-TrayState
    }
  } catch {
    Show-TrayBalloon "启动失败" $_.Exception.Message
    Update-TrayState
  }
})

$script:StopItem.Add_Click({
  if ($script:Busy) { return }
  try {
    if (Stop-JobAgentService) {
      Show-TrayBalloon "求职助手" "后台服务已停止"
      Update-TrayState
    } else {
      Update-TrayState
    }
  } catch {
    Show-TrayBalloon "停止失败" $_.Exception.Message
    Update-TrayState
  }
})

$script:RestartItem.Add_Click({
  if ($script:Busy) { return }
  try {
    if (Restart-JobAgentService) {
      Show-TrayBalloon "求职助手" "后台服务正在重启"
      Update-TrayState
    } else {
      Update-TrayState
    }
  } catch {
    Show-TrayBalloon "重启失败" $_.Exception.Message
    Update-TrayState
  }
})

$exitItem.Add_Click({
  if ($script:NotifyIcon) {
    $script:NotifyIcon.Visible = $false
  }
  if ($script:StateTimer) {
    $script:StateTimer.Stop()
  }
  [System.Windows.Forms.Application]::Exit()
})

$menu.Add_Opening({ Update-TrayState })

$script:NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:NotifyIcon.Icon = New-JobAgentIcon
$script:NotifyIcon.Text = "求职助手"
$script:NotifyIcon.Visible = $true
$script:NotifyIcon.ContextMenuStrip = $menu

$script:NotifyIcon.Add_MouseClick({
  if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    try {
      $state = Update-TrayState
      if ($state -eq "stopped") {
        if (Start-JobAgentService) {
          Show-TrayBalloon "求职助手" "后台服务正在启动"
        }
      }
      Start-Process $ServerUrl
    } catch {
      Show-TrayBalloon "启动失败" $_.Exception.Message
      Update-TrayState
    }
  }
})

$script:StateTimer = New-Object System.Windows.Forms.Timer
$script:StateTimer.Interval = 1500
$script:StateTimer.Add_Tick({ Update-TrayState })
$script:StateTimer.Start()

Update-TrayState

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  if ($script:StateTimer) {
    $script:StateTimer.Stop()
    $script:StateTimer.Dispose()
  }
  if ($script:NotifyIcon) {
    $script:NotifyIcon.Visible = $false
    $script:NotifyIcon.Dispose()
  }
}
