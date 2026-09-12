package collaboration

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type Conversation struct {
	ID               string            `json:"id"`
	ProjectID        string            `json:"projectId"`
	ProjectName      string            `json:"projectName"`
	Role             string            `json:"role"`
	Name             string            `json:"name"`
	Kind             string            `json:"kind"`
	CreatorUserID    int64             `json:"creatorUserId"`
	RuntimeSessionID string            `json:"runtimeSessionId"`
	AssistantID      string            `json:"assistantId"`
	AssistantBackend string            `json:"assistantBackend"`
	AssistantLocked  bool              `json:"assistantLocked"`
	Assistants       []AssistantMember `json:"assistants"`
	ModelID          string            `json:"modelId"`
	ThinkingEffort   string            `json:"thinkingEffort"`
	State            string            `json:"state"`
	LastAIMessageSeq int64             `json:"lastAiMessageSeq"`
	Pinned           bool              `json:"pinned"`
	PinnedAt         *time.Time        `json:"pinnedAt,omitempty"`
	Hidden           bool              `json:"hidden"`
	CreatedAt        time.Time         `json:"createdAt"`
	UpdatedAt        time.Time         `json:"updatedAt"`
}

type Mention struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type Message struct {
	Seq               int64     `json:"seq"`
	ID                string    `json:"id"`
	Conversation      string    `json:"conversationId"`
	AuthorUserID      *int64    `json:"authorUserId,omitempty"`
	AuthorName        string    `json:"authorName"`
	AuthorAssistantID string    `json:"authorAssistantId,omitempty"`
	Kind              string    `json:"kind"`
	Body              string    `json:"body"`
	Mentions          []Mention `json:"mentions"`
	Attachments       []string  `json:"attachments"`
	CreatedAt         time.Time `json:"createdAt"`
}

func (s *Store) CreateConversation(ctx context.Context, conversation Conversation, userID int64) (Conversation, error) {
	conversation.ID = strings.TrimSpace(conversation.ID)
	conversation.Name = strings.TrimSpace(conversation.Name)
	conversation.Kind = strings.TrimSpace(conversation.Kind)
	if conversation.Kind == "" {
		conversation.Kind = "discussion"
	}
	conversation.RuntimeSessionID = strings.TrimSpace(conversation.RuntimeSessionID)
	conversation.AssistantID = strings.TrimSpace(conversation.AssistantID)
	conversation.ModelID = strings.TrimSpace(conversation.ModelID)
	conversation.ThinkingEffort = strings.TrimSpace(conversation.ThinkingEffort)
	// Empty assistant identity represents human-only discussion. Keep the
	// legacy backend column valid so existing releases can still read it.
	if conversation.AssistantID == "" {
		conversation.AssistantBackend, conversation.ModelID, conversation.ThinkingEffort = "codex", "", ""
	}
	if !stableIDPattern.MatchString(conversation.ID) || conversation.Name == "" || len(conversation.Name) > 128 || (conversation.AssistantID != "" && (conversation.ModelID == "" || conversation.ThinkingEffort == "")) || (conversation.AssistantBackend != "codex" && conversation.AssistantBackend != "kimi") {
		return Conversation{}, errors.New("invalid shared conversation")
	}
	if conversation.Kind != "discussion" && conversation.Kind != "personal_task" {
		return Conversation{}, errors.New("invalid shared conversation")
	}
	// A personal task only points at a runtime session on the creator's own
	// userhost; assistant membership does not apply to it.
	if conversation.Kind == "personal_task" && (conversation.CreatorUserID <= 0 || !stableIDPattern.MatchString(conversation.RuntimeSessionID) || conversation.AssistantID != "") {
		return Conversation{}, errors.New("invalid personal task conversation")
	}
	project, err := s.ProjectForUser(ctx, conversation.ProjectID, userID, true)
	if err != nil || project.State != "active" {
		return Conversation{}, ErrForbidden
	}
	stamp := s.now().UTC().UnixMilli()
	_, err = s.db.ExecContext(ctx, `INSERT INTO shared_conversations(id,project_id,name,assistant_id,assistant_backend,model_id,thinking_effort,state,created_at,updated_at,kind,creator_user_id,runtime_session_id) VALUES(?,?,?,?,?,?,?,'idle',?,?,?,?,?)`, conversation.ID, conversation.ProjectID, conversation.Name, conversation.AssistantID, conversation.AssistantBackend, conversation.ModelID, conversation.ThinkingEffort, stamp, stamp, conversation.Kind, conversation.CreatorUserID, conversation.RuntimeSessionID)
	if err != nil {
		return Conversation{}, err
	}
	if err := s.seedConversationAssistant(ctx, conversation); err != nil {
		return Conversation{}, err
	}
	return s.ConversationForUser(ctx, conversation.ID, userID, true)
}

func (s *Store) ConversationForUser(ctx context.Context, conversationID string, userID int64, includeHidden bool) (Conversation, error) {
	var value Conversation
	var hidden, pinned int
	var pinnedAt sql.NullInt64
	var created, updated int64
	err := s.db.QueryRowContext(ctx, `SELECT c.id,c.project_id,p.name,m.role,c.name,c.assistant_id,c.assistant_backend,c.model_id,c.thinking_effort,c.state,c.last_ai_message_seq,COALESCE(us.pinned,0),us.pinned_at,COALESCE(v.hidden,0),c.created_at,c.updated_at,EXISTS(SELECT 1 FROM shared_ai_runs r WHERE r.conversation_id=c.id),c.kind,c.creator_user_id,c.runtime_session_id
FROM shared_conversations c JOIN shared_projects p ON p.id=c.project_id
JOIN shared_members m ON m.project_id=p.id AND m.user_id=? AND m.state='accepted'
LEFT JOIN shared_conversation_visibility v ON v.conversation_id=c.id AND v.user_id=?
LEFT JOIN shared_conversation_user_state us ON us.conversation_id=c.id AND us.user_id=?
WHERE c.id=? AND p.state IN ('active','transfer_pending') AND (c.kind='discussion' OR c.creator_user_id=?)`, userID, userID, userID, strings.TrimSpace(conversationID), userID).Scan(&value.ID, &value.ProjectID, &value.ProjectName, &value.Role, &value.Name, &value.AssistantID, &value.AssistantBackend, &value.ModelID, &value.ThinkingEffort, &value.State, &value.LastAIMessageSeq, &pinned, &pinnedAt, &hidden, &created, &updated, &value.AssistantLocked, &value.Kind, &value.CreatorUserID, &value.RuntimeSessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return Conversation{}, ErrNotFound
	}
	if err != nil {
		return Conversation{}, err
	}
	value.Hidden, value.Pinned = hidden != 0, pinned != 0
	if value.Hidden && !includeHidden {
		return Conversation{}, ErrNotFound
	}
	if pinnedAt.Valid {
		stamp := time.UnixMilli(pinnedAt.Int64).UTC()
		value.PinnedAt = &stamp
	}
	value.CreatedAt, value.UpdatedAt = time.UnixMilli(created).UTC(), time.UnixMilli(updated).UTC()
	value.Assistants, err = s.assistantMembers(ctx, value.ProjectID, value.ID)
	return value, err
}

func (s *Store) ListConversations(ctx context.Context, userID int64, includeHidden bool) ([]Conversation, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT c.id FROM shared_conversations c JOIN shared_projects p ON p.id=c.project_id AND p.state IN ('active','transfer_pending') JOIN shared_members m ON m.project_id=c.project_id AND m.user_id=? AND m.state='accepted' LEFT JOIN shared_conversation_visibility v ON v.conversation_id=c.id AND v.user_id=? LEFT JOIN shared_conversation_user_state us ON us.conversation_id=c.id AND us.user_id=? WHERE (? OR COALESCE(v.hidden,0)=0) AND (c.kind='discussion' OR c.creator_user_id=?) ORDER BY COALESCE(us.pinned,0) DESC,us.pinned_at DESC,c.updated_at DESC,c.id`, userID, userID, userID, includeHidden, userID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	result := make([]Conversation, 0, len(ids))
	for _, id := range ids {
		value, err := s.ConversationForUser(ctx, id, userID, includeHidden)
		if err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, nil
}

func (s *Store) SetConversationHidden(ctx context.Context, conversationID string, userID int64, hidden bool) (Conversation, error) {
	if _, err := s.ConversationForUser(ctx, conversationID, userID, true); err != nil {
		return Conversation{}, err
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO shared_conversation_visibility(conversation_id,user_id,hidden) VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET hidden=excluded.hidden`, conversationID, userID, hidden)
	if err != nil {
		return Conversation{}, err
	}
	return s.ConversationForUser(ctx, conversationID, userID, true)
}

func (s *Store) UpdateConversationMetadata(ctx context.Context, conversationID string, userID int64, name *string, pinned *bool, hidden *bool) (Conversation, error) {
	if name == nil && pinned == nil && hidden == nil {
		return Conversation{}, errors.New("shared conversation update is empty")
	}
	conversationID = strings.TrimSpace(conversationID)
	var nextName string
	if name != nil {
		nextName = strings.TrimSpace(*name)
		if nextName == "" || len(nextName) > 128 {
			return Conversation{}, errors.New("shared conversation name is invalid")
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Conversation{}, err
	}
	defer tx.Rollback()
	var role, kind string
	if err := tx.QueryRowContext(ctx, `SELECT m.role,c.kind FROM shared_conversations c JOIN shared_projects p ON p.id=c.project_id AND p.state IN ('active','transfer_pending') JOIN shared_members m ON m.project_id=c.project_id AND m.user_id=? AND m.state='accepted' WHERE c.id=? AND (c.kind='discussion' OR c.creator_user_id=?)`, userID, conversationID, userID).Scan(&role, &kind); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Conversation{}, ErrNotFound
		}
		return Conversation{}, err
	}
	if name != nil && kind != "personal_task" && role != "owner" {
		return Conversation{}, ErrForbidden
	}
	if name != nil {
		if _, err := tx.ExecContext(ctx, `UPDATE shared_conversations SET name=?,updated_at=? WHERE id=?`, nextName, s.now().UTC().UnixMilli(), conversationID); err != nil {
			return Conversation{}, err
		}
	}
	if pinned != nil {
		var pinnedAt any
		if *pinned {
			pinnedAt = s.now().UTC().UnixMilli()
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO shared_conversation_user_state(conversation_id,user_id,pinned,pinned_at) VALUES(?,?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET pinned=excluded.pinned,pinned_at=excluded.pinned_at`, conversationID, userID, *pinned, pinnedAt); err != nil {
			return Conversation{}, err
		}
	}
	if hidden != nil {
		if _, err := tx.ExecContext(ctx, `INSERT INTO shared_conversation_visibility(conversation_id,user_id,hidden) VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET hidden=excluded.hidden`, conversationID, userID, *hidden); err != nil {
			return Conversation{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Conversation{}, err
	}
	return s.ConversationForUser(ctx, conversationID, userID, true)
}

func (s *Store) DeleteConversation(ctx context.Context, conversationID string, userID int64) error {
	conversationID = strings.TrimSpace(conversationID)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var role, state, kind string
	if err := tx.QueryRowContext(ctx, `SELECT m.role,c.state,c.kind FROM shared_conversations c JOIN shared_projects p ON p.id=c.project_id AND p.state IN ('active','transfer_pending') JOIN shared_members m ON m.project_id=c.project_id AND m.user_id=? AND m.state='accepted' WHERE c.id=? AND (c.kind='discussion' OR c.creator_user_id=?)`, userID, conversationID, userID).Scan(&role, &state, &kind); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	// A personal task belongs to its creator alone; the visibility predicate
	// above has already established that the requester is the creator.
	if kind != "personal_task" && role != "owner" {
		return ErrForbidden
	}
	if state != "idle" {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM shared_ai_runs WHERE conversation_id=?`, conversationID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM shared_conversations WHERE id=?`, conversationID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) UpdateConversationRuntime(ctx context.Context, conversationID string, userID int64, modelID, thinkingEffort string) (Conversation, error) {
	current, err := s.ConversationForUser(ctx, conversationID, userID, true)
	if err != nil {
		return Conversation{}, err
	}
	if _, err := s.UpdateAssistantSettings(ctx, current.ProjectID, current.AssistantID, userID, modelID, thinkingEffort); err != nil {
		return Conversation{}, err
	}
	return s.ConversationForUser(ctx, conversationID, userID, true)
}

func (s *Store) AddMessage(ctx context.Context, message Message, userID int64) (Message, error) {
	message.ID, message.Body, message.AuthorName = strings.TrimSpace(message.ID), strings.TrimSpace(message.Body), strings.TrimSpace(message.AuthorName)
	if !stableIDPattern.MatchString(message.ID) || message.Body == "" || len(message.Body) > 128*1024 || message.AuthorName == "" || message.Kind != "user" {
		return Message{}, errors.New("invalid shared message")
	}
	if _, err := s.ConversationForUser(ctx, message.Conversation, userID, true); err != nil {
		return Message{}, err
	}
	message.AuthorUserID = &userID
	mentions, _ := json.Marshal(message.Mentions)
	attachments, _ := json.Marshal(message.Attachments)
	stamp := s.now().UTC().UnixMilli()
	result, err := s.db.ExecContext(ctx, `INSERT INTO shared_messages(id,conversation_id,author_user_id,author_name,kind,body,mentions_json,attachments_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, message.ID, message.Conversation, userID, message.AuthorName, message.Kind, message.Body, string(mentions), string(attachments), stamp)
	if err != nil {
		return Message{}, err
	}
	message.Seq, err = result.LastInsertId()
	message.CreatedAt = time.UnixMilli(stamp).UTC()
	if err == nil {
		_, err = s.db.ExecContext(ctx, `UPDATE shared_conversations SET updated_at=? WHERE id=?`, stamp, message.Conversation)
	}
	return message, err
}

func (s *Store) ListMessages(ctx context.Context, conversationID string, userID, after int64, limit int) ([]Message, error) {
	if _, err := s.ConversationForUser(ctx, conversationID, userID, true); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 200 {
		limit = 100
	}
	return s.listMessages(ctx, `m.conversation_id=? AND m.seq>?`, []any{conversationID, after, limit})
}

func (s *Store) ListMessagesForUserAfter(ctx context.Context, userID, after int64, limit int) ([]Message, error) {
	if limit < 1 || limit > 200 {
		limit = 200
	}
	return s.listMessages(ctx, `m.seq>? AND EXISTS(SELECT 1 FROM shared_conversations c JOIN shared_projects p ON p.id=c.project_id AND p.state IN ('active','transfer_pending') JOIN shared_members sm ON sm.project_id=c.project_id AND sm.user_id=? AND sm.state='accepted' WHERE c.id=m.conversation_id AND (c.kind='discussion' OR c.creator_user_id=?))`, []any{after, userID, userID, limit})
}

func (s *Store) listMessages(ctx context.Context, where string, args []any) ([]Message, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT m.seq,m.id,m.conversation_id,m.author_user_id,m.author_name,m.kind,m.body,m.mentions_json,m.attachments_json,m.created_at,m.author_assistant_id FROM shared_messages m WHERE `+where+` ORDER BY m.seq LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Message{}
	for rows.Next() {
		var value Message
		var author sql.NullInt64
		var mentions, attachments string
		var created int64
		if err := rows.Scan(&value.Seq, &value.ID, &value.Conversation, &author, &value.AuthorName, &value.Kind, &value.Body, &mentions, &attachments, &created, &value.AuthorAssistantID); err != nil {
			return nil, err
		}
		if author.Valid {
			value.AuthorUserID = &author.Int64
		}
		_ = json.Unmarshal([]byte(mentions), &value.Mentions)
		_ = json.Unmarshal([]byte(attachments), &value.Attachments)
		value.CreatedAt = time.UnixMilli(created).UTC()
		result = append(result, value)
	}
	return result, rows.Err()
}
