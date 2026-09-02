package portal

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"workagent3/internal/audit"
	"workagent3/internal/contracts"
	"workagent3/internal/skillmarket"
	"workagent3/internal/store"
)

// TestSkillMarketBusinessAuditEvents asserts publish-side Portal audit events
// for market install requests and entry deletion (the runtime-side
// skill.install event is covered in internal/userhost).
func TestSkillMarketBusinessAuditEvents(t *testing.T) {
	users, _ := store.Open(":memory:")
	defer users.Close()
	user, _ := users.CreateUser(t.Context(), "alice", "S-1-5-21-5001", "unused")
	_ = users.CreateSession(t.Context(), "market-audit-session", user.ID, time.Now().Add(time.Hour))
	auditStore, err := audit.Open(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer auditStore.Close()

	archiveRoot := t.TempDir()
	archive := []byte("verified zip bytes")
	digest := sha256.Sum256(archive)
	if err := os.MkdirAll(filepath.Join(archiveRoot, "objects"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(archiveRoot, "objects", "market.zip"), archive, 0o600); err != nil {
		t.Fatal(err)
	}
	market, err := skillmarket.OpenWithArchiveRoot(filepath.Join(t.TempDir(), "market.db"), archiveRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer market.Close()
	entry, err := market.Publish(t.Context(), skillmarket.Entry{ID: "market-install", Name: "Wiki", Description: "Wiki workflows", Version: "1.0.0", PublisherUsername: "alice", ObjectKey: "objects/market.zip", ArchiveDigest: hex.EncodeToString(digest[:]), ArchiveBytes: int64(len(archive))})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := market.Review(t.Context(), entry.ID, skillmarket.Approved); err != nil {
		t.Fatal(err)
	}
	downstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusCreated, map[string]any{"id": entry.ID})
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	server, _ := NewWithModules(users, StaticRouter{user.SID: {BaseURL: target, Token: "private-runtime-token"}}, false, Modules{SkillMarket: market, Audit: auditStore})

	install := httptest.NewRequest(http.MethodPost, "http://portal.test/api/portal/skill-market/install", strings.NewReader(`{"id":"market-install"}`))
	install.Header.Set("Origin", "http://portal.test")
	install.Header.Set("Content-Type", "application/json")
	install.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "market-audit-session"})
	installResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(installResponse, install)
	if installResponse.Code != http.StatusCreated {
		t.Fatalf("install response %d: %s", installResponse.Code, installResponse.Body.String())
	}
	installs, err := auditStore.List(t.Context(), contracts.AuditQuery{Action: audit.ActionSkillMarketInstall})
	if err != nil || len(installs) != 1 {
		t.Fatalf("installs=%#v err=%v", installs, err)
	}
	if installs[0].Actor != "alice" || installs[0].Target != entry.ID || installs[0].Result != "success" || installs[0].CorrelationID == "" || installs[0].Metadata["skill_name"] != "Wiki" || installs[0].Metadata["version"] != "1.0.0" {
		t.Fatalf("unexpected install event: %#v", installs[0])
	}

	deleteRequest := httptest.NewRequest(http.MethodDelete, "http://portal.test/api/portal/skill-market?id="+entry.ID, nil)
	deleteRequest.Header.Set("Origin", "http://portal.test")
	deleteRequest.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "market-audit-session"})
	deleteResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusNoContent {
		t.Fatalf("delete response %d: %s", deleteResponse.Code, deleteResponse.Body.String())
	}
	deletes, err := auditStore.List(t.Context(), contracts.AuditQuery{Action: audit.ActionSkillMarketDelete})
	if err != nil || len(deletes) != 1 {
		t.Fatalf("deletes=%#v err=%v", deletes, err)
	}
	if deletes[0].Actor != "alice" || deletes[0].Target != entry.ID || deletes[0].Result != "success" {
		t.Fatalf("unexpected delete event: %#v", deletes[0])
	}
}
