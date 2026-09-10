package portal

import (
	"net/http/httptest"
	"testing"

	"workagent3/internal/quota"
	"workagent3/internal/store"
)

func TestDollarUsageAuthorizationAndIntervalValidation(t *testing.T) {
	data, _ := store.Open(":memory:")
	defer data.Close()
	q, _ := quota.OpenRecorder(":memory:")
	defer q.Close()
	server, _ := NewWithModules(data, StaticRouter{}, false, Modules{Quota: q})
	for _, tc := range []struct {
		admin bool
		query string
		code  int
	}{
		{false, "?from=2026-09-10T00:00:00Z&to=2026-09-11T00:00:00Z", 403},
		{true, "?from=bad&to=bad", 400},
		{true, "?from=2026-09-11T00:00:00Z&to=2026-09-10T00:00:00Z", 400},
		{true, "?from=2026-09-10T00:00:00Z&to=2026-09-11T00:00:00Z", 200},
	} {
		w := httptest.NewRecorder()
		server.dollarUsage(w, httptest.NewRequest("GET", "/api/portal/admin/usage"+tc.query, nil), store.User{Admin: tc.admin})
		if w.Code != tc.code {
			t.Fatalf("%+v got %d", tc, w.Code)
		}
	}

}
