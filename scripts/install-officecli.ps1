param(
    [string]$Version = '1.0.146',
    [string]$ExpectedSHA256 = 'ad36ca99a50102d8f953e8ed1742fab65c9e201a29733601ea6ca9e676b2eed0'
)

# The pinned version, hash, and license are recorded in
# release/managed-tools/officecli/manifest.json; keep these defaults in step
# with that record. Employee Manager verifies the installed binary against the
# manifest at startup.

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

[pscustomobject]@{
    Version = $Version
    SHA256 = $actual
    Path = $target
}
