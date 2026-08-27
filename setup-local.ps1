[CmdletBinding()]
param(
    [string]$RuntimeRoot,
    [string]$VenvRoot,
    [ValidateSet("None", "Auto", "CUDA", "CPU")]
    [string]$VisionBackend = "Auto",
    [switch]$CpuVision
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ProjectRoot = $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    $RuntimeRoot = Join-Path $ProjectRoot ".runtime"
}
if ([string]::IsNullOrWhiteSpace($VenvRoot)) {
    $VenvRoot = Join-Path $ProjectRoot ".venv"
}
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$VenvRoot = [IO.Path]::GetFullPath($VenvRoot)
if ($CpuVision) { $VisionBackend = "CPU" }

$UvVersion = "0.12.6"
$UvSha256 = "DF7CB9F243EAE1621400D4FCF5B1B3D90F20E264ECE91B64DEB3B0078ABCA6EF"
$PythonVersion = "3.11.16"
$UvRoot = Join-Path $RuntimeRoot "uv"
$UvExe = Join-Path $UvRoot "uv.exe"
$UvArchive = Join-Path $RuntimeRoot "uv-$UvVersion.zip"
$PythonExe = Join-Path $VenvRoot "Scripts\python.exe"
$CoreRequirementsInput = Join-Path $ProjectRoot "requirements.txt"
$CoreRequirements = Join-Path $ProjectRoot "requirements.lock.txt"
$VisionRequirementsInput = Join-Path $ProjectRoot "requirements-vision.txt"
$VisionRequirements = Join-Path $ProjectRoot "requirements-vision.lock.txt"
$TorchRequirementsInput = Join-Path $ProjectRoot "requirements-torch.txt"
$TorchCpuRequirements = Join-Path $ProjectRoot "requirements-torch-cpu.lock.txt"
$TorchCudaRequirements = Join-Path $ProjectRoot "requirements-torch-cuda.lock.txt"

Write-Host ""
Write-Host "KataGo HandTalk - local runtime" -ForegroundColor Cyan
Write-Host "Application : $ProjectRoot"
Write-Host "Runtime     : $RuntimeRoot"
Write-Host "Environment : $VenvRoot"
Write-Host "Vision      : $VisionBackend"

foreach ($RequiredPath in @(
    $CoreRequirementsInput,
    $CoreRequirements,
    $VisionRequirementsInput,
    $VisionRequirements,
    $TorchRequirementsInput,
    $TorchCpuRequirements,
    $TorchCudaRequirements
)) {
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
        throw "Required setup file not found: $RequiredPath"
    }
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $UvRoot | Out-Null

$UvReady = $false
if (Test-Path -LiteralPath $UvExe -PathType Leaf) {
    try {
        $ActualUvVersion = (& $UvExe --version).Trim()
        $UvReady = $LASTEXITCODE -eq 0 -and $ActualUvVersion -match "^uv\s+$([regex]::Escape($UvVersion))(?:\s|$)"
    } catch {
        $UvReady = $false
    }
}
if (-not $UvReady) {
    Write-Host "[1/5] Downloading verified uv $UvVersion..." -ForegroundColor Yellow
    if (Test-Path -LiteralPath $UvExe -PathType Leaf) {
        Remove-Item -LiteralPath $UvExe -Force
    }
    $UvUrl = "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip"
    try {
        Invoke-WebRequest -Uri $UvUrl -OutFile $UvArchive -UseBasicParsing
        $ActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $UvArchive).Hash
        if ($ActualHash -ne $UvSha256) {
            throw "uv archive checksum mismatch. Expected $UvSha256, got $ActualHash."
        }
        Expand-Archive -LiteralPath $UvArchive -DestinationPath $UvRoot -Force
    } finally {
        if (Test-Path -LiteralPath $UvArchive -PathType Leaf) {
            Remove-Item -LiteralPath $UvArchive -Force
        }
    }
    $ActualUvVersion = (& $UvExe --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $ActualUvVersion -notmatch "^uv\s+$([regex]::Escape($UvVersion))(?:\s|$)") {
        throw "Pinned uv extraction produced an unexpected version: $ActualUvVersion"
    }
} else {
    Write-Host "[1/5] uv $UvVersion is ready." -ForegroundColor Green
}

$env:UV_PYTHON_INSTALL_DIR = Join-Path $RuntimeRoot "python"
$env:UV_CACHE_DIR = Join-Path $RuntimeRoot "cache"
$env:UV_PYTHON_PREFERENCE = "only-managed"
$env:PYTHONUTF8 = "1"

Write-Host "[2/5] Preparing isolated Python $PythonVersion..." -ForegroundColor Yellow
& $UvExe python install $PythonVersion --no-bin --no-registry
if ($LASTEXITCODE -ne 0) { throw "Portable Python $PythonVersion installation failed." }
$VenvReady = $false
if (Test-Path -LiteralPath $PythonExe -PathType Leaf) {
    try {
        $ActualPythonVersion = (& $PythonExe -c "import platform; print(platform.python_version())").Trim()
        $VenvReady = $LASTEXITCODE -eq 0 -and $ActualPythonVersion -eq $PythonVersion
    } catch {
        $VenvReady = $false
    }
}
if (-not $VenvReady) {
    $VenvArguments = @($VenvRoot, "--python", $PythonVersion)
    if (Test-Path -LiteralPath $VenvRoot) {
        # uv refuses to clear a non-virtual-environment directory unless
        # --force is supplied. Never supply it for a user-configurable path.
        $VenvArguments += "--clear"
    }
    & $UvExe venv @VenvArguments
    if ($LASTEXITCODE -ne 0) { throw "Virtual environment creation failed." }
}
$ActualPythonVersion = (& $PythonExe -c "import platform; print(platform.python_version())").Trim()
if ($LASTEXITCODE -ne 0 -or $ActualPythonVersion -ne $PythonVersion) {
    throw "Virtual environment Python must be $PythonVersion, got: $ActualPythonVersion"
}

Write-Host "[3/5] Installing the core web runtime..." -ForegroundColor Yellow
& $UvExe pip install --python $PythonExe --require-hashes --requirement $CoreRequirements
if ($LASTEXITCODE -ne 0) { throw "Core dependency installation failed." }

$ResolvedVision = $VisionBackend
if ($ResolvedVision -eq "Auto") {
    $ResolvedVision = if (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue) { "CUDA" } else { "CPU" }
}
if ($ResolvedVision -ne "None") {
    Write-Host "[4/5] Installing optional screenshot recognition ($ResolvedVision)..." -ForegroundColor Yellow
    $TorchRequirements = if ($ResolvedVision -eq "CUDA") {
        $TorchCudaRequirements
    } else {
        $TorchCpuRequirements
    }
    $TorchBackend = if ($ResolvedVision -eq "CUDA") { "cu128" } else { "cpu" }
    # The lock pins local-version wheels (+cpu or +cu128). Pass the same uv
    # backend during installation so those hashes are resolved from the
    # matching PyTorch index, then force replacement when users switch flavor.
    & $UvExe pip install --python $PythonExe --require-hashes --requirement $TorchRequirements `
        --torch-backend $TorchBackend `
        --reinstall-package torch --reinstall-package torchvision
    if ($LASTEXITCODE -ne 0) { throw "PyTorch installation failed." }
    & $UvExe pip install --python $PythonExe --require-hashes --requirement $VisionRequirements
    if ($LASTEXITCODE -ne 0) { throw "Vision dependency installation failed." }
} else {
    Write-Host "[4/5] Screenshot recognition is disabled; skipping large AI vision packages." -ForegroundColor DarkGray
}

Write-Host "[5/5] Verifying the runtime..." -ForegroundColor Yellow
$VerifyCode = @'
from importlib.metadata import version
import flask, flask_socketio, simple_websocket
expected = {
    "flask": "3.1.3",
    "flask-socketio": "5.6.1",
    "simple-websocket": "1.1.0",
}
for package, wanted in expected.items():
    installed = version(package)
    if installed != wanted:
        raise SystemExit(f"{package}: expected {wanted}, got {installed}")
print("Core runtime: OK")
'@
$VerifyCode | & $PythonExe -
if ($LASTEXITCODE -ne 0) { throw "Core runtime verification failed." }

if ($ResolvedVision -ne "None") {
    $VisionVerify = @'
import os
import cv2, numpy, PIL, torch, torchvision
backend = os.environ.get("KATAGO_HANDTALK_VISION_BACKEND", "CPU")
suffix = "+cu128" if backend == "CUDA" else "+cpu"
expected = {
    "cv2": "5.0.0",
    "numpy": "2.4.6",
    "PIL": "12.3.0",
    "torch": "2.11.0" + suffix,
    "torchvision": "0.26.0" + suffix,
}
installed = {
    "cv2": cv2.__version__,
    "numpy": numpy.__version__,
    "PIL": PIL.__version__,
    "torch": torch.__version__,
    "torchvision": torchvision.__version__,
}
for package, wanted in expected.items():
    if installed[package] != wanted:
        raise SystemExit(f"{package}: expected {wanted}, got {installed[package]}")
print(f"PyTorch: {torch.__version__}")
print(f"Torchvision: {torchvision.__version__}")
print(f"Torch CUDA build: {torch.version.cuda or 'none'}")
print(f"CUDA available: {torch.cuda.is_available()}")
if backend == "CUDA" and (torch.version.cuda is None or not torch.cuda.is_available()):
    raise SystemExit("CUDA vision was selected but the CUDA wheel/device is unavailable")
if backend == "CPU" and torch.version.cuda is not None:
    raise SystemExit("CPU vision was selected but a CUDA PyTorch wheel is still installed")
'@
    $env:KATAGO_HANDTALK_VISION_BACKEND = $ResolvedVision
    $VisionVerify | & $PythonExe -
    if ($LASTEXITCODE -ne 0) { throw "Vision runtime verification failed." }
}

& $UvExe cache clean | Out-Null
Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
