package feedback

import (
	"archive/zip"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

// ExportBackup locks report changes while taking one database-and-attachment archive.
func (s *Store) ExportBackup(ctx context.Context, destination string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	directory, err := os.MkdirTemp(filepath.Dir(destination), ".feedback-backup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	database := filepath.Join(directory, "feedback.db")
	if _, err = s.db.ExecContext(ctx, `VACUUM INTO ?`, database); err != nil {
		return err
	}
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer output.Close()
	archive := zip.NewWriter(output)
	add := func(name, source string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		input, e := os.Open(source)
		if e != nil {
			return e
		}
		defer input.Close()
		entry, e := archive.Create(name)
		if e != nil {
			return e
		}
		_, e = io.Copy(entry, input)
		return e
	}
	if err = add("feedback.db", database); err != nil {
		return err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT payload FROM reports`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		var r Report
		if err = rows.Scan(&raw); err != nil {
			return err
		}
		if err = json.Unmarshal([]byte(raw), &r); err != nil {
			return err
		}
		for _, a := range r.Attachments {
			if err = add("feedback-attachments/"+r.ID+"/"+a.ID, filepath.Join(s.root, r.ID, a.ID)); err != nil {
				return err
			}
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if err = archive.Close(); err != nil {
		return err
	}
	return output.Sync()
}
