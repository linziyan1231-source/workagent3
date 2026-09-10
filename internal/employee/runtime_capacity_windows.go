//go:build windows

package employee

import (
	"context"
	"errors"
	"strconv"
)

func (p *WindowsPlatform) checkRuntimeCapacity(ctx context.Context, sid string) error {
	if p.config.MaxRunningRuntimes <= 0 {
		return nil
	}
	if !storageSID.MatchString(sid) {
		return errors.New("invalid runtime SID")
	}
	value, err := runPowerShellQuery(ctx, `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
$service=New-Object -ComObject 'Schedule.Service';$service.Connect();$count=0;$existing=$false
foreach($task in $service.GetFolder('\').GetTasks(0)){
 if($task.Name -like 'WorkAgent3-S-1-*' -and [int]$task.State -eq 4){$count++;if($task.Name -eq $env:WA3_TASK){$existing=$true}}
}
[Console]::WriteLine('`+powerShellResultMarker+`'+[string]($existing -or $count -lt [int]$env:WA3_RUNTIME_LIMIT))`, map[string]string{"WA3_TASK": taskName(sid), "WA3_RUNTIME_LIMIT": strconv.Itoa(p.config.MaxRunningRuntimes)})
	if err != nil {
		return err
	}
	if value != "True" {
		return errors.New("runtime_instance_limit_reached")
	}
	return nil
}
