package professionaldb

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testServer(t *testing.T, handler http.HandlerFunc) (*Store, *Server, string) {
	t.Helper()
	upstream := httptest.NewServer(handler)
	t.Cleanup(upstream.Close)
	s := newTestStore(t)
	token := testGrant(t, s, "S-1-5-21-100", 100, 100)
	credential := filepath.Join(t.TempDir(), "credential.json")
	if err := os.WriteFile(credential, []byte(`{"access_token":"test-access","refresh_token":"test-refresh","private_metadata":"preserved"}`), 0600); err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(Config{CredentialPath: credential, APIURL: upstream.URL + "/tools", OAuthHost: upstream.URL}, s, func(context.Context, string) (bool, error) { return true, nil })
	if err != nil {
		t.Fatal(err)
	}
	return s, server, token
}

func rpc(t *testing.T, server *Server, token, method string, params any) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	r := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(string(body)))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, r)
	return w
}
func toolParams(source string) map[string]any {
	return map[string]any{"name": "call_data_source_tool", "arguments": map[string]any{"data_source_name": source, "api_name": "search", "params": map[string]any{}}}
}
func assertRPCError(t *testing.T, w *httptest.ResponseRecorder, code string) {
	t.Helper()
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"isError":true`) || !strings.Contains(w.Body.String(), code) {
		t.Fatalf("expected %s, got %d: %s", code, w.Code, w.Body.String())
	}
}

func TestMCPAuthenticatesEmployeeAndDeniesUnchargedInvalidCalls(t *testing.T) {
	var dispatched atomic.Int64
	s, server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		dispatched.Add(1)
		fmt.Fprint(w, `{"is_success":true,"result":{"assistant":[{"type":"text","text":"answer"}]}}`)
	})
	for _, bad := range []string{"", token + "bad"} {
		if w := rpc(t, server, bad, "tools/list", nil); w.Code != 401 {
			t.Fatalf("bad auth: %d", w.Code)
		}
	}
	for _, method := range []string{"initialize", "tools/list", "ping"} {
		if w := rpc(t, server, token, method, nil); w.Code != 200 || strings.Contains(w.Body.String(), `"error"`) {
			t.Fatalf("handshake: %s", w.Body.String())
		}
	}
	for _, params := range []any{
		toolParams("unknown"), map[string]any{"name": "unknown"},
		map[string]any{"name": "call_data_source_tool", "arguments": map[string]any{"data_source_name": "wind", "api_name": ""}},
		map[string]any{"name": "call_data_source_tool", "arguments": map[string]any{"data_source_name": "wind", "api_name": "search", "params": []string{}}},
	} {
		assertRPCError(t, rpc(t, server, token, "tools/call", params), "PROFESSIONAL_DATABASE_INVALID_ARGUMENTS")
	}
	assertRPCError(t, rpc(t, server, token, "tools/call", toolParams("caixin")), "PROFESSIONAL_DATABASE_SOURCE_DENIED")
	g, _ := s.Grant(context.Background(), "S-1-5-21-100")
	if g.DailyUsed != 0 || dispatched.Load() != 0 {
		t.Fatal("invalid or handshake calls charged")
	}
	server.enabled = func(context.Context, string) (bool, error) { return false, nil }
	if w := rpc(t, server, token, "initialize", nil); w.Code != 403 {
		t.Fatalf("disabled employee accepted: %d", w.Code)
	}
}

func TestMCPQuotaCountsDescriptionQueriesAndUpstreamFailures(t *testing.T) {
	var dispatched atomic.Int64
	s, server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch dispatched.Add(1) {
		case 1:
			fmt.Fprint(w, `{"result":"description"}`)
		case 2:
			fmt.Fprint(w, `{"is_success":false,"error":{"assistant":[{"type":"text","text":"upstream-secret-must-not-leak"}]}}`)
		default:
			http.Error(w, "test-access must not leak", 502)
		}
	})
	if w := rpc(t, server, token, "tools/call", map[string]any{"name": "get_data_source_desc", "arguments": map[string]any{"name": "wind"}}); strings.Contains(w.Body.String(), `"isError"`) || !strings.Contains(w.Body.String(), "description") {
		t.Fatalf("description: %s", w.Body.String())
	}
	for range 2 {
		w := rpc(t, server, token, "tools/call", toolParams("wind"))
		assertRPCError(t, w, "PROFESSIONAL_DATABASE_UPSTREAM_ERROR")
		if strings.Contains(w.Body.String(), "must-not-leak") || strings.Contains(w.Body.String(), "test-access") {
			t.Fatal("upstream error leaked secrets")
		}
	}
	g, _ := s.Grant(context.Background(), "S-1-5-21-100")
	if g.DailyUsed != 3 || g.MonthlyUsed != 3 || dispatched.Load() != 3 {
		t.Fatalf("failure count: %+v dispatched=%d", g, dispatched.Load())
	}
	g.DailyLimit = 3
	g.MonthlyLimit = 3
	s.SetGrant(context.Background(), "S-1-5-21-100", g)
	assertRPCError(t, rpc(t, server, token, "tools/call", toolParams("wind")), "PROFESSIONAL_DATABASE_DAILY_QUOTA_EXCEEDED")
	if dispatched.Load() != 3 {
		t.Fatal("over quota dispatched")
	}
	var failures int
	s.db.QueryRow(`SELECT count(*) FROM professional_database_calls WHERE outcome='upstream_error'`).Scan(&failures)
	if failures != 2 {
		t.Fatalf("failures=%d", failures)
	}
}

func TestMCPMissingCredentialsDoNotChargeAndHealthIsSafe(t *testing.T) {
	s, server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) { t.Error("must not call upstream") })
	os.Remove(server.cfg.CredentialPath)
	assertRPCError(t, rpc(t, server, token, "tools/call", toolParams("wind")), "PROFESSIONAL_DATABASE_NEEDS_AUTH")
	g, _ := s.Grant(context.Background(), "S-1-5-21-100")
	if g.DailyUsed != 0 {
		t.Fatal("missing credentials charged")
	}
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"needs_auth"`) || strings.Contains(w.Body.String(), "credential") {
		t.Fatalf("health: %s", w.Body.String())
	}
}

func TestMCPRechecksGrantAndEmployeeBeforeReservation(t *testing.T) {
	for _, revokeGrant := range []bool{false, true} {
		t.Run(fmt.Sprint(revokeGrant), func(t *testing.T) {
			s, server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) { t.Error("revoked request reached upstream") })
			checks := 0
			server.enabled = func(ctx context.Context, sid string) (bool, error) {
				if sid != "S-1-5-21-100" {
					t.Errorf("employee lookup got wrong SID: %s", sid)
				}
				checks++
				if checks == 2 {
					if !revokeGrant {
						return false, nil
					}
					grant, err := s.Grant(ctx, sid)
					if err != nil {
						return false, err
					}
					grant.Enabled = false
					_, err = s.SetGrant(ctx, sid, grant)
					return true, err
				}
				return true, nil
			}
			assertRPCError(t, rpc(t, server, token, "tools/call", toolParams("wind")), "PROFESSIONAL_DATABASE_DISABLED")
			grant, _ := s.Grant(context.Background(), "S-1-5-21-100")
			if checks != 2 || grant.DailyUsed != 0 || grant.MonthlyUsed != 0 {
				t.Fatalf("checks=%d grant=%+v", checks, grant)
			}
		})
	}
}

func TestOAuthRefreshOnceForConcurrentRejectedTokenAndPersists(t *testing.T) {
	var refreshes atomic.Int64
	var oldCalls atomic.Int64
	var newCalls atomic.Int64
	var mu sync.Mutex
	ids := map[string]int{}
	s, server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/oauth/token" {
			refreshes.Add(1)
			r.ParseForm()
			if r.Form.Get("refresh_token") != "test-refresh" || r.Form.Get("client_id") != oauthClientID {
				t.Error("wrong refresh form")
			}
			fmt.Fprint(w, `{"access_token":"refreshed-access","refresh_token":"rotated-refresh","expires_in":3600}`)
			return
		}
		mu.Lock()
		ids[r.Header.Get("X-Msh-Tool-Call-Id")]++
		mu.Unlock()
		if r.Header.Get("Authorization") == "Bearer test-access" {
			oldCalls.Add(1)
			w.WriteHeader(401)
			return
		}
		if r.Header.Get("Authorization") != "Bearer refreshed-access" {
			t.Error("wrong refreshed credential")
		}
		newCalls.Add(1)
		fmt.Fprint(w, `{"result":"ok"}`)
	})
	var group sync.WaitGroup
	for range 12 {
		group.Add(1)
		go func() {
			defer group.Done()
			w := rpc(t, server, token, "tools/call", toolParams("wind"))
			if strings.Contains(w.Body.String(), `"isError"`) {
				t.Errorf("refresh call: %s", w.Body.String())
			}
		}()
	}
	group.Wait()
	if refreshes.Load() != 1 || oldCalls.Load() < 1 || newCalls.Load() != 12 {
		t.Fatalf("refreshes=%d old=%d new=%d", refreshes.Load(), oldCalls.Load(), newCalls.Load())
	}
	g, _ := s.Grant(context.Background(), "S-1-5-21-100")
	if g.DailyUsed != 12 {
		t.Fatalf("retry charged twice: %+v", g)
	}
	for id, count := range ids {
		if id == "" || count > 2 {
			t.Fatalf("call id/retry invalid: id=%s count=%d", id, count)
		}
	}
	doc, raw, err := server.credential.read()
	if err != nil || doc.RefreshToken != "rotated-refresh" || raw["private_metadata"] != "preserved" {
		t.Fatalf("credential rotation was not persisted")
	}
	if files, _ := filepath.Glob(filepath.Join(filepath.Dir(server.cfg.CredentialPath), "*.tmp")); len(files) != 0 {
		t.Fatal("credential temp file remains")
	}
}

func TestOAuthRejectedRefreshAndRepeated401StayBounded(t *testing.T) {
	for _, refreshOK := range []bool{false, true} {
		t.Run(fmt.Sprint(refreshOK), func(t *testing.T) {
			var refreshes, calls atomic.Int64
			s, server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/oauth/token" {
					refreshes.Add(1)
					if refreshOK {
						fmt.Fprint(w, `{"access_token":"still-rejected","expires_in":3600}`)
					} else {
						http.Error(w, "private-refresh-token", 401)
					}
					return
				}
				calls.Add(1)
				w.WriteHeader(401)
			})
			w := rpc(t, server, token, "tools/call", toolParams("wind"))
			if !strings.Contains(w.Body.String(), `"isError":true`) || strings.Contains(w.Body.String(), "private-refresh-token") {
				t.Fatalf("refresh result: %s", w.Body.String())
			}
			want := int64(1)
			if refreshOK {
				want = 2
			}
			if refreshes.Load() != 1 || calls.Load() != want {
				t.Fatalf("unbounded retry refresh=%d call=%d", refreshes.Load(), calls.Load())
			}
			g, _ := s.Grant(context.Background(), "S-1-5-21-100")
			if g.DailyUsed != 1 {
				t.Fatal("incorrect retry charge")
			}
		})
	}
}

func TestFilesAreEmbeddedAndNeverWriteHostPaths(t *testing.T) {
	hostFile := filepath.Join(t.TempDir(), "must-not-exist.csv")
	_, server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Params map[string]any `json:"params"`
		}
		json.NewDecoder(r.Body).Decode(&request)
		params, _ := request.Params["params"].(map[string]any)
		if params["file_path"] != "must-not-exist.csv" {
			t.Errorf("path was not normalized: %v", params)
		}
		json.NewEncoder(w).Encode(map[string]any{"is_success": true, "result": map[string]any{"assistant": []any{map[string]any{"type": "text", "text": "CSV ready"}}}, "files": []any{map[string]any{"name": hostFile, "content": "name,value\nA,1\n"}, map[string]any{"name": "../../encoded.csv", "encoding": "base64", "content": "YSxiCjEsMgo="}}})
	})
	params := toolParams("wind")
	params["arguments"].(map[string]any)["params"] = map[string]any{"file_path": hostFile}
	w := rpc(t, server, token, "tools/call", params)
	if strings.Contains(w.Body.String(), `"isError"`) || !strings.Contains(w.Body.String(), `"type":"resource"`) || !strings.Contains(w.Body.String(), `"blob":"YSxiCjEsMgo="`) || strings.Contains(w.Body.String(), "../") || strings.Contains(w.Body.String(), strings.ReplaceAll(filepath.Dir(hostFile), "\\", "\\\\")) {
		t.Fatalf("bad embedded files: %s", w.Body.String())
	}
	if _, err := os.Stat(hostFile); !os.IsNotExist(err) {
		t.Fatalf("host file written: %v", err)
	}
}

func TestExpiryFormatsAndProactiveRefresh(t *testing.T) {
	expiry := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	for _, raw := range []string{fmt.Sprint(expiry.Unix()), fmt.Sprint(expiry.UnixMilli()), `"2026-10-01T00:00:00Z"`, fmt.Sprintf(`"%d"`, expiry.Unix())} {
		parsed, err := parseCredentialExpiry(json.RawMessage(raw))
		if err != nil || !parsed.Equal(expiry) {
			t.Fatalf("expiry %s parsed %v %v", raw, parsed, err)
		}
	}
	var refreshed atomic.Int64
	_, server, token := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/oauth/token" {
			refreshed.Add(1)
			fmt.Fprint(w, `{"access_token":"new-access","expires_in":3600}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer new-access" {
			t.Error("expired token dispatched")
		}
		fmt.Fprint(w, `{"result":"ok"}`)
	})
	if err := os.WriteFile(server.cfg.CredentialPath, []byte(`{"access_token":"test-access","refresh_token":"test-refresh","expires_at":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	w := rpc(t, server, token, "tools/call", toolParams("wind"))
	if strings.Contains(w.Body.String(), `"isError"`) || refreshed.Load() != 1 {
		t.Fatalf("proactive refresh failed: %s", w.Body.String())
	}
}

func TestServerUsesOnlyExplicitOutboundProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	data := newTestStore(t)
	server, err := NewServer(Config{}, data, func(context.Context, string) (bool, error) { return true, nil })
	if err != nil {
		t.Fatal(err)
	}
	if server.client.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("service inherited environment proxy")
	}
	server, err = NewServer(Config{OutboundProxy: "http://127.0.0.1:8888"}, data, func(context.Context, string) (bool, error) { return true, nil })
	if err != nil {
		t.Fatal(err)
	}
	proxy, err := server.client.Transport.(*http.Transport).Proxy(httptest.NewRequest("POST", "https://example.invalid", nil))
	if err != nil || proxy.String() != "http://127.0.0.1:8888" {
		t.Fatalf("explicit proxy not used: %v %v", proxy, err)
	}
}
