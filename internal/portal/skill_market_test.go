package portal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"workagent3/internal/skillmarket"
	"workagent3/internal/store"
)

func TestSkillMarketOnlyReturnsApprovedMetadata(t *testing.T) {
	users, _ := store.Open(":memory:")
	defer users.Close()
	user, _ := users.CreateUser(t.Context(), "alice", "S-1-5-21-5000", "unused")
	_ = users.CreateSession(t.Context(), "market-session", user.ID, time.Now().Add(time.Hour))
	market, _ := skillmarket.Open(":memory:")
	defer market.Close()
	entry, err := market.Publish(t.Context(), skillmarket.Entry{ID: "market-1", Name: "wiki", Description: "Wiki workflows", Version: "1.0.0", PublisherUsername: "alice", ObjectKey: "objects/market-1.zip", ArchiveDigest: "private-digest", ArchiveBytes: 42})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := market.Review(t.Context(), entry.ID, skillmarket.Approved); err != nil {
		t.Fatal(err)
	}
	server, _ := NewWithModules(users, StaticRouter{}, false, Modules{SkillMarket: market})
	req := httptest.NewRequest(http.MethodGet, "http://portal.test/api/portal/skill-market", nil)
	req.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "market-session"})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, req)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"name":"wiki"`) {
		t.Fatalf("response %d: %s", response.Code, response.Body.String())
	}
	for _, secretField := range []string{"private-digest", "object_key", "archive_digest"} {
		if strings.Contains(response.Body.String(), secretField) {
			t.Fatalf("internal package metadata leaked: %s", response.Body.String())
		}
	}
}
