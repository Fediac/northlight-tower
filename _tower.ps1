# Starts / stops NorthLight Tower (used by Start.bat, Stop.bat and the desktop shortcut).
#   _tower.ps1 start   -> starts the server if needed, then opens the app window
#   _tower.ps1 stop    -> stops exactly this tower's server (never another program that happens to use the port)
# Environment: NORTHLIGHT_PORT (default 8765); NORTHLIGHT_NO_WINDOW=1 (do not open a window or dialogs; used by tests)
param([Parameter(Position = 0)][string]$Action = 'start')

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8765
if ($env:NORTHLIGHT_PORT) { $port = [int]$env:NORTHLIGHT_PORT }
$base = "http://127.0.0.1:$port"
$pidFile = Join-Path $here '.tower.pid'

# 'tower' = NorthLight Tower answers (it marks every response with X-NorthLight-Tower),
# 'other' = another program answers, 'none' = nothing answers
function Get-PortOwner {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "$base/state"
        if ($r.Headers['X-NorthLight-Tower']) { return 'tower' }
        return 'other'
    } catch {
        $resp = $_.Exception.Response
        if ($resp) {
            if ($resp.Headers['X-NorthLight-Tower']) { return 'tower' }
            return 'other'
        }
        return 'none'
    }
}

function Get-Listeners {
    $lines = @()
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess) -ErrorAction SilentlyContinue
        $lines += ("{0} (PID {1}): {2}" -f $p.Name, $c.OwningProcess, $p.CommandLine)
    }
    return (($lines | Select-Object -Unique) -join "`n")
}

function Show-Message([string]$text) {
    if ($env:NORTHLIGHT_NO_WINDOW) { Write-Host $text; return }
    Add-Type -AssemblyName PresentationFramework
    [void][System.Windows.MessageBox]::Show($text, 'NorthLight Tower', 'OK', 'Warning')
}

function Start-Tower {
    $state = Get-PortOwner
    if ($state -eq 'other') {
        Show-Message ("Port $port is used by another program, so NorthLight Tower cannot start on it.`n`n" + (Get-Listeners) + "`n`nClose that program (or stop its server) and start NorthLight Tower again. Nothing was changed.")
        exit 3
    }
    if ($state -eq 'none') {
        $py = $null
        foreach ($n in 'pythonw.exe', 'pyw.exe', 'python.exe') {
            $c = Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($c) { $py = $c; break }
        }
        if (-not $py) { Show-Message 'Python 3 was not found. Install Python 3 and start NorthLight Tower again.'; exit 2 }
        Start-Process -FilePath $py.Source -ArgumentList 'server.py' -WorkingDirectory $here -WindowStyle Hidden
        $deadline = (Get-Date).AddSeconds(15)
        do { Start-Sleep -Milliseconds 300; $state = Get-PortOwner } while ($state -ne 'tower' -and (Get-Date) -lt $deadline)
        if ($state -ne 'tower') {
            $who = Get-Listeners
            if (-not $who) { $who = '(nothing is listening on the port)' }
            Show-Message ("NorthLight Tower could not start on port $port.`n`nListening on that port: $who`n`nRun server.py in a terminal to see the error.")
            exit 1
        }
    }
    if (-not $env:NORTHLIGHT_NO_WINDOW) {
        try { Start-Process msedge -ArgumentList "--app=$base", '--window-size=1440,880' } catch { Start-Process $base }
    }
    exit 0
}

function Stop-Tower {
    $ours = @()
    if (Test-Path $pidFile) {
        $id = 0
        $txt = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ([int]::TryParse([string]$txt, [ref]$id) -and $id -gt 0) {
            $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
            if ($p -and $p.CommandLine -match 'server\.py') { $ours += $id }
        }
    }
    if (-not $ours) {
        # started without a pid file (older version): accept only if the port answers as NorthLight Tower and exactly one process listens
        if ((Get-PortOwner) -eq 'tower') {
            $ids = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess } | Select-Object -Unique)
            if ($ids.Count -eq 1) { $ours += $ids[0] }
        }
    }
    if ($ours) {
        foreach ($id in $ours) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        Write-Host 'NorthLight Tower stopped.'
        return
    }
    if ((Get-PortOwner) -eq 'other') { Write-Host "Port $port is used by another program. I did not touch it." }
    else { Write-Host 'NorthLight Tower is not running.' }
}

switch ($Action.ToLower()) {
    'start' { Start-Tower }
    'stop' { Stop-Tower }
    default { Write-Host 'Usage: _tower.ps1 start | stop' }
}
