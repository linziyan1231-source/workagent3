package employeemanager

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/sharedtrash"
)

func (s *Service) sharedTrashHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fail := func(status int, code string) {
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]string{"error": code})
	}
	if s.SharedTrash == nil {
		fail(503, "shared_trash_unavailable")
		return
	}
	var input contracts.SharedTrashRequest
	if !decode(r, &input) {
		fail(400, "invalid_shared_trash_request")
		return
	}
	value, err := s.SharedTrash.Operate(r.Context(), r.PathValue("id"), input)
	if err != nil {
		switch {
		case errors.Is(err, sharedtrash.ErrExists):
			fail(409, "file_exists")
		case errors.Is(err, sharedtrash.ErrNotFound), errors.Is(err, fs.ErrNotExist):
			fail(404, "trash_entry_not_found")
		case errors.Is(err, sharedtrash.ErrInvalid):
			fail(400, "invalid_shared_trash_request")
		default:
			log.Printf("Shared trash operation failed: %v", err)
			fail(500, "shared_trash_operation_failed")
		}
		return
	}
	json.NewEncoder(w).Encode(value)
}

// RunSharedTrashRetention starts with a sweep, including offline project owners,
// then enforces retention throughout the service lifetime.
func (s *Service) RunSharedTrashRetention(ctx context.Context) {
	sweep := func() {
		if err := s.SharedTrash.Sweep(ctx); err != nil && ctx.Err() == nil {
			log.Printf("Shared trash retention: %v", err)
		}
	}
	sweep()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweep()
		}
	}
}
