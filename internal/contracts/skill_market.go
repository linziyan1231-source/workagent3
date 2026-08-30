package contracts

import (
	"errors"
	"time"
)

var ErrSkillMarketEntryNotFound = errors.New("skill market entry not found")
var ErrSkillMarketForbidden = errors.New("skill market operation forbidden")

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

// SkillMarketPackage is an internal Portal-to-UserHost transfer object. It is
// never serialized to the browser-facing market catalog.
type SkillMarketPackage struct {
	ID          string
	Name        string
	Description string
	Version     string
	Archive     []byte
}
