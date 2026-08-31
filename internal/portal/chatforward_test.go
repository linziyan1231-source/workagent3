package portal

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"workagent3/internal/contracts"
	"workagent3/internal/store"
)

type chatForwardStub struct {
	identity contracts.ChatForwardDelegation
}

func (stub *chatForwardStub) ServeChatForward(writer http.ResponseWriter, _ *http.Request, identity contracts.ChatForwardDelegation) {
	stub.identity = identity
	writer.WriteHeader(http.StatusNoContent)
}

func TestChatForwardRequiresPortalSessionAndDelegatesOnlyUserID(t *testing.T) {
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	user, err := data.CreateUser(t.Context(), "alice", "S-1-5-21-9000", "unused")
	if err != nil {
		t.Fatal(err)
	}
	if err := data.CreateSession(t.Context(), "chat-session", user.ID, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	adapter := &chatForwardStub{}
	server, err := NewWithModules(data, StaticRouter{}, false, Modules{ChatForward: adapter})
	if err != nil {
		t.Fatal(err)
	}

	unauthenticated := httptest.NewRecorder()
	server.Handler().ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, "/chatgpt/", nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status %d", unauthenticated.Code)
	}

	request := httptest.NewRequest(http.MethodGet, "/chatgpt/", nil)
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "chat-session"})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || adapter.identity.UserID != "1" || adapter.identity.NowUnix == 0 {
		t.Fatalf("delegation failed status=%d identity=%#v", response.Code, adapter.identity)
	}
}
