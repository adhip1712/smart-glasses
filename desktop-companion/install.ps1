$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = (Get-Command python -ErrorAction Stop).Source
$AppData = Join-Path $env:LOCALAPPDATA "VisionaryNexus"
New-Item -ItemType Directory -Force -Path $AppData | Out-Null
$Launcher = Join-Path $AppData "start-companion.vbs"
$Script = Join-Path $Root "companion.py"
@"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """$Python"" ""$Script""", 0, False
"@ | Set-Content -Path $Launcher -Encoding ASCII
$Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument ('"' + $Launcher + '"')
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "VisionaryNexusCompanion" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Visionary Nexus local desktop companion" -Force | Out-Null
Start-Process wscript.exe -ArgumentList ('"' + $Launcher + '"')
Write-Host "Visionary Nexus Companion installed and started. No phone is required."
