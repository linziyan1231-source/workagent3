package portal

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

func (s *Server) notifications(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Notifications == nil {
		writeJSON(writer, http.StatusOK, map[string]any{"notifications": []any{}})
		return
	}
	items, err := s.modules.Notifications.List(request.Context(), user.SID, 20)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "notification_list_failed")
		return
	}
	for _, item := range items {
		if item.ReadAt == nil {
			_ = s.modules.Notifications.MarkRead(request.Context(), user.SID, item.ID)
		}
	}
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, http.StatusOK, map[string]any{"notifications": items})
}

func (s *Server) readNotification(writer http.ResponseWriter, request *http.Request, user store.User) {
	s.notificationReceipt(writer, request, user, false)
}

func (s *Server) acknowledgeNotification(writer http.ResponseWriter, request *http.Request, user store.User) {
	s.notificationReceipt(writer, request, user, true)
}

func (s *Server) notificationReceipt(writer http.ResponseWriter, request *http.Request, user store.User, acknowledge bool) {
	if s.modules.Notifications == nil {
		writeError(writer, http.StatusServiceUnavailable, "notifications_unavailable")
		return
	}
	var err error
	if acknowledge {
		err = s.modules.Notifications.Acknowledge(request.Context(), user.SID, request.PathValue("id"))
	} else {
		err = s.modules.Notifications.MarkRead(request.Context(), user.SID, request.PathValue("id"))
	}
	if errors.Is(err, contracts.ErrNotificationNotFound) {
		writeError(writer, http.StatusNotFound, "notification_not_found")
		return
	}
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "notification_receipt_failed")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) notificationStream(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Notifications == nil {
		writeError(writer, http.StatusServiceUnavailable, "notifications_unavailable")
		return
	}
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeError(writer, http.StatusInternalServerError, "streaming_unavailable")
		return
	}
	events, cancel, err := s.modules.Notifications.Subscribe(user.SID)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "notification_stream_failed")
		return
	}
	defer cancel()
	writer.Header().Set("Cache-Control", "no-cache, no-store")
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("X-Accel-Buffering", "no")
	writeFeed := func() error {
		items, err := s.modules.Notifications.List(request.Context(), user.SID, 20)
		if err != nil {
			return err
		}
		payload, err := json.Marshal(map[string]any{"notifications": items})
		if err != nil {
			return err
		}
		if _, err := writer.Write([]byte("event: notifications\ndata: " + string(payload) + "\n\n")); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	if writeFeed() != nil {
		return
	}
	keepAlive := time.NewTicker(30 * time.Second)
	defer keepAlive.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case <-events:
			if writeFeed() != nil {
				return
			}
		case <-keepAlive.C:
			if _, err := writer.Write([]byte(": keepalive\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
