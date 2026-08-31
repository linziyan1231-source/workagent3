package imdelivery

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"workagent3/internal/imgateway"
	"workagent3/internal/runtimeapi"
)

type Handler struct {
	runtimes  runtimeapi.EmployeeRuntimeRouter
	tokenHash [sha256.Size]byte
	client    *http.Client
}

func NewHandler(runtimes runtimeapi.EmployeeRuntimeRouter, token string) (*Handler, error) {
	if runtimes == nil || len(token) < 32 {
		return nil, errors.New("runtime router and a 32-byte IM delivery token are required")
	}
	return &Handler{runtimes: runtimes, tokenHash: sha256.Sum256([]byte(token)), client: &http.Client{Timeout: 2 * time.Minute}}, nil
}

func (h *Handler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	provided, ok := strings.CutPrefix(request.Header.Get("Authorization"), "Bearer ")
	providedHash := sha256.Sum256([]byte(provided))
	if !ok || subtle.ConstantTimeCompare(providedHash[:], h.tokenHash[:]) != 1 {
		writeError(writer, http.StatusUnauthorized, "authentication_required")
		return
	}
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	var delivery imgateway.RuntimeDelivery
	decoder := json.NewDecoder(io.LimitReader(request.Body, 32<<20))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&delivery) != nil || decoder.Decode(&struct{}{}) != io.EOF || !strings.HasPrefix(delivery.TargetSID, "S-1-") || delivery.Message.ConnectorID == "" || delivery.Message.ExternalMessageID == "" {
		writeError(writer, http.StatusBadRequest, "invalid_im_delivery")
		return
	}
	endpoint, err := h.runtimes.Resolve(request.Context(), delivery.TargetSID)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "runtime_unavailable")
		return
	}
	payload, err := json.Marshal(struct {
		SessionID string                   `json:"session_id,omitempty"`
		Message   imgateway.InboundMessage `json:"message"`
	}{SessionID: delivery.SessionID, Message: delivery.Message})
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "im_delivery_failed")
		return
	}
	target := endpoint.BaseURL.ResolveReference(&url.URL{Path: "/v1/inbox/messages"})
	downstream, _ := http.NewRequestWithContext(request.Context(), http.MethodPost, target.String(), bytes.NewReader(payload))
	downstream.Header.Set("Authorization", "Bearer "+endpoint.Token)
	downstream.Header.Set("Content-Type", "application/json")
	response, err := h.client.Do(downstream)
	if err != nil {
		writeError(writer, http.StatusBadGateway, "runtime_delivery_failed")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		writeError(writer, http.StatusBadGateway, "runtime_delivery_rejected")
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusOK)
	_, _ = io.Copy(writer, io.LimitReader(response.Body, 64<<10))
}

func writeError(writer http.ResponseWriter, status int, code string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]string{"error": code})
}
