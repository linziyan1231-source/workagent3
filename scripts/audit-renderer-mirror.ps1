param(
    [string]$Source = 'C:\projects\WorkAgent2\.tools\worktrees\runtime-auth-deploy-ui\packages\desktop\src\renderer',
    [string]$Target = (Join-Path $PSScriptRoot '..\third_party\aionui\packages\desktop\src\renderer')
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
$sourceCommit = (& git -C $sourceRoot rev-parse --short HEAD 2>$null)
$result = [ordered]@{
    source = $sourceRoot
    source_commit = if ($LASTEXITCODE -eq 0) { $sourceCommit.Trim() } else { $null }
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
