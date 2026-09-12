package portal

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/collaboration"
	"workagent3/internal/store"
)

type PersonalTaskStore interface {
	BeginPersonalTask(context.Context, collaboration.PersonalTaskOperation) (collaboration.PersonalTaskOperation, error)
	PersonalTaskOperation(context.Context, string, int64) (collaboration.PersonalTaskOperation, error)
	RecordPersonalTaskSession(context.Context, collaboration.PersonalTaskOperation, string) error
	CompletePersonalTaskCreation(context.Context, collaboration.PersonalTaskOperation) error
	BeginPersonalTaskDeletion(context.Context, string, int64, string) (collaboration.PersonalTaskOperation, error)
	CompletePersonalTaskDeletion(context.Context, collaboration.PersonalTaskOperation) error
	SetPersonalTaskError(context.Context, collaboration.PersonalTaskOperation, string, bool) error
	PendingPersonalTasks(context.Context) ([]collaboration.PersonalTaskOperation, error)
	PersonalTaskForSession(context.Context, string, int64) (string, error)
}

type PersonalTaskOptions struct {
	Title          string `json:"title"`
	Engine         string `json:"engine"`
	PresetID       string `json:"presetId,omitempty"`
	ModelID        string `json:"modelId,omitempty"`
	ThinkingEffort string `json:"thinkingEffort,omitempty"`
	PermissionMode string `json:"permissionMode,omitempty"`
}

type PersonalTaskRuntime interface {
	Create(context.Context, collaboration.PersonalTaskOperation) (json.RawMessage, error)
	Read(context.Context, string, string) (json.RawMessage, error)
	Delete(context.Context, collaboration.PersonalTaskOperation) error
}

type personalTaskService struct {
	store    CollaborationPort
	runtime  PersonalTaskRuntime
	users    *store.Store
	inflight sync.Map
}

// advance owns one operation at a time. The durable record, not this lock,
// provides recovery across Portal restarts and Runtime response loss.
func (p *personalTaskService) advance(ctx context.Context, op collaboration.PersonalTaskOperation) (collaboration.PersonalTaskOperation, error) {
	if _, busy := p.inflight.LoadOrStore(op.ID, true); busy {
		return op, nil
	}
	defer p.inflight.Delete(op.ID)
	op, err := p.store.PersonalTaskOperation(ctx, op.ID, op.UserID)
	if err != nil {
		return op, err
	}
	if err = ctx.Err(); err != nil {
		return op, err
	}
	if op.State == "creating" || op.State == "linking" {
		user, lookupErr := p.users.UserBySID(ctx, op.CreatorSID)
		if lookupErr != nil || user.Disabled || user.ID != op.UserID {
			return op, p.store.SetPersonalTaskError(ctx, op, "personal_task_account_unavailable", false)
		}
		project, lookupErr := p.store.ProjectForUser(ctx, op.ProjectID, op.UserID, true)
		if errors.Is(lookupErr, collaboration.ErrNotFound) || (lookupErr == nil && (project.State == "archived" || project.State == "failed")) {
			op, err = p.store.BeginPersonalTaskDeletion(ctx, op.ID, op.UserID, op.CreatorSID)
			if err != nil {
				return op, err
			}
		} else if lookupErr != nil {
			return op, lookupErr
		}
	}
	if op.State == "creating" {
		var session json.RawMessage
		session, err = p.runtime.Create(ctx, op)
		if err != nil {
			return p.failed(ctx, op, err)
		}
		var value struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(session, &value) != nil || value.ID == "" {
			return p.failed(ctx, op, errors.New("invalid_runtime_session"))
		}
		if err = p.store.RecordPersonalTaskSession(ctx, op, value.ID); err != nil {
			return op, err
		}
		op, err = p.store.PersonalTaskOperation(ctx, op.ID, op.UserID)
		if err != nil {
			return op, err
		}
	}
	if op.State == "linking" {
		err = p.store.CompletePersonalTaskCreation(ctx, op)
		if errors.Is(err, collaboration.ErrForbidden) {
			// Membership was actually revoked, rather than guessed lost after
			// a timeout. Persist compensation before removing the session.
			op, err = p.store.BeginPersonalTaskDeletion(ctx, op.ID, op.UserID, op.CreatorSID)
		} else if err != nil {
			return p.failed(ctx, op, err)
		}
		if err != nil {
			return op, err
		}
	}
	if op.State == "deleting" {
		if err = p.runtime.Delete(ctx, op); err != nil {
			return p.failed(ctx, op, err)
		}
		if err = p.store.CompletePersonalTaskDeletion(ctx, op); err != nil {
			return op, err
		}
	}
	return p.store.PersonalTaskOperation(ctx, op.ID, op.UserID)
}

func (p *personalTaskService) failed(ctx context.Context, op collaboration.PersonalTaskOperation, cause error) (collaboration.PersonalTaskOperation, error) {
	code := "personal_task_retry_pending"
	rejected := false
	var failure *personalTaskRuntimeError
	if errors.As(cause, &failure) && failure.status == 404 && failure.code == "shared_project_not_found" {
		return p.store.BeginPersonalTaskDeletion(ctx, op.ID, op.UserID, op.CreatorSID)
	}
	if errors.As(cause, &failure) && failure.code == "operation_deleted" {
		if op.State == "deleting" {
			if err := p.store.CompletePersonalTaskDeletion(ctx, op); err != nil {
				return op, err
			}
			return p.store.PersonalTaskOperation(ctx, op.ID, op.UserID)
		}
		code, rejected = "personal_task_already_deleted", true
	}
	if errors.As(cause, &failure) && failure.status >= 400 && failure.status < 500 && failure.status != 408 && failure.status != 429 {
		// A documented invalid request is terminal; offline credentials and
		// temporarily unavailable engines can be repaired then retried.
		if failure.status == 400 {
			code = failure.code
			rejected = op.State == "creating"
		}
	}
	if err := p.store.SetPersonalTaskError(ctx, op, code, rejected); err != nil {
		return op, err
	}
	return p.store.PersonalTaskOperation(ctx, op.ID, op.UserID)
}

func (s *Server) RunPersonalTaskRecovery(ctx context.Context, interval time.Duration) {
	if s.personalTasks == nil {
		return
	}
	timer := time.NewTicker(interval)
	defer timer.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		pending, err := s.modules.Collaboration.PendingPersonalTasks(ctx)
		if err != nil && ctx.Err() == nil {
			log.Printf("Personal task recovery inventory: %v", err)
		}
		for _, op := range pending {
			if ctx.Err() != nil {
				return
			}
			step, cancel := context.WithTimeout(ctx, 20*time.Second)
			var next collaboration.PersonalTaskOperation
			next, err = s.personalTasks.advance(step, op)
			cancel()
			if err == nil && next.State != op.State {
				userID := op.UserID
				s.sharedEvents.publish(collaboration.Message{Kind: "refresh", AuthorUserID: &userID})
			}
			if err != nil && ctx.Err() == nil {
				log.Printf("Personal task recovery %s: %v", op.ID, err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
	}
}

// Normal task menus and old clients can delete through the Runtime proxy.
// They still enter the owner use case when this is a shared personal task.
func (s *Server) interceptPersonalTaskDeletion(w http.ResponseWriter, r *http.Request, user store.User) bool {
	if s.personalTasks == nil || r.Method != http.MethodDelete {
		return false
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/runtime")
	if !strings.HasPrefix(path, "/v1/sessions/") {
		return false
	}
	sessionID := strings.TrimPrefix(path, "/v1/sessions/")
	if strings.Contains(sessionID, "/") {
		return false
	}
	id, err := s.modules.Collaboration.PersonalTaskForSession(r.Context(), sessionID, user.ID)
	if errors.Is(err, collaboration.ErrNotFound) {
		return false
	}
	if err != nil {
		writeError(w, 500, "personal_task_lookup_failed")
		return true
	}
	s.deletePersonalTaskOperation(w, r, user, id)
	return true
}

func (s *Server) personalTaskOperations(w http.ResponseWriter, r *http.Request, user store.User) {
	if s.personalTasks == nil {
		writeError(w, 503, "collaboration_unavailable")
		return
	}
	var op collaboration.PersonalTaskOperation
	var err error
	switch r.Method {
	case http.MethodPost:
		var input struct {
			OperationID string              `json:"operation_id"`
			ProjectID   string              `json:"project_id"`
			Options     PersonalTaskOptions `json:"options"`
		}
		if !decodeJSON(r, &input, 32*1024) || !sharedOperationPattern.MatchString(input.OperationID) {
			writeError(w, 400, "invalid_personal_task")
			return
		}
		input.Options.Title = strings.TrimSpace(input.Options.Title)
		if input.Options.Title == "" || len(input.Options.Title) > 128 || (input.Options.Engine != "harness" && input.Options.Engine != "codex" && input.Options.Engine != "kimi") {
			writeError(w, 400, "invalid_personal_task")
			return
		}
		configuration, _ := json.Marshal(input.Options)
		op, err = s.modules.Collaboration.BeginPersonalTask(r.Context(), collaboration.PersonalTaskOperation{ID: "ptask_" + strconv.FormatInt(user.ID, 10) + "_" + input.OperationID, UserID: user.ID, CreatorSID: user.SID, ProjectID: input.ProjectID, Name: input.Options.Title, Configuration: configuration})
	case http.MethodGet:
		op, err = s.modules.Collaboration.PersonalTaskOperation(r.Context(), r.URL.Query().Get("id"), user.ID)
	case http.MethodDelete:
		var input struct {
			ID string `json:"conversation_id"`
		}
		if !decodeJSON(r, &input, 16*1024) || input.ID == "" {
			writeError(w, 400, "invalid_personal_task")
			return
		}
		op, err = s.modules.Collaboration.BeginPersonalTaskDeletion(r.Context(), input.ID, user.ID, user.SID)
	}
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	if r.Method != http.MethodGet {
		step, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		op, err = s.personalTasks.advance(step, op)
		cancel()
		if err != nil && r.Context().Err() != nil {
			return
		}
		if err != nil {
			writeError(w, 503, "personal_task_retry_pending")
			return
		}
	}
	s.writePersonalTask(w, r, op)
}

func (s *Server) writePersonalTask(w http.ResponseWriter, r *http.Request, op collaboration.PersonalTaskOperation) {
	status := http.StatusAccepted
	result := map[string]any{"operation": op}
	if op.State == "ready" {
		// A ready pointer remains durable even if its Runtime is temporarily
		// offline; clients can navigate to the persisted session identity.
		result["session"] = map[string]any{"id": op.RuntimeSessionID, "workspaceId": "shared:" + op.ProjectID}
		status = http.StatusOK
	} else if op.State == "deleted" {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		status = http.StatusGone
	} else if op.State == "rejected" {
		status = http.StatusUnprocessableEntity
		result["error"] = op.Error
	}
	writeJSON(w, status, result)
}

func (s *Server) deletePersonalTaskOperation(w http.ResponseWriter, r *http.Request, user store.User, id string) {
	op, err := s.modules.Collaboration.BeginPersonalTaskDeletion(r.Context(), id, user.ID, user.SID)
	if err == nil {
		op, err = s.personalTasks.advance(r.Context(), op)
	}
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	s.writePersonalTask(w, r, op)
}

// Compatibility for an already loaded pre-upgrade client: verify the session
// on its creator's Runtime, then enroll it in the same durable workflow.
func (s *Server) registerLegacyPersonalTask(w http.ResponseWriter, r *http.Request, user store.User, projectID, operationID, name, sessionID string) {
	if operationID == "" {
		var err error
		operationID, err = auth.RandomToken(18)
		if err != nil {
			writeError(w, 500, "personal_task_failed")
			return
		}
	}
	if !sharedOperationPattern.MatchString(operationID) {
		writeError(w, 400, "invalid_operation_id")
		return
	}
	if _, err := s.modules.Collaboration.ProjectForUser(r.Context(), projectID, user.ID, true); err != nil {
		writeCollaborationError(w, err)
		return
	}
	encoded, err := s.personalTasks.runtime.Read(r.Context(), user.SID, sessionID)
	if err != nil {
		writeError(w, 503, "personal_task_runtime_unavailable")
		return
	}
	var session struct {
		ID          string `json:"id"`
		WorkspaceID string `json:"workspaceId"`
	}
	if json.Unmarshal(encoded, &session) != nil || session.ID != sessionID || session.WorkspaceID != "shared:"+projectID {
		writeError(w, 400, "invalid_personal_task_session")
		return
	}
	op, err := s.modules.Collaboration.BeginPersonalTask(r.Context(), collaboration.PersonalTaskOperation{ID: "ptask_" + strconv.FormatInt(user.ID, 10) + "_" + operationID, UserID: user.ID, CreatorSID: user.SID, ProjectID: projectID, Name: name, Configuration: json.RawMessage(`{}`), RuntimeSessionID: sessionID})
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	created := op.State != "ready"
	op, err = s.personalTasks.advance(r.Context(), op)
	if err != nil {
		writeError(w, 503, "personal_task_retry_pending")
		return
	}
	if op.State != "ready" {
		s.writePersonalTask(w, r, op)
		return
	}
	row, err := s.modules.Collaboration.ConversationForUser(r.Context(), op.ID, user.ID, true)
	if err != nil {
		writeCollaborationError(w, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]any{"conversation": conversationDTO(row)})
}
