package notifications

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"workagent3/internal/contracts"
	"workagent3/internal/runtimeapi"
)

// RuntimeAuthorizer is the runtime registration credential check, the same
// port the quota and audit runtime handlers use.
type RuntimeAuthorizer interface {
	RuntimeRegistrationAuthorized(context.Context, string, string) bool
}

type runtimeNotificationInput struct {
	SID      string `json:"sid"`
	Kind     string `json:"kind"`
	Title    string `json:"title"`
	Message  string `json:"message"`
	DeepLink string `json:"deep_link"`
}

// RuntimeHandler lets an employee UserHost publish in-app notifications to its
// own SID (automation/team terminal states). It is loopback-only and
// authenticated by the per-SID runtime registration credential; the target is
// always the authenticated SID, so a runtime cannot notify someone else.
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
		var input runtimeNotificationInput
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
		if _, err := store.Publish(request.Context(), contracts.NotificationInput{
			TargetSID: input.SID, Kind: input.Kind, Title: input.Title, Message: input.Message, DeepLink: input.DeepLink,
		}); err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_notification")
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
