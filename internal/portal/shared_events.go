package portal

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"workagent3/internal/collaboration"
	"workagent3/internal/store"
)

type sharedEventHub struct {
	mu          sync.Mutex
	nextID      uint64
	subscribers map[uint64]chan collaboration.Message
}

func newSharedEventHub() *sharedEventHub {
	return &sharedEventHub{subscribers: make(map[uint64]chan collaboration.Message)}
}

func (h *sharedEventHub) subscribe() (uint64, <-chan collaboration.Message) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.nextID++
	channel := make(chan collaboration.Message, 256)
	h.subscribers[h.nextID] = channel
	return h.nextID, channel
}

func (h *sharedEventHub) unsubscribe(id uint64) {
	h.mu.Lock()
	delete(h.subscribers, id)
	h.mu.Unlock()
}

func (h *sharedEventHub) publish(message collaboration.Message) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, channel := range h.subscribers {
		select {
		case channel <- message:
		default:
			close(channel)
			delete(h.subscribers, id)
		}
	}
}

func (s *Server) sharedEventStream(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil {
		writeError(writer, http.StatusServiceUnavailable, "collaboration_unavailable")
		return
	}
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeError(writer, http.StatusInternalServerError, "streaming_unavailable")
		return
	}
	writer.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-cache, no-store")
	writer.Header().Set("X-Accel-Buffering", "no")
	writer.WriteHeader(http.StatusOK)
	subscriberID, events := s.sharedEvents.subscribe()
	defer s.sharedEvents.unsubscribe(subscriberID)
	lastID, _ := strconv.ParseInt(request.Header.Get("Last-Event-ID"), 10, 64)
	for {
		values, err := s.modules.Collaboration.ListMessagesForUserAfter(request.Context(), user.ID, lastID, 200)
		if err != nil {
			return
		}
		for _, value := range values {
			if !writeSharedSSE(writer, user.ID, value) {
				return
			}
			lastID = value.Seq
		}
		if len(values) < 200 {
			break
		}
	}
	flusher.Flush()
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case value, open := <-events:
			if !open {
				return
			}
			if value.Kind == "refresh" {
				if value.AuthorUserID != nil && *value.AuthorUserID == user.ID {
					if _, err := fmt.Fprint(writer, "event: change\ndata: {\"type\":\"refresh\"}\n\n"); err != nil {
						return
					}
					flusher.Flush()
				}
				continue
			}
			if value.Seq <= lastID {
				continue
			}
			if _, err := s.modules.Collaboration.ConversationForUser(request.Context(), value.Conversation, user.ID, true); err != nil {
				continue
			}
			if !writeSharedSSE(writer, user.ID, value) {
				return
			}
			lastID = value.Seq
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := fmt.Fprint(writer, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// An invalidation carries no project or member data. Recipients reload through
// the current ACLs, including a member who has just lost access.
func (s *Server) sharedRefreshAudience(ctx context.Context, userID int64) map[int64]bool {
	users := map[int64]bool{userID: true}
	projects, err := s.modules.Collaboration.ListProjects(ctx, userID, true)
	if err != nil {
		return users
	}
	for _, project := range projects {
		members, err := s.modules.Collaboration.Members(ctx, project.ID, userID)
		if err == nil {
			for _, member := range members {
				users[member.UserID] = true
			}
		}
		if project.CurrentRole == "owner" {
			invites, err := s.modules.Collaboration.ProjectInvites(ctx, project.ID, userID)
			if err == nil {
				for _, invite := range invites {
					users[invite.TargetUserID] = true
				}
			}
		}
	}
	return users
}

func writeSharedSSE(writer http.ResponseWriter, currentUserID int64, value collaboration.Message) bool {
	position := "left"
	if value.Kind == "system" {
		position = "center"
	} else if value.AuthorUserID != nil && *value.AuthorUserID == currentUserID {
		position = "right"
	}
	content := map[string]any{"content": value.Body}
	if value.Kind == "user" {
		content["teammateMessage"] = true
		content["senderName"] = value.AuthorName
		if value.AuthorUserID != nil {
			content["senderUserId"] = strconv.FormatInt(*value.AuthorUserID, 10)
		}
	}
	payload := map[string]any{
		"conversation_id": "shared:" + value.Conversation,
		"type":            "teammate_message",
		"msg_id":          value.ID,
		"created_at":      value.CreatedAt.UnixMilli(),
		"data": map[string]any{
			"id": value.ID, "msg_id": value.ID, "conversation_id": "shared:" + value.Conversation,
			"type": "text", "position": position, "status": "finish", "created_at": value.CreatedAt.UnixMilli(),
			"content": content,
		},
	}
	envelope, _ := json.Marshal(map[string]any{"event": "message.stream", "payload": payload})
	_, err := fmt.Fprintf(writer, "id: %d\ndata: %s\n\n", value.Seq, envelope)
	return err == nil
}
