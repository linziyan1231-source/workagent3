package employeemanager

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"workagent3/internal/store"
)

type listStore struct{ users []store.User }

func (s listStore) ListManagedUsers(context.Context) ([]store.User, error) { return s.users, nil }

func TestHandlerRequiresTokenAndProjectsManagedUsers(t *testing.T) {
	handler := Handler(&Service{Users: listStore{users: []store.User{{Username: "alice", SID: "S-1-5-21-1000"}}}}, "secret")
	denied := httptest.NewRecorder()
	handler.ServeHTTP(denied, httptest.NewRequest(http.MethodGet, "/v1/users", nil))
	if denied.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status %d", denied.Code)
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/users", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"windows_sid":"S-1-5-21-1000"`) {
		t.Fatalf("managed users response %d: %s", response.Code, response.Body.String())
	}
}
