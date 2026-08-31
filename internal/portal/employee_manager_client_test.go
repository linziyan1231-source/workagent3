package portal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEmployeeManagerClientUsesProtectedLoopbackProtocol(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer manager-secret" {
			t.Fatalf("manager authorization was not forwarded")
		}
		switch request.URL.Path {
		case "/v1/users":
			json.NewEncoder(writer).Encode(map[string]any{"users": []ManagedUser{{Username: "alice", WindowsSID: "S-1-5-21-1000", Enabled: true}}, "kimi_datasource_sources": []string{}})
		case "/v1/users/disable":
			var input map[string]string
			_ = json.NewDecoder(request.Body).Decode(&input)
			if input["username"] != "alice" {
				t.Fatalf("wrong employee action: %#v", input)
			}
			json.NewEncoder(writer).Encode(map[string]bool{"success": true})
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	client, err := NewEmployeeManagerClient(server.URL, "manager-secret")
	if err != nil {
		t.Fatal(err)
	}
	users, _, err := client.ListManagedUsers(t.Context())
	if err != nil || len(users) != 1 || users[0].WindowsSID != "S-1-5-21-1000" {
		t.Fatalf("list round trip failed: %#v %v", users, err)
	}
	if err := client.SetEnabled(t.Context(), "alice", false); err != nil {
		t.Fatal(err)
	}
}

func TestEmployeeManagerClientRejectsNonLoopbackOrigin(t *testing.T) {
	if _, err := NewEmployeeManagerClient("https://manager.example.test", "secret"); err == nil {
		t.Fatal("non-loopback Employee Manager endpoint was accepted")
	}
}
