$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$toolPath = Join-Path $repositoryRoot "release/managed-skills/llm-wiki/scripts/wiki_tool.py"
$pythonCommand = Get-Command python -CommandType Application -ErrorAction Stop | Select-Object -First 1
$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("workagent3-wiki-smoke-" + [guid]::NewGuid().ToString("N"))

function Invoke-WikiTool {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $output = & $pythonCommand.Source $toolPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "wiki_tool.py failed with exit code $LASTEXITCODE"
    }
    return (($output -join "`n") | ConvertFrom-Json)
}

try {
    New-Item -ItemType Directory -Path $smokeRoot | Out-Null

    $preview = Invoke-WikiTool @("init", "--root", $smokeRoot, "--json")
    if ($preview.applied -ne $false -or $preview.workspace_state -ne "new" -or $preview.actions.Count -eq 0) {
        throw "Wiki initialization preview did not describe a new workspace"
    }

    $initialization = Invoke-WikiTool @("init", "--root", $smokeRoot, "--apply", "--json")
    if ($initialization.applied -ne $true -or -not (Test-Path -LiteralPath (Join-Path $smokeRoot "wiki-llm/index.md"))) {
        throw "Wiki initialization did not create the expected workspace"
    }

    $status = Invoke-WikiTool @("status", "--root", $smokeRoot, "--json")
    if ($status.schema -ne "llm-wiki.status.v1" -or $status.structural_issues.Count -ne 0) {
        throw "Fresh Wiki workspace status is not healthy"
    }

    $lint = Invoke-WikiTool @("lint", "--root", $smokeRoot, "--json")
    if ($lint.schema -ne "llm-wiki.lint.v1" -or $lint.summary.error -ne 0 -or $lint.summary.warning -ne 0) {
        throw "Fresh Wiki workspace failed structural lint"
    }

    $lock = Invoke-WikiTool @("lock", "acquire", "--root", $smokeRoot, "--run-id", "smoke", "--json")
    if ($lock.acquired -ne $true -or $lock.run_id -ne "smoke") {
        throw "Wiki project lease was not acquired"
    }

    $snapshot = Invoke-WikiTool @("snapshot", "--root", $smokeRoot, "--run-id", "smoke", "--paths", "wiki-llm/index.md", "--json")
    if ($snapshot.paths.'wiki-llm/index.md'.exists -ne $true) {
        throw "Wiki preimage snapshot did not capture the initialized index"
    }

    $release = Invoke-WikiTool @("lock", "release", "--root", $smokeRoot, "--run-id", "smoke", "--json")
    if ($release.released -ne $true) {
        throw "Wiki project lease was not released"
    }

    Write-Output "Managed Skill smoke passed: Wiki init, status, lint, snapshot, and lease lifecycle."
}
finally {
    if (Test-Path -LiteralPath $smokeRoot) {
        $resolvedSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
        $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        if (-not $resolvedSmokeRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not ([System.IO.Path]::GetFileName($resolvedSmokeRoot)).StartsWith("workagent3-wiki-smoke-", [System.StringComparison]::Ordinal)) {
            throw "Refusing to remove unexpected smoke directory: $resolvedSmokeRoot"
        }
        Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force
    }
}
