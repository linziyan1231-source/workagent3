package chatforward

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCallbackAuthenticationAndAdmission(t *testing.T) {
	ledger, subject, _ := openLedger(t)
	secret := []byte("0123456789abcdef0123456789abcdef")
	enabled := true
	proxy := &Proxy{secret: secret}
	proxy.SetQuota(ledger, func(context.Context, string) bool { return enabled })
	invoke := func(path, body, peer string, offset int64, alter bool) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		request.RemoteAddr = peer
		timestamp := strconv.FormatInt(time.Now().Unix()+offset, 10)
		digest := sha256.Sum256([]byte(body))
		mac := hmac.New(sha256.New, secret)
		mac.Write([]byte(strings.Join([]string{"POST", path, timestamp, hex.EncodeToString(digest[:])}, "\n")))
		request.Header.Set(headerTimestamp, timestamp)
		signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
		if alter {
			signature = "invalid"
		}
		request.Header.Set(headerSignature, signature)
		request.Header.Set("X-Forwarded-For", "127.0.0.1")
		response := httptest.NewRecorder()
		proxy.CallbackHandler().ServeHTTP(response, request)
		return response
	}
	payload, _ := json.Marshal(map[string]any{"user_id": subject, "logical_id": "callback_123456789", "attempt_id": "callback_123456789", "request_body": `{"action":"continue","model":"gpt-5-6-pro"}`})
	path := "/internal/chatforward/quota/reserve"
	for _, tc := range []struct {
		peer   string
		offset int64
		alter  bool
	}{{"203.0.113.2:2000", 0, false}, {"127.0.0.1:2000", -61, false}, {"127.0.0.1:2000", 0, true}} {
		if got := invoke(path, string(payload), tc.peer, tc.offset, tc.alter); got.Code != 403 {
			t.Fatalf("invalid authentication accepted: %d", got.Code)
		}
	}
	got := invoke(path, string(payload), "127.0.0.1:2000", 0, false)
	if got.Code != 200 || !strings.Contains(got.Body.String(), `"pro":true`) {
		t.Fatalf("Pro continuation not admitted: %d %s", got.Code, got.Body.String())
	}
	enabled = false
	if got = invoke(path, string(payload), "127.0.0.1:2000", 0, false); got.Code != 403 {
		t.Fatalf("disabled account admitted: %d", got.Code)
	}
	eventBody, _ := json.Marshal(struct {
		UserID int64 `json:"user_id"`
		Event
	}{subject, event("callback_123456789", "dispatch")})
	// Disabling future admission must not lose evidence of already-sent requests.
	if got = invoke("/internal/chatforward/quota/dispatch", string(eventBody), "127.0.0.1:2000", 0, false); got.Code != 200 {
		t.Fatalf("late dispatch rejected: %d %s", got.Code, got.Body.String())
	}
	usage, _ := ledger.Usage(t.Context(), "S-1-5-21-101", time.Now())
	if usage.Used != 1 {
		t.Fatal(usage)
	}
}

func TestModelClassificationFailsClosedForUnknownPro(t *testing.T) {
	for _, action := range []string{"next", "continue", "variant", ""} {
		_, pro, err := proSend(`{"action":"` + action + `","model":"gpt-5-6-pro"}`)
		if err != nil || !pro {
			t.Fatalf("action %q bypassed admission", action)
		}
	}
	if _, _, err := proSend(`{"model":"future-pro"}`); err == nil {
		t.Fatal("unknown Pro passed")
	}
	if _, pro, err := proSend(`{"model":"gpt-5-6-thinking"}`); err != nil || pro {
		t.Fatal("non-Pro charged")
	}
}
