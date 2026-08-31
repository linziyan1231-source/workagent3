package buildinfo

import "workagent3/internal/contracts"

// These values are overridden by release builds through -ldflags.
var (
	Version   = "dev"
	Commit    = "unknown"
	BuildTime = "unknown"
)

func Current() contracts.BuildInfo {
	return contracts.BuildInfo{Version: Version, Commit: Commit, BuildTime: BuildTime}
}
