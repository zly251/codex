# Job Agent one-click launcher (double-click 求职助手.bat)
$ErrorActionPreference = "SilentlyContinue"
if ($PSScriptRoot) {
  $ProjectDir = $PSScriptRoot
} else {
  $ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$ServerUrl  = "http://localhost:3456"
$LogFile    = Join-Path $ProjectDir "data\launcher.log"
$ProfileDir = Join-Path $ProjectDir ".edge-profile"
$ProfileDir2 = Join-Path $ProjectDir ".edge-profile-2"

Set-Location $ProjectDir
if (-not (Test-Path (Join-Path $ProjectDir "data"))) { New-Item -ItemType Directory -Path (Join-Path $ProjectDir "data") -Force | Out-Null }
if (-not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null }

function Write-Log($msg) {
  $line = (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "  " + $msg
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch {}
}

function Test-PortOpen([int]$port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    if ($c) { return $true }
  } catch {}
  return [bool](netstat -ano | Select-String (":" + $port + "\s") -Quiet)
}

function Find-Edge {
  $paths = @(
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files (x86)\Microsoft\Edge Beta\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge Beta\Application\msedge.exe",
    "C:\Program Files (x86)\Microsoft\Edge Dev\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge Dev\Application\msedge.exe",
    "C:\Program Files (x86)\Microsoft\Edge Canary\Application\msedge.exe"
  )
  foreach ($p in $paths) { if (Test-Path $p) { return $p } }
  return $null
}

function Find-Node {
  if ($env:JOB_AGENT_NODE -and (Test-Path -LiteralPath $env:JOB_AGENT_NODE)) { return $env:JOB_AGENT_NODE }
  $localNode = Join-Path $ProjectDir "node.exe"
  if (Test-Path -LiteralPath $localNode) { return $localNode }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Start-Server {
  $node = Find-Node
  if (-not $node) { Write-Log "node not found"; return $false }
  $args = @("node_modules\tsx\dist\cli.mjs", "server.mjs")
  Start-Process -FilePath $node -WindowStyle Hidden -ArgumentList $args -WorkingDirectory $ProjectDir | Out-Null
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortOpen 3456) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Start-Edge {
  $exe = Find-Edge
  if (-not $exe) { Write-Log "edge not found"; return $false }
  $args = @("--remote-debugging-port=9222", "--remote-allow-origins=*", "--user-data-dir=$ProfileDir", "--start-maximized", "--no-first-run", "--disable-notifications", "https://www.zhipin.com")
  Start-Process -FilePath $exe -ArgumentList $args | Out-Null
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 700
  }
  $args2 = @("--remote-debugging-port=9222", "--remote-allow-origins=*", "--user-data-dir=$ProfileDir2", "--start-maximized", "--no-first-run", "--disable-notifications", "https://www.zhipin.com")
  Start-Process -FilePath $exe -ArgumentList $args2 | Out-Null
  $deadline2 = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline2) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 700
  }
  return $false
}

Write-Log "launcher start"
if (-not (Test-PortOpen 3456)) {
  if (-not (Start-Server)) { Write-Log "server start failed" }
} else {
  Write-Log "server already running"
}

if (-not (Test-PortOpen 9222)) {
  if (-not (Start-Edge)) { Write-Log "edge start failed" }
} else {
  Write-Log "edge CDP already open"
}

for ($i = 1; $i -le 3; $i++) {
  try {
    $body = '{"host":"127.0.0.1","port":9222}'
    $res = Invoke-RestMethod -Uri "$ServerUrl/api/boss/connect" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 10
    if ($res.ok) { Write-Log "connected"; break }
  } catch {
    Write-Log "connect retry $i"
    Start-Sleep -Seconds 3
  }
}

Start-Process "http://localhost:3456"
Write-Log "launcher done"
