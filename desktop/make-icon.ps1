[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not ("HandTalk.NativeIcon" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace HandTalk
{
    public static class NativeIcon
    {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool DestroyIcon(IntPtr handle);
    }
}
'@
}

$ResolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$OutputDirectory = Split-Path -Parent $ResolvedOutput
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$Bitmap = New-Object System.Drawing.Bitmap 256, 256
$Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
$BoardPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$BoardBrush = $null
$GridPen = $null
$ShadowBrush = $null
$BlackBrush = $null
$WhiteBrush = $null
$WhiteOutline = $null
$Icon = $null
$Stream = $null
$IconHandle = [IntPtr]::Zero

try {
    $Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $Graphics.Clear([System.Drawing.Color]::Transparent)

    # Rounded, warm wooden board. The three stones remain readable down to a
    # 16 px taskbar icon while still looking like the application's full board.
    $Radius = 42
    $BoardPath.AddArc(8, 8, $Radius, $Radius, 180, 90)
    $BoardPath.AddArc(206, 8, $Radius, $Radius, 270, 90)
    $BoardPath.AddArc(206, 206, $Radius, $Radius, 0, 90)
    $BoardPath.AddArc(8, 206, $Radius, $Radius, 90, 90)
    $BoardPath.CloseFigure()

    $BoardBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Rectangle 8, 8, 240, 240),
        [System.Drawing.Color]::FromArgb(255, 231, 183, 91),
        [System.Drawing.Color]::FromArgb(255, 192, 132, 48),
        35.0
    )
    $Graphics.FillPath($BoardBrush, $BoardPath)

    $GridPen = New-Object System.Drawing.Pen(
        [System.Drawing.Color]::FromArgb(155, 70, 48, 22),
        6.0
    )
    foreach ($Coordinate in @(58, 98, 138, 178, 218)) {
        $Graphics.DrawLine($GridPen, 38, $Coordinate, 218, $Coordinate)
        $Graphics.DrawLine($GridPen, $Coordinate, 38, $Coordinate, 218)
    }

    $ShadowBrush = New-Object System.Drawing.SolidBrush(
        [System.Drawing.Color]::FromArgb(65, 0, 0, 0)
    )
    $Graphics.FillEllipse($ShadowBrush, 51, 49, 78, 78)
    $Graphics.FillEllipse($ShadowBrush, 131, 129, 78, 78)

    $BlackBrush = New-Object System.Drawing.SolidBrush(
        [System.Drawing.Color]::FromArgb(255, 25, 27, 30)
    )
    $Graphics.FillEllipse($BlackBrush, 45, 43, 78, 78)

    $WhiteBrush = New-Object System.Drawing.SolidBrush(
        [System.Drawing.Color]::FromArgb(255, 247, 248, 244)
    )
    $WhiteOutline = New-Object System.Drawing.Pen(
        [System.Drawing.Color]::FromArgb(190, 115, 105, 83),
        4.0
    )
    $Graphics.FillEllipse($WhiteBrush, 125, 123, 78, 78)
    $Graphics.DrawEllipse($WhiteOutline, 125, 123, 78, 78)

    $IconHandle = $Bitmap.GetHicon()
    $Icon = [System.Drawing.Icon]::FromHandle($IconHandle)
    $Stream = [IO.File]::Open(
        $ResolvedOutput,
        [IO.FileMode]::Create,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
    )
    $Icon.Save($Stream)
} finally {
    if ($null -ne $Stream) { $Stream.Dispose() }
    if ($null -ne $Icon) { $Icon.Dispose() }
    if ($IconHandle -ne [IntPtr]::Zero) {
        [void][HandTalk.NativeIcon]::DestroyIcon($IconHandle)
    }
    if ($null -ne $WhiteOutline) { $WhiteOutline.Dispose() }
    if ($null -ne $WhiteBrush) { $WhiteBrush.Dispose() }
    if ($null -ne $BlackBrush) { $BlackBrush.Dispose() }
    if ($null -ne $ShadowBrush) { $ShadowBrush.Dispose() }
    if ($null -ne $GridPen) { $GridPen.Dispose() }
    if ($null -ne $BoardBrush) { $BoardBrush.Dispose() }
    $BoardPath.Dispose()
    $Graphics.Dispose()
    $Bitmap.Dispose()
}

if (-not (Test-Path -LiteralPath $ResolvedOutput -PathType Leaf)) {
    throw "Icon generation failed: $ResolvedOutput"
}

Write-Host "Desktop icon: $ResolvedOutput" -ForegroundColor Green
