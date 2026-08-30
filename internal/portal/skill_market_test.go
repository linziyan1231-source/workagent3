package portal

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
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

func TestSkillMarketInstallStreamsVerifiedPackageToSIDRuntime(t *testing.T) {
	users, _ := store.Open(":memory:")
	defer users.Close()
	user, _ := users.CreateUser(t.Context(), "alice", "S-1-5-21-5001", "unused")
	_ = users.CreateSession(t.Context(), "install-session", user.ID, time.Now().Add(time.Hour))
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
	_, _ = market.Review(t.Context(), entry.ID, skillmarket.Approved)
	downstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/skills/market-install" || request.Header.Get("Authorization") != "Bearer private-runtime-token" {
			t.Fatalf("unexpected runtime request %s %s", request.Method, request.URL.Path)
		}
		body, _ := io.ReadAll(request.Body)
		if string(body) != string(archive) {
			t.Fatalf("archive body = %q", body)
		}
		metadata, _ := base64.RawURLEncoding.DecodeString(request.Header.Get("X-WorkAgent-Skill-Metadata"))
		var decoded map[string]string
		_ = json.Unmarshal(metadata, &decoded)
		if decoded["id"] != entry.ID || decoded["name"] != entry.Name {
			t.Fatalf("metadata = %#v", decoded)
		}
		writeJSON(writer, http.StatusCreated, map[string]any{"id": entry.ID})
	}))
	defer downstream.Close()
	target, _ := url.Parse(downstream.URL)
	server, _ := NewWithModules(users, StaticRouter{user.SID: {BaseURL: target, Token: "private-runtime-token"}}, false, Modules{SkillMarket: market})
	request := httptest.NewRequest(http.MethodPost, "http://portal.test/api/portal/skill-market/install", strings.NewReader(`{"id":"market-install"}`))
	request.Header.Set("Origin", "http://portal.test")
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: "install-session"})
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), `"id":"market-install"`) {
		t.Fatalf("install response %d: %s", response.Code, response.Body.String())
	}
}
