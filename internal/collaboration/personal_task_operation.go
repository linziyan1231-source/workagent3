package collaboration

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// PersonalTaskOperation is the durable creation/deletion intent. It contains
// configuration and identities only, never the task's chat content.
type PersonalTaskOperation struct {
	ID               string          `json:"id"`
	UserID           int64           `json:"-"`
	CreatorSID       string          `json:"-"`
	ProjectID        string          `json:"project_id"`
	Name             string          `json:"-"`
	Configuration    json.RawMessage `json:"-"`
	RuntimeSessionID string          `json:"runtime_session_id,omitempty"`
	State            string          `json:"state"`
	Error            string          `json:"error,omitempty"`
}

func (s *Store) migratePersonalTaskOperations(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS shared_personal_task_operations (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, creator_sid TEXT NOT NULL,
 project_id TEXT NOT NULL, name TEXT NOT NULL, configuration TEXT NOT NULL,
 runtime_session_id TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL CHECK(state IN ('creating','linking','ready','deleting','deleted','rejected')),
 error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shared_personal_task_operations_pending ON shared_personal_task_operations(state,updated_at);`)
	return err
}

const personalTaskColumns = `id,user_id,creator_sid,project_id,name,configuration,runtime_session_id,state,error`

func scanPersonalTask(row interface{ Scan(...any) error }) (PersonalTaskOperation, error) {
	var op PersonalTaskOperation
	var configuration string
	err := row.Scan(&op.ID, &op.UserID, &op.CreatorSID, &op.ProjectID, &op.Name, &configuration, &op.RuntimeSessionID, &op.State, &op.Error)
	if errors.Is(err, sql.ErrNoRows) {
		return op, ErrNotFound
	}
	op.Configuration = json.RawMessage(configuration)
	return op, err
}

func (s *Store) PersonalTaskOperation(ctx context.Context, id string, userID int64) (PersonalTaskOperation, error) {
	return scanPersonalTask(s.db.QueryRowContext(ctx, `SELECT `+personalTaskColumns+` FROM shared_personal_task_operations WHERE id=? AND user_id=?`, id, userID))
}

func (s *Store) PersonalTaskForSession(ctx context.Context, sessionID string, userID int64) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT id FROM shared_personal_task_operations WHERE runtime_session_id=? AND user_id=? UNION SELECT id FROM shared_conversations WHERE kind='personal_task' AND runtime_session_id=? AND creator_user_id=? LIMIT 1`, sessionID, userID, sessionID, userID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return id, err
}

func (s *Store) BeginPersonalTask(ctx context.Context, op PersonalTaskOperation) (PersonalTaskOperation, error) {
	op.Name = strings.TrimSpace(op.Name)
	if !stableIDPattern.MatchString(op.ID) || op.UserID <= 0 || op.CreatorSID == "" || op.Name == "" || len(op.Name) > 128 || !json.Valid(op.Configuration) {
		return op, errors.New("invalid personal task")
	}
	if existing, err := s.PersonalTaskOperation(ctx, op.ID, op.UserID); err == nil {
		if existing.ProjectID != op.ProjectID || existing.Name != op.Name || string(existing.Configuration) != string(op.Configuration) || (op.RuntimeSessionID != "" && existing.RuntimeSessionID != op.RuntimeSessionID) {
			return existing, ErrConflict
		}
		return existing, nil
	} else if !errors.Is(err, ErrNotFound) {
		return op, err
	}
	project, err := s.ProjectForUser(ctx, op.ProjectID, op.UserID, true)
	if err != nil {
		return op, err
	}
	if project.State != "active" {
		return op, ErrConflict
	}
	state := "creating"
	if op.RuntimeSessionID != "" {
		state = "linking"
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO shared_personal_task_operations (`+personalTaskColumns+`,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, op.ID, op.UserID, op.CreatorSID, op.ProjectID, op.Name, string(op.Configuration), op.RuntimeSessionID, state, "", s.now().UnixMilli())
	if err != nil {
		return op, err
	}
	// A competing submit must have the same immutable request.
	return s.BeginPersonalTask(ctx, op)
}

func (s *Store) RecordPersonalTaskSession(ctx context.Context, op PersonalTaskOperation, sessionID string) error {
	if !stableIDPattern.MatchString(sessionID) {
		return errors.New("invalid runtime session")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE shared_personal_task_operations SET runtime_session_id=?,state=CASE WHEN state='deleting' THEN 'deleting' ELSE 'linking' END,error='',updated_at=? WHERE id=? AND user_id=? AND state IN ('creating','deleting') AND runtime_session_id=''`, sessionID, s.now().UnixMilli(), op.ID, op.UserID)
	if err != nil {
		return err
	}
	return requireOne(result, ErrConflict)
}

// The list pointer and the completed operation become visible together.
func (s *Store) CompletePersonalTaskCreation(ctx context.Context, op PersonalTaskOperation) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var projectState string
	err = tx.QueryRowContext(ctx, `SELECT p.state FROM shared_projects p JOIN shared_members m ON m.project_id=p.id AND m.user_id=? AND m.state='accepted' WHERE p.id=?`, op.UserID, op.ProjectID).Scan(&projectState)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	if projectState == "archived" || projectState == "failed" {
		return ErrForbidden
	}
	if projectState != "active" {
		return ErrConflict
	}
	stamp := s.now().UnixMilli()
	result, err := tx.ExecContext(ctx, `UPDATE shared_personal_task_operations SET state='ready',error='',updated_at=? WHERE id=? AND user_id=? AND state='linking' AND runtime_session_id=?`, stamp, op.ID, op.UserID, op.RuntimeSessionID)
	if err != nil {
		return err
	}
	if err = requireOne(result, ErrConflict); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO shared_conversations(id,project_id,name,assistant_id,assistant_backend,model_id,thinking_effort,state,created_at,updated_at,kind,creator_user_id,runtime_session_id) VALUES(?,?,?,'','codex','','','idle',?,?,'personal_task',?,?)`, op.ID, op.ProjectID, op.Name, stamp, stamp, op.UserID, op.RuntimeSessionID)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// Legacy list entries are enrolled before their runtime is touched. Completed
// tombstones remain so a lost DELETE response can be retried after restart.
func (s *Store) BeginPersonalTaskDeletion(ctx context.Context, id string, userID int64, sid string) (PersonalTaskOperation, error) {
	op, err := s.PersonalTaskOperation(ctx, id, userID)
	if errors.Is(err, ErrNotFound) {
		row, lookupErr := s.ConversationForUser(ctx, id, userID, true)
		if lookupErr != nil {
			return op, lookupErr
		}
		if row.Kind != "personal_task" || row.CreatorUserID != userID {
			return op, ErrForbidden
		}
		_, err = s.db.ExecContext(ctx, `INSERT INTO shared_personal_task_operations (`+personalTaskColumns+`,updated_at) VALUES(?,?,?,?,?,? ,?,'deleting','',?) ON CONFLICT(id) DO NOTHING`, id, userID, sid, row.ProjectID, row.Name, "{}", row.RuntimeSessionID, s.now().UnixMilli())
		if err != nil {
			return op, err
		}
	} else if err != nil {
		return op, err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE shared_personal_task_operations SET state='deleting',error='',updated_at=? WHERE id=? AND user_id=? AND state IN ('ready','linking','creating')`, s.now().UnixMilli(), id, userID)
	if err != nil {
		return op, err
	}
	return s.PersonalTaskOperation(ctx, id, userID)
}

func (s *Store) CompletePersonalTaskDeletion(ctx context.Context, op PersonalTaskOperation) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `DELETE FROM shared_conversations WHERE id=? AND kind='personal_task' AND creator_user_id=?`, op.ID, op.UserID); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE shared_personal_task_operations SET state='deleted',error='',updated_at=? WHERE id=? AND user_id=? AND state='deleting'`, s.now().UnixMilli(), op.ID, op.UserID)
	if err != nil {
		return err
	}
	if err = requireOne(result, ErrConflict); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) SetPersonalTaskError(ctx context.Context, op PersonalTaskOperation, code string, rejected bool) error {
	state := op.State
	if rejected {
		state = "rejected"
	}
	_, err := s.db.ExecContext(ctx, `UPDATE shared_personal_task_operations SET state=?,error=?,updated_at=? WHERE id=? AND user_id=? AND state=?`, state, code, s.now().UnixMilli(), op.ID, op.UserID, op.State)
	return err
}

func (s *Store) PendingPersonalTasks(ctx context.Context) ([]PersonalTaskOperation, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+personalTaskColumns+` FROM shared_personal_task_operations WHERE state IN ('creating','linking','deleting') ORDER BY updated_at,id LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []PersonalTaskOperation
	for rows.Next() {
		op, err := scanPersonalTask(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, op)
	}
	return result, rows.Err()
}
