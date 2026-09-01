$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$goScript = Join-Path $PSScriptRoot "go.ps1"
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("workagent3-release-smoke-" + [guid]::NewGuid().ToString("N"))
$candidateRoot = Join-Path $smokeRoot "candidate"
$componentRoot = Join-Path $candidateRoot "components"
$releaseRoot = Join-Path $smokeRoot "releases"
$databasePath = Join-Path $smokeRoot "operations.db"
$notificationPath = Join-Path $smokeRoot "notifications.db"
$manifestPath = Join-Path $candidateRoot "workagent-release.json"
$version = "release-smoke-1.0.0"

function Invoke-ReleaseManager {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $common = @(
        "-db", $databasePath,
        "-release-root", $releaseRoot,
        "-notifications-db", $notificationPath
    )
    $output = & $goScript run ./cmd/release-manager @common @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "release-manager failed with exit code $LASTEXITCODE"
    }
    return (($output -join "`n") | ConvertFrom-Json)
}

try {
    New-Item -ItemType Directory -Path $componentRoot -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $componentRoot "web.zip"), "formal-renderer-candidate")
    [System.IO.File]::WriteAllText((Join-Path $componentRoot "portal.zip"), "portal-candidate")

    $manifest = Invoke-ReleaseManager @(
        "-action", "manifest", "-version", $version,
        "-source", $candidateRoot, "-manifest", $manifestPath,
        "-component", "web=components/web.zip",
        "-component", "portal=components/portal.zip"
    )
    if ($manifest.version -ne $version -or $manifest.artifacts.Count -ne 2) {
        throw "release manifest did not contain both candidate components"
    }

    $installed = Invoke-ReleaseManager @(
        "-action", "install", "-manifest", $manifestPath, "-source", $candidateRoot
    )
    if ($installed.state -ne "candidate") {
        throw "release candidate was not installed"
    }

    Invoke-ReleaseManager @("-action", "notify", "-version", $version) | Out-Null
    Invoke-ReleaseManager @(
        "-action", "readiness", "-version", $version,
        "-harness-evidence", "release-drill-harness-ready",
        "-codex-evidence", "release-drill-codex-ready",
        "-kimi-evidence", "release-drill-kimi-ready",
        "-provider-evidence", "release-drill-provider-ready"
    ) | Out-Null

    # Production activation intentionally enforces a real one-minute notice window.
    Start-Sleep -Seconds 61

    $activation = Invoke-ReleaseManager @("-action", "activate", "-version", $version)
    if ($activation.state -ne "committed" -or $activation.id -le 0) {
        throw "release activation journal was not committed"
    }
    $active = Invoke-ReleaseManager @("-action", "status")
    if ($active.web -ne $version -or $active.portal -ne $version) {
        throw "component pointers did not switch to the candidate"
    }
    $installedWeb = Join-Path $releaseRoot "$version\components\web.zip"
    if ([System.IO.File]::ReadAllText($installedWeb) -ne "formal-renderer-candidate") {
        throw "activated immutable artifact content changed"
    }

    $rollback = Invoke-ReleaseManager @(
        "-action", "rollback", "-activation-id", ([string]$activation.id)
    )
    if ($rollback.state -ne "rolled_back") {
        throw "release rollback journal was not committed"
    }
    $activeAfterRollback = Invoke-ReleaseManager @("-action", "status")
    if (@($activeAfterRollback.PSObject.Properties).Count -ne 0) {
        throw "rollback did not restore the previous empty component pointers"
    }

    Write-Output "Release lifecycle smoke passed: manifest, immutable install, notice, readiness, activation, pointer verification, and rollback."
}
finally {
    if (Test-Path -LiteralPath $smokeRoot) {
        $resolvedSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
        $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        if (-not $resolvedSmokeRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not ([System.IO.Path]::GetFileName($resolvedSmokeRoot)).StartsWith("workagent3-release-smoke-", [System.StringComparison]::Ordinal)) {
            throw "Refusing to remove unexpected release smoke directory: $resolvedSmokeRoot"
        }
        Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force
    }
}
