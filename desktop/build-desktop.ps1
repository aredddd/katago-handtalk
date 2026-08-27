[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Launcher = Join-Path $ProjectRoot "desktop_launcher.py"
$Requirements = Join-Path $PSScriptRoot "requirements-desktop.txt"
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$UvRoot = Join-Path $RuntimeRoot "uv"
$UvExe = Join-Path $UvRoot "uv.exe"
$UvArchive = Join-Path $RuntimeRoot "uv-desktop.zip"
$BuildVenv = Join-Path $RuntimeRoot "desktop-build-venv"
$BuildPython = Join-Path $BuildVenv "Scripts\python.exe"
$BuildRoot = Join-Path $RuntimeRoot "desktop-pyinstaller-work"
$SpecRoot = Join-Path $RuntimeRoot "desktop-pyinstaller-spec"
$AssetRoot = Join-Path $RuntimeRoot "desktop-build-assets"
$IconPath = Join-Path $AssetRoot "handtalk.ico"
$DistRoot = Join-Path $ProjectRoot "desktop-dist"
$AppDirectory = Join-Path $DistRoot "KataGo-HandTalk"
$AppExe = Join-Path $AppDirectory "KataGo-HandTalk.exe"

Write-Host ""
Write-Host "HandTalk desktop builder" -ForegroundColor Cyan
Write-Host "Project: $ProjectRoot"

foreach ($RequiredPath in @($Launcher, $Requirements)) {
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
        throw "Required desktop build file not found: $RequiredPath"
    }
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $UvRoot, $AssetRoot | Out-Null

if (-not (Test-Path -LiteralPath $UvExe -PathType Leaf)) {
    Write-Host "[1/5] Downloading portable uv..." -ForegroundColor Yellow
    $UvUrl = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip"
    try {
        Invoke-WebRequest -Uri $UvUrl -OutFile $UvArchive -UseBasicParsing
        Expand-Archive -LiteralPath $UvArchive -DestinationPath $UvRoot -Force
    } finally {
        if (Test-Path -LiteralPath $UvArchive -PathType Leaf) {
            Remove-Item -LiteralPath $UvArchive -Force
        }
    }
} else {
    Write-Host "[1/5] Portable uv is ready." -ForegroundColor Green
}

$env:UV_PYTHON_INSTALL_DIR = Join-Path $RuntimeRoot "python"
$env:UV_CACHE_DIR = Join-Path $RuntimeRoot "cache"
$env:UV_PYTHON_PREFERENCE = "only-managed"
$env:PYTHONUTF8 = "1"

Write-Host "[2/5] Preparing isolated desktop build environment..." -ForegroundColor Yellow
& $UvExe python install 3.11 --no-bin --no-registry
if ($LASTEXITCODE -ne 0) { throw "Portable Python 3.11 installation failed." }

if (-not (Test-Path -LiteralPath $BuildPython -PathType Leaf)) {
    & $UvExe venv $BuildVenv --python 3.11
    if ($LASTEXITCODE -ne 0) { throw "Desktop build environment creation failed." }
}

& $UvExe pip install --python $BuildPython --requirement $Requirements
if ($LASTEXITCODE -ne 0) { throw "Desktop build dependency installation failed." }

$VersionCheck = @'
from importlib.metadata import version
expected = {"pywebview": "6.1", "pyinstaller": "6.22.2"}
for package, wanted in expected.items():
    installed = version(package)
    if installed != wanted:
        raise SystemExit(f"{package}: expected {wanted}, got {installed}")
    print(f"{package}: {installed}")
'@
$VersionCheck | & $BuildPython -
if ($LASTEXITCODE -ne 0) { throw "Desktop build dependency version check failed." }

Write-Host "[3/5] Generating the board icon..." -ForegroundColor Yellow
& (Join-Path $PSScriptRoot "make-icon.ps1") -OutputPath $IconPath
if ($LASTEXITCODE -ne 0) { throw "Desktop icon generation failed." }

Write-Host "[4/5] Building the lightweight desktop shell..." -ForegroundColor Yellow
$PyInstallerArguments = @(
    "--noconfirm",
    "--clean",
    "--onedir",
    "--windowed",
    "--noupx",
    "--name", "KataGo-HandTalk",
    "--icon", $IconPath,
    "--distpath", $DistRoot,
    "--workpath", $BuildRoot,
    "--specpath", $SpecRoot,
    "--exclude-module", "torch",
    "--exclude-module", "torchvision",
    "--exclude-module", "cv2",
    "--exclude-module", "flask",
    "--exclude-module", "flask_socketio",
    $Launcher
)
& $BuildPython -m PyInstaller @PyInstallerArguments
if ($LASTEXITCODE -ne 0) { throw "PyInstaller desktop build failed." }

if (-not (Test-Path -LiteralPath $AppExe -PathType Leaf)) {
    throw "Desktop executable was not produced: $AppExe"
}

# Catch an accidental import of the heavyweight server stack before a build is
# handed to users. These packages belong only in .venv and are started as a
# separate child process by the launcher.
$ForbiddenPackages = @("torch", "torchvision", "cv2", "flask", "flask_socketio")
$UnexpectedFiles = Get-ChildItem -LiteralPath $AppDirectory -Recurse -File |
    Where-Object {
        $Name = $_.Name.ToLowerInvariant()
        foreach ($Forbidden in $ForbiddenPackages) {
            if ($Name -eq "$Forbidden.pyd" -or
                $Name -eq "$Forbidden.pyc" -or
                $Name -like "$Forbidden-*.dist-info") {
                return $true
            }
        }
        return $false
    }
if ($UnexpectedFiles.Count -gt 0) {
    $UnexpectedList = ($UnexpectedFiles.FullName -join "`n  - ")
    throw "Heavy server dependencies leaked into the desktop build:`n  - $UnexpectedList"
}

Write-Host "[5/5] Desktop build verified." -ForegroundColor Green
Write-Host ""
Write-Host "Desktop application: $AppExe" -ForegroundColor Green
