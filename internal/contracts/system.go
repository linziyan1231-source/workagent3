package contracts

type BuildInfo struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildTime string `json:"build_time"`
}

type ComponentStatus struct {
	ID      string `json:"id"`
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

type SystemStatus struct {
	Build      BuildInfo         `json:"build"`
	Components []ComponentStatus `json:"components"`
}

type RuntimeRestart struct {
	ReconnectAfterMS int `json:"reconnect_after_ms"`
}
