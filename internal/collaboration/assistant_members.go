package collaboration

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"strings"
	"time"
)

type AssistantMember struct {
	ProjectID      string    `json:"project_id"`
	AssistantID    string    `json:"assistant_id"`
	Name           string    `json:"name"`
	Backend        string    `json:"assistant_backend"`
	ModelID        string    `json:"model_id"`
	ThinkingEffort string    `json:"thinking_effort"`
	State          string    `json:"state"`
	JoinedAt       time.Time `json:"joined_at"`
	Running        bool      `json:"running"`
	Active         bool      `json:"active"`
}

func (s *Store) migrateAssistantMembers(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for table, columns := range map[string][]string{"shared_ai_runs": {"assistant_id", "assistant_name"}, "shared_messages": {"author_assistant_id"}} {
		rows, err := tx.QueryContext(ctx, "PRAGMA table_info("+table+")")
		if err != nil {
			return err
		}
		present := map[string]bool{}
		for rows.Next() {
			var cid, notNull, pk int
			var name, kind string
			var defaultValue any
			if err := rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &pk); err != nil {
				rows.Close()
				return err
			}
			present[name] = true
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		for _, column := range columns {
			if !present[column] {
				if _, err := tx.ExecContext(ctx, "ALTER TABLE "+table+" ADD COLUMN "+column+" TEXT NOT NULL DEFAULT ''"); err != nil {
					return err
				}
			}
		}
	}
	_, err = tx.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS shared_assistant_members (
 project_id TEXT NOT NULL REFERENCES shared_projects(id) ON DELETE CASCADE,
 assistant_id TEXT NOT NULL,
 name TEXT NOT NULL,
 backend TEXT NOT NULL CHECK(backend IN ('codex','kimi')),
 model_id TEXT NOT NULL,
 thinking_effort TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('accepted','removed')),
 joined_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,assistant_id)
);
CREATE TABLE IF NOT EXISTS shared_assistant_sessions (
 conversation_id TEXT NOT NULL REFERENCES shared_conversations(id) ON DELETE CASCADE,
 assistant_id TEXT NOT NULL,
 session_key TEXT NOT NULL UNIQUE,
 last_context_seq INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(conversation_id,assistant_id)
);
INSERT OR IGNORE INTO shared_assistant_members(project_id,assistant_id,name,backend,model_id,thinking_effort,state,joined_at)
 SELECT project_id,assistant_id,assistant_id,assistant_backend,model_id,thinking_effort,'accepted',created_at FROM shared_conversations WHERE assistant_id<>'' ORDER BY updated_at DESC;
INSERT OR IGNORE INTO shared_assistant_sessions(conversation_id,assistant_id,session_key,last_context_seq)
 SELECT id,assistant_id,'session-shared-'||id,last_ai_message_seq FROM shared_conversations WHERE assistant_id<>'';
UPDATE shared_ai_runs SET assistant_id=COALESCE((SELECT assistant_id FROM shared_conversations WHERE id=conversation_id),'') WHERE assistant_id='';
UPDATE shared_ai_runs SET assistant_name=assistant_id WHERE assistant_name='';
UPDATE shared_messages SET author_assistant_id=COALESCE((SELECT assistant_id FROM shared_conversations WHERE id=conversation_id),'') WHERE kind='assistant' AND author_assistant_id='';
DROP INDEX IF EXISTS shared_ai_one_active;
CREATE UNIQUE INDEX IF NOT EXISTS shared_ai_one_assistant_active ON shared_ai_runs(conversation_id,assistant_id) WHERE state='running';
CREATE UNIQUE INDEX IF NOT EXISTS shared_ai_one_assistant_trigger ON shared_ai_runs(trigger_message_id,assistant_id);
`)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) AssistantMembers(ctx context.Context, projectID string, userID int64) ([]AssistantMember, error) {
	if _, err := s.ProjectForUser(ctx, projectID, userID, true); err != nil {
		return nil, err
	}
	return s.assistantMembers(ctx, projectID, "")
}
func (s *Store) assistantMembers(ctx context.Context, projectID, conversationID string) ([]AssistantMember, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT a.project_id,a.assistant_id,a.name,a.backend,a.model_id,a.thinking_effort,a.state,a.joined_at,EXISTS(SELECT 1 FROM shared_ai_runs r JOIN shared_conversations c ON c.id=r.conversation_id WHERE c.project_id=a.project_id AND r.assistant_id=a.assistant_id AND r.state='running'),EXISTS(SELECT 1 FROM shared_ai_runs r WHERE r.conversation_id=? AND r.assistant_id=a.assistant_id AND r.state='running') FROM shared_assistant_members a WHERE a.project_id=? AND a.state='accepted' ORDER BY a.joined_at,a.assistant_id`, conversationID, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := []AssistantMember{}
	for rows.Next() {
		var a AssistantMember
		var joined int64
		if err := rows.Scan(&a.ProjectID, &a.AssistantID, &a.Name, &a.Backend, &a.ModelID, &a.ThinkingEffort, &a.State, &joined, &a.Running, &a.Active); err != nil {
			return nil, err
		}
		a.JoinedAt = time.UnixMilli(joined).UTC()
		values = append(values, a)
	}
	return values, rows.Err()
}

func (s *Store) InviteAssistant(ctx context.Context, member AssistantMember, userID int64) (AssistantMember, error) {
	project, err := s.ProjectForUser(ctx, member.ProjectID, userID, true)
	if err != nil {
		return AssistantMember{}, err
	}
	if project.CurrentRole != "owner" {
		return AssistantMember{}, ErrForbidden
	}
	member.AssistantID = strings.TrimSpace(member.AssistantID)
	member.Name = strings.TrimSpace(member.Name)
	if member.AssistantID == "" || len(member.AssistantID) > 128 || member.Name == "" || !validAssistantRuntime(member.Backend, member.ModelID, member.ThinkingEffort) {
		return AssistantMember{}, errors.New("invalid_shared_runtime")
	}
	var existingBackend, state string
	err = s.db.QueryRowContext(ctx, `SELECT backend,state FROM shared_assistant_members WHERE project_id=? AND assistant_id=?`, member.ProjectID, member.AssistantID).Scan(&existingBackend, &state)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return AssistantMember{}, err
	}
	if err == nil && existingBackend != member.Backend {
		return AssistantMember{}, ErrAssistantLocked
	}
	if state == "accepted" {
		return AssistantMember{}, ErrMemberExists
	}
	stamp := s.now().UnixMilli()
	// Rejoining preserves this identity's configuration, sessions and cursors.
	_, err = s.db.ExecContext(ctx, `INSERT INTO shared_assistant_members(project_id,assistant_id,name,backend,model_id,thinking_effort,state,joined_at) VALUES(?,?,?,?,?,?,'accepted',?) ON CONFLICT(project_id,assistant_id) DO UPDATE SET state='accepted',name=excluded.name,joined_at=excluded.joined_at`, member.ProjectID, member.AssistantID, member.Name, member.Backend, member.ModelID, member.ThinkingEffort, stamp)
	if err != nil {
		return AssistantMember{}, err
	}
	members, err := s.AssistantMembers(ctx, member.ProjectID, userID)
	for _, a := range members {
		if a.AssistantID == member.AssistantID {
			return a, err
		}
	}
	return AssistantMember{}, err
}

func validAssistantRuntime(backend, model, effort string) bool {
	return (backend == "codex" || backend == "kimi") && strings.TrimSpace(model) != "" && len(model) <= 256 && (strings.TrimSpace(effort) != "" && len(effort) <= 32)
}

func (s *Store) UpdateAssistantSettings(ctx context.Context, projectID, assistantID string, userID int64, model, effort string) (AssistantMember, error) {
	project, err := s.ProjectForUser(ctx, projectID, userID, true)
	if err != nil {
		return AssistantMember{}, err
	}
	if project.CurrentRole != "owner" {
		return AssistantMember{}, ErrForbidden
	}
	values, err := s.AssistantMembers(ctx, projectID, userID)
	if err != nil {
		return AssistantMember{}, err
	}
	var current AssistantMember
	for _, a := range values {
		if a.AssistantID == assistantID {
			current = a
			break
		}
	}
	if current.AssistantID == "" {
		return AssistantMember{}, ErrNotFound
	}
	if !validAssistantRuntime(current.Backend, model, effort) {
		return AssistantMember{}, errors.New("invalid_shared_runtime")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE shared_assistant_members SET model_id=?,thinking_effort=? WHERE project_id=? AND assistant_id=? AND state='accepted' AND NOT EXISTS(SELECT 1 FROM shared_ai_runs r JOIN shared_conversations c ON c.id=r.conversation_id WHERE c.project_id=? AND r.assistant_id=? AND r.state='running')`, model, effort, projectID, assistantID, projectID, assistantID)
	if err != nil {
		return AssistantMember{}, err
	}
	if err = requireOne(result, ErrConflict); err != nil {
		return AssistantMember{}, err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE shared_conversations SET model_id=?,thinking_effort=? WHERE project_id=? AND assistant_id=?`, model, effort, projectID, assistantID)
	current.ModelID, current.ThinkingEffort = model, effort
	return current, err
}

func (s *Store) RemoveAssistant(ctx context.Context, projectID, assistantID string, userID int64) error {
	project, err := s.ProjectForUser(ctx, projectID, userID, true)
	if err != nil {
		return err
	}
	if project.CurrentRole != "owner" {
		return ErrForbidden
	}
	result, err := s.db.ExecContext(ctx, `UPDATE shared_assistant_members SET state='removed' WHERE project_id=? AND assistant_id=? AND state='accepted' AND NOT EXISTS(SELECT 1 FROM shared_ai_runs r JOIN shared_conversations c ON c.id=r.conversation_id WHERE c.project_id=? AND r.assistant_id=? AND r.state='running')`, projectID, assistantID, projectID, assistantID)
	if err != nil {
		return err
	}
	return requireOne(result, ErrConflict)
}

// Used only by legacy conversation creation. Explicit invitations are the normal path.
func (s *Store) seedConversationAssistant(ctx context.Context, c Conversation) error {
	if c.AssistantID == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO shared_assistant_members(project_id,assistant_id,name,backend,model_id,thinking_effort,state,joined_at) VALUES(?,?,?,?,?,?,'accepted',?)`, c.ProjectID, c.AssistantID, c.AssistantID, c.AssistantBackend, c.ModelID, c.ThinkingEffort, s.now().UnixMilli())
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO shared_assistant_sessions(conversation_id,assistant_id,session_key,last_context_seq) VALUES(?,?,?,0)`, c.ID, c.AssistantID, "session-shared-"+c.ID)
	return err
}

func newAssistantSessionKey() string { return "session-shared-" + rand.Text() }
