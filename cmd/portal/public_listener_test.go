package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPublicListenerDoesNotExposeInternalRoutes(t *testing.T) {
	handler := publicPortalHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(r.RemoteAddr)) }))
	for _, path := range []string{"/internal", "/internal/runtime/lease", "/%69nternal/runtime/quota"} {
		request := httptest.NewRequest("POST", "http://192.0.2.1:42761"+path, nil)
		request.RemoteAddr = "127.0.0.1:1234"
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 404 {
			t.Fatal("public internal route", path, response.Code)
		}
	}
	request := httptest.NewRequest("GET", "http://192.0.2.1:42761/healthz", nil)
	request.RemoteAddr = "198.51.100.8:4567"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 200 || response.Body.String() != request.RemoteAddr {
		t.Fatal("public peer was lost")
	}
}
