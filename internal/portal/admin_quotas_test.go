package portal

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"workagent3/internal/quota"
	"workagent3/internal/store"
)

func TestQuotaManagementRequiresAdministratorAndSameOrigin(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	admin, _ := data.CreateUser(t.Context(), "admin", "S-1-5-21-100", "hash")
	data.SetUserAdmin(t.Context(), admin.Username, true)
	employee, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-200", "hash")
	data.CreateSession(t.Context(), "admin", admin.ID, time.Now().Add(time.Hour))
	data.CreateSession(t.Context(), "alice", employee.ID, time.Now().Add(time.Hour))
	budgets, err := quota.OpenRecorder(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer budgets.Close()
	budgets.EnsureBudget(t.Context(), quota.Budget{SID: employee.SID, ModelID: "codex-native", Period: quota.Weekly, LimitUnits: 100})
	server, _ := NewWithModules(data, StaticRouter{}, false, Modules{Quota: budgets})
	body := `{"username":"alice","modelId":"codex-native","mode":"temporary","limitUnits":200}`
	for _, tc := range []struct {
		session, origin, method, body string
		want                          int
	}{
		{"alice", "http://portal.test", "GET", "", 403},
		{"alice", "http://portal.test", "POST", body, 403},
		{"admin", "http://evil.test", "POST", body, 403},
		{"admin", "http://portal.test", "POST", strings.Replace(body, "200", "-1", 1), 400},
		{"admin", "http://portal.test", "POST", strings.Replace(body, `"limitUnits":200`, `"limitUnits":null`, 1), 400},
		{"admin", "http://portal.test", "POST", body, 200},
		{"admin", "http://portal.test", "GET", "", 200},
	} {
		r := httptest.NewRequest(tc.method, "http://portal.test/api/portal/admin/quotas?username=alice", strings.NewReader(tc.body))
		r.Header.Set("Origin", tc.origin)
		r.AddCookie(&http.Cookie{Name: developmentSessionCookie, Value: tc.session})
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("%+v status=%d body=%s", tc, w.Code, w.Body.String())
		}
	}
	result, _ := budgets.ManagedBudgets(t.Context(), employee.SID, time.Now())
	if len(result) != 1 || !result[0].Temporary || result[0].BaseLimitUnits != 100 || result[0].LimitUnits != 200 {
		t.Fatalf("incorrect adjustment: %+v", result)
	}
}
