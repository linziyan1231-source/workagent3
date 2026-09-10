param(
 [Parameter(Mandatory)][string]$StageDirectory,
 [Parameter(Mandatory)][string]$ReleaseRoot,
 [Parameter(Mandatory)][string]$EmployeeRoot,
 [Parameter(Mandatory)][string]$Version,
 [Parameter(Mandatory)][string]$LockPath
)
# Assemble the complete software once in StageDirectory before calling this.
# This script seals and moves it; it never creates per-employee software copies.
$ErrorActionPreference='Stop'
if($Version -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]+$'){throw 'Invalid version'}
$stage=[IO.Path]::GetFullPath($StageDirectory).TrimEnd('\')
$root=[IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
$employees=[IO.Path]::GetFullPath($EmployeeRoot).TrimEnd('\')
$target=Join-Path $root $Version
foreach($path in @($stage,$root)){
 if($path -eq $employees -or $path.StartsWith($employees+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Software/staging cannot be inside personal or shared quota storage'}
}
$lock=[IO.File]::Open($LockPath,'OpenOrCreate','ReadWrite','None')
try{
 if(Test-Path -LiteralPath $target){throw 'Immutable release already exists'}
 if((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Release root must be a normal directory'}
 & icacls.exe $root /reset | Out-Null
 if($LASTEXITCODE){throw 'Release directory ACL reset failed'}
 & icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
 if($LASTEXITCODE){throw 'Release directory ACL failed'}
 if((Get-Item -LiteralPath $stage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Staging root must be a normal directory'}
 foreach($name in @('portal.exe','userhost.exe','employee-manager.exe','profile-reference.exe','web','profiles\workagent\node_modules','profiles\workagent\package.json')){
  if(-not(Test-Path -LiteralPath (Join-Path $stage $name))){throw "Incomplete software release: $name"}
 }
 $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($stage)
 while($pending.Count){
  foreach($entry in [IO.DirectoryInfo]::new($pending.Pop()).EnumerateFileSystemInfos()){
   if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){
    if([IO.Path]::IsPathFullyQualified($entry.LinkTarget) -or -not $entry.ResolveLinkTarget($true).FullName.StartsWith($stage+'\',[StringComparison]::OrdinalIgnoreCase)){throw "Nonportable software link: $($entry.FullName)"}
   }elseif($entry -is [IO.DirectoryInfo]){$pending.Push($entry.FullName)}
  }
 }
 $manifest=Join-Path $stage 'software-release.json'
 if(Test-Path -LiteralPath $manifest){throw 'Stage already has a release identity'}
 $entries=@(Get-ChildItem -LiteralPath $stage -Force|Select-Object -ExpandProperty Name)
 [IO.File]::WriteAllText($manifest,(@{kind='immutable-software';version=$Version;state='published';entries=$entries}|ConvertTo-Json -Depth 5))
 & icacls.exe $stage /reset | Out-Null
 if($LASTEXITCODE){throw 'Software root ACL reset failed'}
 & icacls.exe $stage /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
 if($LASTEXITCODE){throw 'Software root ACL failed'}
 & icacls.exe "$stage\*" /reset /T /C /L | Out-Null
 if($LASTEXITCODE){throw 'Software descendant ACL failed'}
 # Move on the same volume: no copy fallback, no active version overwrite.
 [IO.Directory]::Move($stage,$target)
 $target
}finally{$lock.Dispose()}
