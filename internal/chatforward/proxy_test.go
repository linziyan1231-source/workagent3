package chatforward

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workagent3/internal/contracts"
)

func TestProxyDelegatesIdentityAndStripsBrowserCredentials(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	var received *http.Request
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		received = request.Clone(request.Context())
		writer.Header().Set("Set-Cookie", "upstream=forbidden")
		writer.WriteHeader(http.StatusCreated)
	}))
	defer upstream.Close()

	secretFile := filepath.Join(t.TempDir(), "chatforward.secret")
	if err := os.WriteFile(secretFile, secret, 0o600); err != nil {
		t.Fatal(err)
	}
	proxy, err := NewProxy(upstream.URL, secretFile)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "http://portal.test/chatgpt/api/chat?stream=1", strings.NewReader("hello"))
	request.Header.Set("Cookie", "portal=session")
	request.Header.Set("Authorization", "Bearer browser-secret")
	response := httptest.NewRecorder()
	identity := contracts.ChatForwardDelegation{UserID: "42", NowUnix: 1788138000}
	proxy.ServeChatForward(response, request, identity)

	if response.Code != http.StatusCreated || response.Header().Get("Set-Cookie") != "" {
		t.Fatalf("unexpected response status=%d headers=%v", response.Code, response.Header())
	}
	if received.URL.RequestURI() != "/api/chat?stream=1" || received.Header.Get("Cookie") != "" || received.Header.Get("Authorization") != "" {
		t.Fatalf("credentials or path leaked upstream: %#v", received)
	}
	if received.Header.Get(headerUserID) != "42" || received.Header.Get(headerTimestamp) != "1788138000" {
		t.Fatalf("delegated identity missing: %v", received.Header)
	}
	expected := delegationHeaders(secret, identity, http.MethodPost, "/api/chat?stream=1")[headerSignature]
	if signature := received.Header.Get(headerSignature); signature != expected {
		t.Fatalf("signature %q does not match %q", signature, expected)
	} else if _, err := base64.RawURLEncoding.DecodeString(signature); err != nil {
		t.Fatalf("signature is not base64url: %v", err)
	}
}

func TestProxyRejectsWeakOrLinkedSecret(t *testing.T) {
	directory := t.TempDir()
	weak := filepath.Join(directory, "weak")
	if err := os.WriteFile(weak, []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewProxy("http://127.0.0.1:3000", weak); err == nil {
		t.Fatal("weak secret was accepted")
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink(weak, link); err == nil {
		if _, err := NewProxy("http://127.0.0.1:3000", link); err == nil {
			t.Fatal("symlink secret was accepted")
		}
	}
}
