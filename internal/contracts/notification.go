package contracts

import (
	"errors"
	"time"
)

var ErrNotificationNotFound = errors.New("notification not found")

// Notification is a user-visible fact owned by the Notifications module.
// DeepLink is always an application-relative path and never contains credentials.
type Notification struct {
	ID             string     `json:"id"`
	Kind           string     `json:"kind"`
	Title          string     `json:"title,omitempty"`
	Message        string     `json:"message"`
	DeepLink       string     `json:"deep_link,omitempty"`
	PublishedAt    time.Time  `json:"published_at"`
	ReadAt         *time.Time `json:"read_at,omitempty"`
	AcknowledgedAt *time.Time `json:"acknowledged_at,omitempty"`
}

type NotificationInput struct {
	TargetSID string
	Kind      string
	Title     string
	Message   string
	DeepLink  string
	ExpiresAt *time.Time
}
