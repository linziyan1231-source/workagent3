package quota

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"workagent3/internal/runtimeapi"
)

type RuntimeAuthorizer interface {
	RuntimeRegistrationAuthorized(context.Context, string, string) bool
}

type runtimeReserveInput struct {
	RunID          string `json:"runId"`
	SID            string `json:"sid"`
	ModelID        string `json:"modelId"`
	EstimatedUnits int64  `json:"estimatedUnits"`
	// PayerSID scopes a shared-run reservation to the frozen payer (the member
	// who mentioned the assistant) while the caller authenticates as the
	// runtime owner SID.
	PayerSID string `json:"payerSid,omitempty"`
}

type runtimeSettleInput struct {
	RunID       string `json:"runId"`
	SID         string `json:"sid"`
	ActualUnits int64  `json:"actualUnits"`
	PayerSID    string `json:"payerSid,omitempty"`
}

// runtimePayer returns the SID the reservation belongs to: the caller's own
// SID, or the frozen shared-run payer when one is pinned.
func runtimePayer(sid, payerSID string) string {
	if payerSID != "" {
		return payerSID
	}
	return sid
}

// RuntimeHandler exposes only the minimal quota capability required by a
// fixed SID Runtime. It is loopback-only and reuses the per-SID provisioning
// credential; it never exposes budgets or the Quota database itself.
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
		switch request.URL.Path {
		case "/internal/runtime/quota/reserve":
			var input runtimeReserveInput
			if !decodeRuntimeInput(request, &input) {
				writeRuntimeError(writer, http.StatusBadRequest, "invalid_request")
				return
			}
			if !authorizer.RuntimeRegistrationAuthorized(request.Context(), input.SID, credential) {
				writeRuntimeError(writer, http.StatusUnauthorized, "registration_rejected")
				return
			}
			reservation, err := store.ReserveForSID(request.Context(), runtimePayer(input.SID, input.PayerSID), ReserveRequest{
				RunID: input.RunID, SID: runtimePayer(input.SID, input.PayerSID), ModelID: input.ModelID, EstimatedUnits: input.EstimatedUnits,
			})
			if err != nil {
				writeQuotaError(writer, err)
				return
			}
			writeRuntimeJSON(writer, http.StatusOK, reservation)
		case "/internal/runtime/quota/settle":
			var input runtimeSettleInput
			if !decodeRuntimeInput(request, &input) {
				writeRuntimeError(writer, http.StatusBadRequest, "invalid_request")
				return
			}
			if !authorizer.RuntimeRegistrationAuthorized(request.Context(), input.SID, credential) {
				writeRuntimeError(writer, http.StatusUnauthorized, "registration_rejected")
				return
			}
			if err := store.SettleForSID(request.Context(), runtimePayer(input.SID, input.PayerSID), SettleRequest{RunID: input.RunID, ActualUnits: input.ActualUnits}); err != nil {
				writeQuotaError(writer, err)
				return
			}
			writer.WriteHeader(http.StatusNoContent)
		default:
			writeRuntimeError(writer, http.StatusNotFound, "not_found")
		}
	})
}

func decodeRuntimeInput(request *http.Request, target any) bool {
	decoder := json.NewDecoder(io.LimitReader(request.Body, 16*1024))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target) == nil && decoder.Decode(&struct{}{}) == io.EOF
}

func writeQuotaError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrExceeded):
		writeRuntimeError(writer, http.StatusTooManyRequests, "quota_exceeded")
	case errors.Is(err, ErrModelUnauthorized):
		writeRuntimeError(writer, http.StatusForbidden, "model_not_authorized")
	case errors.Is(err, ErrBudgetNotConfigured):
		writeRuntimeError(writer, http.StatusConflict, "quota_not_configured")
	case errors.Is(err, ErrIdempotencyConflict):
		writeRuntimeError(writer, http.StatusConflict, "quota_idempotency_conflict")
	case errors.Is(err, ErrReservationNotFound):
		writeRuntimeError(writer, http.StatusNotFound, "quota_reservation_not_found")
	default:
		writeRuntimeError(writer, http.StatusBadRequest, "invalid_request")
	}
}

func writeRuntimeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeRuntimeError(writer http.ResponseWriter, status int, code string) {
	writeRuntimeJSON(writer, status, map[string]string{"error": code})
}
