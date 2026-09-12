package feedback

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestRecoveryPreservesCommittedAndUnknownAttachments(t *testing.T) {
	path := filepath.Join(t.TempDir(), "feedback.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	report, err := s.Create(t.Context(), Report{SID: "alice", RequestID: "request-123", Description: "issue"}, []Upload{{Name: "log.txt", Type: "text/plain", Data: []byte("saved")}})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"abandoned", "unknown"} {
		if err = os.Mkdir(filepath.Join(s.root, id), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.db.Exec(`INSERT INTO attachment_journal(id) VALUES(?),(?)`, report.ID, "abandoned"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err = os.Stat(filepath.Join(s.root, "abandoned")); !os.IsNotExist(err) {
		t.Fatal("abandoned upload not removed", err)
	}
	for _, id := range []string{report.ID, "unknown"} {
		if _, err = os.Stat(filepath.Join(s.root, id)); err != nil {
			t.Fatal("must preserve", id, err)
		}
	}
	backup := filepath.Join(t.TempDir(), "feedback.zip")
	if err = s.ExportBackup(t.Context(), backup); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.OpenReader(backup)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	restore := t.TempDir()
	for _, entry := range archive.File {
		input, e := entry.Open()
		if e != nil {
			t.Fatal(e)
		}
		data, e := io.ReadAll(input)
		input.Close()
		if e != nil {
			t.Fatal(e)
		}
		target := filepath.Join(restore, filepath.FromSlash(entry.Name))
		if e = os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(target, data, 0600); e != nil {
			t.Fatal(e)
		}
	}
	restored, err := Open(filepath.Join(restore, "feedback.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	file, _, err := restored.Attachment(t.Context(), report.ID, report.Attachments[0].ID, "alice", false)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil || string(data) != "saved" {
		t.Fatal("attachment restore", err)
	}
}
