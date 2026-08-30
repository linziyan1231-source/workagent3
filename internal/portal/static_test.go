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
