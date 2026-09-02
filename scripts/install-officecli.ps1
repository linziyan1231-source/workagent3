param(
    [string]$Version = '1.0.146',
    [string]$ExpectedSHA256 = 'ad36ca99a50102d8f953e8ed1742fab65c9e201a29733601ea6ca9e676b2eed0',
    [string]$PluginVersion = '1.0.0',
    [string]$PluginExpectedSHA256 = '3545c86d3d7b49095f8f5cf7f99f7a0b6fba57a416fc9a1692ccfcecd30d33e5',
    [string]$GoCommand = ''
)

# The pinned versions, hashes, and licenses are recorded in
# release/managed-tools/officecli/manifest.json; keep these defaults in step
# with that record (the officecli.exe pin plus the plugins[] entry for the
# internal PDF exporter). Employee Manager verifies the installed binary and
# every pinned plugin against the manifest at startup.
#
# The exporter plugin is built from this repository (cmd/officecli-exporter-pdf)
# because no official upstream PDF exporter exists; the pinned plugin hash is
# reproducible with the pinned toolchain (go1.26.5) and the fixed build flags
# below. Set -GoCommand when `go` is not on PATH.

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$cacheRoot = Join-Path $repositoryRoot ".cache\officecli-v$Version"
$targetRoot = Join-Path $repositoryRoot 'release\managed-tools\officecli'
$download = Join-Path $cacheRoot 'officecli-win-x64.exe'
$target = Join-Path $targetRoot 'officecli.exe'
$backup = Join-Path $targetRoot 'officecli.exe.previous'
$staging = Join-Path $targetRoot "officecli.staging-$([guid]::NewGuid().ToString('N')).exe"
$source = "https://github.com/iOfficeAI/OfficeCLI/releases/download/v$Version/officecli-win-x64.exe"

New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null

function Save-OfficeCliDownload {
    param([string]$Uri, [string]$Destination)
    try {
        Import-Module BitsTransfer -ErrorAction Stop
        Start-BitsTransfer -Source $Uri -Destination $Destination -DisplayName "WorkAgent3 OfficeCLI v$Version" -ErrorAction Stop
    } catch {
        Write-Warning "BITS transfer failed ($($_.Exception.Message)); falling back to Invoke-WebRequest."
        Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing
    }
}

if (-not (Test-Path -LiteralPath $download) -or
    (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $ExpectedSHA256) {
    Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
    Save-OfficeCliDownload -Uri $source -Destination $download
}

$actual = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $ExpectedSHA256.ToLowerInvariant()) {
    throw "OfficeCLI SHA256 mismatch: expected $ExpectedSHA256, received $actual"
}

# Transactional replacement: stage the verified download, prove the staged
# binary runs and reports the pinned version, then swap it in. Any failure
# leaves the previous binary in place or restores it from the backup.
Copy-Item -LiteralPath $download -Destination $staging
$hadPrevious = Test-Path -LiteralPath $target
try {
    $reported = & $staging --version
    if ($LASTEXITCODE -ne 0 -or $reported -notmatch [regex]::Escape($Version)) {
        throw "OfficeCLI version verification failed: $reported"
    }
    if ($hadPrevious) {
        Move-Item -LiteralPath $target -Destination $backup -Force
    }
    try {
        Move-Item -LiteralPath $staging -Destination $target
    } catch {
        if ($hadPrevious) {
            Move-Item -LiteralPath $backup -Destination $target -Force
        }
        throw
    }
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
} catch {
    if (-not (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $backup)) {
        Move-Item -LiteralPath $backup -Destination $target -Force
    }
    throw
} finally {
    Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
}

# --- PDF exporter plugin (internal build, cmd/officecli-exporter-pdf) ---

if ([string]::IsNullOrWhiteSpace($GoCommand)) {
    $GoCommand = (Get-Command go -ErrorAction SilentlyContinue).Source
}
if ([string]::IsNullOrWhiteSpace($GoCommand)) {
    # Deployment hosts without Go on PATH carry the pinned toolchain here.
    $fallback = Join-Path $env:USERPROFILE '.codex\tools\go1.26.5-verified\go\bin\go.exe'
    if (Test-Path -LiteralPath $fallback) {
        $GoCommand = $fallback
    }
}
if ([string]::IsNullOrWhiteSpace($GoCommand)) {
    throw "Go toolchain not found; pass -GoCommand (pinned: go1.26.5) to build the PDF exporter plugin"
}

$pluginDir = Join-Path $targetRoot 'plugins\exporter\pdf'
$pluginTarget = Join-Path $pluginDir 'plugin.exe'
$pluginBackup = Join-Path $pluginDir 'plugin.exe.previous'
$pluginStaging = Join-Path $pluginDir "plugin.staging-$([guid]::NewGuid().ToString('N')).exe"

New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null

Push-Location $repositoryRoot
try {
    & $GoCommand build -trimpath -buildvcs=false -ldflags '-s -w' -o $pluginStaging ./cmd/officecli-exporter-pdf
    if ($LASTEXITCODE -ne 0) {
        throw "PDF exporter plugin build failed (go exit $LASTEXITCODE)"
    }
} finally {
    Pop-Location
}

$pluginActual = (Get-FileHash -LiteralPath $pluginStaging -Algorithm SHA256).Hash.ToLowerInvariant()
if ($pluginActual -ne $PluginExpectedSHA256.ToLowerInvariant()) {
    Remove-Item -LiteralPath $pluginStaging -Force -ErrorAction SilentlyContinue
    throw "PDF exporter plugin SHA256 mismatch: expected $PluginExpectedSHA256, received $pluginActual (rebuild with the pinned go1.26.5 toolchain and flags)"
}

# Transactional replacement, same discipline as officecli.exe: prove the staged
# plugin answers --info with the pinned identity before swapping it in.
$hadPreviousPlugin = Test-Path -LiteralPath $pluginTarget
try {
    $pluginInfo = (& $pluginStaging --info) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $pluginInfo.name -ne 'officecli-exporter-pdf' -or
        $pluginInfo.version -ne $PluginVersion -or $pluginInfo.protocol -ne 1 -or
        $pluginInfo.kinds -notcontains 'exporter') {
        throw "PDF exporter plugin --info verification failed: $($pluginInfo | ConvertTo-Json -Compress)"
    }
    if ($hadPreviousPlugin) {
        Move-Item -LiteralPath $pluginTarget -Destination $pluginBackup -Force
    }
    try {
        Move-Item -LiteralPath $pluginStaging -Destination $pluginTarget
    } catch {
        if ($hadPreviousPlugin) {
            Move-Item -LiteralPath $pluginBackup -Destination $pluginTarget -Force
        }
        throw
    }
    Remove-Item -LiteralPath $pluginBackup -Force -ErrorAction SilentlyContinue
} catch {
    if (-not (Test-Path -LiteralPath $pluginTarget) -and (Test-Path -LiteralPath $pluginBackup)) {
        Move-Item -LiteralPath $pluginBackup -Destination $pluginTarget -Force
    }
    throw
} finally {
    Remove-Item -LiteralPath $pluginStaging -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{
    Version       = $Version
    SHA256        = $actual
    Path          = $target
    PluginVersion = $PluginVersion
    PluginSHA256  = $pluginActual
    PluginPath    = $pluginTarget
}
