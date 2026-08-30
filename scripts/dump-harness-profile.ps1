$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$profileHome = Join-Path $repositoryRoot '.cache\dsh-home'
$profileDirectory = Join-Path $profileHome 'profiles\workagent'
$bundleDirectory = Join-Path $profileHome 'harness-bundle'
$contractsDirectory = Join-Path $profileHome 'contracts'
$profileNodeModules = Join-Path $profileDirectory 'node_modules'
$profileLockfile = Join-Path $profileDirectory 'pnpm-lock.yaml'

New-Item -ItemType Directory -Force -Path $profileDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $bundleDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $contractsDirectory | Out-Null
if (Test-Path -LiteralPath $profileNodeModules) {
    Remove-Item -LiteralPath $profileNodeModules -Recurse -Force
}
if (Test-Path -LiteralPath $profileLockfile) {
    Remove-Item -LiteralPath $profileLockfile -Force
}
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'profiles\workagent\package.json') -Destination $profileDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'profiles\workagent\cordis.patch.yml') -Destination $profileDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'harness-bundle\package.json') -Destination $bundleDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'harness-bundle\cordis.patch.yml') -Destination $bundleDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'harness-bundle\dist') -Destination $bundleDirectory -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'packages\contracts\package.json') -Destination $contractsDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'packages\contracts\dist') -Destination $contractsDirectory -Recurse -Force

$contractsArchive = (& pnpm --dir $contractsDirectory pack --pack-destination $profileHome | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or $contractsArchive -eq '') {
    throw 'Failed to pack the WorkAgent contracts'
}

$bundleManifestPath = Join-Path $bundleDirectory 'package.json'
$bundleManifest = Get-Content -Raw -LiteralPath $bundleManifestPath | ConvertFrom-Json
$bundleManifest.dependencies.'@workagent/contracts' = 'file:../../' + (Split-Path -Leaf $contractsArchive)
$bundleManifestJson = $bundleManifest | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText(
    $bundleManifestPath,
    $bundleManifestJson,
    [System.Text.UTF8Encoding]::new($false)
)

$packageArchive = (& pnpm --dir $bundleDirectory pack --pack-destination $profileHome | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or $packageArchive -eq '') {
    throw 'Failed to pack the WorkAgent Harness bundle'
}
$profileManifestPath = Join-Path $profileDirectory 'package.json'
$profileManifest = Get-Content -Raw -LiteralPath $profileManifestPath | ConvertFrom-Json
$profileManifest.dependencies.'@workagent/harness-bundle' = 'file:../../' + (Split-Path -Leaf $packageArchive)
$profileManifest.dependencies | Add-Member -NotePropertyName '@workagent/contracts' -NotePropertyValue ('file:../../' + (Split-Path -Leaf $contractsArchive)) -Force
$profileManifestJson = $profileManifest | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText(
    $profileManifestPath,
    $profileManifestJson,
    [System.Text.UTF8Encoding]::new($false)
)

& pnpm --dir $profileDirectory install --ignore-workspace --force
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$env:DSH_HOME = $profileHome
& pnpm exec dsh --profile workagent --dump-config
exit $LASTEXITCODE
