[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Launcher = Join-Path $ProjectRoot "desktop_launcher.py"
$RequirementsInput = Join-Path $PSScriptRoot "requirements-desktop.txt"
$Requirements = Join-Path $PSScriptRoot "requirements-desktop.lock.txt"
$VersionSource = Join-Path $ProjectRoot "VERSION"
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
$PeVersionPath = Join-Path $AssetRoot "version-info.txt"
$DistRoot = Join-Path $ProjectRoot "desktop-dist"
$AppDirectory = Join-Path $DistRoot "KataGo-HandTalk"
$AppExe = Join-Path $AppDirectory "KataGo-HandTalk.exe"
$AppResourceRoot = Join-Path $AppDirectory "app"
$LicenseRoot = Join-Path $AppDirectory "licenses"
$PythonVersion = "3.11.16"

# Pin the bootstrap itself. Downloading "latest" made two builds from the
# same source tag resolve to different tools and offered no integrity check.
$UvVersion = "0.12.6"
$UvArchiveSha256 = "DF7CB9F243EAE1621400D4FCF5B1B3D90F20E264ECE91B64DEB3B0078ABCA6EF"
$UvUrl = "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip"

# Native assets are verified against immutable upstream archives instead of
# trusting filenames or PE version strings. These archives are cached below
# .runtime, and every use rechecks the pinned SHA-256 value.
$NativeSourceRoot = Join-Path $RuntimeRoot "native-license-sources"
$PbsRelease = "20260825"
$PbsCommit = "c0aa3bbdc2fff56a77ad1ecec68b1e47794d8779"
$PbsRuntimeArchiveUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/$PbsRelease/cpython-3.11.16%2B$PbsRelease-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
$PbsRuntimeArchiveSha256 = "F91242B07E318D2540F9DA71162B92D494C39745ABDE9B994D7D906756453FC9"
$PbsMetadataArchiveUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/$PbsRelease/cpython-3.11.16%2B$PbsRelease-x86_64-pc-windows-msvc-pgo-full.tar.zst"
$PbsMetadataArchiveSha256 = "3A6160F9E3502986D925B627AF13D6C98D977808F0986BCC03B44E73DBDA5AAA"
$PbsProjectLicenseUrl = "https://raw.githubusercontent.com/astral-sh/python-build-standalone/$PbsCommit/LICENSE"
$PbsProjectLicenseSha256 = "1F256ECAD192880510E84AD60474EAB7589218784B9A50BC7CEEE34C2B91F1D5"

$WebViewVersion = "1.0.2957.106"
$WebViewPackageUrl = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$WebViewVersion/microsoft.web.webview2.$WebViewVersion.nupkg"
$WebViewPackageSha256 = "4C35A54835B63954159EAC1D5B7A60AE617A41DBB5B73BFDB11C4870A891080A"
$NetStandardVersion = "2.0.1"
$NetStandardPackageUrl = "https://api.nuget.org/v3-flatcontainer/netstandard.library/$NetStandardVersion/netstandard.library.$NetStandardVersion.nupkg"
$NetStandardPackageSha256 = "B385221FCE3C6BEA76C96C0C1FEF0F6981A740BDAA9D8D069A2C6878BBE48434"
$NetFxVersion = "2.0.1-servicing-26011-01"
$NetFxPackageUrl = "https://pkgs.dev.azure.com/dnceng/9ee6d478-d288-47f7-aacc-f6e6d082ae6d/_packaging/45bacae2-5efb-47c8-91e5-8ec20c22b4f8/nuget/v3/flat2/netstandard.library.netframework/$NetFxVersion/netstandard.library.netframework.$NetFxVersion.nupkg"
$NetFxPackageSha256 = "218DD4C63D3F800DE697BCA41178827A52DF0A9EC7A9B47520327D91EBC7051C"

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $Encoding = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $Value, $Encoding)
}

function Assert-StrictChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Parent
    )
    $ResolvedPath = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $ResolvedParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    $Prefix = $ResolvedParent + [IO.Path]::DirectorySeparatorChar
    if (-not $ResolvedPath.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing operation outside the expected directory: $ResolvedPath"
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-CanonicalTextSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $Value = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n").Replace("`r", "`n")
    # A checkout may add or remove the conventional final newline. Preserve all
    # substantive text (including spaces inside lines) while normalizing EOF.
    $Value = $Value.Trim([char[]]"`n") + "`n"
    $Bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Value)
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($Hasher.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $Hasher.Dispose()
    }
}

function Assert-CanonicalTextMatches {
    param(
        [Parameter(Mandatory = $true)][string]$AuditedCopy,
        [Parameter(Mandatory = $true)][string]$UpstreamCopy,
        [Parameter(Mandatory = $true)][string]$Component
    )

    $AuditedHash = Get-CanonicalTextSha256 -Path $AuditedCopy
    $UpstreamHash = Get-CanonicalTextSha256 -Path $UpstreamCopy
    if ($AuditedHash -ne $UpstreamHash) {
        throw "$Component audited notice differs from its pinned upstream archive: $AuditedCopy"
    }
}

function Get-VerifiedDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Sha256
    )

    $Expected = $Sha256.ToLowerInvariant()
    if ((Test-Path -LiteralPath $Path -PathType Leaf) -and
        (Get-Sha256 -Path $Path) -eq $Expected) {
        return $Path
    }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $DownloadPath = "$Path.download"
    try {
        Invoke-WebRequest -Uri $Uri -OutFile $DownloadPath -UseBasicParsing
        $Actual = Get-Sha256 -Path $DownloadPath
        if ($Actual -ne $Expected) {
            throw "Pinned download checksum mismatch for $Uri. Expected $Expected, got $Actual"
        }
        Move-Item -LiteralPath $DownloadPath -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $DownloadPath -PathType Leaf) {
            Remove-Item -LiteralPath $DownloadPath -Force
        }
    }
    return $Path
}

function Reset-NativeExtractDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    Assert-StrictChildPath -Path $Path -Parent $NativeSourceRoot
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Expand-PinnedZip {
    param(
        [Parameter(Mandatory = $true)][string]$Archive,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    Reset-NativeExtractDirectory -Path $Destination
    Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
}

function Get-ReleaseFileRecord {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Expected release component is missing: $Path"
    }
    return [ordered]@{
        path = $Path.Substring($AppDirectory.Length).TrimStart('\', '/').Replace('\', '/')
        sha256 = Get-Sha256 -Path $Path
        size = (Get-Item -LiteralPath $Path).Length
    }
}

function Assert-SameFileHash {
    param(
        [Parameter(Mandatory = $true)][string]$Actual,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Component
    )

    if ((Get-Sha256 -Path $Actual) -ne (Get-Sha256 -Path $Expected)) {
        throw "$Component binary does not match its pinned upstream archive: $Actual"
    }
}

function Copy-ResourceTree {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $SourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
        throw "Required application resource directory not found: $SourceRoot"
    }

    $ReparsePoints = Get-ChildItem -LiteralPath $SourceRoot -Recurse -Force |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
    if ($ReparsePoints.Count -gt 0) {
        throw "Application resource trees must not contain links: $($ReparsePoints[0].FullName)"
    }

    foreach ($File in Get-ChildItem -LiteralPath $SourceRoot -Recurse -Force -File) {
        $Relative = $File.FullName.Substring($SourceRoot.Length).TrimStart('\', '/')
        $Segments = $Relative -split '[\\/]'
        if ($Segments -contains "__pycache__" -or
            $Segments -contains ".pytest_cache" -or
            $Segments -contains ".git" -or
            $File.Extension -in @(".pyc", ".pyo")) {
            continue
        }
        $Target = Join-Path $Destination $Relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
        Copy-Item -LiteralPath $File.FullName -Destination $Target -Force
    }
}

function Test-FileContainsText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string[]]$Patterns
    )

    $Bytes = [IO.File]::ReadAllBytes($Path)
    # Build tools and Python can record paths as either UTF-8/ANSI or UTF-16.
    $Utf8Text = [Text.Encoding]::UTF8.GetString($Bytes)
    $Utf16Text = [Text.Encoding]::Unicode.GetString($Bytes)
    foreach ($Pattern in $Patterns) {
        if ([string]::IsNullOrWhiteSpace($Pattern)) { continue }
        if ($Utf8Text.IndexOf($Pattern, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $Utf16Text.IndexOf($Pattern, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

function Assert-ReleaseTreeSafe {
    param([Parameter(Mandatory = $true)][string]$Root)

    $ResolvedRoot = [IO.Path]::GetFullPath($Root)
    $ForbiddenDirectoryNames = @(
        ".git", ".runtime", ".venv", "venv", "models", "__pycache__", ".pytest_cache"
    )
    $ForbiddenFiles = @(
        "*.pth", "*.pt", "*.onnx", "*.bin.gz", "katago.exe", ".env", "*.pyc", "*.pyo",
        "*.log", "*.db"
    )

    $BadDirectories = Get-ChildItem -LiteralPath $ResolvedRoot -Recurse -Force -Directory |
        Where-Object { $ForbiddenDirectoryNames -contains $_.Name.ToLowerInvariant() }
    $BadFiles = foreach ($Pattern in $ForbiddenFiles) {
        Get-ChildItem -LiteralPath $ResolvedRoot -Recurse -Force -File -Filter $Pattern
    }
    if ($BadDirectories.Count -gt 0 -or $BadFiles.Count -gt 0) {
        $Entries = @($BadDirectories.FullName) + @($BadFiles.FullName)
        throw "Forbidden runtime/model content leaked into desktop artifact:`n  - $($Entries -join "`n  - ")"
    }

    $DeveloperPaths = @(
        $ProjectRoot,
        $ProjectRoot.Replace('\', '/'),
        $env:USERPROFILE,
        $(if ($env:USERPROFILE) { $env:USERPROFILE.Replace('\', '/') } else { $null })
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    $PathLeaks = Get-ChildItem -LiteralPath $ResolvedRoot -Recurse -Force -File |
        Where-Object { Test-FileContainsText -Path $_.FullName -Patterns $DeveloperPaths }
    if ($PathLeaks.Count -gt 0) {
        throw "Absolute developer paths leaked into desktop artifact:`n  - $($PathLeaks.FullName -join "`n  - ")"
    }
}

Write-Host ""
Write-Host "HandTalk desktop builder" -ForegroundColor Cyan
Write-Host "Project: $ProjectRoot"

$RequiredFiles = @(
    $Launcher,
    $RequirementsInput,
    $Requirements,
    $VersionSource,
    (Join-Path $ProjectRoot "run-local.py"),
    (Join-Path $ProjectRoot "setup-local.ps1"),
    (Join-Path $ProjectRoot "config.ini"),
    (Join-Path $ProjectRoot "README.md"),
    (Join-Path $ProjectRoot "LOCAL-SETUP.md"),
    (Join-Path $ProjectRoot "LICENSE"),
    (Join-Path $ProjectRoot "THIRD_PARTY_NOTICES.md"),
    (Join-Path $ProjectRoot "CHANGELOG.md")
)
$RequiredFiles += @(
    "OpenSSL-LICENSE.txt",
    "libffi-LICENSE.txt",
    "WebView2-LICENSE.txt",
    "WebView2-NOTICE.txt",
    "DotNet-LICENSE.txt",
    "DotNet-THIRD-PARTY-NOTICES.txt"
) | ForEach-Object { Join-Path $ProjectRoot "third_party\$_" }
foreach ($RequiredPath in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
        throw "Required desktop build file not found: $RequiredPath"
    }
}
foreach ($RequiredDirectory in @("server", "static", "config", "third_party")) {
    $RequiredPath = Join-Path $ProjectRoot $RequiredDirectory
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Container)) {
        throw "Required application resource directory not found: $RequiredPath"
    }
}

$Version = (Get-Content -LiteralPath $VersionSource -Raw).Trim()
if ($Version -notmatch '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?$') {
    throw "VERSION must contain one SemVer value, got: $Version"
}
$VersionParts = @(
    [int]$Matches.major,
    [int]$Matches.minor,
    [int]$Matches.patch,
    0
)
if ($Matches.prerelease -and $Matches.prerelease -match '(?<revision>\d+)$') {
    $VersionParts[3] = [int]$Matches.revision
}
if (($VersionParts | Measure-Object -Maximum).Maximum -gt 65535) {
    throw "PE version components must not exceed 65535: $Version"
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $UvRoot, $AssetRoot | Out-Null

$UvReady = $false
if (Test-Path -LiteralPath $UvExe -PathType Leaf) {
    try {
        $ActualUvVersion = (& $UvExe --version).Trim()
        $UvReady = $ActualUvVersion -match "^uv\s+$([regex]::Escape($UvVersion))(?:\s|$)"
    } catch {
        $UvReady = $false
    }
}

if (-not $UvReady) {
    Write-Host "[1/7] Downloading pinned portable uv $UvVersion..." -ForegroundColor Yellow
    try {
        Invoke-WebRequest -Uri $UvUrl -OutFile $UvArchive -UseBasicParsing
        $ActualHash = (Get-FileHash -LiteralPath $UvArchive -Algorithm SHA256).Hash
        if ($ActualHash -ne $UvArchiveSha256) {
            throw "uv archive checksum mismatch. Expected $UvArchiveSha256, got $ActualHash"
        }
        Expand-Archive -LiteralPath $UvArchive -DestinationPath $UvRoot -Force
    } finally {
        if (Test-Path -LiteralPath $UvArchive -PathType Leaf) {
            Remove-Item -LiteralPath $UvArchive -Force
        }
    }
    $ActualUvVersion = (& $UvExe --version).Trim()
    if ($ActualUvVersion -notmatch "^uv\s+$([regex]::Escape($UvVersion))(?:\s|$)") {
        throw "Pinned uv extraction produced an unexpected version: $ActualUvVersion"
    }
} else {
    Write-Host "[1/7] Portable uv $UvVersion is ready." -ForegroundColor Green
}

$env:UV_PYTHON_INSTALL_DIR = Join-Path $RuntimeRoot "python"
$env:UV_CACHE_DIR = Join-Path $RuntimeRoot "cache"
$env:UV_PYTHON_PREFERENCE = "only-managed"
$env:PYTHONUTF8 = "1"
$env:PYTHONHASHSEED = "0"
$env:SOURCE_DATE_EPOCH = "946684800"
$env:TZ = "UTC"

Write-Host "[2/7] Preparing isolated desktop build environment (Python $PythonVersion)..." -ForegroundColor Yellow
& $UvExe python install $PythonVersion --no-bin --no-registry
if ($LASTEXITCODE -ne 0) { throw "Portable Python $PythonVersion installation failed." }

$BuildPythonReady = $false
if (Test-Path -LiteralPath $BuildPython -PathType Leaf) {
    $ActualPythonVersion = (& $BuildPython -c "import platform; print(platform.python_version())").Trim()
    $BuildPythonReady = $LASTEXITCODE -eq 0 -and $ActualPythonVersion -eq $PythonVersion
}
if (-not $BuildPythonReady) {
    Assert-StrictChildPath -Path $BuildVenv -Parent $RuntimeRoot
    if (Test-Path -LiteralPath $BuildVenv) {
        Remove-Item -LiteralPath $BuildVenv -Recurse -Force
    }
    & $UvExe venv $BuildVenv --python $PythonVersion
    if ($LASTEXITCODE -ne 0) { throw "Desktop build environment creation failed." }
}

& $UvExe pip sync --python $BuildPython --strict --require-hashes $Requirements
if ($LASTEXITCODE -ne 0) { throw "Desktop build dependency synchronization failed." }

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

Write-Host "[3/7] Generating icon and PE version metadata..." -ForegroundColor Yellow
& (Join-Path $PSScriptRoot "make-icon.ps1") -OutputPath $IconPath
if ($LASTEXITCODE -ne 0) { throw "Desktop icon generation failed." }

$PeVersion = @"
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=($($VersionParts[0]), $($VersionParts[1]), $($VersionParts[2]), $($VersionParts[3])),
    prodvers=($($VersionParts[0]), $($VersionParts[1]), $($VersionParts[2]), $($VersionParts[3])),
    mask=0x3f,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0)
  ),
  kids=[
    StringFileInfo([
      StringTable('040904B0', [
        StringStruct('CompanyName', 'aredddd and contributors'),
        StringStruct('FileDescription', 'KataGo HandTalk desktop application'),
        StringStruct('FileVersion', '$Version'),
        StringStruct('InternalName', 'KataGo-HandTalk'),
        StringStruct('LegalCopyright', 'Copyright (c) 2026 aredddd and contributors'),
        StringStruct('OriginalFilename', 'KataGo-HandTalk.exe'),
        StringStruct('ProductName', 'KataGo HandTalk'),
        StringStruct('ProductVersion', '$Version')
      ])
    ]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
"@
Write-Utf8NoBom -Path $PeVersionPath -Value $PeVersion

Write-Host "[4/7] Building the lightweight desktop shell..." -ForegroundColor Yellow
$PyInstallerArguments = @(
    "--noconfirm",
    "--clean",
    "--onedir",
    "--windowed",
    "--noupx",
    "--name", "KataGo-HandTalk",
    "--icon", $IconPath,
    "--version-file", $PeVersionPath,
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

Write-Host "[5/7] Copying the explicit application-resource allowlist..." -ForegroundColor Yellow
if (Test-Path -LiteralPath $AppResourceRoot) {
    Remove-Item -LiteralPath $AppResourceRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $AppResourceRoot | Out-Null

foreach ($DirectoryName in @("server", "static", "config", "third_party")) {
    Copy-ResourceTree `
        -Source (Join-Path $ProjectRoot $DirectoryName) `
        -Destination (Join-Path $AppResourceRoot $DirectoryName)
}

$RootResourceFiles = @(
    "run-local.py",
    "setup-local.ps1",
    "config.ini",
    "VERSION",
    "README.md",
    "LOCAL-SETUP.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "CHANGELOG.md"
)
$RootResourceFiles += Get-ChildItem -LiteralPath $ProjectRoot -File -Filter "requirements*.txt" |
    Select-Object -ExpandProperty Name
$RootResourceFiles = $RootResourceFiles | Select-Object -Unique
foreach ($FileName in $RootResourceFiles) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot $FileName) -Destination $AppResourceRoot -Force
}
# Keep the source's descriptive name while also providing the conventional
# NOTICE.md filename expected by binary-distribution tooling.
Copy-Item -LiteralPath (Join-Path $ProjectRoot "THIRD_PARTY_NOTICES.md") `
    -Destination (Join-Path $AppResourceRoot "NOTICE.md") -Force

Write-Host "[6/7] Collecting redistribution notices..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $LicenseRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectRoot "LICENSE") `
    -Destination (Join-Path $LicenseRoot "PROJECT-LICENSE.txt") -Force
Copy-Item -LiteralPath (Join-Path $ProjectRoot "THIRD_PARTY_NOTICES.md") `
    -Destination (Join-Path $LicenseRoot "THIRD_PARTY_NOTICES.md") -Force
Copy-ResourceTree `
    -Source (Join-Path $ProjectRoot "third_party") `
    -Destination (Join-Path $LicenseRoot "third_party")

$PythonBase = (& $BuildPython -c "import sys; print(sys.base_prefix)").Trim()
$PythonLicense = Join-Path $PythonBase "LICENSE.txt"
if (-not (Test-Path -LiteralPath $PythonLicense -PathType Leaf)) {
    throw "Managed Python license not found: $PythonLicense"
}
Copy-Item -LiteralPath $PythonLicense `
    -Destination (Join-Path $LicenseRoot "Python-LICENSE.txt") -Force

$SitePackages = Join-Path $BuildVenv "Lib\site-packages"
$PackageLicenseRoot = Join-Path $LicenseRoot "desktop-python-packages"
New-Item -ItemType Directory -Force -Path $PackageLicenseRoot | Out-Null
foreach ($DistInfo in Get-ChildItem -LiteralPath $SitePackages -Directory -Filter "*.dist-info") {
    $LicenseFiles = Get-ChildItem -LiteralPath $DistInfo.FullName -Recurse -File |
        Where-Object { $_.Name -match '^(?i:license|copying|notice)(?:\..*)?$' }
    foreach ($LicenseFile in $LicenseFiles) {
        $Relative = $LicenseFile.FullName.Substring($DistInfo.FullName.Length).TrimStart('\', '/')
        $Target = Join-Path (Join-Path $PackageLicenseRoot $DistInfo.Name) $Relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
        Copy-Item -LiteralPath $LicenseFile.FullName -Destination $Target -Force
    }
}

# Setuptools and a few other wheels vendor packages whose notices live inside
# the import package rather than its top-level dist-info. Preserve every
# license/notice file from site-packages under its original relative path.
$VendoredLicenseRoot = Join-Path $PackageLicenseRoot "site-packages-notices"
foreach ($LicenseFile in Get-ChildItem -LiteralPath $SitePackages -Recurse -File |
    Where-Object { $_.Name -match '^(?i:license|copying|notice)(?:\..*)?$' }) {
    $Relative = $LicenseFile.FullName.Substring($SitePackages.Length).TrimStart('\', '/')
    $Target = Join-Path $VendoredLicenseRoot $Relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
    Copy-Item -LiteralPath $LicenseFile.FullName -Destination $Target -Force
}

# proxy_tools 0.1.0 declares a license in metadata but omits the text from its
# wheel. Keep the audited upstream copy in third_party and duplicate it beside
# the generated package notices for people inspecting only the binary bundle.
$ProxyToolsLicense = Join-Path $ProjectRoot "third_party\proxy_tools-LICENSE.txt"
if (-not (Test-Path -LiteralPath $ProxyToolsLicense -PathType Leaf)) {
    throw "proxy_tools redistribution license not found: $ProxyToolsLicense"
}
New-Item -ItemType Directory -Force `
    -Path (Join-Path $PackageLicenseRoot "proxy_tools-0.1.0.dist-info") | Out-Null
Copy-Item -LiteralPath $ProxyToolsLicense `
    -Destination (Join-Path $PackageLicenseRoot "proxy_tools-0.1.0.dist-info\LICENSE.txt") -Force

$InventoryCode = @'
import importlib.metadata as metadata
import json

packages = []
for dist in metadata.distributions():
    name = dist.metadata.get("Name") or "unknown"
    license_name = dist.metadata.get("License-Expression") or dist.metadata.get("License") or ""
    if "\n" in license_name or len(license_name) > 160:
        classifiers = [
            item.removeprefix("License :: ")
            for item in dist.metadata.get_all("Classifier", [])
            if item.startswith("License :: ")
        ]
        license_name = "; ".join(classifiers) or "see bundled license text"
    if name.lower().replace("-", "_") == "proxy_tools":
        # The 0.1.0 wheel says MIT but omits a text; the upstream repository's
        # audited LICENSE.txt is BSD and is bundled by this build.
        license_name = "BSD; see bundled upstream LICENSE.txt"
    packages.append({"name": name, "version": dist.version, "license": license_name})
print(json.dumps({"schema": 1, "packages": sorted(packages, key=lambda item: item["name"].lower())}, indent=2))
'@
$InventoryJson = ($InventoryCode | & $BuildPython -) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "Desktop dependency inventory generation failed." }
Write-Utf8NoBom `
    -Path (Join-Path $LicenseRoot "desktop-dependencies.json") `
    -Value ($InventoryJson + "`n")

# Native and managed DLLs brought in by portable Python, pywebview, and
# pythonnet are not independent Python distributions. Resolve their exact
# upstream archives, preserve the upstream legal files, and prove every
# shipped binary by name and SHA-256 before producing the inventory.
New-Item -ItemType Directory -Force -Path $NativeSourceRoot | Out-Null
$NativeLicenseRoot = Join-Path $LicenseRoot "third_party"

$PbsRuntimeArchive = Get-VerifiedDownload `
    -Uri $PbsRuntimeArchiveUrl `
    -Path (Join-Path $NativeSourceRoot "python-build-standalone-runtime.tar.gz") `
    -Sha256 $PbsRuntimeArchiveSha256
$PbsRuntimeExtract = Join-Path $NativeSourceRoot "python-build-standalone-runtime"
Reset-NativeExtractDirectory -Path $PbsRuntimeExtract
& tar.exe -xf $PbsRuntimeArchive -C $PbsRuntimeExtract `
    "python/DLLs/libcrypto-3-x64.dll" `
    "python/DLLs/libssl-3-x64.dll" `
    "python/DLLs/libffi-8.dll" `
    "python/LICENSE.txt"
if ($LASTEXITCODE -ne 0) {
    throw "Could not extract the pinned python-build-standalone runtime archive."
}

$PbsMetadataArchive = Get-VerifiedDownload `
    -Uri $PbsMetadataArchiveUrl `
    -Path (Join-Path $NativeSourceRoot "python-build-standalone-metadata.tar.zst") `
    -Sha256 $PbsMetadataArchiveSha256
$PbsMetadataExtract = Join-Path $NativeSourceRoot "python-build-standalone-metadata"
Reset-NativeExtractDirectory -Path $PbsMetadataExtract
& tar.exe -xf $PbsMetadataArchive -C $PbsMetadataExtract `
    "python/PYTHON.json" `
    "python/licenses"
if ($LASTEXITCODE -ne 0) {
    throw "Could not extract license metadata from the pinned python-build-standalone archive."
}
$PbsProjectLicense = Get-VerifiedDownload `
    -Uri $PbsProjectLicenseUrl `
    -Path (Join-Path $NativeSourceRoot "python-build-standalone-MPL-2.0.txt") `
    -Sha256 $PbsProjectLicenseSha256

$PbsMetadataPath = Join-Path $PbsMetadataExtract "python\PYTHON.json"
$PbsMetadata = Get-Content -LiteralPath $PbsMetadataPath -Raw | ConvertFrom-Json
if ($PbsMetadata.version -ne 8 -or
    $PbsMetadata.python_version -ne $PythonVersion -or
    $PbsMetadata.target_triple -ne "x86_64-pc-windows-msvc") {
    throw "Pinned python-build-standalone metadata does not describe the selected Windows x64 Python."
}
$PbsSslMetadata = @($PbsMetadata.build_info.extensions._ssl)[0]
$PbsHashlibMetadata = @($PbsMetadata.build_info.extensions._hashlib)[0]
$PbsCtypesMetadata = @($PbsMetadata.build_info.extensions._ctypes)[0]
if (-not ($PbsSslMetadata.license_paths -contains "licenses/LICENSE.openssl-3.txt") -or
    -not ($PbsHashlibMetadata.license_paths -contains "licenses/LICENSE.openssl-3.txt") -or
    -not ($PbsCtypesMetadata.license_paths -contains "licenses/LICENSE.libffi.txt")) {
    throw "Pinned python-build-standalone metadata does not map OpenSSL/libffi to the expected license files."
}
$PythonBuildMarker = Join-Path $PythonBase "BUILD"
if (-not (Test-Path -LiteralPath $PythonBuildMarker -PathType Leaf) -or
    (Get-Content -LiteralPath $PythonBuildMarker -Raw).Trim() -ne $PbsRelease) {
    throw "Managed Python does not carry the expected python-build-standalone release marker $PbsRelease."
}

$PbsBundledLicenseRoot = Join-Path $LicenseRoot "python-build-standalone"
if (Test-Path -LiteralPath $PbsBundledLicenseRoot) {
    Remove-Item -LiteralPath $PbsBundledLicenseRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $PbsBundledLicenseRoot | Out-Null
Copy-ResourceTree `
    -Source (Join-Path $PbsMetadataExtract "python\licenses") `
    -Destination (Join-Path $PbsBundledLicenseRoot "licenses")
Copy-Item -LiteralPath $PbsMetadataPath `
    -Destination (Join-Path $PbsBundledLicenseRoot "PYTHON.json") -Force
Copy-Item -LiteralPath $PbsProjectLicense `
    -Destination (Join-Path $PbsBundledLicenseRoot "LICENSE.txt") -Force
Copy-Item -LiteralPath $PythonBuildMarker `
    -Destination (Join-Path $PbsBundledLicenseRoot "BUILD") -Force

$PbsOpenSslLicense = Join-Path $PbsMetadataExtract "python\licenses\LICENSE.openssl-3.txt"
$PbsLibffiLicense = Join-Path $PbsMetadataExtract "python\licenses\LICENSE.libffi.txt"
Assert-CanonicalTextMatches `
    -AuditedCopy (Join-Path $ProjectRoot "third_party\OpenSSL-LICENSE.txt") `
    -UpstreamCopy $PbsOpenSslLicense `
    -Component "OpenSSL"
Assert-CanonicalTextMatches `
    -AuditedCopy (Join-Path $ProjectRoot "third_party\libffi-LICENSE.txt") `
    -UpstreamCopy $PbsLibffiLicense `
    -Component "libffi"
# Overwrite normalized source copies with the archive's exact bytes in the
# binary distribution.
Copy-Item -LiteralPath $PbsOpenSslLicense `
    -Destination (Join-Path $NativeLicenseRoot "OpenSSL-LICENSE.txt") -Force
Copy-Item -LiteralPath $PbsLibffiLicense `
    -Destination (Join-Path $NativeLicenseRoot "libffi-LICENSE.txt") -Force

$PbsBinaryNames = @("libcrypto-3-x64.dll", "libssl-3-x64.dll", "libffi-8.dll")
$PbsBinaryRecords = @{}
foreach ($Name in $PbsBinaryNames) {
    $ArchiveBinary = Join-Path $PbsRuntimeExtract "python\DLLs\$Name"
    $ManagedPythonBinary = Join-Path $PythonBase "DLLs\$Name"
    $PackagedBinary = Join-Path $AppDirectory "_internal\$Name"
    Assert-SameFileHash -Actual $ManagedPythonBinary -Expected $ArchiveBinary -Component $Name
    Assert-SameFileHash -Actual $PackagedBinary -Expected $ArchiveBinary -Component $Name
    $PbsBinaryRecords[$Name] = Get-ReleaseFileRecord -Path $PackagedBinary
}

$WebViewPackage = Get-VerifiedDownload `
    -Uri $WebViewPackageUrl `
    -Path (Join-Path $NativeSourceRoot "Microsoft.Web.WebView2.$WebViewVersion.nupkg") `
    -Sha256 $WebViewPackageSha256
$WebViewExtract = Join-Path $NativeSourceRoot "Microsoft.Web.WebView2"
Expand-PinnedZip -Archive $WebViewPackage -Destination $WebViewExtract
$WebViewLicense = Join-Path $WebViewExtract "LICENSE.txt"
$WebViewNotice = Join-Path $WebViewExtract "NOTICE.txt"
Assert-CanonicalTextMatches `
    -AuditedCopy (Join-Path $ProjectRoot "third_party\WebView2-LICENSE.txt") `
    -UpstreamCopy $WebViewLicense `
    -Component "Microsoft WebView2"
Assert-CanonicalTextMatches `
    -AuditedCopy (Join-Path $ProjectRoot "third_party\WebView2-NOTICE.txt") `
    -UpstreamCopy $WebViewNotice `
    -Component "Microsoft WebView2"
Copy-Item -LiteralPath $WebViewLicense `
    -Destination (Join-Path $NativeLicenseRoot "WebView2-LICENSE.txt") -Force
Copy-Item -LiteralPath $WebViewNotice `
    -Destination (Join-Path $NativeLicenseRoot "WebView2-NOTICE.txt") -Force

$WebViewMappings = [ordered]@{
    "_internal\webview\lib\Microsoft.Web.WebView2.Core.dll" = "lib\net462\Microsoft.Web.WebView2.Core.dll"
    "_internal\webview\lib\Microsoft.Web.WebView2.WinForms.dll" = "lib\net462\Microsoft.Web.WebView2.WinForms.dll"
    "_internal\webview\lib\runtimes\win-arm64\native\WebView2Loader.dll" = "runtimes\win-arm64\native\WebView2Loader.dll"
    "_internal\webview\lib\runtimes\win-x64\native\WebView2Loader.dll" = "runtimes\win-x64\native\WebView2Loader.dll"
    "_internal\webview\lib\runtimes\win-x86\native\WebView2Loader.dll" = "runtimes\win-x86\native\WebView2Loader.dll"
}
$WebViewRecords = @()
foreach ($Entry in $WebViewMappings.GetEnumerator()) {
    $PackagedBinary = Join-Path $AppDirectory $Entry.Key
    $PackageBinary = Join-Path $WebViewExtract $Entry.Value
    Assert-SameFileHash -Actual $PackagedBinary -Expected $PackageBinary -Component $Entry.Key
    $WebViewRecords += Get-ReleaseFileRecord -Path $PackagedBinary
}

$NetStandardPackage = Get-VerifiedDownload `
    -Uri $NetStandardPackageUrl `
    -Path (Join-Path $NativeSourceRoot "NETStandard.Library.$NetStandardVersion.nupkg") `
    -Sha256 $NetStandardPackageSha256
$NetStandardExtract = Join-Path $NativeSourceRoot "NETStandard.Library"
Expand-PinnedZip -Archive $NetStandardPackage -Destination $NetStandardExtract
$NetStandardLicense = Join-Path $NetStandardExtract "LICENSE.TXT"
$NetStandardNotice = Join-Path $NetStandardExtract "THIRD-PARTY-NOTICES.TXT"
Assert-CanonicalTextMatches `
    -AuditedCopy (Join-Path $ProjectRoot "third_party\DotNet-LICENSE.txt") `
    -UpstreamCopy $NetStandardLicense `
    -Component "NETStandard.Library $NetStandardVersion"
Assert-CanonicalTextMatches `
    -AuditedCopy (Join-Path $ProjectRoot "third_party\DotNet-THIRD-PARTY-NOTICES.txt") `
    -UpstreamCopy $NetStandardNotice `
    -Component "NETStandard.Library $NetStandardVersion"
Copy-Item -LiteralPath $NetStandardLicense `
    -Destination (Join-Path $NativeLicenseRoot "DotNet-LICENSE.txt") -Force
Copy-Item -LiteralPath $NetStandardNotice `
    -Destination (Join-Path $NativeLicenseRoot "DotNet-THIRD-PARTY-NOTICES.txt") -Force

$NetFxPackage = Get-VerifiedDownload `
    -Uri $NetFxPackageUrl `
    -Path (Join-Path $NativeSourceRoot "NETStandard.Library.NETFramework.$NetFxVersion.nupkg") `
    -Sha256 $NetFxPackageSha256
$NetFxExtract = Join-Path $NativeSourceRoot "NETStandard.Library.NETFramework"
Expand-PinnedZip -Archive $NetFxPackage -Destination $NetFxExtract
$NetFxLicenseName = "DotNet-NETFramework-LICENSE.txt"
$NetFxNoticeName = "DotNet-NETFramework-THIRD-PARTY-NOTICES.txt"
Copy-Item -LiteralPath (Join-Path $NetFxExtract "LICENSE.TXT") `
    -Destination (Join-Path $NativeLicenseRoot $NetFxLicenseName) -Force
Copy-Item -LiteralPath (Join-Path $NetFxExtract "THIRD-PARTY-NOTICES.TXT") `
    -Destination (Join-Path $NativeLicenseRoot $NetFxNoticeName) -Force

$PythonNetRuntimeRoot = Join-Path $AppDirectory "_internal\pythonnet\runtime"
$ExpectedFacadeRoot = Join-Path $NetFxExtract "build\net461\lib"
$ExpectedFacadeFiles = @(
    Get-ChildItem -LiteralPath $ExpectedFacadeRoot -File -Filter "*.dll" |
        Where-Object { $_.Name -ne "netfx.force.conflicts.dll" }
)
$PackagedFacadeFiles = @(
    Get-ChildItem -LiteralPath $PythonNetRuntimeRoot -File -Filter "*.dll" |
        Where-Object { $_.Name -ne "Python.Runtime.dll" }
)
if ($ExpectedFacadeFiles.Count -ne 96 -or
    $PackagedFacadeFiles.Count -ne $ExpectedFacadeFiles.Count) {
    throw "pythonnet .NET facade set is incomplete or unexpected: package=$($ExpectedFacadeFiles.Count), artifact=$($PackagedFacadeFiles.Count)"
}
$PackagedFacadesByName = @{}
foreach ($File in $PackagedFacadeFiles) {
    if ($PackagedFacadesByName.ContainsKey($File.Name)) {
        throw "Duplicate pythonnet facade in release artifact: $($File.Name)"
    }
    $PackagedFacadesByName[$File.Name] = $File
}
$FacadeRecords = @()
foreach ($ExpectedFile in $ExpectedFacadeFiles | Sort-Object Name) {
    if (-not $PackagedFacadesByName.ContainsKey($ExpectedFile.Name)) {
        throw "pythonnet facade missing from release artifact: $($ExpectedFile.Name)"
    }
    $PackagedFile = $PackagedFacadesByName[$ExpectedFile.Name]
    Assert-SameFileHash `
        -Actual $PackagedFile.FullName `
        -Expected $ExpectedFile.FullName `
        -Component $ExpectedFile.Name
    $FacadeRecords += Get-ReleaseFileRecord -Path $PackagedFile.FullName
}

# 80 of the 96 NETFramework compatibility assemblies are byte-identical to
# NETStandard.Library 2.0.1 reference assemblies. Verify that overlap too; the
# remaining 16 (including netstandard.dll) are proven by the official
# NETStandard.Library.NETFramework package above.
$NetStandardRefHashes = @{}
foreach ($File in Get-ChildItem -LiteralPath (Join-Path $NetStandardExtract "build\netstandard2.0\ref") -File -Filter "*.dll") {
    $NetStandardRefHashes[(Get-Sha256 -Path $File.FullName)] = $true
}
$NetStandardOverlap = @(
    $ExpectedFacadeFiles | Where-Object {
        $NetStandardRefHashes.ContainsKey((Get-Sha256 -Path $_.FullName))
    }
).Count
if ($NetStandardOverlap -ne 80) {
    throw "Expected 80 NETStandard.Library 2.0.1 facade matches, found $NetStandardOverlap."
}

$PythonNetFiles = @(
    "Python.Runtime.dll",
    "Python.Runtime.deps.json",
    "Python.Runtime.xml"
)
$PythonNetRecords = @()
foreach ($Name in $PythonNetFiles) {
    $PythonNetRecords += Get-ReleaseFileRecord -Path (Join-Path $PythonNetRuntimeRoot $Name)
}
$PythonNetLicenseRelative = "desktop-python-packages/pythonnet-3.1.0.dist-info/licenses/LICENSE"
if (-not (Test-Path -LiteralPath (Join-Path $LicenseRoot $PythonNetLicenseRelative) -PathType Leaf)) {
    throw "pythonnet redistribution license was not collected."
}

$NativeSources = @(
    [ordered]@{
        id = "python-build-standalone-runtime"
        version = "$PythonVersion+$PbsRelease"
        url = $PbsRuntimeArchiveUrl
        sha256 = $PbsRuntimeArchiveSha256.ToLowerInvariant()
    },
    [ordered]@{
        id = "python-build-standalone-metadata"
        version = "$PythonVersion+$PbsRelease"
        url = $PbsMetadataArchiveUrl
        sha256 = $PbsMetadataArchiveSha256.ToLowerInvariant()
    },
    [ordered]@{
        id = "python-build-standalone-project-license"
        version = $PbsCommit
        url = $PbsProjectLicenseUrl
        sha256 = $PbsProjectLicenseSha256.ToLowerInvariant()
    },
    [ordered]@{
        id = "Microsoft.Web.WebView2"
        version = $WebViewVersion
        url = $WebViewPackageUrl
        sha256 = $WebViewPackageSha256.ToLowerInvariant()
    },
    [ordered]@{
        id = "NETStandard.Library"
        version = $NetStandardVersion
        url = $NetStandardPackageUrl
        sha256 = $NetStandardPackageSha256.ToLowerInvariant()
    },
    [ordered]@{
        id = "NETStandard.Library.NETFramework"
        version = $NetFxVersion
        url = $NetFxPackageUrl
        sha256 = $NetFxPackageSha256.ToLowerInvariant()
    }
)
$OpenSslReportedVersion = (Get-Item -LiteralPath (Join-Path $AppDirectory "_internal\libcrypto-3-x64.dll")).VersionInfo.FileVersion
$NativeInventory = @(
    [ordered]@{
        component = "OpenSSL"
        version = $OpenSslReportedVersion
        provenance = "python-build-standalone-runtime"
        files = @($PbsBinaryRecords["libcrypto-3-x64.dll"], $PbsBinaryRecords["libssl-3-x64.dll"])
        license = "python-build-standalone/licenses/LICENSE.openssl-3.txt"
        notices = @()
    },
    [ordered]@{
        component = "libffi"
        version = $null
        abi = 8
        provenance = "python-build-standalone-runtime"
        files = @($PbsBinaryRecords["libffi-8.dll"])
        license = "python-build-standalone/licenses/LICENSE.libffi.txt"
        notices = @()
    },
    [ordered]@{
        component = "Microsoft WebView2 SDK"
        version = $WebViewVersion
        provenance = "Microsoft.Web.WebView2"
        files = @($WebViewRecords)
        license = "third_party/WebView2-LICENSE.txt"
        notices = @("third_party/WebView2-NOTICE.txt")
    },
    [ordered]@{
        component = ".NET Framework compatibility facades"
        version = $NetFxVersion
        provenance = "NETStandard.Library.NETFramework"
        netStandardLibraryOverlap = $NetStandardOverlap
        files = @($FacadeRecords)
        license = "third_party/$NetFxLicenseName"
        notices = @("third_party/$NetFxNoticeName")
    },
    [ordered]@{
        component = "Python.Runtime bridge"
        version = "3.1.0"
        provenance = "pythonnet wheel"
        files = @($PythonNetRecords)
        license = $PythonNetLicenseRelative
        notices = @()
    }
)
$NativeInventoryJson = [ordered]@{
    schema = 2
    sources = $NativeSources
    components = $NativeInventory
} | ConvertTo-Json -Depth 8
Write-Utf8NoBom `
    -Path (Join-Path $LicenseRoot "native-components.json") `
    -Value ($NativeInventoryJson + "`n")

# Catch accidental imports of the heavyweight server stack before a build is
# handed to users. These packages belong only in the separate local runtime.
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

Write-Host "[7/7] Verifying desktop artifact..." -ForegroundColor Yellow
Assert-ReleaseTreeSafe -Root $AppDirectory
$VersionInfo = (Get-Item -LiteralPath $AppExe).VersionInfo
if ($VersionInfo.ProductVersion -ne $Version -or $VersionInfo.FileVersion -ne $Version) {
    throw "PE version metadata mismatch: file=$($VersionInfo.FileVersion), product=$($VersionInfo.ProductVersion), expected=$Version"
}
if ((Get-Content -LiteralPath (Join-Path $AppResourceRoot "VERSION") -Raw).Trim() -ne $Version) {
    throw "Bundled VERSION does not match source VERSION."
}

Write-Host "Desktop build verified." -ForegroundColor Green
Write-Host ""
Write-Host "Desktop application: $AppExe" -ForegroundColor Green
Write-Host "Bundled app resources: $AppResourceRoot" -ForegroundColor Green
Write-Host "Version: $Version" -ForegroundColor Green
