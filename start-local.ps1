[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$PythonExe = Join-Path $ProjectRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
    Write-Host "First run: preparing the local runtime..." -ForegroundColor Yellow
    & (Join-Path $ProjectRoot "setup-local.ps1")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$KataGoRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "..\KataGo"))
$env:KATAGO_PATH = Join-Path $KataGoRoot "katago.exe"
$env:KATAGO_MODEL = Join-Path $KataGoRoot "models\kata1-tf2-b10c384-s2941M-d5872M.bin.gz"
$env:KATAGO_CONFIG = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "..\KaTrain\analysis_5060.cfg"))
$env:PORT = "5000"
$env:DEFAULT_LANGUAGE = "zh"
$env:DEFAULT_MAX_VISITS = "1000"
$env:PYTHONUTF8 = "1"
$env:PYTHONUNBUFFERED = "1"
$VisionModelRoot = Join-Path $ProjectRoot "models\image2sgf"
$BoardVisionModel = Join-Path $VisionModelRoot "board.pth"
$StoneVisionModel = Join-Path $VisionModelRoot "stone.pth"

if ($NoBrowser) {
    $env:KATAGO_WEB_NO_BROWSER = "1"
} else {
    Remove-Item Env:KATAGO_WEB_NO_BROWSER -ErrorAction SilentlyContinue
}

foreach ($RequiredPath in @(
    $env:KATAGO_PATH,
    $env:KATAGO_MODEL,
    $env:KATAGO_CONFIG,
    $BoardVisionModel,
    $StoneVisionModel
)) {
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
        throw "Required file not found: $RequiredPath"
    }
}

Push-Location $ProjectRoot
try {
    & $PythonExe (Join-Path $ProjectRoot "run-local.py")
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
