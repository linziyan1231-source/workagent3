package collaboration

import (
	"context"
	"errors"
)

var ErrAssistantLocked = errors.New("shared assistant identity is fixed; invite a separate assistant member")

// DefaultConversation has a stable identity, including for projects predating
// the discussion-first UI. INSERT conflicts are resolved by reading the winner.
func (s *Store) DefaultConversation(ctx context.Context, projectID string, userID int64) (Conversation, error) {
	id := "discussion_" + projectID
	if value, err := s.ConversationForUser(ctx, id, userID, true); err == nil {
		return value, nil
	} else if !errors.Is(err, ErrNotFound) {
		return Conversation{}, err
	}
	value, err := s.CreateConversation(ctx, Conversation{ID: id, ProjectID: projectID, Name: "项目讨论"}, userID)
	if err == nil {
		return value, nil
	}
	return s.ConversationForUser(ctx, id, userID, true)
}

func (s *Store) MessageByID(ctx context.Context, id, conversationID string, userID int64) (Message, error) {
	if _, err := s.ConversationForUser(ctx, conversationID, userID, true); err != nil {
		return Message{}, err
	}
	values, err := s.listMessages(ctx, `m.id=? AND m.conversation_id=? AND m.author_user_id=?`, []any{id, conversationID, userID, 1})
	if err != nil {
		return Message{}, err
	}
	if len(values) == 0 {
		return Message{}, ErrNotFound
	}
	return values[0], nil
}

func (s *Store) ProjectInvites(ctx context.Context, projectID string, userID int64) ([]Invite, error) {
	project, err := s.ProjectForUser(ctx, projectID, userID, true)
	if err != nil {
		return nil, err
	}
	if project.CurrentRole != "owner" {
		return nil, ErrForbidden
	}
	if _, err = s.db.ExecContext(ctx, `UPDATE shared_invites SET status='expired',acted_at=? WHERE project_id=? AND status='pending' AND expires_at<=?`, s.now().UnixMilli(), projectID, s.now().UnixMilli()); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM shared_invites WHERE project_id=? ORDER BY created_at DESC,id`, projectID)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	values := []Invite{}
	for _, id := range ids {
		value, err := s.Invite(ctx, id)
		if err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, nil
}

func (s *Store) BindAssistant(ctx context.Context, conversationID string, userID int64, assistantID, backend, modelID, effort string) (Conversation, error) {
	current, err := s.ConversationForUser(ctx, conversationID, userID, true)
	if err != nil {
		return Conversation{}, err
	}
	if current.Role != "owner" {
		return Conversation{}, ErrForbidden
	}
	if current.AssistantID == "" || current.AssistantID != assistantID || current.AssistantBackend != backend {
		return Conversation{}, ErrAssistantLocked
	}
	return s.UpdateConversationRuntime(ctx, conversationID, userID, modelID, effort)
}
