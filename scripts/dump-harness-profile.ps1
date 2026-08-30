$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$profileHome = Join-Path $repositoryRoot '.cache\dsh-home'
$profileDirectory = Join-Path $profileHome 'profiles\workagent'
$bundleDirectory = Join-Path $profileHome 'harness-bundle'

New-Item -ItemType Directory -Force -Path $profileDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $bundleDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'profiles\workagent\package.json') -Destination $profileDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'profiles\workagent\cordis.patch.yml') -Destination $profileDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'harness-bundle\package.json') -Destination $bundleDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'harness-bundle\cordis.patch.yml') -Destination $bundleDirectory -Force

& pnpm --dir $profileDirectory install --ignore-workspace
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$env:DSH_HOME = $profileHome
& pnpm exec dsh --profile workagent --dump-config
exit $LASTEXITCODE
