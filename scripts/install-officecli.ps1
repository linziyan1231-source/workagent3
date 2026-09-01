param(
    [string]$Version = '1.0.146',
    [string]$ExpectedSHA256 = 'ad36ca99a50102d8f953e8ed1742fab65c9e201a29733601ea6ca9e676b2eed0'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$cacheRoot = Join-Path $repositoryRoot ".cache\officecli-v$Version"
$targetRoot = Join-Path $repositoryRoot 'release\managed-tools\officecli'
$download = Join-Path $cacheRoot 'officecli-win-x64.exe'
$target = Join-Path $targetRoot 'officecli.exe'
$source = "https://github.com/iOfficeAI/OfficeCLI/releases/download/v$Version/officecli-win-x64.exe"

New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null

if (-not (Test-Path -LiteralPath $download) -or
    (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $ExpectedSHA256) {
    Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
    Import-Module BitsTransfer
    Start-BitsTransfer -Source $source -Destination $download -DisplayName "WorkAgent3 OfficeCLI v$Version"
}

$actual = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $ExpectedSHA256.ToLowerInvariant()) {
    throw "OfficeCLI SHA256 mismatch: expected $ExpectedSHA256, received $actual"
}

Copy-Item -LiteralPath $download -Destination $target -Force
$reported = & $target --version
if ($LASTEXITCODE -ne 0 -or $reported -notmatch [regex]::Escape($Version)) {
    throw "OfficeCLI version verification failed: $reported"
}

[pscustomobject]@{
    Version = $Version
    SHA256 = $actual
    Path = $target
}
