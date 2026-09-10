package contracts

type StorageLimits struct {
	PersonalBytes int64 `json:"personalBytes"`
	SharedBytes   int64 `json:"sharedBytes"`
}

type StorageQuota struct {
	UsedBytes  int64 `json:"usedBytes"`
	LimitBytes int64 `json:"limitBytes"`
	Hard       bool  `json:"hard"`
	Enabled    bool  `json:"enabled"`
}

type StorageUsage struct {
	Personal StorageQuota `json:"personal"`
	Shared   StorageQuota `json:"shared"`
}
