# Runs the Lounge relay on 127.0.0.1:8787 and restarts it if it exits.
# Exposed publicly by Tailscale Funnel (`tailscale funnel --bg 8787`).
param(
    [int]$Port = 8787,
    [string]$AllowedOrgs = $env:LOUNGE_ALLOWED_ORGS
)

$ErrorActionPreference = "Stop"
$serverPath = Join-Path $PSScriptRoot "server.mjs"
$logPath = Join-Path $PSScriptRoot "lounge.log"

$probe = [Net.Sockets.TcpClient]::new()
$inUse = try { $probe.ConnectAsync("127.0.0.1", $Port).Wait(1000) } catch { $false } finally { $probe.Dispose() }
if ($inUse) {
    Write-Output "Port $Port already in use; relay is likely running."
    exit 0
}

$env:HOST = "127.0.0.1"
$env:PORT = "$Port"
if ($AllowedOrgs) { $env:LOUNGE_ALLOWED_ORGS = $AllowedOrgs }

while ($true) {
    "$(Get-Date -Format s) starting relay" | Add-Content $logPath
    & node $serverPath 2>&1 | Out-File -FilePath $logPath -Append -Encoding utf8
    "$(Get-Date -Format s) relay exited with code $LASTEXITCODE; restarting in 5s" | Add-Content $logPath
    Start-Sleep -Seconds 5
}
