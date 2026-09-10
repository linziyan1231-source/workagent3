param(
 [Parameter(Mandatory)][string]$MigrationJournal,
 [Parameter(Mandatory)][string[]]$ReferenceModules,
 [Parameter(Mandatory)][string]$EvidencePath,
 [switch]$Verified,
 [switch]$Apply
)
# Run under the deployment activation lock after authenticated acceptance.
# Only byte-identical software files are removed. Unknown files and links stay.
$ErrorActionPreference='Stop'
$journal=Get-Content -LiteralPath $MigrationJournal -Raw|ConvertFrom-Json
if(-not $Verified -or $journal.phase -notin @('activated','partially-cleaned')){throw 'Verified migration journal required'}
$target=[IO.Path]::GetFullPath((Join-Path (Split-Path $MigrationJournal -Parent) 'node_modules'))
if((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Cleanup target must be an archived ordinary tree'}
foreach($reference in $ReferenceModules){if(-not [IO.Path]::IsPathFullyQualified($reference) -or $reference -eq $target){throw 'Invalid reference root'}}
$typeGate=[string]::Intern('WorkAgent3.VerifiedSoftwareCleanup.TypeInitialization')
[Threading.Monitor]::Enter($typeGate)
try {
if(-not ('VerifiedSoftwareCleanup' -as [type])){
Add-Type @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
public class VerifiedSoftwareResult {
 public long files,bytes; public string[] retained;
}
public static class VerifiedSoftwareCleanup {
 static ConcurrentDictionary<string,Lazy<byte[]>> cache=new ConcurrentDictionary<string,Lazy<byte[]>>(StringComparer.OrdinalIgnoreCase);
 static long cachedBytes;
 static string referenceSet;
 static ConcurrentDictionary<string,Lazy<int[]>> candidates=new ConcurrentDictionary<string,Lazy<int[]>>(StringComparer.OrdinalIgnoreCase);
 static int[] Candidates(string[] references,string relative,string portable,long size){
  var key=size+"\n"+relative+"\n"+portable;
  return candidates.GetOrAdd(key,_=>new Lazy<int[]>(()=>{
   var found=new List<int>();
   for(int i=0;i<references.Length;i++){
    var direct=new FileInfo(Path.Combine(references[i],relative));
    if(direct.Exists&&direct.Length==size)found.Add(i*2);
    if(portable!=relative){var flat=new FileInfo(Path.Combine(references[i],portable));if(flat.Exists&&flat.Length==size)found.Add(i*2+1);}
   }
   return found.ToArray();
  })).Value;
 }
 static bool Equal(string a,string b){
  var x=new FileInfo(a);var y=new FileInfo(b);if(!y.Exists||x.Length!=y.Length)return false;
  if(y.Length<=65536){
   Lazy<byte[]> value;
   if(cache.TryGetValue(b,out value)||Interlocked.Read(ref cachedBytes)<256L*1024*1024){
    value=cache.GetOrAdd(b,path=>new Lazy<byte[]>(()=>{var data=File.ReadAllBytes(path);Interlocked.Add(ref cachedBytes,data.Length);return data;}));
    var expected=value.Value;var actual=File.ReadAllBytes(a);if(actual.Length!=expected.Length)return false;
    for(int i=0;i<actual.Length;i++)if(actual[i]!=expected[i])return false;
    return true;
   }
  }
  using(var f=x.OpenRead())using(var g=y.OpenRead()){
   var p=new byte[65536];var q=new byte[65536];int n;
   while((n=f.Read(p,0,p.Length))>0){int offset=0,k;while(offset<n&&(k=g.Read(q,offset,n-offset))>0)offset+=k;if(offset!=n)return false;for(int i=0;i<n;i++)if(p[i]!=q[i])return false;}
  }return true;
 }
 public static VerifiedSoftwareResult Run(string root,string[] references,bool apply){
  // Hundreds of legacy copies reuse the same immutable reference set. Cache
  // candidate locations, not decisions about file contents; every deletion
  // still requires a fresh byte comparison of the archived file.
  var selected=String.Join("\n",references);
  if(referenceSet!=selected){candidates.Clear();referenceSet=selected;}
  var files=new List<string>();var dirs=new List<string>();var retained=new ConcurrentBag<string>();var todo=new Stack<string>();todo.Push(root);
  while(todo.Count>0){var dir=todo.Pop();dirs.Add(dir);foreach(var entry in new DirectoryInfo(dir).EnumerateFileSystemInfos()){
   if((entry.Attributes&FileAttributes.ReparsePoint)!=0){retained.Add(Path.GetRelativePath(root,entry.FullName));continue;}
   if(entry is DirectoryInfo directory){
    if(directory.GetFileSystemInfos().Length==0){
     var relative=Path.GetRelativePath(root,entry.FullName);bool known=false;
     foreach(var reference in references)if(Directory.Exists(Path.Combine(reference,relative))){known=true;break;}
     if(!known){retained.Add(relative+Path.DirectorySeparatorChar);continue;}
    }
    todo.Push(entry.FullName);
   }else files.Add(entry.FullName);
  }}
  var result=new VerifiedSoftwareResult();
  Parallel.ForEach(files,new ParallelOptions{MaxDegreeOfParallelism=32},file=>{
   var relative=Path.GetRelativePath(root,file);var portable=relative;
   // pnpm's stored package path resolves to that same package in the flat release.
   if(relative.StartsWith(".pnpm"+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)){
    var marker=Path.DirectorySeparatorChar+"node_modules"+Path.DirectorySeparatorChar;
    int index=relative.IndexOf(marker,StringComparison.OrdinalIgnoreCase);
    if(index>=0)portable=relative.Substring(index+marker.Length);
   }
   bool matched=false;
   // Most copies match the selected release. Avoid searching every historical
   // version for those files; use the cached candidate inventory for variants.
   if(Equal(file,Path.Combine(references[0],relative))||(portable!=relative&&Equal(file,Path.Combine(references[0],portable))))matched=true;
   if(!matched)foreach(var index in Candidates(references,relative,portable,new FileInfo(file).Length)){
    if(Equal(file,Path.Combine(references[index/2],index%2==0?relative:portable))){matched=true;break;}
   }
   if(!matched){retained.Add(relative);return;}
   long bytes=new FileInfo(file).Length;if(apply)File.Delete(file);
   Interlocked.Increment(ref result.files);Interlocked.Add(ref result.bytes,bytes);
  });
  if(apply){dirs.Reverse();foreach(var dir in dirs){if(dir==root)continue;if(new DirectoryInfo(dir).GetFileSystemInfos().Length==0)Directory.Delete(dir);}}
  result.retained=retained.ToArray();Array.Sort(result.retained,StringComparer.OrdinalIgnoreCase);return result;
 }
}
'@
}
}finally{[Threading.Monitor]::Exit($typeGate)}
# A partial cleanup rolls back by reference, never by moving the remaining tree.
if($Apply){$journal.phase='partially-cleaned';[IO.File]::WriteAllText($MigrationJournal,($journal|ConvertTo-Json -Depth 10))}
$result=[VerifiedSoftwareCleanup]::Run($target,$ReferenceModules,[bool]$Apply)
if($Apply -and $result.retained.Length -eq 0){
 [IO.Directory]::Delete($target)
 $journal.phase='cleaned';[IO.File]::WriteAllText($MigrationJournal,($journal|ConvertTo-Json -Depth 10))
}
[IO.File]::WriteAllText($EvidencePath,(@{target=$target;references=$ReferenceModules;applied=[bool]$Apply;files=$result.files;bytes=$result.bytes;retained=$result.retained}|ConvertTo-Json -Depth 8))
[pscustomobject]@{files=$result.files;bytes=$result.bytes;retained=$result.retained.Count;applied=[bool]$Apply}
