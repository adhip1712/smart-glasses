$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = (Get-Command python -ErrorAction Stop).Source
$Startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
New-Item -ItemType Directory -Force -Path $Startup | Out-Null
$Script = Join-Path $Root "companion.py"
$ShortcutPath = Join-Path $Startup "Visionary Nexus Companion.lnk"
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Python
$Shortcut.Arguments = ('"' + $Script + '"')
$Shortcut.WorkingDirectory = $Root
$Shortcut.Save()
Start-Process -FilePath $Python -ArgumentList @($Script) -WindowStyle Hidden
Write-Host "Visionary Nexus Companion installed and started for this Windows user."
Write-Host "It will start automatically when you sign in. No administrator access or phone is required."
