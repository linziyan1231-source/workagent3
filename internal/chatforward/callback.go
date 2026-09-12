package chatforward

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Model classification is explicit configuration, shared with the managed
// browser's request admission. Unrecognized Pro model names fail closed.
var defaultProModels = []string{"gpt-5-4-pro", "gpt-5-5-pro", "gpt-5-6-pro"}

func proSend(body string) (string, bool, error) {
	var v struct {
		Model     string `json:"model"`
		ModelSlug string `json:"model_slug"`
	}
	if len(body) > 16*1024*1024 || json.Unmarshal([]byte(body), &v) != nil {
		return "", false, errors.New("invalid conversation request")
	}
	model := strings.ToLower(strings.TrimSpace(v.ModelSlug))
	if model == "" {
		model = strings.ToLower(strings.TrimSpace(v.Model))
	}
	for _, candidate := range defaultProModels {
		if model == candidate {
			return model, true, nil
		}
	}
	if strings.Contains(model, "pro") {
		return "", false, errors.New("unrecognized Pro model")
	}
	return model, false, nil
}

func callbackJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func callbackError(w http.ResponseWriter, status int, code string) {
	callbackJSON(w, status, map[string]any{"success": false, "code": code})
}

// CallbackHandler belongs on Portal's internal root mux; authentication uses
// the socket peer and a body-bound signature, never browser cookies or XFF.
func (p *Proxy) CallbackHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p.quota == nil {
			callbackError(w, 503, "quota_unavailable")
			return
		}
		if r.Method != http.MethodPost || r.URL.RawQuery != "" {
			callbackError(w, 405, "invalid_method")
			return
		}
		if r.URL.Path != "/internal/chatforward/quota/reserve" && r.URL.Path != "/internal/chatforward/quota/dispatch" && r.URL.Path != "/internal/chatforward/quota/settle" {
			callbackError(w, 404, "not_found")
			return
		}
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
			callbackError(w, 403, "invalid_signature")
			return
		}
		timestamp, err := strconv.ParseInt(r.Header.Get(headerTimestamp), 10, 64)
		delta := time.Now().Unix() - timestamp
		if err != nil || delta < -60 || delta > 60 {
			callbackError(w, 403, "invalid_signature")
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 20*1024*1024+1))
		if err != nil || len(body) > 20*1024*1024 {
			callbackError(w, 413, "request_too_large")
			return
		}
		digest := sha256.Sum256(body)
		mac := hmac.New(sha256.New, p.secret)
		_, _ = mac.Write([]byte(strings.Join([]string{r.Method, r.URL.Path, strconv.FormatInt(timestamp, 10), hex.EncodeToString(digest[:])}, "\n")))
		provided, err := base64.RawURLEncoding.DecodeString(r.Header.Get(headerSignature))
		if err != nil || !hmac.Equal(provided, mac.Sum(nil)) {
			callbackError(w, 403, "invalid_signature")
			return
		}
		var input struct {
			UserID      int64  `json:"user_id"`
			RequestBody string `json:"request_body,omitempty"`
			Event
		}
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF || input.UserID <= 0 {
			callbackError(w, 400, "invalid_request")
			return
		}
		if r.URL.Path == "/internal/chatforward/quota/reserve" {
			sid, err := p.quota.SubjectSID(r.Context(), input.UserID)
			if err != nil || !p.enabled(r.Context(), sid) {
				callbackError(w, 403, "account_unavailable")
				return
			}
			model, pro, err := proSend(input.RequestBody)
			if err != nil {
				callbackError(w, 400, "invalid_model_request")
				return
			}
			if !pro {
				callbackJSON(w, 200, map[string]any{"success": true, "allowed": true, "pro": false})
				return
			}
			reservation, err := p.quota.Reserve(r.Context(), input.UserID, input.LogicalID, input.AttemptID, model, time.Now())
			if err != nil {
				writeCallbackStoreError(w, err)
				return
			}
			callbackJSON(w, 200, map[string]any{"success": true, "allowed": reservation.Allowed, "pro": true, "logical_id": reservation.LogicalID, "attempt_id": reservation.AttemptID, "requested_model": model, "code": reservation.Code, "used": reservation.Usage.Used + reservation.Usage.Pending, "limit": reservation.Usage.Limit, "reset_at": reservation.Usage.ResetAt, "quota": reservation.Usage, "policy": PolicyVersion})
			return
		}
		if (r.URL.Path == "/internal/chatforward/quota/dispatch" && input.Kind != "dispatch" && input.Kind != "unknown" && input.Kind != "cancel") || (r.URL.Path == "/internal/chatforward/quota/settle" && input.Kind != "settle") {
			callbackError(w, 400, "invalid_event_kind")
			return
		}
		if err := p.quota.ApplyEvent(r.Context(), input.UserID, input.Event, time.Now()); err != nil {
			writeCallbackStoreError(w, err)
			return
		}
		callbackJSON(w, 200, map[string]any{"success": true, "event_id": input.EventID})
	})
}
func writeCallbackStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrInvalid) {
		callbackError(w, 400, "invalid_request")
	} else if errors.Is(err, ErrConflict) {
		callbackError(w, 409, "idempotency_conflict")
	} else if errors.Is(err, ErrNotFound) {
		callbackError(w, 404, "request_not_found")
	} else {
		callbackError(w, 500, "quota_unavailable")
	}
}
