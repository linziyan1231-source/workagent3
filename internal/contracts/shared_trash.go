package contracts

import "time"

// SharedTrashRequest is sent only after Portal checks current project membership.
type SharedTrashRequest struct {
	OwnerSID  string `json:"ownerSID"`
	Operation string `json:"operation"`
	Path      string `json:"path,omitempty"`
	EntryID   string `json:"entryId,omitempty"`
}

type SharedTrashEntry struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Path            string     `json:"path"`
	Kind            string     `json:"kind"`
	Size            int64      `json:"size"`
	DeletedAt       time.Time  `json:"deletedAt"`
	ExpiresAt       time.Time  `json:"expiresAt"`
	Legacy          bool       `json:"legacy,omitempty"`
	LegacyDeletedAt *time.Time `json:"legacyDeletedAt,omitempty"`
}

type SharedTrashList struct {
	Entries          []SharedTrashEntry `json:"entries"`
	UsedBytes        int64              `json:"usedBytes"`
	ProjectUsedBytes int64              `json:"projectUsedBytes"`
	LimitBytes       int64              `json:"limitBytes"`
	RetentionDays    int                `json:"retentionDays"`
}
