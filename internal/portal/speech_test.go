package portal

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

type speechStub struct {
	called bool
	sid    string
}

func (stub *speechStub) Capability() contracts.SpeechCapability {
	return contracts.SpeechCapability{Enabled: true, Streaming: true, MaxAudioBytes: 1024, MaxStreamSeconds: 60}
}

func (stub *speechStub) ServeSpeech(writer http.ResponseWriter, _ *http.Request, sid string) {
	stub.called = true
	stub.sid = sid
	writer.WriteHeader(http.StatusNoContent)
}

func TestSpeechRoutesUseAuthenticatedSIDAndSameOrigin(t *testing.T) {
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	user, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-700", "unused")
	if err != nil {
		t.Fatal(err)
	}
	if err := data.CreateSession(t.Context(), "session", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	adapter := &speechStub{}
	server, err := NewWithModules(data, StaticRouter{}, false, Modules{Speech: adapter})
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "http://portal.test/api/stt", nil)
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "session"})
	request.Header.Set("Origin", "http://portal.test")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || !adapter.called || adapter.sid != user.SID {
		t.Fatalf("speech proxy response %d, called=%v sid=%q", response.Code, adapter.called, adapter.sid)
	}

	crossOrigin := httptest.NewRequest(http.MethodGet, "http://portal.test/api/stt/stream", nil)
	crossOrigin.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "session"})
	crossOrigin.Header.Set("Upgrade", "websocket")
	crossOrigin.Header.Set("Origin", "https://attacker.test")
	crossOriginResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(crossOriginResponse, crossOrigin)
	if crossOriginResponse.Code != http.StatusForbidden {
		t.Fatalf("cross-origin WebSocket response: %d", crossOriginResponse.Code)
	}
}

func TestSpeechCapabilityIsAuthenticatedAndHidesCredentials(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	server, _ := NewWithModules(data, StaticRouter{}, false, Modules{})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/speech/capability", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated capability response: %d", response.Code)
	}
}
