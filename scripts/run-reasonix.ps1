param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Task,

    [string]$ProjectDir = "",

    [ValidateSet("deepseek-flash", "deepseek-pro", "mimo-pro", "mimo-flash")]
    [string]$Model = "deepseek-flash",

    [ValidateSet("manual", "ask", "auto", "acceptEdits", "dontAsk", "plan", "bypassPermissions")]
    [string]$PermissionMode = "auto",

    [int]$MaxSteps = 0,

    [string]$OutputDir = "",

    [string[]]$AllowedTools = @()
)

$ErrorActionPreference = "Stop"

if (-not $ProjectDir) {
    if ($PSScriptRoot) {
        $ProjectDir = Join-Path $PSScriptRoot ".."
    } else {
        $ProjectDir = (Get-Location).Path
    }
}

if (-not (Test-Path -LiteralPath $ProjectDir)) {
    throw "Project directory not found: $ProjectDir"
}

$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path

$reasonixCandidates = @()
if ($env:REASONIX_BIN) { $reasonixCandidates += $env:REASONIX_BIN }
$cmd = Get-Command reasonix -ErrorAction SilentlyContinue
if ($cmd) { $reasonixCandidates += $cmd.Source }
$localReasonix = Join-Path (Split-Path -Parent $ProjectDir) "reasonix-desktop\reasonix-cli.exe"
if (Test-Path -LiteralPath $localReasonix) { $reasonixCandidates += $localReasonix }
$reasonixBin = $reasonixCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

if (-not $reasonixBin) {
    throw "ReasonX CLI not found. Set REASONIX_BIN or add reasonix to PATH."
}

if (-not $OutputDir) {
    $OutputDir = Join-Path $ProjectDir "tmp\reasonix"
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$taskFile = Join-Path ([System.IO.Path]::GetTempPath()) ("reasonix-task-" + [Guid]::NewGuid().ToString("N") + ".txt")
$stdoutPath = Join-Path $OutputDir "$stamp.json"
$stderrPath = Join-Path $OutputDir "$stamp.err.txt"
$metricsPath = Join-Path $OutputDir "$stamp.metrics.json"

try {
    Set-Content -LiteralPath $taskFile -Value $Task -Encoding UTF8
    $taskText = (Get-Content -LiteralPath $taskFile -Raw).Trim()

    $reasonixArgs = @(
        "run",
        "--dir", $ProjectDir,
        "--model", $Model,
        "--permission-mode", $PermissionMode,
        "--output-format", "json",
        "--metrics", $metricsPath
    )

    if ($MaxSteps -gt 0) {
        $reasonixArgs += @("--max-steps", [string]$MaxSteps)
    }

    if ($AllowedTools.Count -gt 0) {
        $reasonixArgs += @("--allowed-tools", ($AllowedTools -join ","))
    }

    $output = & $reasonixBin @reasonixArgs $taskText 2> $stderrPath | Out-String
    $exitCode = $LASTEXITCODE

    Set-Content -LiteralPath $stdoutPath -Value $output.Trim() -Encoding UTF8

    if ($exitCode -ne 0) {
        Write-Host "REASONIX_FAILED exit=$exitCode stdout=$stdoutPath stderr=$stderrPath"
        if (Test-Path -LiteralPath $stderrPath) {
            Get-Content -LiteralPath $stderrPath -Tail 30
        }
        exit $exitCode
    }

    $parsed = $null
    try {
        $parsed = $output.Trim() | ConvertFrom-Json
    }
    catch {
        $parsed = $null
    }

    if ($parsed) {
        [pscustomobject]@{
            session_id  = $parsed.session_id
            result      = $parsed.result
            total_cost  = $parsed.total_cost
            total_cost_usd = $parsed.total_cost_usd
            usage       = $parsed.usage
            stdout      = $stdoutPath
            metrics     = $metricsPath
        } | Format-List
    }
    else {
        Write-Host "REASONIX_OUTPUT_NON_JSON stdout=$stdoutPath"
        $output
    }
}
finally {
    Remove-Item -LiteralPath $taskFile -Force -ErrorAction SilentlyContinue
}
