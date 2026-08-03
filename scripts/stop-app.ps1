<#
.SYNOPSIS
    Stops the compliance-core dev servers started by start-app.bat.

.DESCRIPTION
    Finds whatever is LISTENING on the API port (from apps/api/.env) and on the
    Vite dev ports, and stops those processes.

    Deliberately targets processes BY LISTENING PORT rather than killing every
    node.exe - this machine may be running a second checkout, an editor's
    language server, or other Node tooling that must not be disturbed.

    PostgreSQL is left running: it is a Windows service shared with anything
    else on the box, and stopping it is not part of shutting down this app.
#>
[CmdletBinding()]
param(
    [int[]]$ExtraPorts = @()
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host ""
Write-Host "  ===================================================" -ForegroundColor White
Write-Host "   compliance-core  -  stopping services" -ForegroundColor White
Write-Host "  ===================================================" -ForegroundColor White

# ---- work out which API port this checkout uses -----------------------------
$ApiPort = 3000
$EnvPath = Join-Path $RepoRoot 'apps\api\.env'
if (Test-Path $EnvPath) {
    foreach ($line in (Get-Content $EnvPath)) {
        $t = $line.Trim()
        if ($t -match '^PORT\s*=\s*(\d+)') { $ApiPort = [int]$Matches[1] }
    }
}

$ports = @($ApiPort) + (5175..5185) + $ExtraPorts | Select-Object -Unique

$stopped = 0
$skipped = 0

foreach ($port in $ports) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) { continue }

    foreach ($c in $conns) {
        $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if (-not $proc) { continue }

        # Only stop things that belong to THIS repo. A sibling checkout on a
        # neighbouring port must survive.
        $belongs = $false
        try {
            $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.Id)" -ErrorAction Stop).CommandLine
            if ($cmdline -and $cmdline.ToLower().Contains($RepoRoot.ToLower())) { $belongs = $true }
            if (-not $belongs) {
                $cwd = $null
                try { $cwd = $proc.Path } catch { }
                if ($cwd -and $cwd.ToLower().StartsWith($RepoRoot.ToLower())) { $belongs = $true }
            }
        } catch { }

        if ($belongs) {
            Write-Host ("   stopping  port {0,-5}  {1} (PID {2})" -f $port, $proc.ProcessName, $proc.Id) -ForegroundColor Yellow
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction Stop
                $stopped++
            } catch {
                Write-Host ("   could not stop PID {0}: {1}" -f $proc.Id, $_.Exception.Message) -ForegroundColor Red
            }
        } else {
            Write-Host ("   skipping  port {0,-5}  {1} (PID {2}) - not from this repo" -f $port, $proc.ProcessName, $proc.Id) -ForegroundColor DarkGray
            $skipped++
        }
    }
}

Write-Host ""
if ($stopped -eq 0) {
    Write-Host "   Nothing from this repo was running." -ForegroundColor Gray
} else {
    Write-Host "   Stopped $stopped process(es)." -ForegroundColor Green
}
if ($skipped -gt 0) {
    Write-Host "   Left $skipped process(es) alone (another checkout or unrelated tool)." -ForegroundColor DarkGray
}
Write-Host "   PostgreSQL was left running (shared Windows service)." -ForegroundColor DarkGray
Write-Host ""
