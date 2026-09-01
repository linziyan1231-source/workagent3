$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$testPath = Join-Path $repositoryRoot 'release/managed-skills/pdf/scripts/check_bounding_boxes_test.py'
$python = Get-Command python -ErrorAction SilentlyContinue
if ($null -eq $python) {
    $python = Get-Command py -ErrorAction SilentlyContinue
}
if ($null -eq $python) {
    throw 'PDF Skill requires Python.'
}

& $python.Source $testPath
if ($LASTEXITCODE -ne 0) {
    throw "PDF Skill validator smoke failed with exit code $LASTEXITCODE."
}

Write-Output '{"skill":"pdf","validator":"passed"}'
