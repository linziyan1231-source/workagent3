package portal

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
	"workagent3/internal/publishedapps"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

type stoppingAppRouter struct {
	calls            atomic.Int32
	entered, aborted chan struct{}
	target           *url.URL
}

func (r *stoppingAppRouter) Resolve(ctx context.Context, _ string) (runtimeapi.Endpoint, error) {
	if r.calls.Add(1) == 1 {
		close(r.entered)
		<-ctx.Done()
		close(r.aborted)
		return runtimeapi.Endpoint{}, ctx.Err()
	}
	return runtimeapi.Endpoint{BaseURL: r.target, Token: "internal"}, nil
}
func TestApplicationStopCancelsOldAdmissionBeforeStoppingRuntime(t *testing.T) {
	router := &stoppingAppRouter{entered: make(chan struct{}), aborted: make(chan struct{})}
	stopped := false
	downstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-router.aborted:
		default:
			t.Error("runtime stopped before old admission was cancelled")
		}
		stopped = true
		w.Write([]byte(`{}`))
	}))
	defer downstream.Close()
	router.target, _ = url.Parse(downstream.URL)
	data, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	user, err := data.CreateUser(t.Context(), "owner", "S-1-5-21-1000", "hash")
	if err != nil {
		t.Fatal(err)
	}
	apps, err := publishedapps.Open(filepath.Join(t.TempDir(), "apps.db"), 23000, 23009)
	if err != nil {
		t.Fatal(err)
	}
	defer apps.Close()
	app, err := apps.Create(t.Context(), publishedapps.App{OwnerSID: user.SID, OwnerID: user.ID, WorkspaceID: "default", Name: "app", Kind: "static", Entry: "index.html"})
	if err != nil {
		t.Fatal(err)
	}
	app.Enabled = true
	app.Access = "public"
	app.Version = "v1"
	app.PreviewVersion = "preview"
	app, err = apps.Update(t.Context(), app, app.Revision)
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewWithModules(data, router, false, Modules{PublishedApps: PublishedAppsConfig{Store: apps, PublicURL: "http://192.0.2.1:8080"}})
	if err != nil {
		t.Fatal(err)
	}
	requestDone := make(chan struct{})
	go func() {
		defer close(requestDone)
		r := httptest.NewRequest("GET", "http://192.0.2.1:"+strconv.Itoa(app.Port)+"/", nil)
		server.apps.handler(app.ID, false).ServeHTTP(httptest.NewRecorder(), r)
	}()
	select {
	case <-router.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("admission did not start")
	}
	request := httptest.NewRequest("POST", "/api/portal/apps/"+app.ID+"/unpublish", nil)
	request.SetPathValue("id", app.ID)
	request.SetPathValue("action", "unpublish")
	response := httptest.NewRecorder()
	server.publishedAppsHTTP(response, request, user)
	if response.Code != 200 || !stopped {
		t.Fatalf("stop failed: %d %s", response.Code, response.Body.String())
	}
	select {
	case <-requestDone:
	case <-time.After(time.Second):
		t.Fatal("old request still running")
	}
	updated, err := apps.Get(t.Context(), app.ID)
	if err != nil || updated.Enabled || updated.PreviewVersion != "" {
		t.Fatal("app admission still enabled", err)
	}
}
