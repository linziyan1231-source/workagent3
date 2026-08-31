package imdelivery

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"workagent3/internal/store"
)

func TestDirectoryReturnsOnlyExistingEnabledEmployeeSID(t *testing.T) {
	users, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer users.Close()
	user, err := users.CreateUser(t.Context(), "alice", "S-1-5-21-9000", "unused")
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewDirectoryHandler(users, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	request := func(sid string, authenticated bool) int {
		req := httptest.NewRequest(http.MethodGet, "/internal/im/employees/"+sid, nil)
		if authenticated {
			req.Header.Set("Authorization", "Bearer 0123456789abcdef0123456789abcdef")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response.Code
	}
	if status := request(user.SID, true); status != http.StatusNoContent {
		t.Fatalf("enabled employee status %d", status)
	}
	if status := request("S-1-5-21-unknown", true); status != http.StatusNotFound {
		t.Fatalf("unknown employee status %d", status)
	}
	if status := request(user.SID, false); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status %d", status)
	}
	if err := users.SetUserCredentials(t.Context(), user.ID, "unused", true); err != nil {
		t.Fatal(err)
	}
	if status := request(user.SID, true); status != http.StatusNotFound {
		t.Fatalf("disabled employee status %d", status)
	}
}
