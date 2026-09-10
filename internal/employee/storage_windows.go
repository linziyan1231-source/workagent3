//go:build windows

package employee

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"regexp"
	"strconv"

	"workagent3/internal/contracts"
)

var storageSID = regexp.MustCompile(`^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$`)

const storageScript = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
Import-Module FileServerResourceManager -ErrorAction Stop
function Read-Quota([string]$path, [string]$limit) {
  $directory=Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if(-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Storage quota root must be a normal directory'}
  $quota=Get-FsrmQuota -Path $path -ErrorAction SilentlyContinue
  if($limit -and ($env:WA3_QUOTA_MODE -eq 'set' -or -not $quota)) {
    if($quota){ Set-FsrmQuota -Path $path -Size ([Int64]$limit) -SoftLimit:$false -Disabled:$false -ErrorAction Stop | Out-Null }
    else { New-FsrmQuota -Path $path -Size ([Int64]$limit) -Description 'WorkAgent storage hard quota' -ErrorAction Stop | Out-Null }
    $quota=Get-FsrmQuota -Path $path -ErrorAction Stop
    if($quota.SoftLimit -or $quota.Disabled -or [Int64]$quota.Size -ne [Int64]$limit){throw 'Storage hard quota verification failed'}
  }
  if(-not $quota){return @{usedBytes=0;limitBytes=0;hard=$false;enabled=$false}}
  return @{usedBytes=[Int64]$quota.Usage;limitBytes=[Int64]$quota.Size;hard=(-not $quota.SoftLimit);enabled=(-not $quota.Disabled)}
}
$personal=Read-Quota $env:WA3_PERSONAL_ROOT $env:WA3_PERSONAL_LIMIT
$shared=Read-Quota $env:WA3_SHARED_ROOT $env:WA3_SHARED_LIMIT
`

func (p *WindowsPlatform) storage(ctx context.Context, sid string, limits *contracts.StorageLimits, mode string) (contracts.StorageUsage, error) {
	var result contracts.StorageUsage
	if !storageSID.MatchString(sid) {
		return result, errors.New("invalid storage SID")
	}
	values := map[string]string{"WA3_PERSONAL_ROOT": filepath.Join(p.config.DataRootBase, sid), "WA3_SHARED_ROOT": filepath.Join(p.config.DataRootBase, "shared", sid), "WA3_QUOTA_MODE": mode}
	if limits != nil {
		if limits.PersonalBytes < 1024*1024 || limits.SharedBytes < 1024*1024 || limits.PersonalBytes > 1024*1024*1024*1024*100 || limits.SharedBytes > 1024*1024*1024*1024*100 {
			return result, errors.New("storage limits must be between 1 MiB and 100 TiB")
		}
		values["WA3_PERSONAL_LIMIT"] = strconv.FormatInt(limits.PersonalBytes, 10)
		values["WA3_SHARED_LIMIT"] = strconv.FormatInt(limits.SharedBytes, 10)
	}
	output, err := runPowerShellQuery(ctx, storageScript+`[Console]::WriteLine('`+powerShellResultMarker+`'+(@{personal=$personal;shared=$shared}|ConvertTo-Json -Compress -Depth 4))`, values)
	if err != nil {
		return result, err
	}
	err = json.Unmarshal([]byte(output), &result)
	return result, err
}

func (p *WindowsPlatform) StorageUsage(ctx context.Context, sid string) (contracts.StorageUsage, error) {
	return p.storage(ctx, sid, nil, "")
}
func (p *WindowsPlatform) SetStorageLimits(ctx context.Context, sid string, limits contracts.StorageLimits) (contracts.StorageUsage, error) {
	return p.storage(ctx, sid, &limits, "set")
}
func (p *WindowsPlatform) ensureStorageLimits(ctx context.Context, sid string) error {
	if p.config.StorageLimits == nil {
		return nil
	}
	_, err := p.storage(ctx, sid, p.config.StorageLimits, "ensure")
	return err
}
