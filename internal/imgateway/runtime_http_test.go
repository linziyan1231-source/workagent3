package imgateway

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPRuntimeDeliveryCarriesReplyBackToGateway(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/im/deliver" || request.Header.Get("Authorization") != "Bearer 0123456789abcdef0123456789abcdef" {
			t.Fatalf("unexpected Runtime delivery request: %s %v", request.URL.Path, request.Header)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"runtime_session_id":"session-1","runtime_receipt_id":"inbox-1","duplicate":false,"reply_text":"hello back"}`))
	}))
	defer server.Close()
	delivery, err := NewHTTPRuntimeDelivery(server.URL, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := delivery.Deliver(t.Context(), RuntimeDelivery{TargetSID: "S-1-5-21-9000", Message: message()})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ReplyText != "hello back" || receipt.RuntimeReceiptID != "inbox-1" {
		t.Fatalf("Runtime reply was not preserved: %#v", receipt)
	}
}
