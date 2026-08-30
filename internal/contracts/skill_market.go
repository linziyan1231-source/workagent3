package contracts

import "time"

type SkillMarketEntry struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	Version      string    `json:"version"`
	Publisher    Publisher `json:"publisher"`
	UpdatedAt    time.Time `json:"updated_at"`
	ArchiveBytes int64     `json:"archive_bytes"`
	CanDelete    bool      `json:"can_delete"`
}

type Publisher struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}
