package feedback

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestFeedbackOwnershipRetryAndAttachments(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "feedback.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	input := Report{SID: "S-1-a", Username: "alice", RequestID: "request-0001", Description: "cannot open file"}
	r, err := s.Create(t.Context(), input, []Upload{{Name: "notes.txt", Type: "text/plain", Data: []byte("redacted")}})
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.Create(t.Context(), input, []Upload{{Name: "notes.txt", Type: "text/plain", Data: []byte("redacted")}})
	if err != nil || again.ID != r.ID {
		t.Fatal("duplicate", err)
	}
	if _, err = s.Get(t.Context(), r.ID, "S-1-b", false); !errors.Is(err, ErrNotFound) {
		t.Fatal("cross employee access", err)
	}
	file, a, err := s.Attachment(t.Context(), r.ID, r.Attachments[0].ID, "S-1-a", false)
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	if a.Size != 8 {
		t.Fatal(a)
	}
	updated, err := s.SetStatus(t.Context(), r.ID, "resolved")
	if err != nil || updated.Status != "resolved" {
		t.Fatal(err)
	}
	if _, err = s.SetStatus(t.Context(), r.ID, "arbitrary"); !errors.Is(err, ErrInvalid) {
		t.Fatal("bad status")
	}
}
func TestFeedbackRejectsUnsupportedAttachmentAndDescription(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "feedback.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	input := Report{SID: "S-1-a", RequestID: "request-0001", Description: "issue"}
	if _, err = s.Create(t.Context(), input, []Upload{{Name: "run.html", Type: "text/html", Data: []byte("<script/>")}}); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	input.Description = ""
	if _, err = s.Create(t.Context(), input, nil); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}
