package imdelivery

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"workagent3/internal/runtimeapi"
)

func TestHandlerAuthenticatesAndRoutesOnlyToTargetSIDRuntime(t *testing.T) {
	var received string
	runtime := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/inbox/messages" || request.Header.Get("Authorization") != "Bearer runtime-private-token" {
			t.Errorf("unexpected runtime request path=%s headers=%v", request.URL.Path, request.Header)
		}
		body, _ := io.ReadAll(request.Body)
		received = string(body)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"runtime_session_id":"session-1","runtime_receipt_id":"turn-1","duplicate":false}`))
	}))
	defer runtime.Close()
	registry := runtimeapi.NewRegistry()
	if err := registry.Register(runtimeapi.Registration{SID: "S-1-5-21-9000", BaseURL: runtime.URL, Token: "runtime-private-token", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(registry, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}

	payload := `{"target_sid":"S-1-5-21-9000","message":{"connector_id":"weixin","external_account_id":"bot","external_conversation_id":"chat","external_message_id":"message-1","sender":{"id":"sender","display_name":"Alice"},"text":"hello","attachments":[],"received_at":"2026-08-31T02:00:00Z"}}`
	request := httptest.NewRequest(http.MethodPost, "/internal/im/deliver", strings.NewReader(payload))
	request.Header.Set("Authorization", "Bearer 0123456789abcdef0123456789abcdef")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(received, `"external_message_id":"message-1"`) || strings.Contains(received, "target_sid") {
		t.Fatalf("delivery status=%d runtime body=%s response=%s", response.Code, received, response.Body.String())
	}

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPost, "/internal/im/deliver", strings.NewReader(payload)))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status %d", unauthorized.Code)
	}
}
