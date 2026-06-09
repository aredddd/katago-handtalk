<#
.SYNOPSIS
    Suspend or resume the KataGo process for the Circuit Breaker demo (option C).

.DESCRIPTION
    Suspending (not killing) the engine keeps the process alive — so the server's
    is_ready() check still passes and analysis requests reach the Circuit Breaker,
    where they TIME OUT (a real hung-engine fault) and trip the breaker to OPEN.
    Resuming the process lets the HALF_OPEN trial succeed and the breaker recover
    to CLOSED. See TP2/demo-circuit-breaker.md.

    Uses ntdll NtSuspendProcess / NtResumeProcess via P/Invoke — no external tool
    (no Sysinternals) required.

.EXAMPLE
    .\demo_suspend_katago.ps1            # suspend (freeze) KataGo
    .\demo_suspend_katago.ps1 -Resume    # resume (unfreeze) KataGo
    .\demo_suspend_katago.ps1 -Name katago -Id 12345
#>
param(
    [switch]$Resume,
    [string]$Name = "katago",
    [int]$Id = 0
)

# Guard so re-running in the same shell (suspend, then later resume) does not
# fail with "type already exists".
if (-not ("Demo.NtProc" -as [type])) {
    Add-Type -Name NtProc -Namespace Demo -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("ntdll.dll")]
public static extern int NtSuspendProcess(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("ntdll.dll")]
public static extern int NtResumeProcess(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern System.IntPtr OpenProcess(int access, bool inherit, int pid);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern bool CloseHandle(System.IntPtr h);
'@
}

$PROCESS_SUSPEND_RESUME = 0x0800

if ($Id -gt 0) {
    $targets = @(Get-Process -Id $Id -ErrorAction SilentlyContinue)
} else {
    $targets = @(Get-Process -Name $Name -ErrorAction SilentlyContinue)
}

if (-not $targets -or $targets.Count -eq 0) {
    Write-Error "No process found (Name='$Name', Id=$Id). Is KataGo running?"
    exit 1
}

foreach ($p in $targets) {
    $h = [Demo.NtProc]::OpenProcess($PROCESS_SUSPEND_RESUME, $false, $p.Id)
    if ($h -eq [System.IntPtr]::Zero) {
        Write-Error "OpenProcess failed for PID $($p.Id) (try running as Administrator)."
        continue
    }
    if ($Resume) {
        [void][Demo.NtProc]::NtResumeProcess($h)
        Write-Output "RESUMED  PID $($p.Id)  ($($p.ProcessName)) - engine unfrozen"
    } else {
        [void][Demo.NtProc]::NtSuspendProcess($h)
        Write-Output "SUSPENDED PID $($p.Id)  ($($p.ProcessName)) - engine frozen (queries will time out)"
    }
    [void][Demo.NtProc]::CloseHandle($h)
}
