package portal

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"workagent3/internal/feedback"
	"workagent3/internal/store"
)

func (s *Server) feedbackHTTP(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.modules.Feedback == nil {
		writeError(w, 503, "feedback_unavailable")
		return
	}
	id := r.PathValue("id")
	if r.Method == http.MethodGet {
		if attachment := r.PathValue("attachment"); attachment != "" {
			file, a, err := s.modules.Feedback.Attachment(r.Context(), id, attachment, user.SID, user.Admin)
			if err != nil {
				feedbackError(w, err)
				return
			}
			defer file.Close()
			w.Header().Set("Content-Type", a.Type)
			w.Header().Set("Content-Disposition", "attachment")
			w.Header().Set("Cache-Control", "private, no-store")
			_, _ = io.Copy(w, file)
			return
		}
		if id != "" {
			report, err := s.modules.Feedback.Get(r.Context(), id, user.SID, user.Admin)
			if err != nil {
				feedbackError(w, err)
				return
			}
			writeJSON(w, 200, report)
			return
		}
		all := r.URL.Query().Get("all") == "1"
		if all && !user.Admin {
			writeError(w, 403, "administrator_required")
			return
		}
		reports, err := s.modules.Feedback.List(r.Context(), user.SID, all)
		if err != nil {
			feedbackError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": reports})
		return
	}
	if r.Method == http.MethodPatch {
		if !user.Admin {
			writeError(w, 403, "administrator_required")
			return
		}
		var input struct {
			Status string `json:"status"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&input) != nil {
			writeError(w, 400, "invalid_feedback")
			return
		}
		report, err := s.modules.Feedback.SetStatus(r.Context(), id, input.Status)
		s.recordBusinessEvent(r.Context(), user.Username, "feedback.status", id, err, nil)
		if err != nil {
			feedbackError(w, err)
			return
		}
		writeJSON(w, 200, report)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 17*1024*1024)
	if err := r.ParseMultipartForm(512 * 1024); err != nil {
		writeError(w, 413, "feedback_too_large")
		return
	}
	defer r.MultipartForm.RemoveAll()
	report := feedback.Report{SID: user.SID, Username: user.Username, RequestID: r.FormValue("requestId"), Module: r.FormValue("module"), Description: strings.TrimSpace(r.FormValue("description")), Steps: r.FormValue("steps"), CorrelationID: r.FormValue("correlationId"), Version: s.modules.SoftwareVersion}
	uploads := []feedback.Upload{}
	for _, files := range r.MultipartForm.File {
		for _, header := range files {
			if len(uploads) >= 4 || header.Size > 4*1024*1024 {
				writeError(w, 413, "feedback_too_large")
				return
			}
			file, err := header.Open()
			if err != nil {
				writeError(w, 400, "invalid_attachment")
				return
			}
			data, err := io.ReadAll(io.LimitReader(file, 4*1024*1024+1))
			file.Close()
			if err != nil || len(data) > 4*1024*1024 {
				writeError(w, 413, "feedback_too_large")
				return
			}
			kind := http.DetectContentType(data)
			if strings.HasPrefix(kind, "text/plain") {
				kind = "text/plain"
			}
			if json.Valid(data) {
				kind = "application/json"
			}
			uploads = append(uploads, feedback.Upload{Name: header.Filename, Type: kind, Data: data})
		}
	}
	saved, err := s.modules.Feedback.Create(r.Context(), report, uploads)
	s.recordBusinessEvent(r.Context(), user.Username, "feedback.submit", saved.ID, err, nil)
	if err != nil {
		feedbackError(w, err)
		return
	}
	writeJSON(w, 201, saved)
}
func feedbackError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, feedback.ErrInvalid):
		writeError(w, 400, err.Error())
	case errors.Is(err, feedback.ErrNotFound):
		writeError(w, 404, err.Error())
	case errors.Is(err, feedback.ErrCapacity):
		writeError(w, 429, err.Error())
	default:
		writeError(w, 500, "feedback_failed")
	}
}
