param(
 [Parameter(Mandatory)][string]$ReleaseRoot,
 [Parameter(Mandatory)][string]$EmployeeRoot,
 [Parameter(Mandatory)][string[]]$ReferenceFiles,
 [Parameter(Mandatory)][string]$LockPath,
 [Parameter(Mandatory)][string]$EvidencePath,
 [string]$InventoryRoot,
 [int]$RollbackVersions=2,
 [int]$StagingDays=7,
 [switch]$Apply
)
# Only administrator-published, inventoried software releases are eligible.
# Run under the same exclusive lock used by activation, including dry runs.
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
$lock=[IO.File]::Open($LockPath,'OpenOrCreate','ReadWrite','None')
try {
 $references=[Collections.Generic.List[string]]::new()
 foreach($file in $ReferenceFiles){$references.Add([IO.File]::ReadAllText($file))}
 foreach($process in Get-CimInstance Win32_Process){if($process.CommandLine){$references.Add($process.CommandLine)}}
 foreach($task in Get-ScheduledTask){foreach($action in $task.Actions){if($action.Execute){$references.Add($action.Execute)};if($action.Arguments){$references.Add($action.Arguments)}}}
 # Never follow links while discovering references, including inactive profiles.
 $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($EmployeeRoot)
 while($pending.Count){
  foreach($entry in [IO.DirectoryInfo]::new($pending.Pop()).EnumerateFileSystemInfos()){
   if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){$references.Add($entry.ResolveLinkTarget($true).FullName)}
   elseif($entry -is [IO.DirectoryInfo]){$pending.Push($entry.FullName)}
  }
 }
 function Inventory-Path($release){
  $internal=Join-Path $release.FullName 'software-release.json'
  if(Test-Path -LiteralPath $internal){return $internal}
  if($InventoryRoot){return Join-Path $InventoryRoot ($release.Name+'.json')}
  return $internal
 }
 $releases=@(Get-ChildItem -LiteralPath $root -Directory -Force | Where-Object {Test-Path -LiteralPath (Inventory-Path $_)} | Sort-Object LastWriteTimeUtc -Descending)
 $retained=0;$report=@()
 if($Apply -and (Test-Path -LiteralPath $EvidencePath)){
  $report=@(Get-Content -LiteralPath $EvidencePath -Raw|ConvertFrom-Json|Where-Object removed)
 }
 foreach($release in $releases){
  if($release.Parent.FullName -ne $root -or ($release.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Invalid release directory'}
  $manifest=Get-Content -LiteralPath (Inventory-Path $release) -Raw|ConvertFrom-Json
  if($manifest.version -ne $release.Name -or $manifest.kind -ne 'immutable-software'){throw 'Invalid release inventory'}
  $actual=@(Get-ChildItem -LiteralPath $release.FullName -Force | Select-Object -ExpandProperty Name | Sort-Object)
  $expected=@(@($manifest.entries)+@(if(Test-Path -LiteralPath (Join-Path $release.FullName 'software-release.json')){'software-release.json'}) | Sort-Object)
  $unknown=@(Compare-Object $expected $actual)
  $referenced=@($references | Where-Object { $_.IndexOf($release.FullName+'\',[StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.IndexOf($release.FullName.Replace('\','\\')+'\\',[StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0
  $reason='expired';$remove=$true
  if($unknown.Count){$reason='unidentified-content';$remove=$false}
  elseif($referenced){$reason='referenced';$remove=$false}
  elseif($manifest.state -eq 'staging' -and $release.LastWriteTimeUtc -gt [DateTime]::UtcNow.AddDays(-$StagingDays)){$reason='recent-staging';$remove=$false}
  elseif($manifest.state -ne 'staging' -and $retained -lt $RollbackVersions){$retained++;$reason='rollback';$remove=$false}
  $bytes=0L
  if($remove -and $Apply){
   # Metadata accounting only; established software provenance authorizes deletion.
   $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($release.FullName)
   while($pending.Count){foreach($entry in [IO.DirectoryInfo]::new($pending.Pop()).EnumerateFileSystemInfos()){
    if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){continue}
    if($entry -is [IO.DirectoryInfo]){$pending.Push($entry.FullName)}else{$bytes+=$entry.Length}
   }}
   @{path=$release.FullName;bytes=$bytes;phase='deleting'}|ConvertTo-Json|Set-Content ($EvidencePath+'.pending.json')
   [IO.Directory]::Delete($release.FullName,$true)
  }
  $report+=@{path=$release.FullName;reason=$reason;removed=($remove -and $Apply);eligible=$remove;deletedBytes=$(if($remove -and $Apply){$bytes}else{0})}
  if($Apply){[IO.File]::WriteAllText($EvidencePath,($report|ConvertTo-Json -Depth 5))}
 }
 [IO.File]::WriteAllText($EvidencePath,($report|ConvertTo-Json -Depth 5))
 $report|ConvertTo-Json -Depth 5
}finally{$lock.Dispose()}
