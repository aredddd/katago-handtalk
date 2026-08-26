[CmdletBinding()]
param(
    [switch]$CpuVision
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ProjectRoot = $PSScriptRoot
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$UvRoot = Join-Path $RuntimeRoot "uv"
$UvExe = Join-Path $UvRoot "uv.exe"
$UvArchive = Join-Path $RuntimeRoot "uv.zip"
$PythonExe = Join-Path $ProjectRoot ".venv\Scripts\python.exe"

$KataGoRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "..\KataGo"))
$KataGoExe = Join-Path $KataGoRoot "katago.exe"
$KataGoModel = Join-Path $KataGoRoot "models\kata1-tf2-b10c384-s2941M-d5872M.bin.gz"
$AnalysisConfig = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "..\KaTrain\analysis_5060.cfg"))
$VisionModelRoot = Join-Path $ProjectRoot "models\image2sgf"
$BoardVisionModel = Join-Path $VisionModelRoot "board.pth"
$StoneVisionModel = Join-Path $VisionModelRoot "stone.pth"

Write-Host ""
Write-Host "KataGo Web - portable local runtime" -ForegroundColor Cyan
Write-Host "Project: $ProjectRoot"

foreach ($RequiredPath in @($KataGoExe, $KataGoModel, $AnalysisConfig)) {
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
        throw "Required file not found: $RequiredPath"
    }
}

$MissingVisionModels = @($BoardVisionModel, $StoneVisionModel) |
    Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }
if ($MissingVisionModels.Count -gt 0) {
    $MissingList = $MissingVisionModels -join "`n  - "
    throw @"
Screenshot recognition model missing:
  - $MissingList
Download board.pth and stone.pth from the upstream image2sgf release and place
them in: $VisionModelRoot
https://github.com/noword/image2sgf/releases
"@
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $UvRoot | Out-Null

if (-not (Test-Path -LiteralPath $UvExe -PathType Leaf)) {
    Write-Host "[1/5] Downloading the portable uv runtime manager..." -ForegroundColor Yellow
    $UvUrl = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip"
    Invoke-WebRequest -Uri $UvUrl -OutFile $UvArchive -UseBasicParsing
    Expand-Archive -LiteralPath $UvArchive -DestinationPath $UvRoot -Force
    Remove-Item -LiteralPath $UvArchive -Force
} else {
    Write-Host "[1/5] uv is ready." -ForegroundColor Green
}

$env:UV_PYTHON_INSTALL_DIR = Join-Path $RuntimeRoot "python"
$env:UV_CACHE_DIR = Join-Path $RuntimeRoot "cache"
$env:UV_PYTHON_PREFERENCE = "only-managed"

Write-Host "[2/5] Preparing project-local Python 3.11..." -ForegroundColor Yellow
& $UvExe python install 3.11 --no-bin --no-registry
if ($LASTEXITCODE -ne 0) { throw "Python 3.11 installation failed." }

if (-not (Test-Path -LiteralPath $PythonExe -PathType Leaf)) {
    & $UvExe venv (Join-Path $ProjectRoot ".venv") --python 3.11
    if ($LASTEXITCODE -ne 0) { throw "Virtual environment creation failed." }
}

Write-Host "[3/5] Installing Web and screenshot recognition dependencies..." -ForegroundColor Yellow
if ($CpuVision) {
    $TorchIndex = "https://download.pytorch.org/whl/cpu"
    $ExpectedTorchFlavor = "cpu"
} else {
    $TorchIndex = "https://download.pytorch.org/whl/cu128"
    $ExpectedTorchFlavor = "12.8"
}
& $UvExe pip install --python $PythonExe torch torchvision --index-url $TorchIndex
if ($LASTEXITCODE -ne 0) { throw "PyTorch installation failed." }

# uv correctly treats an installed same-version wheel as satisfied even when
# switching CPU/CUDA indexes. Detect that case and explicitly replace the wheel.
$InstalledTorchFlavor = (& $PythonExe -c "import torch; print(torch.version.cuda or 'cpu')").Trim()
if ($InstalledTorchFlavor -ne $ExpectedTorchFlavor) {
    Write-Host "Switching PyTorch runtime ($InstalledTorchFlavor -> $ExpectedTorchFlavor)..." -ForegroundColor Yellow
    & $UvExe pip install --python $PythonExe --reinstall torch torchvision --index-url $TorchIndex
    if ($LASTEXITCODE -ne 0) { throw "PyTorch runtime switch failed." }
}

& $UvExe pip install --python $PythonExe -r (Join-Path $ProjectRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed." }

Write-Host "[4/5] Verifying imports and RTX acceleration..." -ForegroundColor Yellow
$VerifyCode = @'
import os
import cv2, flask, flask_socketio, simple_websocket
import torch, torchvision
print(f"Python import: OK")
print(f"PyTorch: {torch.__version__}")
print(f"Torchvision: {torchvision.__version__}")
print(f"CUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"CUDA device: {torch.cuda.get_device_name(0)}")
if os.environ.get("KATAGO_WEB_EXPECT_CUDA") == "1" and not torch.cuda.is_available():
    raise SystemExit("CUDA PyTorch was installed, but the NVIDIA GPU is unavailable")
'@
$env:KATAGO_WEB_EXPECT_CUDA = if ($CpuVision) { "0" } else { "1" }
$VerifyCode | & $PythonExe -
if ($LASTEXITCODE -ne 0) { throw "Dependency import verification failed." }

Write-Host "[5/5] Removing downloaded package cache..." -ForegroundColor Yellow
& $UvExe cache clean
if ($LASTEXITCODE -ne 0) { throw "uv cache cleanup failed." }

Write-Host ""
Write-Host "Setup complete. Double-click start-local.cmd to launch." -ForegroundColor Green
Write-Host "The service only listens on http://127.0.0.1:5000." -ForegroundColor Green
