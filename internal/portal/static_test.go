package portal

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestSPAHandlerServesAssetsAndClientRoutes(t *testing.T) {
	web := fstest.MapFS{
		"index.html":    {Data: []byte("<main>WorkAgent</main>")},
		"assets/app.js": {Data: []byte("console.log('ready')")},
	}
	handler := SPAHandler(web)

	for _, test := range []struct {
		path string
		want string
	}{
		{path: "/assets/app.js", want: "console.log('ready')"},
		{path: "/conversation/session-1", want: "<main>WorkAgent</main>"},
	} {
		request := httptest.NewRequest(http.MethodGet, test.path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK || response.Body.String() != test.want {
			t.Fatalf("GET %s = %d %q", test.path, response.Code, response.Body.String())
		}
	}
}

func TestSPAHandlerRejectsWrites(t *testing.T) {
	handler := SPAHandler(fstest.MapFS{"index.html": {Data: []byte("app")}})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/unknown", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST fallback status = %d", response.Code)
	}
}

func TestAssistantAvatarHandlerServesOnlyFlatReadOnlyAssets(t *testing.T) {
	handler := AssistantAvatarHandler(fstest.MapFS{"official.jpg": {Data: []byte("image")}})
	mux := http.NewServeMux()
	mux.Handle("/assets/puxin-builtin-assistants/", handler)
	mux.HandleFunc("/", func(writer http.ResponseWriter, _ *http.Request) { writer.WriteHeader(http.StatusTeapot) })
	request := httptest.NewRequest(http.MethodGet, "/assets/puxin-builtin-assistants/avatars/official.jpg", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "image" || response.Header().Get("Cache-Control") == "" {
		t.Fatalf("avatar response = %d %q %#v", response.Code, response.Body.String(), response.Header())
	}
	for _, probe := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodPost, "/assets/puxin-builtin-assistants/avatars/official.jpg", http.StatusMethodNotAllowed},
		{http.MethodGet, "/assets/puxin-builtin-assistants/avatars/../rules/official.md", http.StatusTemporaryRedirect},
		{http.MethodGet, "/assets/puxin-builtin-assistants/rules/official.md", http.StatusNotFound},
		{http.MethodGet, "/assets/puxin-builtin-assistants/avatars/missing.jpg", http.StatusNotFound},
	} {
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(probe.method, probe.path, nil))
		if response.Code != probe.status {
			t.Fatalf("%s %s = %d", probe.method, probe.path, response.Code)
		}
	}
}
