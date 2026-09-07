package portal

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDshBrandingPreservesBootstrapAndManifestSettings(t *testing.T) {
	for _, test := range []struct{ path, contentType, body string }{
		{"/", "text/html; charset=utf-8", `<html><head><title>DeepSeek Harness</title></head><body><script>window.__DSH_BOOT__={}</script></body></html>`},
		{"/manifest.webmanifest", "application/manifest+json", `{"name":"DeepSeek Harness","short_name":"DSH","start_url":"/","icons":[{"src":"/favicon.svg"}]}`},
	} {
		response := &http.Response{StatusCode: 200, Request: httptest.NewRequest(http.MethodGet, test.path, nil), Header: http.Header{"Content-Type": {test.contentType}, "Etag": {"old"}}, Body: io.NopCloser(strings.NewReader(test.body))}
		if err := brandDshResponse(response); err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		if strings.Contains(string(body), "DeepSeek Harness") || response.ContentLength != int64(len(body)) || response.Header.Get("ETag") != "" || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("Incorrect branded response: %s %#v", body, response.Header)
		}
		if test.path == "/" {
			if !strings.Contains(string(body), "<title>WorkAgent</title>") || !strings.Contains(string(body), "window.__DSH_BOOT__={}") {
				t.Fatalf("Document branding damaged bootstrap: %s", body)
			}
		} else {
			var manifest struct {
				Name      string
				ShortName string `json:"short_name"`
				StartURL  string `json:"start_url"`
				Icons     []struct{ Src string }
			}
			if err := json.Unmarshal(body, &manifest); err != nil {
				t.Fatal(err)
			}
			if manifest.Name != "WorkAgent" || manifest.ShortName != "WorkAgent" || manifest.StartURL != "/" || len(manifest.Icons) != 1 || manifest.Icons[0].Src != "/favicon.svg" {
				t.Fatalf("Unexpected manifest: %s", body)
			}
		}
	}
}

func TestDshBrandingLeavesAssetsAndAPIsUntouched(t *testing.T) {
	for _, path := range []string{"/assets/app.js", "/api/runtime/v1/workspaces/file/content"} {
		body := `const example = "<title>DeepSeek Harness</title>";`
		response := &http.Response{StatusCode: 200, Request: httptest.NewRequest(http.MethodGet, path, nil), Header: http.Header{"Content-Type": {"text/html"}}, Body: io.NopCloser(strings.NewReader(body))}
		if err := brandDshResponse(response); err != nil {
			t.Fatal(err)
		}
		actual, _ := io.ReadAll(response.Body)
		if string(actual) != body {
			t.Fatalf("Non-document content changed: %s", path)
		}
	}
}
