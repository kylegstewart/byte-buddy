# Registers a "ByteBuddyLounge" scheduled task that starts the relay at logon, daily at 8 AM, and re-checks every 5 minutes.
param(
    [string]$TaskName = "ByteBuddyLounge",
    [string]$AllowedOrgs = ""
)

$script = Join-Path $PSScriptRoot "start-lounge.ps1"
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
if ($AllowedOrgs) { $arguments += " -AllowedOrgs `"$AllowedOrgs`"" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $PSScriptRoot
$triggers = @(
    New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    New-ScheduledTaskTrigger -Daily -At 8am
    # Self-heal: re-run every 5 minutes; start-lounge.ps1 exits immediately if the relay is already up.
    New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
    -Description "Byte Buddy Lounge relay (exposed via Tailscale Funnel)" -Force | Out-Null
Write-Host "Registered scheduled task '$TaskName'. Start it now with: Start-ScheduledTask -TaskName $TaskName"
