package speech

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBatchProxyInjectsSIDCredentialAndStripsBrowserSecrets(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/stt" || request.Header.Get("Authorization") != "Bearer speech-adapter-secret-123" || request.Header.Get("X-WorkAgent-SID") != "S-1-5-21-900" {
			t.Fatalf("unexpected upstream request: %s %#v", request.URL.Path, request.Header)
		}
		if request.Header.Get("Cookie") != "" || request.Header.Get("X-API-Key") != "" || request.Header.Get("X-WorkAgent-Forged") != "" {
			t.Fatalf("browser credentials leaked upstream: %#v", request.Header)
		}
		body, _ := io.ReadAll(request.Body)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"success":true,"data":{"text":"` + string(body) + `"}}`))
	}))
	defer upstream.Close()

	proxy, err := NewProxy(upstream.URL, "speech-adapter-secret-123", 1024, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "http://portal.test/api/stt", strings.NewReader("audio"))
	request.Header.Set("Cookie", "browser-session")
	request.Header.Set("X-API-Key", "browser-key")
	request.Header.Set("X-WorkAgent-Forged", "forged")
	response := httptest.NewRecorder()
	proxy.ServeSpeech(response, request, "S-1-5-21-900")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"text":"audio"`) {
		t.Fatalf("unexpected response %d: %s", response.Code, response.Body.String())
	}
}

func TestProxyFailsClosedAndLimitsBatchBody(t *testing.T) {
	disabled, err := NewProxy("", "", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if disabled.Capability().Enabled {
		t.Fatal("disabled proxy advertised speech")
	}
	disabledResponse := httptest.NewRecorder()
	disabled.ServeSpeech(disabledResponse, httptest.NewRequest(http.MethodPost, "/api/stt", nil), "S-1-5-21-1")
	if disabledResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled response: %d", disabledResponse.Code)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("oversized body reached speech adapter")
	}))
	defer upstream.Close()
	limited, _ := NewProxy(upstream.URL, "speech-adapter-secret-123", 4, time.Minute)
	request := httptest.NewRequest(http.MethodPost, "/api/stt", strings.NewReader("12345"))
	response := httptest.NewRecorder()
	limited.ServeSpeech(response, request, "S-1-5-21-1")
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized response: %d %s", response.Code, response.Body.String())
	}
}

func TestConfiguredProxyRequiresPrivateCredential(t *testing.T) {
	if _, err := NewProxy("https://speech.example", "short", 0, 0); err == nil {
		t.Fatal("configured proxy accepted a weak or missing adapter credential")
	}
}
