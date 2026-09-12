package credentialbroker

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// recoveryRecord retains the original Windows maintenance backup format. The
// caller must seal the returned snapshot and clear its plaintext after use.
type recoveryRecord struct {
	ID     string
	Secret []byte
}

func clearRecovery(records []recoveryRecord) {
	for _, record := range records {
		clear(record.Secret)
	}
}

// ExportRecovery is an offline operation: the lifecycle owner stops writers
// before calling it. Protector controls the Windows identity used for DPAPI;
// the broker owns both the stored ciphertext and the recovery representation.
func ExportRecovery(ctx context.Context, path string, protector Protector) ([]byte, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return []byte("[]"), nil
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx, "SELECT id,sealed_value FROM credentials WHERE length(sealed_value)>0 ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []recoveryRecord{}
	defer func() { clearRecovery(records) }()
	for rows.Next() {
		var id string
		var sealed []byte
		if err := rows.Scan(&id, &sealed); err != nil {
			return nil, err
		}
		plain, err := protector.Open(sealed)
		clear(sealed)
		if err != nil {
			return nil, fmt.Errorf("credential migration preflight cannot decrypt broker record: %w", err)
		}
		records = append(records, recoveryRecord{id, plain})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return json.Marshal(records)
}

// RecoveryCount inspects an exported snapshot without exposing its format to
// employee lifecycle code.
func RecoveryCount(snapshot []byte) (int, error) {
	var records []recoveryRecord
	err := json.Unmarshal(snapshot, &records)
	defer clearRecovery(records)
	return len(records), err
}

// RestoreRecovery reseals existing records without changing their metadata.
// A missing row or failed protector rolls back the entire recovery.
func RestoreRecovery(ctx context.Context, path string, protector Protector, snapshot []byte) error {
	var records []recoveryRecord
	if err := json.Unmarshal(snapshot, &records); err != nil {
		clearRecovery(records)
		return err
	}
	defer clearRecovery(records)
	if len(records) == 0 {
		return nil
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, record := range records {
		sealed, err := protector.Seal(record.Secret)
		if err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, "UPDATE credentials SET sealed_value=? WHERE id=?", sealed, record.ID)
		clear(sealed)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return errors.New("broker record disappeared during migration")
		}
	}
	return tx.Commit()
}
