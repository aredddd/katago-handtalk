[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$AppExe = Join-Path $ProjectRoot "desktop-dist\KataGo-HandTalk\KataGo-HandTalk.exe"

try {
    if (-not $SkipBuild) {
        & (Join-Path $PSScriptRoot "build-desktop.ps1")
        if ($LASTEXITCODE -ne 0) { throw "Desktop build failed with exit code $LASTEXITCODE." }
    }

    if (-not (Test-Path -LiteralPath $AppExe -PathType Leaf)) {
        throw "Desktop application not found: $AppExe`nRun desktop\build-desktop.ps1 first."
    }

    $DesktopDirectory = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::DesktopDirectory
    )
    $ProgramsDirectory = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::Programs
    )
    if ([string]::IsNullOrWhiteSpace($DesktopDirectory) -or
        [string]::IsNullOrWhiteSpace($ProgramsDirectory)) {
        throw "Windows Desktop or Start Menu directory could not be resolved."
    }

    # Windows PowerShell 5.1 reads BOM-less scripts using the active ANSI code
    # page. Construct the Chinese display name from code points so the script
    # works from a UTF-8 git checkout on every Windows locale.
    $HandTalkName = [string][char]0x624B + [string][char]0x8C08
    $AppDisplayName = "$HandTalkName KataGo"
    $StartMenuDirectory = Join-Path $ProgramsDirectory $AppDisplayName
    New-Item -ItemType Directory -Force -Path $StartMenuDirectory | Out-Null

    $DesktopShortcut = Join-Path $DesktopDirectory "$AppDisplayName.lnk"
    $StartMenuShortcut = Join-Path $StartMenuDirectory "$AppDisplayName.lnk"
    $ShortcutArguments = '--project-root "{0}"' -f $ProjectRoot.Replace('"', '\"')
    $Shell = New-Object -ComObject WScript.Shell

    foreach ($ShortcutPath in @($DesktopShortcut, $StartMenuShortcut)) {
        $Shortcut = $Shell.CreateShortcut($ShortcutPath)
        $Shortcut.TargetPath = $AppExe
        $Shortcut.Arguments = $ShortcutArguments
        $Shortcut.WorkingDirectory = $ProjectRoot
        $Shortcut.IconLocation = "$AppExe,0"
        $Shortcut.Description = "$AppDisplayName - local Go review"
        $Shortcut.Save()

        if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) {
            throw "Shortcut creation failed: $ShortcutPath"
        }
    }

    Write-Host ""
    Write-Host "HandTalk desktop installation complete." -ForegroundColor Green
    Write-Host "Desktop shortcut : $DesktopShortcut"
    Write-Host "Start Menu       : $StartMenuShortcut"
    Write-Host ""
    Write-Host "Double-click '$AppDisplayName' to start. The first launch prepares the" -ForegroundColor Cyan
    Write-Host "local runtime automatically, starts KataGo, and opens the desktop window." -ForegroundColor Cyan
} catch {
    Write-Host ""
    Write-Host "Desktop installation failed." -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
