package contracts

// AdminMigrationItem is one journaled Skill/MCP migration result awaiting
// administrator disposition (W14). ID is an opaque composite token the
// browser echoes back to the disposition endpoints; it binds the item to its
// owning runtime (SID), journal kind and source ID.
type AdminMigrationItem struct {
	ID       string `json:"id"`
	SID      string `json:"sid"`
	Username string `json:"username"`
	SourceID string `json:"source_id"`
	TargetID string `json:"target_id,omitempty"`
	Kind     string `json:"kind"`
	Status   string `json:"status"`
	Reason   string `json:"reason,omitempty"`
}

// MigrationDispositionJob tracks an asynchronous administrator disposition
// (retry re-projection). It mirrors the EmployeeProvisionJob polling shape:
// POST returns 202 with the job, the browser polls until status is terminal.
type MigrationDispositionJob struct {
	ID           string              `json:"id"`
	Status       string              `json:"status"`
	Percent      int                 `json:"percent"`
	Step         string              `json:"step"`
	ErrorCode    string              `json:"error_code,omitempty"`
	ErrorMessage string              `json:"error_message,omitempty"`
	Item         *AdminMigrationItem `json:"item,omitempty"`
}
