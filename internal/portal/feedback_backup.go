package portal

import (
	"net/http"
	"os"
	"path/filepath"
	"workagent3/internal/store"
)

func (s *Server) feedbackBackup(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Feedback == nil {
		writeError(w, 503, "feedback_unavailable")
		return
	}
	directory, err := os.MkdirTemp("", "workagent-feedback-backup-")
	if err != nil {
		writeError(w, 500, "feedback_backup_failed")
		return
	}
	defer os.RemoveAll(directory)
	destination := filepath.Join(directory, "feedback.zip")
	err = s.modules.Feedback.ExportBackup(r.Context(), destination)
	s.recordBusinessEvent(r.Context(), user.Username, "feedback.backup", "feedback", err, nil)
	if err != nil {
		writeError(w, 500, "feedback_backup_failed")
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="feedback.zip"`)
	w.Header().Set("Cache-Control", "private, no-store")
	http.ServeFile(w, r, destination)
}
