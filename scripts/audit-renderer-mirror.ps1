param(
    [string]$Source = 'C:\projects\WorkAgent2\.tools\worktrees\runtime-auth-deploy-ui\packages\desktop\src\renderer',
    [string]$Target = (Join-Path $PSScriptRoot '..\third_party\aionui\packages\desktop\src\renderer'),
    [string]$ExpectedSourceCommit = '0a5e806e9e495323368fb3b5b5f359c5ff8a9f4b',
    [string]$ExpectedSourceBranch = 'codex/dwg-managed-mcp-web77'
)

$ErrorActionPreference = 'Stop'

$allowedDeltas = @(
    'components/base/AionModal.tsx',
    'components/layout/PortalNotificationHost.tsx',
    'pages/admin/index.tsx',
    'pages/admin/types.ts',
    'pages/conversation/Messages/MessageList.tsx',
    'pages/guid/components/GuidActionRow.tsx',
    'services/i18n/locales/en-US/settings.json',
    'services/i18n/locales/zh-CN/settings.json'
)

function Resolve-Tree([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Renderer tree does not exist: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Get-TreeFiles([string]$Root) {
    $files = @{}
    Get-ChildItem -LiteralPath $Root -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
        $files[$relative] = $_.FullName
    }
    return $files
}

function Test-FileContentEqual([string]$Left, [string]$Right) {
    $leftInfo = Get-Item -LiteralPath $Left
    $rightInfo = Get-Item -LiteralPath $Right
    if ($leftInfo.Length -ne $rightInfo.Length) { return $false }

    $leftStream = [IO.File]::OpenRead($Left)
    $rightStream = [IO.File]::OpenRead($Right)
    try {
        $leftBuffer = [byte[]]::new(65536)
        $rightBuffer = [byte[]]::new(65536)
        while (($read = $leftStream.Read($leftBuffer, 0, $leftBuffer.Length)) -gt 0) {
            if ($rightStream.Read($rightBuffer, 0, $rightBuffer.Length) -ne $read) { return $false }
            for ($index = 0; $index -lt $read; $index++) {
                if ($leftBuffer[$index] -ne $rightBuffer[$index]) { return $false }
            }
        }
        return $true
    }
    finally {
        $leftStream.Dispose()
        $rightStream.Dispose()
    }
}

$sourceRoot = Resolve-Tree $Source
$targetRoot = Resolve-Tree $Target
$sourceCommit = (& git -C $sourceRoot rev-parse HEAD 2>$null).Trim()
$sourceBranch = (& git -C $sourceRoot branch --show-current 2>$null).Trim()
$sourceRendererCommit = (& git -C $sourceRoot log -1 --format=%H -- . 2>$null).Trim()
$latestRendererCommit = (& git -C $sourceRoot log --all -1 --format=%H -- . 2>$null).Trim()
$sourceRendererStatus = @(& git -C $sourceRoot status --short -- . 2>$null)
if ($sourceCommit -ne $ExpectedSourceCommit) {
    throw "Renderer source snapshot changed: expected $ExpectedSourceCommit, got $sourceCommit"
}
if ($sourceBranch -ne $ExpectedSourceBranch) {
    throw "Renderer source branch changed: expected $ExpectedSourceBranch, got $sourceBranch"
}
if ($sourceRendererCommit -ne $latestRendererCommit) {
    throw "Renderer source is not the latest local Renderer tree: source $sourceRendererCommit, latest $latestRendererCommit"
}
if ($sourceRendererStatus.Count -ne 0) {
    throw "Renderer source contains uncommitted changes: $($sourceRendererStatus -join ', ')"
}
$sourceFiles = Get-TreeFiles $sourceRoot
$targetFiles = Get-TreeFiles $targetRoot
$relativePaths = @($sourceFiles.Keys + $targetFiles.Keys | Sort-Object -Unique)
$deltas = @()

foreach ($relativePath in $relativePaths) {
    if (-not $sourceFiles.ContainsKey($relativePath)) {
        $deltas += [pscustomobject]@{ path = $relativePath; status = 'target-only' }
    }
    elseif (-not $targetFiles.ContainsKey($relativePath)) {
        $deltas += [pscustomobject]@{ path = $relativePath; status = 'source-only' }
    }
    elseif (-not (Test-FileContentEqual $sourceFiles[$relativePath] $targetFiles[$relativePath])) {
        $deltas += [pscustomobject]@{ path = $relativePath; status = 'modified' }
    }
}

$unexpected = @($deltas | Where-Object { $_.path -notin $allowedDeltas })
$result = [ordered]@{
    source = $sourceRoot
    source_commit = $sourceCommit
    source_branch = $sourceBranch
    source_renderer_commit = $sourceRendererCommit
    latest_local_renderer_commit = $latestRendererCommit
    source_renderer_clean = $true
    target = $targetRoot
    source_file_count = $sourceFiles.Count
    target_file_count = $targetFiles.Count
    allowed_deltas = $allowedDeltas
    observed_deltas = $deltas
    unexpected_deltas = $unexpected
    passed = $unexpected.Count -eq 0
}

$result | ConvertTo-Json -Depth 5
if ($unexpected.Count -ne 0) { exit 1 }
