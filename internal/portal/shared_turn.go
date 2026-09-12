package portal

import (
	"context"
	"errors"
	"log"
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
		AssistantID    string `json:"assistant_id"`
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
	sharedMessageMu.Lock()
	defer sharedMessageMu.Unlock()
	run, message, err := s.modules.Collaboration.StopAssistantRun(request.Context(), input.ConversationID, input.AssistantID, user.ID, messageID)
	if err != nil {
		writeCollaborationError(writer, err)
		return
	}
	if s.modules.SharedRunQuota != nil {
		// Close an undispatched admission before sending cancellation: a late
		// runtime request must not accept work already stopped in Collaboration.
		if err := s.modules.SharedRunQuota.ReleaseSharedRun(context.WithoutCancel(request.Context()), run.PayerSID, run.ID); err != nil && !errors.Is(err, contracts.ErrQuotaRunAccepted) {
			log.Printf("Shared quota cancellation %s: %v", run.ID, err)
		}
	}
	_ = s.modules.SharedTurns.Cancel(request.Context(), run.OwnerSID, run.ID)
	s.sharedEvents.publish(message)
	writeJSON(writer, http.StatusOK, map[string]any{"stopped": true})
}

func (s *Server) maybeStartSharedAI(ctx context.Context, message collaboration.Message, requesterUserID int64) bool {
	started, _ := s.startSharedAI(ctx, message, requesterUserID)
	return started
}

type sharedAssistantOutcome struct {
	AssistantID string `json:"assistant_id"`
	Status      string `json:"status"`
	Reason      string `json:"reason,omitempty"`
}

func (s *Server) startSharedAssistants(ctx context.Context, message collaboration.Message, userID int64) []sharedAssistantOutcome {
	values := []sharedAssistantOutcome{}
	seen := map[string]bool{}
	for _, mention := range message.Mentions {
		if mention.Kind != "assistant" || seen[mention.ID] {
			continue
		}
		seen[mention.ID] = true
		started, reason := s.startSharedAssistant(ctx, message, userID, mention.ID)
		status := "blocked"
		if started {
			status = "started"
		} else if reason == "shared_run_busy" {
			status = "busy"
		}
		values = append(values, sharedAssistantOutcome{AssistantID: mention.ID, Status: status, Reason: reason})
	}
	return values
}
func (s *Server) startSharedAI(ctx context.Context, message collaboration.Message, userID int64) (bool, string) {
	results := s.startSharedAssistants(ctx, message, userID)
	for _, r := range results {
		if r.Status == "started" {
			return true, ""
		}
	}
	if len(results) > 0 {
		return false, results[0].Reason
	}
	return false, ""
}

func (s *Server) startSharedAssistant(ctx context.Context, message collaboration.Message, requesterUserID int64, assistantID string) (bool, string) {
	conversation, err := s.modules.Collaboration.ConversationForUser(ctx, message.Conversation, requesterUserID, true)
	if err != nil || !mentionsAssistant(message.Mentions, assistantID) {
		return false, ""
	}
	var agent collaboration.AssistantMember
	for _, a := range conversation.Assistants {
		if a.AssistantID == assistantID {
			agent = a
			break
		}
	}
	if agent.AssistantID == "" {
		return false, "invalid_shared_mention"
	}
	if s.modules.SharedTurns == nil {
		return false, "shared_turn_unavailable"
	}
	project, err := s.modules.Collaboration.ProjectForUser(ctx, conversation.ProjectID, requesterUserID, false)
	if err != nil {
		return false, "shared_runtime_not_authorized"
	}
	owner, err := s.store.UserByID(ctx, project.OwnerUserID)
	if err != nil {
		return false, "shared_runtime_not_authorized"
	}
	if err = s.applyMarketActions(ctx, owner); err != nil {
		return false, "market_security_update_pending"
	}
	capabilities, err := s.resolveProjectCapabilities(ctx, conversation.ProjectID, owner)
	if err != nil {
		return false, "project_capability_unavailable"
	}
	billingModel := agent.ModelID
	if s.modules.ModelAccess != nil {
		user, err := s.store.UserByID(ctx, requesterUserID)
		if err != nil {
			return false, "shared_runtime_not_authorized"
		}
		models, err := s.modules.ModelAccess.ListAuthorized(ctx, user.SID)
		if err != nil {
			return false, "model_access_failed"
		}
		billingModel = sharedBillingModel(models, agent.Backend, agent.ModelID)
		if billingModel == "" {
			return false, "shared_runtime_not_authorized"
		}
	}
	if agent.Active {
		return false, "shared_run_busy"
	}
	runID, err := auth.RandomToken(18)
	if err != nil {
		return false, "shared_turn_failed"
	}
	run, err := s.modules.Collaboration.ReserveAssistantRun(ctx, runID, message, requesterUserID, assistantID)
	if err != nil {
		return false, "shared_run_busy"
	}
	delta, err := s.modules.Collaboration.SharedMessagesRange(ctx, conversation.ID, run.ContextFromSeq, run.ContextThroughSeq)
	if err != nil {
		s.finishSharedAIRun(run, SharedTurnResult{}, err)
		return false, "shared_context_unavailable"
	}
	full, err := s.modules.Collaboration.SharedMessagesRange(ctx, conversation.ID, 0, run.ContextThroughSeq)
	if err != nil {
		s.finishSharedAIRun(run, SharedTurnResult{}, err)
		return false, "shared_context_unavailable"
	}
	request := SharedTurnRequest{
		Capabilities: &capabilities,
		RunID:        run.ID, ConversationID: conversation.ID, ProjectID: conversation.ProjectID,
		Engine: agent.Backend, ModelID: agent.ModelID, ThinkingEffort: agent.ThinkingEffort,
		Context: formatSharedAIContext(delta), RecoveryContext: formatSharedAIContext(full), RuntimeSessionID: run.PreviousRuntimeSessionID, SessionKey: run.SessionKey,
		PayerSID:     run.PayerSID,
		AssistantID:  agent.AssistantID,
		QuotaModelID: billingModel,
	}
	if len(request.Context) > 512*1024 || len(request.RecoveryContext) > 768*1024 {
		s.finishSharedAIRun(run, SharedTurnResult{}, errors.New("shared_context_too_large"))
		return false, "shared_context_too_large"
	}
	if s.modules.SharedRunQuota != nil {
		if err := s.modules.SharedRunQuota.ReserveSharedRun(ctx, contracts.SharedRunQuotaRequest{RunID: run.ID, OwnerSID: run.OwnerSID, PayerSID: run.PayerSID, ModelID: billingModel, Engine: agent.Backend, EstimatedUnits: estimatedSharedTurnUnits(request.Context)}); err != nil {
			s.finishSharedAIRun(run, SharedTurnResult{}, err)
			s.publishNotification(ctx, contracts.NotificationInput{
				TargetSID: run.PayerSID, Kind: "shared_quota", Title: "Shared AI run not started",
				Message: "Your quota could not cover the shared AI run you triggered; ask the owner or an administrator to review your budget.", DeepLink: "/",
			})
			return false, "quota_exceeded"
		}
	}
	go func() {
		runContext, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		result, runErr := s.modules.SharedTurns.Run(runContext, run.OwnerSID, request)
		if runErr != nil && s.modules.SharedRunQuota != nil {
			// Close only an admission the runtime never accepted. A transport
			// failure after acceptance leaves accounting to durable recovery.
			if releaseErr := s.modules.SharedRunQuota.ReleaseSharedRun(context.Background(), run.PayerSID, run.ID); releaseErr != nil {
				log.Printf("Shared AI run %s admission remains pending: %v", run.ID, releaseErr)
			}
		}
		s.finishSharedAIRun(run, result, runErr)
	}()
	return true, ""
}

func mentionsAssistant(mentions []collaboration.Mention, assistantID string) bool {
	if assistantID == "" {
		return false
	}
	for _, mention := range mentions {
		if mention.Kind == "assistant" && mention.ID == assistantID {
			return true
		}
	}
	return false
}

func formatSharedAIContext(messages []collaboration.Message) string {
	var builder strings.Builder
	builder.WriteString("Shared project group conversation. Authors include employees and assistants; respect their labeled identities and use the shared workspace. Only the current user mention requests your reply; other assistants have independent sessions.\n\n")
	for _, message := range messages {
		builder.WriteString("[")
		builder.WriteString(message.AuthorName)
		if message.AuthorUserID != nil {
			builder.WriteString(" user:")
			builder.WriteString(strconv.FormatInt(*message.AuthorUserID, 10))
		}
		if message.AuthorAssistantID != "" {
			builder.WriteString(" assistant:")
			builder.WriteString(message.AuthorAssistantID)
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
	if runErr != nil {
		log.Printf("Shared AI run %s (conversation %s, assistant %s, engine %s) failed: %v", run.ID, run.ConversationID, run.AssistantID, run.Engine, runErr)
	}
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
