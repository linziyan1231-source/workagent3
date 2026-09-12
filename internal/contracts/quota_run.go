package contracts

import "errors"

var ErrQuotaRunAccepted = errors.New("accepted quota run awaits runtime completion")

// SharedRunQuotaRequest is produced by Portal from the frozen collaboration
// run. It is never accepted from a browser or runtime credential.
type SharedRunQuotaRequest struct {
	RunID          string
	OwnerSID       string
	PayerSID       string
	ModelID        string
	Engine         string
	EstimatedUnits int64
}

type PendingQuotaRun struct {
	RunID    string
	PayerSID string
	OwnerSID string
	Legacy   bool
}

// SharedRunIdentity is the persisted business authorization used only by the
// trusted Portal recovery coordinator; project membership may since change.
type SharedRunIdentity struct {
	RunID    string
	OwnerSID string
	PayerSID string
	Engine   string
	State    string
}
