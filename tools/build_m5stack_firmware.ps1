param(
  [string]$AtomPort = "",
  [string]$CameraPort = ""
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$BuildRoot = Join-Path $Root "build\m5stack"

Write-Host "Building M5Stack ATOM Echo..."
arduino-cli compile --fqbn esp32:esp32:m5stack-atom --output-dir (Join-Path $BuildRoot "atom_echo") (Join-Path $Root "firmware\atom_echo")
if ($LASTEXITCODE -ne 0) { throw "ATOM Echo build failed." }

Write-Host "Building M5Stack Unit CAM (U109/U109-B)..."
arduino-cli compile --fqbn esp32:esp32:esp32 --build-property build.partitions=huge_app --output-dir (Join-Path $BuildRoot "unit_cam") (Join-Path $Root "firmware\m5stack_unit_cam")
if ($LASTEXITCODE -ne 0) { throw "Unit CAM build failed." }

if ($AtomPort) {
  Write-Host "Uploading ATOM Echo to $AtomPort..."
  arduino-cli upload --fqbn esp32:esp32:m5stack-atom --port $AtomPort --input-dir (Join-Path $BuildRoot "atom_echo") (Join-Path $Root "firmware\atom_echo")
  if ($LASTEXITCODE -ne 0) { throw "ATOM Echo upload failed." }
}
if ($CameraPort) {
  Write-Host "Uploading Unit CAM to $CameraPort..."
  arduino-cli upload --fqbn esp32:esp32:esp32 --port $CameraPort --input-dir (Join-Path $BuildRoot "unit_cam") (Join-Path $Root "firmware\m5stack_unit_cam")
  if ($LASTEXITCODE -ne 0) { throw "Unit CAM upload failed." }
}
Write-Host "Build completed. Firmware binaries are under build\m5stack."
if (-not $AtomPort -and -not $CameraPort) {
  Write-Host "To upload later, rerun with -AtomPort COMx and/or -CameraPort COMy."
}
