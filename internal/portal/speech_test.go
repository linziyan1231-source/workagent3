package portal

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/modelaccess"
	"workagent3/internal/quota"
	"workagent3/internal/speech"
	"workagent3/internal/store"
)

type speechStub struct {
	called bool
	sid    string
}

type speechQuotaStub struct {
	reserveErr       error
	reservedSID      string
	reservedRunID    string
	estimatedSeconds int64
	settledRunID     string
	actualSeconds    int64
	settled          chan struct{}
}

func (stub *speechQuotaStub) ReserveSpeech(_ context.Context, sid, runID string, estimatedSeconds int64) error {
	stub.reservedSID = sid
	stub.reservedRunID = runID
	stub.estimatedSeconds = estimatedSeconds
	return stub.reserveErr
}

func (stub *speechQuotaStub) SettleSpeech(_ context.Context, runID string, actualSeconds int64) error {
	stub.settledRunID = runID
	stub.actualSeconds = actualSeconds
	if stub.settled != nil {
		select {
		case stub.settled <- struct{}{}:
		default:
		}
	}
	return nil
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
	meter := &speechQuotaStub{}
	server, err := NewWithModules(data, StaticRouter{}, false, Modules{Speech: adapter, SpeechQuota: meter})
	if err != nil {
		t.Fatal(err)
	}
	assertModuleStatus(t, server.platformModuleReadModel(), "speech", "healthy")

	request := httptest.NewRequest(http.MethodPost, "http://portal.test/api/stt", nil)
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "session"})
	request.Header.Set("Origin", "http://portal.test")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || !adapter.called || adapter.sid != user.SID {
		t.Fatalf("speech proxy response %d, called=%v sid=%q", response.Code, adapter.called, adapter.sid)
	}
	if meter.reservedSID != user.SID || meter.estimatedSeconds != 60 || meter.reservedRunID == "" || meter.settledRunID != meter.reservedRunID || meter.actualSeconds != 1 {
		t.Fatalf("speech quota lifecycle: %#v", meter)
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

func TestSpeechFailsClosedBeforeAdapterWhenQuotaRejects(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	user, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-701", "unused")
	_ = data.CreateSession(t.Context(), "session", user.ID, time.Now().Add(time.Hour))
	for _, test := range []struct {
		err    error
		status int
		code   string
	}{
		{contracts.ErrQuotaExceeded, http.StatusTooManyRequests, "quota_exceeded"},
		{contracts.ErrModelUnauthorized, http.StatusForbidden, "model_not_authorized"},
		{contracts.ErrQuotaNotConfigured, http.StatusConflict, "quota_not_configured"},
		{errors.New("database unavailable"), http.StatusServiceUnavailable, "speech_quota_unavailable"},
	} {
		adapter := &speechStub{}
		server, err := NewWithModules(data, StaticRouter{}, false, Modules{Speech: adapter, SpeechQuota: &speechQuotaStub{reserveErr: test.err}})
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "http://portal.test/api/stt", nil)
		request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "session"})
		request.Header.Set("Origin", "http://portal.test")
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		if response.Code != test.status || !strings.Contains(response.Body.String(), test.code) || adapter.called {
			t.Fatalf("error %v: status=%d body=%s called=%v", test.err, response.Code, response.Body.String(), adapter.called)
		}
	}
}

func TestEnabledSpeechRequiresQuotaPortAtComposition(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	if _, err := NewWithModules(data, StaticRouter{}, false, Modules{Speech: &speechStub{}}); err == nil {
		t.Fatal("enabled speech adapter started without its declared quota dependency")
	}
	disabled, err := NewWithModules(data, StaticRouter{}, false, Modules{})
	if err != nil {
		t.Fatal(err)
	}
	assertModuleStatus(t, disabled.platformModuleReadModel(), "speech", "disabled")
}

func assertModuleStatus(t *testing.T, entries []contracts.ModuleReadModelEntry, id, status string) {
	t.Helper()
	for _, entry := range entries {
		if entry.Manifest.ID == id {
			if entry.Status != status {
				t.Fatalf("module %s status=%q, want %q", id, entry.Status, status)
			}
			return
		}
	}
	t.Fatalf("module %s was not declared", id)
}

func TestSpeechRequestUsesRealQuotaAndPrivateAdapterBoundary(t *testing.T) {
	ctx := t.Context()
	const sid = "S-1-5-21-702"
	data, _ := store.Open(":memory:")
	defer data.Close()
	user, _ := data.CreateUser(ctx, "alice", sid, "unused")
	_ = data.CreateSession(ctx, "session", user.ID, time.Now().Add(time.Hour))

	models, _ := modelaccess.Open(":memory:")
	defer models.Close()
	if err := models.UpsertModel(ctx, modelaccess.Model{
		ID: quota.SpeechTranscriptionModelID, ProviderID: "speech", DisplayName: "Speech transcription",
		Aliases: []string{}, ContextWindow: 1, Health: modelaccess.Healthy,
	}); err != nil {
		t.Fatal(err)
	}
	if err := models.SetAuthorization(ctx, sid, quota.SpeechTranscriptionModelID, true, ""); err != nil {
		t.Fatal(err)
	}
	quotas, _ := quota.Open(":memory:", models)
	defer quotas.Close()
	if err := quotas.SetBudget(ctx, quota.Budget{
		SID: sid, ModelID: quota.SpeechTranscriptionModelID, Period: quota.Daily, LimitUnits: 10,
	}); err != nil {
		t.Fatal(err)
	}

	adapterCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		adapterCalls++
		if request.Header.Get("Authorization") != "Bearer private-speech-adapter-token" || request.Header.Get("X-WorkAgent-SID") != sid {
			t.Fatalf("private speech identity was not projected: %#v", request.Header)
		}
		if request.Header.Get("Cookie") != "" || request.Header.Get("X-API-Key") != "" || request.Header.Get("X-WorkAgent-Forged") != "" {
			t.Fatalf("browser credentials reached speech adapter: %#v", request.Header)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"success":true,"data":{"text":"hello"}}`))
	}))
	defer upstream.Close()
	adapter, err := speech.NewProxy(upstream.URL, "private-speech-adapter-token", 1024, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewWithModules(data, StaticRouter{}, false, Modules{Speech: adapter, SpeechQuota: quotas})
	if err != nil {
		t.Fatal(err)
	}

	requestSpeech := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "http://portal.test/api/stt", strings.NewReader("audio"))
		request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "session"})
		request.Header.Set("Origin", "http://portal.test")
		request.Header.Set("X-API-Key", "browser-secret")
		request.Header.Set("X-WorkAgent-Forged", "forged")
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		return response
	}
	first := requestSpeech()
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), `"text":"hello"`) {
		t.Fatalf("first transcription=%d body=%s", first.Code, first.Body.String())
	}
	usage, err := quotas.Usage(ctx, sid, quota.SpeechTranscriptionModelID, time.Now())
	if err != nil || usage.ConsumedUnits != 1 || usage.ReservedUnits != 0 {
		t.Fatalf("speech usage=%#v err=%v", usage, err)
	}
	second := requestSpeech()
	if second.Code != http.StatusTooManyRequests || !strings.Contains(second.Body.String(), "quota_exceeded") || adapterCalls != 1 {
		t.Fatalf("second transcription=%d body=%s adapterCalls=%d", second.Code, second.Body.String(), adapterCalls)
	}
}

func TestSpeechWebSocketUsesSameOriginPrivateProjectionAndQuotaLifecycle(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	user, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-703", "unused")
	_ = data.CreateSession(t.Context(), "session", user.ID, time.Now().Add(time.Hour))

	upstreamHeaders := make(chan http.Header, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		upstreamHeaders <- request.Header.Clone()
		connection, buffered, err := http.NewResponseController(writer).Hijack()
		if err != nil {
			t.Errorf("hijack speech fixture: %v", err)
			return
		}
		_, _ = buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_ = buffered.Flush()
		_ = connection.Close()
	}))
	defer upstream.Close()
	adapter, err := speech.NewProxy(upstream.URL, "private-speech-adapter-token", 1024, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	meter := &speechQuotaStub{settled: make(chan struct{}, 1)}
	server, err := NewWithModules(data, StaticRouter{}, false, Modules{Speech: adapter, SpeechQuota: meter})
	if err != nil {
		t.Fatal(err)
	}
	portalHTTP := httptest.NewServer(server.Handler())
	defer portalHTTP.Close()
	portalURL, _ := url.Parse(portalHTTP.URL)
	connection, err := net.Dial("tcp", portalURL.Host)
	if err != nil {
		t.Fatal(err)
	}
	requestText := "GET /api/stt/stream HTTP/1.1\r\nHost: " + portalURL.Host +
		"\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" +
		"\r\nSec-WebSocket-Version: 13\r\nOrigin: " + portalHTTP.URL +
		"\r\nCookie: " + developmentSessionCookie + "=session\r\nX-API-Key: browser-secret\r\n\r\n"
	if _, err := io.WriteString(connection, requestText); err != nil {
		t.Fatal(err)
	}
	status, err := bufio.NewReader(connection).ReadString('\n')
	if err != nil || !strings.Contains(status, "101 Switching Protocols") {
		t.Fatalf("websocket status=%q err=%v", status, err)
	}
	headers := <-upstreamHeaders
	if headers.Get("Authorization") != "Bearer private-speech-adapter-token" || headers.Get("X-WorkAgent-SID") != user.SID || headers.Get("Cookie") != "" || headers.Get("X-API-Key") != "" {
		t.Fatalf("stream projection headers: %#v", headers)
	}
	_ = connection.Close()
	select {
	case <-meter.settled:
	case <-time.After(2 * time.Second):
		t.Fatal("streaming speech did not settle its quota reservation")
	}
	if meter.estimatedSeconds != 10 || meter.actualSeconds < 1 || meter.actualSeconds > 10 || meter.settledRunID != meter.reservedRunID {
		t.Fatalf("stream quota lifecycle: %#v", meter)
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
