package feedback

import (
	"context"
	"os"
	"path/filepath"
	"strings"
)

// Journal entries are created before any attachment writes. Only journaled,
// uncommitted directories are recovered; unidentified directories are preserved.
func (s *Store) recoverAttachments(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `SELECT j.id, EXISTS(SELECT 1 FROM reports r WHERE r.id=j.id) FROM attachment_journal j`)
	if err != nil {
		return err
	}
	type pending struct {
		id        string
		committed bool
	}
	var entries []pending
	for rows.Next() {
		var entry pending
		if err = rows.Scan(&entry.id, &entry.committed); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, entry)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.committed {
			if err = s.removeAttachments(entry.id); err != nil {
				return err
			}
		}
		if _, err = s.db.ExecContext(ctx, `DELETE FROM attachment_journal WHERE id=?`, entry.id); err != nil {
			return err
		}
	}
	return nil
}
func (s *Store) removeAttachments(id string) error {
	if id == "" || id == "." || id == ".." || strings.ContainsAny(id, "/\\:") {
		return ErrInvalid
	}
	root, err := filepath.Abs(s.root)
	if err != nil {
		return err
	}
	target := filepath.Join(root, id)
	if filepath.Dir(target) != root {
		return ErrInvalid
	}
	return os.RemoveAll(target)
}
func writeAttachment(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err = file.Write(data); err != nil {
		return err
	}
	return file.Sync()
}
