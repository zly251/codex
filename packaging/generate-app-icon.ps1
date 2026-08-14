#Requires -Version 5.1
<#
生成 packaging/job-agent.ico，视觉与托盘图标一致：
透明底、蓝色 #4F6AF5 圆形、白色“求”字。
多尺寸：16 / 24 / 32 / 48 / 64 / 128（BMP 32bpp）+ 256（PNG）。
用法：powershell -NoProfile -ExecutionPolicy Bypass -File packaging/generate-app-icon.ps1
#>
[CmdletBinding()]
param(
  [string]$OutPath
)

# $PSScriptRoot 在部分执行环境下为空，这里做多重回退
if (-not $PSScriptRoot) {
  $script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
  $script:ScriptDir = $PSScriptRoot
}
if (-not $script:ScriptDir) {
  $script:ScriptDir = (Get-Location).Path
}
if (-not $OutPath) {
  $OutPath = Join-Path $script:ScriptDir "job-agent.ico"
}

Add-Type -AssemblyName System.Drawing

$Sizes = @(16, 24, 32, 48, 64, 128, 256)
$CharQiu = [string][char]0x6C42  # “求”

function New-JobAgentBitmap([int]$Size) {
  $bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $bgBrush = $null
  $font = $null
  $format = $null
  $textBrush = $null
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)

    # 与托盘一致：32px 时圆形从 (1,1) 到 (31,31)，其余尺寸按比例缩放
    $margin = [Math]::Max(1, [int][Math]::Round($Size / 32.0))
    $diameter = $Size - 2 * $margin
    $bgBrush = New-Object System.Drawing.SolidBrush(
      [System.Drawing.Color]::FromArgb(255, 79, 106, 245))
    $graphics.FillEllipse($bgBrush, $margin, $margin, $diameter, $diameter)

    # 与托盘一致：32px 用 15px 粗体，其余尺寸按比例缩放
    $fontSize = [Math]::Max(7, [int][Math]::Round($Size * 15.0 / 32.0))
    $font = New-Object System.Drawing.Font(
      "Microsoft YaHei UI",
      $fontSize,
      [System.Drawing.FontStyle]::Bold,
      [System.Drawing.GraphicsUnit]::Pixel)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $bounds = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
    $graphics.DrawString($CharQiu, $font, $textBrush, $bounds, $format)
  } finally {
    if ($textBrush) { $textBrush.Dispose() }
    if ($format) { $format.Dispose() }
    if ($font) { $font.Dispose() }
    if ($bgBrush) { $bgBrush.Dispose() }
    $graphics.Dispose()
  }
  return $bitmap
}

# 转成 ICO 用的 32bpp BGRA 位图数据（BITMAPINFOHEADER + 像素，自下而上）
function ConvertTo-IconBmpBytes([System.Drawing.Bitmap]$bitmap) {
  $width = $bitmap.Width
  $height = $bitmap.Height
  $stride = $width * 4
  $pixels = New-Object byte[] ($stride * $height)
  for ($y = 0; $y -lt $height; $y++) {
    for ($x = 0; $x -lt $width; $x++) {
      $c = $bitmap.GetPixel($x, $y)
      $i = ($height - 1 - $y) * $stride + $x * 4
      $pixels[$i] = $c.B
      $pixels[$i + 1] = $c.G
      $pixels[$i + 2] = $c.R
      $pixels[$i + 3] = $c.A
    }
  }
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  try {
    $bw.Write([int32]40)              # biSize
    $bw.Write([int32]$width)          # biWidth
    $bw.Write([int32]$height)         # biHeight（32bpp 含 alpha，无需 AND mask）
    $bw.Write([int16]1)               # biPlanes
    $bw.Write([int16]32)              # biBitCount
    $bw.Write([int32]0)               # biCompression
    $bw.Write([int32]$pixels.Length)  # biSizeImage
    $bw.Write([int32]0)
    $bw.Write([int32]0)
    $bw.Write([int32]0)
    $bw.Write([int32]0)
    $bw.Write($pixels)
    $bw.Flush()
    $bytes = $ms.ToArray()
  } finally {
    $bw.Dispose()
    $ms.Dispose()
  }
  return ,$bytes
}

# 转成 ICO 用的 PNG 数据（256x256 使用 PNG 压缩）
function ConvertTo-IconPngBytes([System.Drawing.Bitmap]$bitmap) {
  $ms = New-Object System.IO.MemoryStream
  try {
    $bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
  } finally {
    $ms.Dispose()
  }
  return ,$bytes
}

$outDir = Split-Path -Parent $OutPath
if (-not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

# 先绘制所有尺寸，收集图像数据
$blobs = @()
foreach ($size in $Sizes) {
  $bitmap = New-JobAgentBitmap -Size $size
  try {
    if ($size -ge 256) {
      $blob = ConvertTo-IconPngBytes $bitmap
    } else {
      $blob = ConvertTo-IconBmpBytes $bitmap
    }
  } finally {
    $bitmap.Dispose()
  }
  $blobs += ,@{
    Size   = $size
    Length = $blob.Length
    Data   = $blob
  }
}

# 组装 ICO：ICONDIR + ICONDIRENTRY + 图像数据
$headerSize = 6 + 16 * $blobs.Count
$offset = $headerSize
$fs = [System.IO.File]::Create($OutPath)
$bw = New-Object System.IO.BinaryWriter($fs)
try {
  $bw.Write([uint16]0)             # reserved
  $bw.Write([uint16]1)             # type: icon
  $bw.Write([uint16]$blobs.Count)  # count
  foreach ($entry in $blobs) {
    $dim = $entry.Size
    if ($dim -ge 256) { $dim = 0 }  # 256 在 ICONDIRENTRY 中记为 0
    $bw.Write([byte]$dim)           # width
    $bw.Write([byte]$dim)           # height
    $bw.Write([byte]0)              # color count
    $bw.Write([byte]0)              # reserved
    $bw.Write([uint16]1)            # planes
    $bw.Write([uint16]32)           # bit count
    $bw.Write([uint32]$entry.Length)
    $bw.Write([uint32]$offset)
    $offset += $entry.Length
  }
  foreach ($entry in $blobs) {
    $bw.Write($entry.Data)
  }
  $bw.Flush()
} finally {
  $bw.Dispose()
  $fs.Dispose()
}

$sizeBytes = (Get-Item -LiteralPath $OutPath).Length
Write-Host "[generate-app-icon] 已生成 $OutPath ($sizeBytes bytes, $($blobs.Count) 个尺寸: $($Sizes -join '/'))"
