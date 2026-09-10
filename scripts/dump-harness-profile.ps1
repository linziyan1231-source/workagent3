param(
    [string]$DestinationHome
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$profileHome = if ([string]::IsNullOrWhiteSpace($DestinationHome)) {
    Join-Path $repositoryRoot '.cache\dsh-home'
} else {
    [System.IO.Path]::GetFullPath($DestinationHome)
}
$profileDirectory = Join-Path $profileHome 'profiles\workagent'
$bundleDirectory = Join-Path $profileHome 'harness-bundle'
$contractsDirectory = Join-Path $profileHome 'contracts'
$clientDirectory = Join-Path $profileHome 'dsh-client-workagent'
$appearanceDirectory = Join-Path $profileHome 'dsh-client-appearance'
$profileNodeModules = Join-Path $profileDirectory 'node_modules'
$profileLockfile = Join-Path $profileDirectory 'pnpm-lock.yaml'

& pnpm --dir (Join-Path $repositoryRoot 'packages\dsh-client-workagent') build
if ($LASTEXITCODE -ne 0) { throw 'Failed to build the WorkAgent client' }

New-Item -ItemType Directory -Force -Path $profileDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $bundleDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $contractsDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $clientDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $appearanceDirectory | Out-Null
if (Test-Path -LiteralPath $profileNodeModules) {
    if ((Split-Path -Parent ([IO.Path]::GetFullPath($profileNodeModules))) -ne [IO.Path]::GetFullPath($profileDirectory)) { throw 'Profile dependency path escaped the intended profile' }
    Remove-Item -LiteralPath $profileNodeModules -Recurse -Force
}
if (Test-Path -LiteralPath $profileLockfile) {
    Remove-Item -LiteralPath $profileLockfile -Force
}
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'profiles\workagent\package.json') -Destination $profileDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'profiles\workagent\cordis.patch.yml') -Destination $profileDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'profiles\workagent\pnpm-workspace.yaml') -Destination $profileDirectory -Force
New-Item -ItemType Directory -Force -Path (Join-Path $profileDirectory 'patches') | Out-Null
Copy-Item -Path (Join-Path $repositoryRoot 'patches\*.patch') -Destination (Join-Path $profileDirectory 'patches') -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'harness-bundle\package.json') -Destination $bundleDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'harness-bundle\cordis.patch.yml') -Destination $bundleDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'harness-bundle\dist') -Destination $bundleDirectory -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'packages\contracts\package.json') -Destination $contractsDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'packages\contracts\dist') -Destination $contractsDirectory -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'packages\dsh-client-workagent\package.json') -Destination $clientDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'packages\dsh-client-workagent\index.js') -Destination $clientDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'packages\dsh-client-workagent\client.js') -Destination $clientDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'packages\dsh-client-workagent\tokens.css') -Destination $clientDirectory -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'packages\dsh-client-workagent\document-preview.html') -Destination $clientDirectory -Force
foreach ($file in @('package.json', 'index.js', 'client.js', 'tokens.css')) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot "packages\dsh-client-appearance\$file") -Destination $appearanceDirectory -Force
}

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
$clientArchive = (& pnpm --dir $clientDirectory pack --pack-destination $profileHome | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or $clientArchive -eq '') {
    throw 'Failed to pack the WorkAgent dsh client'
}
$profileManifestPath = Join-Path $profileDirectory 'package.json'
$appearanceArchive = (& pnpm --dir $appearanceDirectory pack --pack-destination $profileHome | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or $appearanceArchive -eq '') {
    throw 'Failed to pack the WorkAgent appearance plugin'
}
$profileManifest = Get-Content -Raw -LiteralPath $profileManifestPath | ConvertFrom-Json
$profileManifest.dependencies.'@workagent/harness-bundle' = 'file:../../' + (Split-Path -Leaf $packageArchive)
$profileManifest.dependencies.'@workagent/dsh-client' = 'file:../../' + (Split-Path -Leaf $clientArchive)
$profileManifest.dependencies.'@workagent/dsh-appearance' = 'file:../../' + (Split-Path -Leaf $appearanceArchive)
$profileManifest.dependencies | Add-Member -NotePropertyName '@workagent/contracts' -NotePropertyValue ('file:../../' + (Split-Path -Leaf $contractsArchive)) -Force
$profileManifestJson = $profileManifest | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText(
    $profileManifestPath,
    $profileManifestJson,
    [System.Text.UTF8Encoding]::new($false)
)

& pnpm --dir $profileDirectory install --force
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$env:DSH_HOME = $profileHome
& pnpm exec dsh --profile workagent --dump-config
exit $LASTEXITCODE
