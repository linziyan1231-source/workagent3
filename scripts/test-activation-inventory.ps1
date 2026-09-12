$ErrorActionPreference='Stop'
# Exercise the real activation preflight, stopping at the expected-release gate
# before credential access, service control or any production mutation.
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('wa3-activation-inventory-'+[Guid]::NewGuid())
New-Item -ItemType Directory -Path $fixture|Out-Null
$employees=Join-Path $fixture 'employees'
foreach($sid in @('S-1-1','S-1-2','S-1-3','S-1-4')){
 $runtime=Join-Path $employees "$sid\runtime"
 New-Item -ItemType Directory -Path $runtime -Force|Out-Null
 '{}'|Set-Content (Join-Path $runtime 'userhost.json')
}
$inventoryRunningConfig=Join-Path $employees 'S-1-3\runtime\userhost.json'
$helper=Join-Path $fixture 'system-helper.ps1'
'function Get-CimInstance { [pscustomobject]@{Name="userhost.exe";CommandLine="userhost.exe --config $inventoryRunningConfig"} }'|Set-Content $helper
$managerPath=Join-Path $fixture 'manager.json'
@{dataRootBase=$employees;harnessProfileSource='intentionally-changed'}|ConvertTo-Json|Set-Content $managerPath
$settingsPath=Join-Path $fixture 'settings.json'
@{managerPath=$managerPath;systemHelperPath=$helper;lockPath=(Join-Path $fixture 'activation.lock');employeeSIDs=@('S-1-1','S-1-2');expectedRelease=(Join-Path $fixture 'old');release=(Join-Path $fixture 'new')}|ConvertTo-Json|Set-Content $settingsPath
try{
 $stopped=$false
 try{ . "$PSScriptRoot\activate-shared-release.ps1" -SettingsPath $settingsPath }catch{
  if($_.Exception.Message -ne 'Active release changed; rebase candidate'){throw}
  $stopped=$true
 }
 if(-not $stopped){throw 'Expected preflight boundary was not reached'}
 if(($s.employeeSIDs -join ',') -ne 'S-1-1,S-1-2,S-1-3,S-1-4'){throw 'A configured employee was omitted from activation'}
 if(($restartSIDs -join ',') -ne 'S-1-1,S-1-2,S-1-3'){throw 'Running/new or idle employee startup policy is incorrect'}
 'PASS: discovers newly provisioned running and idle accounts; preserves on-demand startup'
}finally{
 # The target is the explicit, newly-created test directory above.
 Remove-Item -LiteralPath $fixture -Recurse -Force
}
