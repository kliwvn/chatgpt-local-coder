param(
  [string]$Version = "v0.0.11",
  [string]$SourceCommit = "8d55683eeef80bc5e360d95abf4692454fafc615",
  [string]$PatchRevision = "lazy-codex-v2",
  [string]$OutputDir = "",
  [string]$GoExe = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$expectedBinarySha256 = "c900f09edba10115a17f937fb3b101e9e35e58b342d3c92f59f9f6f9b9166494"
$defaultGenerationDir = Join-Path $repoRoot ("bin\lazy-codex-verified-v2\sha256-" + $expectedBinarySha256)
$outDir = if ([string]::IsNullOrWhiteSpace($OutputDir)) { $defaultGenerationDir } else { [IO.Path]::GetFullPath($OutputDir) }
$outExe = Join-Path $outDir "tunnel-client.exe"
$markerFile = Join-Path $outDir "version.json"
$lockFile = Join-Path $outDir ".build.lock"
$tempDir = Join-Path $env:TEMP ("chatgpt-local-coder-tunnel-client-" + [guid]::NewGuid().ToString("N"))
$tempGoDir = Join-Path $env:TEMP ("chatgpt-local-coder-go-" + [guid]::NewGuid().ToString("N"))
$stageId = [guid]::NewGuid().ToString("N")
$stagedExe = Join-Path $outDir ("tunnel-client." + $stageId + ".tmp.exe")
$stagedMarker = Join-Path $outDir ("version." + $stageId + ".tmp.json")
$buildLock = $null

# v0.0.11 declares `go 1.26.2`. Use a pinned portable toolchain archive instead
# of depending on a machine-wide Go install. This makes fresh clone/reinstall and
# boot-time self-repair deterministic on the supported Windows amd64 platform.
$goVersion = "1.26.2"
$goArchiveName = "go$goVersion.windows-amd64.zip"
$goArchiveSha256 = "98eb3570bade15cb826b0909338df6cc6d2cf590bc39c471142002db3832b708"
$goArchiveUrl = "https://go.dev/dl/$goArchiveName"
$goCacheDir = Join-Path $repoRoot "bin\toolchains\downloads"
$goArchive = Join-Path $goCacheDir $goArchiveName

function Get-ExactRuntimeValid {
  if (-not (Test-Path -LiteralPath $outExe) -or -not (Test-Path -LiteralPath $markerFile)) { return $false }
  try {
    $marker = Get-Content -LiteralPath $markerFile -Raw | ConvertFrom-Json
    if ($marker.schema -ne 1) { return $false }
    if ([string]$marker.version -ne $Version) { return $false }
    if ([string]$marker.patch_revision -ne $PatchRevision) { return $false }
    if ([string]$marker.source_commit -ne $SourceCommit) { return $false }
    $expected = ([string]$marker.sha256).ToLowerInvariant()
    if ($expected -ne $expectedBinarySha256) { return $false }
    $actual = (Get-FileHash -LiteralPath $outExe -Algorithm SHA256).Hash.ToLowerInvariant()
    return $actual -eq $expectedBinarySha256
  }
  catch {
    return $false
  }
}

function Acquire-BuildLock {
  $deadline = [DateTime]::UtcNow.AddMinutes(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      return [IO.File]::Open($lockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    }
    catch [IO.IOException] {
      Start-Sleep -Milliseconds 250
    }
  }
  throw "Timed out waiting for patched runtime build lock: $lockFile"
}

function Ensure-PinnedGoArchive {
  New-Item -ItemType Directory -Force -Path $goCacheDir | Out-Null
  if (Test-Path -LiteralPath $goArchive) {
    $cachedHash = (Get-FileHash -LiteralPath $goArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($cachedHash -eq $goArchiveSha256) { return }
  }

  $downloadTmp = Join-Path $goCacheDir ($goArchiveName + "." + [guid]::NewGuid().ToString("N") + ".tmp")
  try {
    Write-Host "Downloading pinned Go $goVersion toolchain..."
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
      & $curl.Source -fL --retry 3 --retry-delay 2 --connect-timeout 20 --output $downloadTmp $goArchiveUrl
      if ($LASTEXITCODE -ne 0) { throw "Pinned Go toolchain download failed via curl.exe" }
    }
    else {
      Invoke-WebRequest -UseBasicParsing -Uri $goArchiveUrl -OutFile $downloadTmp -TimeoutSec 300
    }
    $downloadHash = (Get-FileHash -LiteralPath $downloadTmp -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($downloadHash -ne $goArchiveSha256) {
      throw "Go toolchain SHA256 mismatch: expected $goArchiveSha256, got $downloadHash"
    }
    Move-Item -LiteralPath $downloadTmp -Destination $goArchive -Force
  }
  finally {
    if (Test-Path -LiteralPath $downloadTmp) {
      Remove-Item -LiteralPath $downloadTmp -Force -ErrorAction SilentlyContinue
    }
  }
}

function Resolve-GoExecutable {
  if (-not [string]::IsNullOrWhiteSpace($GoExe)) {
    $explicit = Get-Command $GoExe -ErrorAction SilentlyContinue
    $resolvedExplicit = if ($explicit) { $explicit.Source } elseif (Test-Path -LiteralPath $GoExe) { [IO.Path]::GetFullPath($GoExe) } else { $null }
    if (-not $resolvedExplicit) { throw "Explicit Go executable not found: $GoExe" }
    $explicitVersionOutput = (& $resolvedExplicit version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $explicitVersionOutput -notlike "*go$goVersion *") {
      throw "Explicit Go executable must be exactly Go ${goVersion}: $explicitVersionOutput"
    }
    return $resolvedExplicit
  }

  Ensure-PinnedGoArchive
  $archiveHash = (Get-FileHash -LiteralPath $goArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($archiveHash -ne $goArchiveSha256) {
    throw "Cached Go toolchain SHA256 mismatch after verification."
  }
  New-Item -ItemType Directory -Force -Path $tempGoDir | Out-Null
  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($tar) {
    & $tar.Source -xf $goArchive -C $tempGoDir
    if ($LASTEXITCODE -ne 0) { throw "Pinned Go toolchain extraction failed via tar.exe" }
  }
  else {
    Expand-Archive -LiteralPath $goArchive -DestinationPath $tempGoDir -Force
  }
  $portableGo = Join-Path $tempGoDir "go\bin\go.exe"
  if (-not (Test-Path -LiteralPath $portableGo)) {
    throw "Pinned Go toolchain archive did not contain go\\bin\\go.exe"
  }
  $goVersionOutput = (& $portableGo version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $goVersionOutput -notlike "*go$goVersion *") {
    throw "Pinned Go toolchain identity mismatch: $goVersionOutput"
  }
  return $portableGo
}

try {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $buildLock = Acquire-BuildLock

  # Another Manager/installer may have repaired the runtime while we waited.
  if (Get-ExactRuntimeValid) {
    Write-Host "Patched runtime already exact/verified: $outExe"
    exit 0
  }

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git executable is required to fetch pinned OpenAI tunnel-client source."
  }
  $resolvedGoExe = Resolve-GoExecutable

  & git clone --quiet --depth 1 --branch $Version https://github.com/openai/tunnel-client.git $tempDir
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }

  Push-Location $tempDir
  try {
    $actualCommit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $SourceCommit) {
      throw "Upstream source identity mismatch: expected $SourceCommit, got $actualCommit"
    }

    $bridge = Join-Path $tempDir "pkg\codexappserver\bridge.go"
    $source = [IO.File]::ReadAllText($bridge)
    $old = @'
	if lifecycle != nil {
		lifecycle.Append(fx.Hook{
			OnStart: func(context.Context) error {
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					defer cancel()
					_ = b.EnsureStarted(ctx)
				}()
				return nil
			},
			OnStop: func(ctx context.Context) error {
				return b.Stop(ctx)
			},
		})
	}
'@
    $new = @'
	if lifecycle != nil {
		lifecycle.Append(fx.Hook{
			// Keep the optional Codex assistant lazy. Core tunnel/MCP forwarding
			// does not require codex app-server; assistant actions start it on demand.
			OnStop: func(ctx context.Context) error {
				return b.Stop(ctx)
			},
		})
	}
'@
    $sourceNormalized = $source.Replace("`r`n", "`n")
    $oldNormalized = $old.Replace("`r`n", "`n")
    $newNormalized = $new.Replace("`r`n", "`n")
    if (-not $sourceNormalized.Contains($oldNormalized)) {
      throw "Expected upstream Codex eager-start block was not found; refuse to patch unknown source."
    }
    $sourceNormalized = $sourceNormalized.Replace($oldNormalized, $newNormalized)
    [IO.File]::WriteAllText($bridge, $sourceNormalized, [Text.UTF8Encoding]::new($false))

    & git diff --check -- pkg/codexappserver/bridge.go
    if ($LASTEXITCODE -ne 0) { throw "patched source failed git diff --check" }

    & $resolvedGoExe test ./pkg/codexappserver ./pkg/adminui
    if ($LASTEXITCODE -ne 0) { throw "tunnel-client targeted tests failed" }

    $semanticVersion = $Version.TrimStart('v')
    $ldflags = "-s -w -X github.com/openai/tunnel-client/pkg/version.GitSHA=$SourceCommit -X github.com/openai/tunnel-client/pkg/version.semanticVersion=$semanticVersion"
    & $resolvedGoExe build -buildvcs=false -trimpath -ldflags $ldflags -o $stagedExe ./cmd/client
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $stagedExe)) {
      throw "tunnel-client patched build failed"
    }

    $binarySha256 = (Get-FileHash -LiteralPath $stagedExe -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($binarySha256 -ne $expectedBinarySha256) {
      throw "Patched tunnel-client SHA256 mismatch: expected $expectedBinarySha256, got $binarySha256"
    }
    $marker = [ordered]@{
      schema = 1
      version = $Version
      patch_revision = $PatchRevision
      source_commit = $SourceCommit
      sha256 = $binarySha256
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($stagedMarker, $marker, [Text.UTF8Encoding]::new($false))

    # Publish the binary first and the identity marker last. A crash between these
    # moves is detected by hash/identity verification and repaired on the next run.
    Move-Item -LiteralPath $stagedExe -Destination $outExe -Force
    Move-Item -LiteralPath $stagedMarker -Destination $markerFile -Force
    Write-Host "Built lazy-Codex tunnel-client: $outExe"
    Write-Host "Marker: $marker"
  }
  finally {
    Pop-Location
  }
}
finally {
  if ($buildLock) { $buildLock.Dispose() }
  if (Test-Path -LiteralPath $stagedExe) {
    Remove-Item -LiteralPath $stagedExe -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $stagedMarker) {
    Remove-Item -LiteralPath $stagedMarker -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $tempGoDir) {
    Remove-Item -LiteralPath $tempGoDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
