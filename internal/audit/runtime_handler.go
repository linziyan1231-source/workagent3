package audit

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"workagent3/internal/auth"
	"workagent3/internal/contracts"
	"workagent3/internal/runtimeapi"
)

// RuntimeAuthorizer is the runtime registration credential check, the same
// port the quota runtime handler uses.
type RuntimeAuthorizer interface {
	RuntimeRegistrationAuthorized(context.Context, string, string) bool
}

type runtimeEventInput struct {
	SID           string            `json:"sid"`
	Target        string            `json:"target"`
	Action        string            `json:"action"`
	Result        string            `json:"result"`
	CorrelationID string            `json:"correlation_id"`
	Metadata      map[string]string `json:"metadata"`
}

// RuntimeHandler receives business audit events from an employee UserHost
// (Skill/MCP lifecycle, MCP OAuth). It is loopback-only and authenticated by
// the per-SID runtime registration credential; the actor is always the
// authenticated SID, so a runtime cannot attribute events to someone else.
func RuntimeHandler(store *Store, authorizer RuntimeAuthorizer) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !runtimeapi.IsLoopbackRequest(request) {
			writeRuntimeError(writer, http.StatusForbidden, "loopback_required")
			return
		}
		credential, ok := strings.CutPrefix(request.Header.Get("Authorization"), "Bearer ")
		if !ok || credential == "" {
			writeRuntimeError(writer, http.StatusUnauthorized, "authentication_required")
			return
		}
		if request.Method != http.MethodPost {
			writer.Header().Set("Allow", "POST")
			writeRuntimeError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		var input runtimeEventInput
		decoder := json.NewDecoder(io.LimitReader(request.Body, 16*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_request")
			return
		}
		if !authorizer.RuntimeRegistrationAuthorized(request.Context(), input.SID, credential) {
			writeRuntimeError(writer, http.StatusUnauthorized, "registration_rejected")
			return
		}
		correlationID := strings.TrimSpace(input.CorrelationID)
		if correlationID == "" {
			generated, err := auth.RandomToken(18)
			if err != nil {
				writeRuntimeError(writer, http.StatusInternalServerError, "internal_error")
				return
			}
			correlationID = generated
		}
		if input.Metadata == nil {
			input.Metadata = map[string]string{}
		}
		for _, key := range []string{"client_ip", "peer_ip", "user_agent", "source_kind"} {
			delete(input.Metadata, key)
		}
		input.Metadata["source_kind"] = "employee_runtime"
		if _, err := store.Record(request.Context(), contracts.AuditInput{
			Actor: input.SID, Target: input.Target, Action: input.Action,
			Result: input.Result, CorrelationID: correlationID, Metadata: input.Metadata,
		}); err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_event")
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	})
}

func writeRuntimeError(writer http.ResponseWriter, status int, code string) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]string{"error": code})
}
