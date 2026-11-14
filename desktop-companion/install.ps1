$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = (Get-Command python -ErrorAction Stop).Source
& $Python -m pip install --upgrade pywinauto
if ($LASTEXITCODE -ne 0) { throw "Could not install pywinauto. Companion was not updated." }
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
Get-CimInstance Win32_Process -Filter "name = 'python.exe'" | Where-Object { $_.CommandLine -like "*desktop-companion*companion.py*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Process -FilePath $Python -ArgumentList @($Script) -WindowStyle Hidden
Write-Host "Visionary Nexus Companion 3.0 installed and started."
Write-Host "It will start automatically when you sign in. No administrator access or phone is required."
