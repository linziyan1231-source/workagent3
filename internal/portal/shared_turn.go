package portal

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/collaboration"
	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

func (s *Server) cancelSharedRun(writer http.ResponseWriter, request *http.Request, user store.User) {
	if s.modules.Collaboration == nil || s.modules.SharedTurns == nil {
		writeError(writer, http.StatusServiceUnavailable, "shared_turn_unavailable")
		return
	}
	var input struct {
		ConversationID string `json:"conversation_id"`
	}
	if !decodeJSON(request, &input, 16*1024) {
		writeError(writer, http.StatusBadRequest, "invalid_shared_run")
		return
	}
	messageID, err := auth.RandomToken(18)
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "shared_run_stop_failed")
		return
	}
	run, message, err := s.modules.Collaboration.StopAIRun(request.Context(), input.ConversationID, user.ID, messageID)
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	_ = s.modules.SharedTurns.Cancel(request.Context(), run.OwnerSID, run.ID)
	s.sharedEvents.publish(message)
	writeJSON(writer, http.StatusOK, map[string]any{"stopped": true})
}

func (s *Server) maybeStartSharedAI(ctx context.Context, message collaboration.Message, requesterUserID int64) bool {
	if s.modules.SharedTurns == nil {
		return false
	}
	conversation, err := s.modules.Collaboration.ConversationForUser(ctx, message.Conversation, requesterUserID, true)
	if err != nil || !mentionsAssistant(message.Mentions, conversation.AssistantID) {
		return false
	}
	runID, err := auth.RandomToken(18)
	if err != nil {
		return false
	}
	run, err := s.modules.Collaboration.ReserveAIRun(ctx, runID, message, requesterUserID)
	if err != nil {
		return false
	}
	delta, err := s.modules.Collaboration.UserMessagesRange(ctx, conversation.ID, run.ContextFromSeq, run.ContextThroughSeq)
	if err != nil {
		s.finishSharedAIRun(run, SharedTurnResult{}, err)
		return false
	}
	full, err := s.modules.Collaboration.UserMessagesRange(ctx, conversation.ID, 0, run.ContextThroughSeq)
	if err != nil {
		s.finishSharedAIRun(run, SharedTurnResult{}, err)
		return false
	}
	request := SharedTurnRequest{
		RunID: run.ID, ConversationID: conversation.ID, ProjectID: conversation.ProjectID,
		Engine: conversation.AssistantBackend, ModelID: conversation.ModelID, ThinkingEffort: conversation.ThinkingEffort,
		Context: formatSharedAIContext(delta), RecoveryContext: formatSharedAIContext(full), RuntimeSessionID: run.PreviousRuntimeSessionID,
		PayerSID: run.PayerSID,
	}
	if s.modules.SharedRunQuota != nil {
		if err := s.modules.SharedRunQuota.ReserveSharedRun(ctx, run.PayerSID, run.ID, conversation.ModelID, estimatedSharedTurnUnits(request.Context)); err != nil {
			s.finishSharedAIRun(run, SharedTurnResult{}, err)
			s.publishNotification(ctx, contracts.NotificationInput{
				TargetSID: run.PayerSID, Kind: "shared_quota", Title: "Shared AI run not started",
				Message: "Your quota could not cover the shared AI run you triggered; ask the owner or an administrator to review your budget.", DeepLink: "/",
			})
			return false
		}
	}
	go func() {
		runContext, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		result, runErr := s.modules.SharedTurns.Run(runContext, run.OwnerSID, request)
		if runErr != nil && s.modules.SharedRunQuota != nil {
			// A run that never reached the runtime-side runner (e.g. the owner
			// Runtime rejected the turn) would otherwise leak its admission
			// reservation in the reserved state; settle it with zero usage.
			// When the runner did see the turn it settles on its own first, so
			// this best-effort release is an idempotent no-op or conflict.
			_ = s.modules.SharedRunQuota.ReleaseSharedRun(context.Background(), run.PayerSID, run.ID)
		}
		s.finishSharedAIRun(run, result, runErr)
	}()
	return true
}

func mentionsAssistant(mentions []collaboration.Mention, assistantID string) bool {
	for _, mention := range mentions {
		if mention.Kind == "assistant" && mention.ID == assistantID {
			return true
		}
	}
	return false
}

func formatSharedAIContext(messages []collaboration.Message) string {
	var builder strings.Builder
	builder.WriteString("Shared project group conversation. Treat each bracketed author as a distinct human participant and use the shared workspace.\n\n")
	for _, message := range messages {
		builder.WriteString("[")
		builder.WriteString(message.AuthorName)
		if message.AuthorUserID != nil {
			builder.WriteString(" user:")
			builder.WriteString(strconv.FormatInt(*message.AuthorUserID, 10))
		}
		builder.WriteString("]\n")
		builder.WriteString(message.Body)
		for _, attachment := range message.Attachments {
			builder.WriteString("\n[attachment:")
			builder.WriteString(attachment)
			builder.WriteString("]")
		}
		builder.WriteString("\n\n")
	}
	return builder.String()
}

// estimatedSharedTurnUnits mirrors estimatedAutomationUnits in the UserHost
// quota runner so the admission reservation and the runtime-side settlement
// use the same conservative estimate for the same context.
func estimatedSharedTurnUnits(context string) int64 {
	return int64((len(context)+3)/4) + 1024
}

func (s *Server) finishSharedAIRun(run collaboration.AIRun, result SharedTurnResult, runErr error) {
	messageID, err := auth.RandomToken(18)
	if err != nil {
		return
	}
	if runErr == nil && strings.TrimSpace(result.AssistantBody) == "" {
		runErr = errors.New("shared AI returned no assistant message")
	}
	message, err := s.modules.Collaboration.FinishAIRun(context.Background(), run, messageID, result.RuntimeSessionID, result.AssistantBody, runErr)
	if err == nil {
		s.sharedEvents.publish(message)
	}
}
