[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$AllowDirty,
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$DistRoot = Join-Path $ProjectRoot "desktop-dist"
$BuiltApp = Join-Path $DistRoot "KataGo-HandTalk"
$BuiltExe = Join-Path $BuiltApp "KataGo-HandTalk.exe"
$StageRoot = Join-Path $RuntimeRoot "release-stage"
$StageApp = Join-Path $StageRoot "KataGo-HandTalk"
$VersionPath = Join-Path $ProjectRoot "VERSION"
$OutputRoot = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    Join-Path $DistRoot "release"
} else {
    [IO.Path]::GetFullPath($OutputDirectory)
}

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

function Test-FileContainsText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string[]]$Patterns
    )
    $Bytes = [IO.File]::ReadAllBytes($Path)
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

    $ForbiddenDirectoryNames = @(
        ".git", ".runtime", ".venv", "venv", "models", "__pycache__", ".pytest_cache"
    )
    $ForbiddenFiles = @(
        "*.pth", "*.pt", "*.onnx", "*.ckpt", "*.safetensors", "*.weights", "*.pb",
        "*.bin.gz", "katago.exe", ".env", "*.pyc", "*.pyo", "*.log", "*.db"
    )

    $BadDirectories = Get-ChildItem -LiteralPath $Root -Recurse -Force -Directory |
        Where-Object { $ForbiddenDirectoryNames -contains $_.Name.ToLowerInvariant() }
    $BadFiles = foreach ($Pattern in $ForbiddenFiles) {
        Get-ChildItem -LiteralPath $Root -Recurse -Force -File -Filter $Pattern
    }
    if ($BadDirectories.Count -gt 0 -or $BadFiles.Count -gt 0) {
        $Entries = @($BadDirectories.FullName) + @($BadFiles.FullName)
        throw "Forbidden model/runtime content found in release tree:`n  - $($Entries -join "`n  - ")"
    }

    $DeveloperPaths = @(
        $ProjectRoot,
        $ProjectRoot.Replace('\', '/'),
        $env:USERPROFILE,
        $(if ($env:USERPROFILE) { $env:USERPROFILE.Replace('\', '/') } else { $null })
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    $PathLeaks = Get-ChildItem -LiteralPath $Root -Recurse -Force -File |
        Where-Object { Test-FileContainsText -Path $_.FullName -Patterns $DeveloperPaths }
    if ($PathLeaks.Count -gt 0) {
        throw "Absolute developer paths found in release tree:`n  - $($PathLeaks.FullName -join "`n  - ")"
    }
}

if (-not (Test-Path -LiteralPath $VersionPath -PathType Leaf)) {
    throw "VERSION not found: $VersionPath"
}
$Version = (Get-Content -LiteralPath $VersionPath -Raw).Trim()
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    throw "VERSION must contain one SemVer value, got: $Version"
}

$SourceRevision = "unknown"
$SourceTreeDirty = $true
try {
    $CandidateRevision = (& git -C $ProjectRoot rev-parse HEAD 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or $CandidateRevision -notmatch '^[0-9a-f]{40}$') {
        throw "Git revision is unavailable."
    }
    $SourceRevision = $CandidateRevision
    $DirtyEntries = @(& git -C $ProjectRoot status --porcelain=v1 --untracked-files=all 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw "Git working-tree status is unavailable."
    }
    $SourceTreeDirty = $DirtyEntries.Count -gt 0
} catch {
    if (-not $AllowDirty) {
        throw "A verified clean Git checkout is required for release packaging: $($_.Exception.Message)"
    }
}
if ($SourceTreeDirty -and -not $AllowDirty) {
    throw "Release packaging requires a clean Git checkout. Commit or stash all changes first."
}
if ($SkipBuild -and -not $AllowDirty) {
    throw "-SkipBuild is a development-only shortcut. Pair it with -AllowDirty; official packages must rebuild from a clean checkout."
}

if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot "build-desktop.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop build failed with exit code $LASTEXITCODE."
    }
}

# Recheck Git after the build. A build step must not be able to modify source
# and still produce a manifest that claims it came from a clean revision.
$PostBuildRevisionChanged = $false
try {
    $PostBuildRevision = (& git -C $ProjectRoot rev-parse HEAD 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or $PostBuildRevision -notmatch '^[0-9a-f]{40}$') {
        throw "Git revision is unavailable after the build."
    }
    if ($SourceRevision -ne "unknown" -and $PostBuildRevision -ne $SourceRevision) {
        $PostBuildRevisionChanged = $true
    }
    $PostBuildDirtyEntries = @(& git -C $ProjectRoot status --porcelain=v1 --untracked-files=all 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw "Git working-tree status is unavailable after the build."
    }
    $SourceTreeDirty = $SourceTreeDirty -or $PostBuildDirtyEntries.Count -gt 0
} catch {
    if (-not $AllowDirty) {
        throw "Could not verify the source tree after the build: $($_.Exception.Message)"
    }
    $SourceTreeDirty = $true
}
if ($PostBuildRevisionChanged) {
    throw "Git HEAD changed while the release package was being built."
}
if ($SourceTreeDirty -and -not $AllowDirty) {
    throw "The release build modified the Git working tree; refusing to label the package clean."
}
$ArtifactQualifier = if ($SourceTreeDirty -or $SkipBuild) { "-dirty" } else { "" }

foreach ($RequiredArtifactPath in @(
    $BuiltExe,
    (Join-Path $BuiltApp "app\run-local.py"),
    (Join-Path $BuiltApp "app\setup-local.ps1"),
    (Join-Path $BuiltApp "app\server"),
    (Join-Path $BuiltApp "app\static"),
    (Join-Path $BuiltApp "app\config"),
    (Join-Path $BuiltApp "app\third_party"),
    (Join-Path $BuiltApp "app\VERSION"),
    (Join-Path $BuiltApp "app\NOTICE.md"),
    (Join-Path $BuiltApp "licenses\PROJECT-LICENSE.txt"),
    (Join-Path $BuiltApp "licenses\THIRD_PARTY_NOTICES.md"),
    (Join-Path $BuiltApp "licenses\desktop-dependencies.json"),
    (Join-Path $BuiltApp "licenses\native-components.json"),
    (Join-Path $BuiltApp "licenses\third_party\OpenSSL-LICENSE.txt"),
    (Join-Path $BuiltApp "licenses\third_party\libffi-LICENSE.txt"),
    (Join-Path $BuiltApp "licenses\third_party\WebView2-LICENSE.txt"),
    (Join-Path $BuiltApp "licenses\third_party\WebView2-NOTICE.txt"),
    (Join-Path $BuiltApp "licenses\third_party\DotNet-LICENSE.txt"),
    (Join-Path $BuiltApp "licenses\third_party\DotNet-THIRD-PARTY-NOTICES.txt"),
    (Join-Path $BuiltApp "licenses\third_party\DotNet-NETFramework-LICENSE.txt"),
    (Join-Path $BuiltApp "licenses\third_party\DotNet-NETFramework-THIRD-PARTY-NOTICES.txt"),
    (Join-Path $BuiltApp "licenses\python-build-standalone\BUILD"),
    (Join-Path $BuiltApp "licenses\python-build-standalone\LICENSE.txt"),
    (Join-Path $BuiltApp "licenses\python-build-standalone\PYTHON.json"),
    (Join-Path $BuiltApp "licenses\python-build-standalone\licenses\LICENSE.openssl-3.txt"),
    (Join-Path $BuiltApp "licenses\python-build-standalone\licenses\LICENSE.libffi.txt")
)) {
    if (-not (Test-Path -LiteralPath $RequiredArtifactPath)) {
        throw "Desktop artifact is incomplete: $RequiredArtifactPath"
    }
}

$NativeInventoryPath = Join-Path $BuiltApp "licenses\native-components.json"
try {
    $NativeInventory = Get-Content -LiteralPath $NativeInventoryPath -Raw | ConvertFrom-Json
} catch {
    throw "Native component inventory is not valid JSON: $($_.Exception.Message)"
}
if ($NativeInventory.schema -ne 2) {
    throw "Native component inventory schema must be 2."
}
$RequiredNativeSources = @(
    "python-build-standalone-runtime",
    "python-build-standalone-metadata",
    "python-build-standalone-project-license",
    "Microsoft.Web.WebView2",
    "NETStandard.Library",
    "NETStandard.Library.NETFramework"
)
$NativeSourcesById = @{}
foreach ($Source in @($NativeInventory.sources)) {
    if ([string]::IsNullOrWhiteSpace($Source.id) -or $NativeSourcesById.ContainsKey($Source.id)) {
        throw "Native component inventory has a missing or duplicate source id."
    }
    if ($Source.url -notmatch '^https://' -or $Source.sha256 -notmatch '^[0-9a-f]{64}$') {
        throw "Native component source is not pinned by HTTPS URL and SHA-256: $($Source.id)"
    }
    $NativeSourcesById[$Source.id] = $Source
}
foreach ($SourceId in $RequiredNativeSources) {
    if (-not $NativeSourcesById.ContainsKey($SourceId)) {
        throw "Native component inventory is missing source provenance: $SourceId"
    }
}

$RequiredNativeComponents = @(
    "OpenSSL",
    "libffi",
    "Microsoft WebView2 SDK",
    ".NET Framework compatibility facades",
    "Python.Runtime bridge"
)
$NativeComponentsByName = @{}
foreach ($Component in @($NativeInventory.components)) {
    if ([string]::IsNullOrWhiteSpace($Component.component) -or
        $NativeComponentsByName.ContainsKey($Component.component)) {
        throw "Native component inventory has a missing or duplicate component name."
    }
    $NativeComponentsByName[$Component.component] = $Component
    if (@($Component.files).Count -eq 0) {
        throw "Native component has no inventoried files: $($Component.component)"
    }
    foreach ($File in @($Component.files)) {
        if ($File.path -notmatch '^[^/\\].*' -or
            $File.path -match '(^|[/\\])\.\.([/\\]|$)' -or
            $File.sha256 -notmatch '^[0-9a-f]{64}$') {
            throw "Unsafe or incomplete native file record for $($Component.component)."
        }
        $NativeFilePath = Join-Path $BuiltApp ($File.path.Replace('/', '\'))
        Assert-StrictChildPath -Path $NativeFilePath -Parent $BuiltApp
        if (-not (Test-Path -LiteralPath $NativeFilePath -PathType Leaf)) {
            throw "Inventoried native file is missing: $($File.path)"
        }
        $ActualNativeHash = (Get-FileHash -LiteralPath $NativeFilePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($ActualNativeHash -ne $File.sha256) {
            throw "Inventoried native file hash mismatch: $($File.path)"
        }
    }
    foreach ($NoticePath in @($Component.license) + @($Component.notices)) {
        if ([string]::IsNullOrWhiteSpace($NoticePath) -or
            $NoticePath -match '(^|[/\\])\.\.([/\\]|$)') {
            throw "Unsafe or missing license path for $($Component.component)."
        }
        $BundledNoticePath = Join-Path (Join-Path $BuiltApp "licenses") ($NoticePath.Replace('/', '\'))
        Assert-StrictChildPath -Path $BundledNoticePath -Parent (Join-Path $BuiltApp "licenses")
        if (-not (Test-Path -LiteralPath $BundledNoticePath -PathType Leaf)) {
            throw "Inventoried license/notice is missing: $NoticePath"
        }
    }
}
foreach ($ComponentName in $RequiredNativeComponents) {
    if (-not $NativeComponentsByName.ContainsKey($ComponentName)) {
        throw "Native component inventory is missing: $ComponentName"
    }
}

$BundledVersion = (Get-Content -LiteralPath (Join-Path $BuiltApp "app\VERSION") -Raw).Trim()
if ($BundledVersion -ne $Version) {
    throw "Built app version $BundledVersion does not match source version $Version."
}
$VersionInfo = (Get-Item -LiteralPath $BuiltExe).VersionInfo
if ($VersionInfo.ProductVersion -ne $Version -or $VersionInfo.FileVersion -ne $Version) {
    throw "PE version metadata does not match VERSION ($Version)."
}

Assert-ReleaseTreeSafe -Root $BuiltApp

# The only recursive deletion is a fixed child of this repository's .runtime.
# Validate its resolved location before replacing the staging directory.
Assert-StrictChildPath -Path $StageRoot -Parent $RuntimeRoot
if (Test-Path -LiteralPath $StageRoot) {
    Remove-Item -LiteralPath $StageRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $StageRoot, $OutputRoot | Out-Null
Copy-Item -LiteralPath $BuiltApp -Destination $StageApp -Recurse -Force

Assert-ReleaseTreeSafe -Root $StageApp

$ManifestPath = Join-Path $StageApp "FILE-MANIFEST.json"
$Files = Get-ChildItem -LiteralPath $StageApp -Recurse -Force -File |
    Where-Object { $_.FullName -ne $ManifestPath } |
    ForEach-Object {
        $Relative = $_.FullName.Substring($StageApp.Length).TrimStart('\', '/').Replace('\', '/')
        [ordered]@{
            path = $Relative
            size = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    } |
    Sort-Object { $_.path }

$Manifest = [ordered]@{
    schema = 1
    component = "KataGo-HandTalk"
    version = $Version
    platform = "windows-x64"
    sourceRevision = $SourceRevision
    sourceTreeDirty = $SourceTreeDirty
    buildSkipped = [bool]$SkipBuild
    note = "FILE-MANIFEST.json is intentionally excluded from its own file list."
    files = @($Files)
}
$ManifestJson = $Manifest | ConvertTo-Json -Depth 6
Write-Utf8NoBom -Path $ManifestPath -Value ($ManifestJson + "`n")

# ZIP stores entry modification times. Normalize every staged entry after the
# manifest is written so repeating package-release.ps1 over the same build
# yields the same archive hash instead of encoding the packaging wall clock.
$StableTimestamp = [DateTime]::new(2000, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
foreach ($File in Get-ChildItem -LiteralPath $StageApp -Recurse -Force -File) {
    $File.LastWriteTimeUtc = $StableTimestamp
}
foreach ($Directory in Get-ChildItem -LiteralPath $StageApp -Recurse -Force -Directory |
    Sort-Object { $_.FullName.Length } -Descending) {
    $Directory.LastWriteTimeUtc = $StableTimestamp
}
(Get-Item -LiteralPath $StageApp).LastWriteTimeUtc = $StableTimestamp

$ArchiveName = "KataGo-HandTalk-$Version$ArtifactQualifier-windows-x64.zip"
$ExternalManifestName = "KataGo-HandTalk-$Version$ArtifactQualifier-file-manifest.json"
$ArchivePath = Join-Path $OutputRoot $ArchiveName
$ExternalManifestPath = Join-Path $OutputRoot $ExternalManifestName
$ChecksumsPath = Join-Path $OutputRoot "SHA256SUMS"

foreach ($OutputPath in @($ArchivePath, $ExternalManifestPath, $ChecksumsPath)) {
    if (Test-Path -LiteralPath $OutputPath -PathType Leaf) {
        Remove-Item -LiteralPath $OutputPath -Force
    }
}

Add-Type -AssemblyName System.IO.Compression
$ZipStream = [IO.File]::Open(
    $ArchivePath,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None
)
$ZipArchive = New-Object IO.Compression.ZipArchive(
    $ZipStream,
    [IO.Compression.ZipArchiveMode]::Create,
    $false
)
try {
    $ZipTimestamp = New-Object DateTimeOffset($StableTimestamp)
    foreach ($File in Get-ChildItem -LiteralPath $StageApp -Recurse -Force -File |
        Sort-Object FullName) {
        $Relative = $File.FullName.Substring($StageApp.Length).TrimStart('\', '/').Replace('\', '/')
        $Entry = $ZipArchive.CreateEntry(
            "KataGo-HandTalk/$Relative",
            [IO.Compression.CompressionLevel]::Optimal
        )
        $Entry.LastWriteTime = $ZipTimestamp
        $InputStream = [IO.File]::OpenRead($File.FullName)
        $EntryStream = $Entry.Open()
        try {
            $InputStream.CopyTo($EntryStream)
        } finally {
            $EntryStream.Dispose()
            $InputStream.Dispose()
        }
    }
} finally {
    $ZipArchive.Dispose()
    $ZipStream.Dispose()
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$ReadArchive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
try {
    if ($ReadArchive.Entries.Count -ne ($Files.Count + 1)) {
        throw "ZIP entry count does not match the file manifest."
    }
    foreach ($Item in $Files) {
        $EntryName = "KataGo-HandTalk/$($Item.path)"
        $Entry = $ReadArchive.GetEntry($EntryName)
        if ($null -eq $Entry) {
            throw "ZIP is missing manifest entry: $EntryName"
        }
        $EntryStream = $Entry.Open()
        $Hasher = [Security.Cryptography.SHA256]::Create()
        try {
            $ActualHash = ([BitConverter]::ToString($Hasher.ComputeHash($EntryStream))).Replace('-', '').ToLowerInvariant()
        } finally {
            $Hasher.Dispose()
            $EntryStream.Dispose()
        }
        if ($ActualHash -ne $Item.sha256) {
            throw "ZIP content hash differs from the manifest: $EntryName"
        }
    }
    if ($null -eq $ReadArchive.GetEntry("KataGo-HandTalk/FILE-MANIFEST.json")) {
        throw "ZIP is missing its embedded FILE-MANIFEST.json."
    }
} finally {
    $ReadArchive.Dispose()
}

Copy-Item -LiteralPath $ManifestPath -Destination $ExternalManifestPath -Force

$ArchiveHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$ManifestHash = (Get-FileHash -LiteralPath $ExternalManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$ChecksumText = @(
    "$ArchiveHash  $ArchiveName",
    "$ManifestHash  $ExternalManifestName"
) -join "`n"
Write-Utf8NoBom -Path $ChecksumsPath -Value ($ChecksumText + "`n")

Write-Host ""
Write-Host "Release package verified." -ForegroundColor Green
Write-Host "Archive : $ArchivePath" -ForegroundColor Green
Write-Host "Manifest: $ExternalManifestPath" -ForegroundColor Green
Write-Host "Hashes  : $ChecksumsPath" -ForegroundColor Green
