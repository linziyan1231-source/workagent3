param(
 [Parameter(Mandatory)][ValidateSet('Inspect','Migrate','Clean','Rollback')][string]$Action,
 [Parameter(Mandatory)][string]$PreviousProfile,
 [Parameter(Mandatory)][string]$Profile,
 [Parameter(Mandatory)][string]$Destination,
 [Parameter(Mandatory)][string]$Archive,
 [Parameter(Mandatory)][string]$ReferenceExecutable,
 [switch]$Verified
)
# PowerShell 7. Caller owns the activation lock and has stopped all runtimes.
$ErrorActionPreference='Stop'
foreach($path in @($PreviousProfile,$Profile,$Destination,$Archive,$ReferenceExecutable)) {
 if(-not [IO.Path]::IsPathFullyQualified($path)){throw 'All paths must be absolute'}
}
$Destination=[IO.Path]::GetFullPath($Destination).TrimEnd('\')
$Archive=[IO.Path]::GetFullPath($Archive).TrimEnd('\')
if($Archive.StartsWith($Destination+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Archive cannot be inside employee profile'}
if(Get-Command Get-FsrmQuota -ErrorAction SilentlyContinue){
 foreach($quota in Get-FsrmQuota){
  $quotaRoot=[IO.Path]::GetFullPath($quota.Path).TrimEnd('\')
  if($Archive -eq $quotaRoot -or $Archive.StartsWith($quotaRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Software archive must be outside quota roots'}
 }
}
$modules=Join-Path $Destination 'node_modules'
$saved=Join-Path $Archive 'node_modules'
$journal=Join-Path $Archive 'migration.json'
function Save-Json($path,$value){[IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 10))}
# Unknown or modified files remain data, regardless of directory names.
if(-not ('SoftwareComparison' -as [type])){
Add-Type @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
public class SoftwareInventory {public long files,bytes;public string[] unknown;}
public static class SoftwareComparison {
 public static bool Equal(string a,string b){
  var x=new FileInfo(a);var y=new FileInfo(b);
  if(!y.Exists || x.Length!=y.Length)return false;
  using(var f=x.OpenRead())using(var g=y.OpenRead()){
   var p=new byte[65536];var q=new byte[65536];int n;
   while((n=f.Read(p,0,p.Length))>0){int offset=0,k;while(offset<n&&(k=g.Read(q,offset,n-offset))>0)offset+=k;if(offset!=n)return false;for(int i=0;i<n;i++)if(p[i]!=q[i])return false;}
  }return true;
 }
 public static SoftwareInventory Inspect(string root,string reference){
  var files=new List<string>();var unknown=new ConcurrentBag<string>();var pending=new Stack<string>();pending.Push(root);
  while(pending.Count>0){foreach(var entry in new DirectoryInfo(pending.Pop()).EnumerateFileSystemInfos()){
   var relative=Path.GetRelativePath(root,entry.FullName);var other=Path.Combine(reference,relative);
   if((entry.Attributes&FileAttributes.ReparsePoint)!=0){unknown.Add(relative);}
   else if(entry is DirectoryInfo){if(Directory.Exists(other))pending.Push(entry.FullName);else unknown.Add(relative);}
   else files.Add(entry.FullName);
  }}
  var result=new SoftwareInventory();
  Parallel.ForEach(files,new ParallelOptions{MaxDegreeOfParallelism=8},file=>{
   var relative=Path.GetRelativePath(root,file);
   if(Equal(file,Path.Combine(reference,relative))){Interlocked.Increment(ref result.files);Interlocked.Add(ref result.bytes,new FileInfo(file).Length);}
   else unknown.Add(relative);
  });
  result.unknown=unknown.ToArray();Array.Sort(result.unknown,StringComparer.OrdinalIgnoreCase);return result;
 }
}
'@
}
function Inspect-Tree([string]$tree,[string]$reference){
 $result=[SoftwareComparison]::Inspect($tree,$reference)
 return @{files=$result.files;bytes=$result.bytes;unknown=$result.unknown;matches=($result.unknown.Length -eq 0);reference=$reference}
}
if($Action -eq 'Inspect'){
 Inspect-Tree $modules (Join-Path $PreviousProfile 'node_modules') | ConvertTo-Json -Depth 5
 exit
}
if($Action -eq 'Migrate'){
 if(Test-Path -LiteralPath $Archive){
  $record=Get-Content -LiteralPath $journal -Raw|ConvertFrom-Json
  if($record.phase -ne 'rolled-back' -or (Test-Path -LiteralPath $saved) -or $record.destination -ne $Destination -or $record.profile -ne $Profile -or $record.previous -ne $PreviousProfile){throw 'Archive exists; inspect its interrupted migration journal'}
  # Reuse the inventory only to move a previously rolled-back tree. Cleanup
  # still rechecks every byte before deleting anything.
 }else{
  New-Item -ItemType Directory -Path $Archive | Out-Null
  & icacls.exe $Archive /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if($LASTEXITCODE){throw 'Cannot protect migration archive'}
  $record=@{destination=$Destination;previous=$PreviousProfile;profile=$Profile;phase='prepared';software=$null}
  $entry=Get-Item -LiteralPath $modules -Force
  if(-not ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){
   $record.software=Inspect-Tree $modules (Join-Path $PreviousProfile 'node_modules')
  }
 }
 if(-not [SoftwareComparison]::Equal((Join-Path $Destination 'package.json'),(Join-Path $PreviousProfile 'package.json'))){throw 'Customized manifest: reconcile personal plugins before activation'}
 Copy-Item -LiteralPath (Join-Path $Destination 'package.json') -Destination (Join-Path $Archive 'package.json')
 Save-Json $journal $record
 # Move only dependencies out of the quota; unexpected profile-local data stays.
 [IO.Directory]::Move($modules,$saved)
 $record.phase='archived';Save-Json $journal $record
 # A same-volume move can retain explicit employee ACEs. The archive must
 # inherit only its protected administrator/SYSTEM ACL, including descendants.
 # Existing public-package references are not software copies. Traversing a
 # junction with icacls /T touches its public target and can hit long paths.
 if(-not ((Get-Item -LiteralPath $saved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){
  & icacls.exe $saved /reset /T /C /L | Out-Null
  if($LASTEXITCODE){throw 'Cannot protect archived software permissions'}
 }
 & $ReferenceExecutable -source $PreviousProfile -destination $Destination
 if($LASTEXITCODE){throw 'Previous reference creation failed; use journal rollback'}
 & $ReferenceExecutable -source $Profile -destination $Destination
 if($LASTEXITCODE){throw 'New reference creation failed; use journal rollback'}
 $record.phase='activated';Save-Json $journal $record
 exit
}
$record=Get-Content -LiteralPath $journal -Raw|ConvertFrom-Json
if($record.destination -ne $Destination -or $record.profile -ne $Profile -or $record.previous -ne $PreviousProfile){throw 'Journal path mismatch'}
if($Action -eq 'Clean'){
 if(-not $Verified -or $record.phase -ne 'activated'){throw 'Runtime and browser verification required'}
 if($record.software){
  $check=Inspect-Tree $saved (Join-Path $PreviousProfile 'node_modules')
  Save-Json (Join-Path $Archive 'cleanup-inspection.json') $check
  if(-not $check.matches){throw 'Changed files retained in protected archive; review required'}
 }
 $item=Get-Item -LiteralPath $saved -Force
 if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){[IO.Directory]::Delete($saved)}
 else{[IO.Directory]::Delete($saved,$true)}
 $record.phase='cleaned';Save-Json $journal $record
 exit
}
if($Action -eq 'Rollback'){
 $current=Get-Item -LiteralPath $modules -Force -ErrorAction SilentlyContinue
 if($current){
  if(-not ($current.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Refuse to remove unidentified active tree'}
  [IO.Directory]::Delete($modules)
 }
 Copy-Item -LiteralPath (Join-Path $Archive 'package.json') -Destination (Join-Path $Destination 'package.json') -Force
 if((Test-Path -LiteralPath $saved) -and $record.phase -ne 'partially-cleaned'){[IO.Directory]::Move($saved,$modules)}
 else{
  & $ReferenceExecutable -source $PreviousProfile -destination $Destination
  if($LASTEXITCODE){throw 'Rollback reference failed'}
 }
 $record.phase='rolled-back';Save-Json $journal $record
}
