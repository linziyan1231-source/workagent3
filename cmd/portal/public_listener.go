package main

import (
	"net/http"
	"strings"
)

func publicPortalHandler(root http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/internal" || strings.HasPrefix(r.URL.Path, "/internal/") {
			http.NotFound(w, r)
			return
		}
		root.ServeHTTP(w, r)
	})
}
