param([Parameter(Mandatory)][string]$SettingsPath)
# PowerShell 7, administrator/SYSTEM deployment input kept outside product code.
# Settings: managerPath, expectedRelease, release, lockPath, evidenceRoot,
# archiveRoot, wrappers[], serviceTasks[], employeeSIDs[] (explicit start requests), systemHelperPath,
# healthURL. Candidate must already be complete, immutable and Users RX.
$ErrorActionPreference='Stop'
$s=Get-Content -LiteralPath $SettingsPath -Raw|ConvertFrom-Json
. $s.systemHelperPath
$lock=[IO.File]::Open($s.lockPath,'OpenOrCreate','ReadWrite','None')
function Write-Json($path,$value){[IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 50))}
function Pause-Runtimes {
 foreach($task in $s.serviceTasks){Stop-ScheduledTask -TaskName $task}
 foreach($sid in $s.employeeSIDs){Stop-ScheduledTask -TaskName "WorkAgent3-$sid"}
 foreach($process in Get-CimInstance Win32_Process){
  if($process.ExecutablePath -and $process.Name -in @('portal.exe','employee-manager.exe','userhost.exe') -and ($process.ExecutablePath.StartsWith($s.expectedRelease+'\',[StringComparison]::OrdinalIgnoreCase) -or $process.ExecutablePath.StartsWith($s.release+'\',[StringComparison]::OrdinalIgnoreCase))){
   try{Stop-Process -Id $process.ProcessId -Force}catch{
    # Stopping the wrapper can finish a process after the CIM snapshot.
    if(Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue){throw}
   }
  }
 }
 Start-Sleep -Seconds 2
}
function Start-Runtimes {
 foreach($task in $s.serviceTasks){Start-ScheduledTask -TaskName $task}
 foreach($sid in $restartSIDs){if((Start-UserhostViaSystem $sid) -notmatch 'START_OK'){throw "Employee start failed: $sid"}}
}
try {
 $manager=Get-Content -LiteralPath $s.managerPath -Raw|ConvertFrom-Json
 # Update every configured employee, including idle accounts created after the
 # settings file. Preserve on-demand startup for those that were not running.
 $configuredSIDs=@(Get-ChildItem -LiteralPath $manager.dataRootBase -Directory | Where-Object { $_.Name -like 'S-1-*' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'runtime\userhost.json')) } | Select-Object -ExpandProperty Name)
 $runningHosts=@(Get-CimInstance Win32_Process | Where-Object Name -eq 'userhost.exe')
 $runningSIDs=@($configuredSIDs | Where-Object { $config=Join-Path $manager.dataRootBase "$_\runtime\userhost.json"; @($runningHosts | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($config,[StringComparison]::OrdinalIgnoreCase) }).Count -gt 0 })
 $restartSIDs=@(@($s.employeeSIDs)+$runningSIDs | Sort-Object -Unique)
 $s.employeeSIDs=@($configuredSIDs+@($s.employeeSIDs) | Sort-Object -Unique)
 $previousProfile=Join-Path $s.expectedRelease 'profiles\workagent'
 $profile=Join-Path $s.release 'profiles\workagent'
 if($manager.harnessProfileSource -ne $previousProfile){throw 'Active release changed; rebase candidate'}
 foreach($name in @('portal.exe','userhost.exe','employee-manager.exe','profile-reference.exe','web','profiles\workagent\node_modules')){
  if(-not(Test-Path -LiteralPath (Join-Path $s.release $name))){throw "Incomplete release: $name"}
 }
 # Credential journals are checked without printing their decrypted contents.
 if([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne 'S-1-5-18'){throw 'Activation requires SYSTEM for credential-journal checks'}
 Add-Type -AssemblyName System.Security
 foreach($sid in $s.employeeSIDs){
  $plain=$null
  try{
   $sealed=[IO.File]::ReadAllBytes((Join-Path $manager.credentialRoot ($sid.ToLowerInvariant()+'.sealed')))
   $plain=[Security.Cryptography.ProtectedData]::Unprotect($sealed,[Text.Encoding]::UTF8.GetBytes('WorkAgent3-CredentialBroker-v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
   $credential=[Text.Encoding]::UTF8.GetString($plain)|ConvertFrom-Json
   if($credential.phase -or $credential.pending -or $credential.sid -ne $sid){throw 'Finish pending Windows credential maintenance first'}
  }finally{if($plain){[Array]::Clear($plain,0,$plain.Length)};$credential=$null}
 }
 $backup=Join-Path $s.evidenceRoot 'rollback'
 if(Test-Path -LiteralPath $backup){throw 'Activation journal exists; inspect before retry'}
 New-Item -ItemType Directory -Path $backup -Force|Out-Null
 Copy-Item -LiteralPath $s.managerPath -Destination (Join-Path $backup 'manager.json')
 foreach($wrapper in $s.wrappers){Copy-Item -LiteralPath $wrapper -Destination (Join-Path $backup (Split-Path $wrapper -Leaf))}
 foreach($sid in $s.employeeSIDs){
  Copy-Item -LiteralPath (Join-Path $manager.dataRootBase "$sid\runtime\userhost.json") -Destination (Join-Path $backup "$sid.json")
  Copy-Item -LiteralPath (Join-Path $manager.launchManifestRoot "$sid.json") -Destination (Join-Path $backup "$sid-launch.json")
 }
 Pause-Runtimes
 try {
  foreach($sid in $s.employeeSIDs){
   $destination=Join-Path $manager.dataRootBase "$sid\dsh-home\profiles\$($manager.profile)"
   & "$PSScriptRoot\migrate-shared-profile.ps1" -Action Migrate -PreviousProfile $previousProfile -Profile $profile -Destination $destination -Archive (Join-Path $s.archiveRoot $sid) -ReferenceExecutable (Join-Path $s.release 'profile-reference.exe')
   $path=Join-Path $manager.dataRootBase "$sid\runtime\userhost.json"
   $runtime=([IO.File]::ReadAllText($path).Replace($s.expectedRelease.Replace('\','\\'),$s.release.Replace('\','\\'))|ConvertFrom-Json)
   $runtime.harnessArguments[0]=Join-Path $profile $manager.harnessEntrypoint
   Write-Json $path $runtime
   $launch=Join-Path $manager.launchManifestRoot "$sid.json"
   $manifest=Get-Content -LiteralPath $launch -Raw|ConvertFrom-Json
   $manifest.executable=Join-Path $s.release 'userhost.exe';Write-Json $launch $manifest
  }
  foreach($wrapper in $s.wrappers){[IO.File]::WriteAllText($wrapper,[IO.File]::ReadAllText($wrapper).Replace($s.expectedRelease,$s.release))}
  [IO.File]::WriteAllText($s.managerPath,[IO.File]::ReadAllText($s.managerPath).Replace($s.expectedRelease.Replace('\','\\'),$s.release.Replace('\','\\')))
  Start-Runtimes
  $deadline=[DateTime]::UtcNow.AddSeconds(150)
  do{
   $ready=$false
   try{
    $ready=(Invoke-RestMethod $s.healthURL -TimeoutSec 5).status -eq 'healthy'
    foreach($sid in $restartSIDs){
     $token=[IO.File]::ReadAllText((Join-Path $manager.dataRootBase "$sid\runtime\portal-registration.token")).Trim()
     $uri=([Uri]$s.healthURL).GetLeftPart([UriPartial]::Authority)+"/internal/runtime/lease?sid=$sid"
     if((Invoke-WebRequest $uri -Headers @{Authorization="Bearer $token"} -TimeoutSec 5).StatusCode -ne 204){$ready=$false}
    }
   }catch{$ready=$false}finally{$token=$null}
   if(-not $ready){Start-Sleep -Seconds 2}
  }while(-not $ready -and [DateTime]::UtcNow -lt $deadline)
  if(-not $ready){throw 'Runtime health failed'}
  foreach($sid in $s.employeeSIDs){
   & $manager.harnessCommand "$PSScriptRoot\verify-profile-reference.mjs" (Join-Path $manager.dataRootBase "$sid\dsh-home\profiles\$($manager.profile)") $profile
   if($LASTEXITCODE){throw 'Employee packages do not resolve to selected public release'}
  }
  $processes=@(Get-CimInstance Win32_Process|Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($s.release+'\',[StringComparison]::OrdinalIgnoreCase)}|Select-Object Name,ProcessId,CommandLine)
  foreach($name in @('portal.exe','employee-manager.exe')){if(@($processes|Where-Object Name -eq $name).Count -ne 1){throw "Missing new process: $name"}}
  foreach($hostProcess in Get-CimInstance Win32_Process | Where-Object Name -eq 'userhost.exe'){
   foreach($sid in $s.employeeSIDs){
    $config=Join-Path $manager.dataRootBase "$sid\runtime\userhost.json"
    if($hostProcess.CommandLine -and $hostProcess.CommandLine.Contains($config,[StringComparison]::OrdinalIgnoreCase) -and $hostProcess.ExecutablePath -ne (Join-Path $s.release 'userhost.exe')){throw "UserHost release mismatch: $sid"}
   }
  }
  if(@($processes|Where-Object Name -eq 'userhost.exe').Count -lt $restartSIDs.Count){throw 'Expected employee runtime missing'}
  Write-Json (Join-Path $s.evidenceRoot 'activation.json') @{release=$s.release;processes=$processes;health='healthy';browserAcceptance='pending'}
 }catch{
  $failure=$_;Pause-Runtimes
  foreach($sid in $s.employeeSIDs){
   $archive=Join-Path $s.archiveRoot $sid
   $journal=Join-Path $archive 'migration.json'
   if((Test-Path -LiteralPath $journal) -and (Get-Content -LiteralPath $journal -Raw|ConvertFrom-Json).phase -in @('archived','activated')){
    & "$PSScriptRoot\migrate-shared-profile.ps1" -Action Rollback -PreviousProfile $previousProfile -Profile $profile -Destination (Join-Path $manager.dataRootBase "$sid\dsh-home\profiles\$($manager.profile)") -Archive $archive -ReferenceExecutable (Join-Path $s.release 'profile-reference.exe')
   }
   Copy-Item -LiteralPath (Join-Path $backup "$sid.json") -Destination (Join-Path $manager.dataRootBase "$sid\runtime\userhost.json") -Force
   Copy-Item -LiteralPath (Join-Path $backup "$sid-launch.json") -Destination (Join-Path $manager.launchManifestRoot "$sid.json") -Force
  }
  Copy-Item -LiteralPath (Join-Path $backup 'manager.json') -Destination $s.managerPath -Force
  foreach($wrapper in $s.wrappers){Copy-Item -LiteralPath (Join-Path $backup (Split-Path $wrapper -Leaf)) -Destination $wrapper -Force}
  Start-Runtimes;throw $failure
 }
}finally{$lock.Dispose()}
