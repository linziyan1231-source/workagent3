param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$GoArgs
)

$ErrorActionPreference = 'Stop'
$command = Get-Command go -ErrorAction SilentlyContinue
if ($null -ne $command) {
    & $command.Source @GoArgs
    exit $LASTEXITCODE
}

$portableGo = 'C:\Users\Administrator\.codex\tools\go1.26.5-verified\go\bin\go.exe'
if (-not (Test-Path -LiteralPath $portableGo)) {
    throw 'Go 1.26 or newer is required. Install Go or provide it on PATH.'
}

& $portableGo @GoArgs
exit $LASTEXITCODE

