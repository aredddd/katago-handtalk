[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [string]$KataGoPath,
    [string]$ModelPath,
    [string]$ConfigPath,
    [switch]$DisableVision,
    [switch]$CpuVision
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$PythonExe = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$PreferredBoardVisionModel = Join-Path $ProjectRoot "models\vision\board.pth"
$PreferredStoneVisionModel = Join-Path $ProjectRoot "models\vision\stone.pth"
$LegacyBoardVisionModel = Join-Path $ProjectRoot "models\image2sgf\board.pth"
$LegacyStoneVisionModel = Join-Path $ProjectRoot "models\image2sgf\stone.pth"
if ((Test-Path -LiteralPath $PreferredBoardVisionModel -PathType Leaf) -and
    (Test-Path -LiteralPath $PreferredStoneVisionModel -PathType Leaf)) {
    $BoardVisionModel = $PreferredBoardVisionModel
    $StoneVisionModel = $PreferredStoneVisionModel
} else {
    $BoardVisionModel = $LegacyBoardVisionModel
    $StoneVisionModel = $LegacyStoneVisionModel
}
$VisionAvailable = (
    -not $DisableVision -and
    (Test-Path -LiteralPath $BoardVisionModel -PathType Leaf) -and
    (Test-Path -LiteralPath $StoneVisionModel -PathType Leaf)
)

if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
    Write-Host "First run: preparing the local runtime..." -ForegroundColor Yellow
    $VisionBackend = if (-not $VisionAvailable) { "None" } elseif ($CpuVision) { "CPU" } else { "Auto" }
    & (Join-Path $ProjectRoot "setup-local.ps1") -VisionBackend $VisionBackend
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not [string]::IsNullOrWhiteSpace($KataGoPath)) { $env:KATAGO_PATH = [IO.Path]::GetFullPath($KataGoPath) }
if (-not [string]::IsNullOrWhiteSpace($ModelPath)) { $env:KATAGO_MODEL = [IO.Path]::GetFullPath($ModelPath) }
if (-not [string]::IsNullOrWhiteSpace($ConfigPath)) { $env:KATAGO_CONFIG = [IO.Path]::GetFullPath($ConfigPath) }
$env:PORT = if ($env:PORT) { $env:PORT } else { "5000" }
$env:DEFAULT_LANGUAGE = "zh"
$env:DEFAULT_MAX_VISITS = "1000"
$env:KATAGO_WORK_DIR = Join-Path $ProjectRoot ".runtime\katago-work"
$env:PYTHONUTF8 = "1"
$env:PYTHONUNBUFFERED = "1"
$env:KATAGO_VISION_ENABLED = if ($VisionAvailable) { "1" } else { "0" }
if ($VisionAvailable) {
    $env:KATAGO_VISION_BOARD_MODEL = $BoardVisionModel
    $env:KATAGO_VISION_STONE_MODEL = $StoneVisionModel
}

if ($NoBrowser) {
    $env:KATAGO_WEB_NO_BROWSER = "1"
} else {
    Remove-Item Env:KATAGO_WEB_NO_BROWSER -ErrorAction SilentlyContinue
}

Push-Location $ProjectRoot
try {
    & $PythonExe (Join-Path $ProjectRoot "run-local.py")
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
