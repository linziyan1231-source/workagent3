package collaboration

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"workagent3/internal/contracts"
)

type AIRun struct {
	ID                       string
	AssistantID              string
	AssistantName            string
	ModelID                  string
	ThinkingEffort           string
	SessionKey               string
	ConversationID           string
	TriggerMessageID         string
	Engine                   string
	OwnerUserID              int64
	OwnerSID                 string
	PayerUserID              int64
	PayerSID                 string
	ContextFromSeq           int64
	ContextThroughSeq        int64
	PreviousRuntimeSessionID string
}

func (s *Store) recoverInterruptedRuns(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `SELECT id,conversation_id FROM shared_ai_runs WHERE state='running' ORDER BY created_at,id`)
	if err != nil {
		return err
	}
	type interrupted struct{ runID, conversationID string }
	var runs []interrupted
	for rows.Next() {
		var run interrupted
		if err := rows.Scan(&run.runID, &run.conversationID); err != nil {
			rows.Close()
			return err
		}
		runs = append(runs, run)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(runs) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stamp := s.now().UTC().UnixMilli()
	for _, run := range runs {
		if _, err := tx.ExecContext(ctx, `UPDATE shared_ai_runs SET state='failed',finished_at=? WHERE id=? AND state='running'`, stamp, run.runID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE shared_conversations SET state='idle',updated_at=? WHERE id=? AND state='running'`, stamp, run.conversationID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO shared_messages(id,conversation_id,author_name,kind,body,created_at) VALUES(?,?,'System','system','AI run was interrupted by a Portal restart; its triggering messages remain available for retry.',?)`, "recovery_"+run.runID, run.conversationID, stamp); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ReserveAIRun(ctx context.Context, runID string, message Message, payerUserID int64) (AIRun, error) {
	conversation, err := s.ConversationForUser(ctx, message.Conversation, payerUserID, true)
	if err != nil {
		return AIRun{}, err
	}
	return s.ReserveAssistantRun(ctx, runID, message, payerUserID, conversation.AssistantID)
}

func (s *Store) ReserveAssistantRun(ctx context.Context, runID string, message Message, payerUserID int64, assistantID string) (AIRun, error) {
	if !stableIDPattern.MatchString(strings.TrimSpace(runID)) || message.Seq <= 0 || !stableIDPattern.MatchString(message.ID) || payerUserID <= 0 || assistantID == "" {
		return AIRun{}, errors.New("shared AI reservation is invalid")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AIRun{}, err
	}
	defer tx.Rollback()
	var run AIRun
	var projectState string
	err = tx.QueryRowContext(ctx, `SELECT c.id,a.assistant_id,a.name,a.backend,a.model_id,a.thinking_effort,p.owner_user_id,p.owner_sid,m.sid,p.state FROM shared_conversations c JOIN shared_projects p ON p.id=c.project_id JOIN shared_members m ON m.project_id=p.id AND m.user_id=? AND m.state='accepted' JOIN shared_assistant_members a ON a.project_id=p.id AND a.assistant_id=? AND a.state='accepted' WHERE c.id=?`, payerUserID, assistantID, message.Conversation).Scan(&run.ConversationID, &run.AssistantID, &run.AssistantName, &run.Engine, &run.ModelID, &run.ThinkingEffort, &run.OwnerUserID, &run.OwnerSID, &run.PayerSID, &projectState)
	if errors.Is(err, sql.ErrNoRows) {
		return AIRun{}, ErrForbidden
	}
	if err != nil {
		return AIRun{}, err
	}
	if projectState != "active" {
		return AIRun{}, ErrConflict
	}
	var attempted, active bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM shared_ai_runs WHERE trigger_message_id=? AND assistant_id=?),EXISTS(SELECT 1 FROM shared_ai_runs WHERE conversation_id=? AND assistant_id=? AND state='running')`, message.ID, assistantID, message.Conversation, assistantID).Scan(&attempted, &active); err != nil {
		return AIRun{}, err
	}
	if attempted || active {
		return AIRun{}, ErrConflict
	}
	if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO shared_assistant_sessions(conversation_id,assistant_id,session_key,last_context_seq) VALUES(?,?,?,0)`, message.Conversation, assistantID, newAssistantSessionKey()); err != nil {
		return AIRun{}, err
	}
	var last int64
	if err = tx.QueryRowContext(ctx, `SELECT session_key,last_context_seq FROM shared_assistant_sessions WHERE conversation_id=? AND assistant_id=?`, message.Conversation, assistantID).Scan(&run.SessionKey, &last); err != nil {
		return AIRun{}, err
	}
	if message.Seq <= last {
		return AIRun{}, ErrConflict
	}
	run.ID, run.TriggerMessageID, run.PayerUserID = runID, message.ID, payerUserID
	run.ContextFromSeq, run.ContextThroughSeq = last+1, message.Seq
	if last == 0 {
		run.ContextFromSeq = 0
	}
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(runtime_session_id,'') FROM shared_ai_runs WHERE conversation_id=? AND assistant_id=? AND state='succeeded' ORDER BY finished_at DESC,rowid DESC LIMIT 1`, message.Conversation, assistantID).Scan(&run.PreviousRuntimeSessionID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return AIRun{}, err
	}
	stamp := s.now().UnixMilli()
	_, err = tx.ExecContext(ctx, `INSERT INTO shared_ai_runs(id,conversation_id,trigger_message_id,assistant_id,assistant_name,engine,state,owner_user_id,owner_sid,context_from_seq,context_through_seq,created_at) VALUES(?,?,?,?,?,?,'running',?,?,?,?,?)`, run.ID, run.ConversationID, run.TriggerMessageID, run.AssistantID, run.AssistantName, run.Engine, run.OwnerUserID, run.OwnerSID, run.ContextFromSeq, run.ContextThroughSeq, stamp)
	if err != nil {
		return AIRun{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO shared_ai_run_payers(run_id,user_id,sid,share_denominator) VALUES(?,?,?,1)`, run.ID, run.PayerUserID, run.PayerSID); err != nil {
		return AIRun{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE shared_conversations SET state='running',updated_at=? WHERE id=?`, stamp, run.ConversationID); err != nil {
		return AIRun{}, err
	}
	if err = tx.Commit(); err != nil {
		return AIRun{}, err
	}
	return run, nil
}

func (s *Store) SharedMessagesRange(ctx context.Context, conversationID string, fromSeq, throughSeq int64) ([]Message, error) {
	return s.listMessages(ctx, `m.conversation_id=? AND m.seq>=? AND m.seq<=?`, []any{conversationID, fromSeq, throughSeq, -1})
}

func (s *Store) UserMessagesRange(ctx context.Context, conversationID string, fromSeq, throughSeq int64) ([]Message, error) {
	return s.listMessages(ctx, `m.conversation_id=? AND m.seq>=? AND m.seq<=? AND m.kind='user'`, []any{conversationID, fromSeq, throughSeq, -1})
}

func (s *Store) FinishAIRun(ctx context.Context, run AIRun, resultMessageID, runtimeSessionID, assistantBody string, runErr error) (Message, error) {
	resultMessageID, runtimeSessionID, assistantBody = strings.TrimSpace(resultMessageID), strings.TrimSpace(runtimeSessionID), strings.TrimSpace(assistantBody)
	if !stableIDPattern.MatchString(resultMessageID) || (runErr == nil && (runtimeSessionID == "" || assistantBody == "")) {
		return Message{}, errors.New("shared AI result is invalid")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback()
	state, kind, body := "succeeded", "assistant", assistantBody
	if runErr != nil {
		state, kind, body = "failed", "system", sharedRunFailureBody(runErr)
	}
	stamp := s.now().UTC().UnixMilli()
	result, err := tx.ExecContext(ctx, `UPDATE shared_ai_runs SET state=?,runtime_session_id=?,finished_at=? WHERE id=? AND state='running'`, state, nullableString(runtimeSessionID), stamp, run.ID)
	if err != nil {
		return Message{}, err
	}
	if err := requireOne(result, ErrConflict); err != nil {
		return Message{}, err
	}
	messageResult, err := tx.ExecContext(ctx, `INSERT INTO shared_messages(id,conversation_id,author_name,author_assistant_id,kind,body,created_at) VALUES(?,?,?,?,?,?,?)`, resultMessageID, run.ConversationID, run.AssistantName, run.AssistantID, kind, body, stamp)
	if err != nil {
		return Message{}, err
	}
	seq, err := messageResult.LastInsertId()
	if err != nil {
		return Message{}, err
	}
	lastAI := int64(0)
	if runErr == nil {
		lastAI = run.ContextThroughSeq
	}
	if lastAI > 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE shared_assistant_sessions SET last_context_seq=? WHERE conversation_id=? AND assistant_id=?`, lastAI, run.ConversationID, run.AssistantID); err != nil {
			return Message{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE shared_conversations SET state=CASE WHEN EXISTS(SELECT 1 FROM shared_ai_runs r WHERE r.conversation_id=shared_conversations.id AND r.state='running') THEN 'running' ELSE 'idle' END,last_ai_message_seq=CASE WHEN ?>0 AND assistant_id=? THEN ? ELSE last_ai_message_seq END,updated_at=? WHERE id=?`, lastAI, run.AssistantID, lastAI, stamp, run.ConversationID); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	return Message{Seq: seq, ID: resultMessageID, Conversation: run.ConversationID, AuthorName: run.AssistantName, AuthorAssistantID: run.AssistantID, Kind: kind, Body: body, Mentions: []Mention{}, Attachments: []string{}, CreatedAt: time.UnixMilli(stamp).UTC()}, nil
}

func (s *Store) StopAIRun(ctx context.Context, conversationID string, userID int64, messageID string) (AIRun, Message, error) {
	return s.StopAssistantRun(ctx, conversationID, "", userID, messageID)
}
func (s *Store) StopAssistantRun(ctx context.Context, conversationID, assistantID string, userID int64, messageID string) (AIRun, Message, error) {
	if !stableIDPattern.MatchString(strings.TrimSpace(conversationID)) || !stableIDPattern.MatchString(strings.TrimSpace(messageID)) || userID <= 0 {
		return AIRun{}, Message{}, errors.New("shared AI stop is invalid")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AIRun{}, Message{}, err
	}
	defer tx.Rollback()
	var run AIRun
	err = tx.QueryRowContext(ctx, `SELECT r.id,r.conversation_id,r.trigger_message_id,r.engine,r.owner_user_id,r.owner_sid,r.context_from_seq,r.context_through_seq,p.user_id,p.sid,r.assistant_id,r.assistant_name FROM shared_ai_runs r JOIN shared_ai_run_payers p ON p.run_id=r.id WHERE r.conversation_id=? AND (?='' OR r.assistant_id=?) AND r.state='running' AND EXISTS(SELECT 1 FROM shared_conversations c JOIN shared_members m ON m.project_id=c.project_id AND m.user_id=? AND m.state='accepted' WHERE c.id=r.conversation_id) ORDER BY r.created_at,r.id LIMIT 1`, conversationID, assistantID, assistantID, userID).Scan(&run.ID, &run.ConversationID, &run.TriggerMessageID, &run.Engine, &run.OwnerUserID, &run.OwnerSID, &run.ContextFromSeq, &run.ContextThroughSeq, &run.PayerUserID, &run.PayerSID, &run.AssistantID, &run.AssistantName)
	if errors.Is(err, sql.ErrNoRows) {
		return AIRun{}, Message{}, ErrNotFound
	}
	if err != nil {
		return AIRun{}, Message{}, err
	}
	stamp := s.now().UTC().UnixMilli()
	if _, err := tx.ExecContext(ctx, `UPDATE shared_ai_runs SET state='stopped',finished_at=? WHERE id=? AND state='running'`, stamp, run.ID); err != nil {
		return AIRun{}, Message{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE shared_conversations SET state=CASE WHEN EXISTS(SELECT 1 FROM shared_ai_runs r WHERE r.conversation_id=shared_conversations.id AND r.state='running') THEN 'running' ELSE 'idle' END,updated_at=? WHERE id=?`, stamp, conversationID); err != nil {
		return AIRun{}, Message{}, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO shared_messages(id,conversation_id,author_name,kind,body,created_at) VALUES(?,?,'System','system','AI run was stopped. Messages sent during the run remain in the next shared context.',?)`, messageID, conversationID, stamp)
	if err != nil {
		return AIRun{}, Message{}, err
	}
	seq, err := result.LastInsertId()
	if err != nil {
		return AIRun{}, Message{}, err
	}
	if err := tx.Commit(); err != nil {
		return AIRun{}, Message{}, err
	}
	message := Message{Seq: seq, ID: messageID, Conversation: conversationID, AuthorName: "System", Kind: "system", Body: "AI run was stopped. Messages sent during the run remain in the next shared context.", Mentions: []Mention{}, Attachments: []string{}, CreatedAt: time.UnixMilli(stamp).UTC()}
	return run, message, nil
}

// sharedRunFailureBody gives conversation participants an actionable reason
// when the run was rejected at admission; generic failures stay vague because
// the trigger messages remain retryable.
func sharedRunFailureBody(runErr error) string {
	switch {
	case errors.Is(runErr, contracts.ErrQuotaExceeded):
		return "AI run was not started: the quota of the member who mentioned the assistant is exhausted."
	case errors.Is(runErr, contracts.ErrQuotaNotConfigured):
		return "AI run was not started: no quota budget is configured for the member who mentioned the assistant."
	case errors.Is(runErr, contracts.ErrModelUnauthorized):
		return "AI run was not started: the member who mentioned the assistant is not authorized for this model."
	default:
		return "AI run failed; the triggering messages remain available for retry."
	}
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
