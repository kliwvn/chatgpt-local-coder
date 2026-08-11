# check-dist-fresh.ps1 - Exit code 1 when the newest source file is newer than
# the built dist entry. Used by setup.bat so the Manager never hits the
# "Runtime source is newer than dist" buildDrift refusal. Outputs "1" (build
# needed) or "0" (fresh).
param(
  [string]$SrcDir,
  [string]$DistEntry
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $DistEntry)) { Write-Output "1"; exit 0 }
if (-not (Test-Path -LiteralPath $SrcDir)) { Write-Output "0"; exit 0 }
$newestSrc = Get-ChildItem -Path $SrcDir -Recurse -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $newestSrc) { Write-Output "0"; exit 0 }
$src = $newestSrc.LastWriteTime
$dst = (Get-Item -LiteralPath $DistEntry).LastWriteTime
if ($src -gt $dst) { Write-Output "1" } else { Write-Output "0" }
exit 0
