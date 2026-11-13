$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = (Get-Command python -ErrorAction Stop).Source
$AppData = Join-Path $env:LOCALAPPDATA "VisionaryNexus"
$Startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
New-Item -ItemType Directory -Force -Path $AppData, $Startup | Out-Null
$Launcher = Join-Path $AppData "start-companion.vbs"
$Script = Join-Path $Root "companion.py"
@"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """$Python"" ""$Script""", 0, False
"@ | Set-Content -Path $Launcher -Encoding ASCII
$ShortcutPath = Join-Path $Startup "Visionary Nexus Companion.lnk"
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments = ('"' + $Launcher + '"')
$Shortcut.WorkingDirectory = $Root
$Shortcut.Save()
Start-Process wscript.exe -ArgumentList ('"' + $Launcher + '"')
Write-Host "Visionary Nexus Companion installed and started for this Windows user."
Write-Host "It will start automatically when you sign in. No administrator access or phone is required."
