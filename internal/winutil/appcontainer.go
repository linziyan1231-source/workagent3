package winutil

import (
	"errors"
	"regexp"
)

var appIdentity = regexp.MustCompile(`^[A-Za-z0-9_-]{24}$`)

func AppContainerName(appID, version string) (string, error) {
	if !appIdentity.MatchString(appID) || !appIdentity.MatchString(version) {
		return "", errors.New("invalid published application identity")
	}
	return "WorkAgent3." + appID + "." + version, nil
}

type AppNetworkRule struct {
	AppID       string `json:"appId"`
	Version     string `json:"version"`
	BackendPort int    `json:"backendPort"`
	BrokerPort  int    `json:"brokerPort"`
}

type AppProcessOptions struct {
	Executable  string
	Arguments   []string
	Directory   string
	Environment []string
	PackageSID  string
	LogPath     string
	OwnerJob    *Job
}
