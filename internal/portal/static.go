package portal

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

func SPAHandler(web fs.FS) http.Handler {
	files := http.FileServer(http.FS(web))
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		asset := strings.TrimPrefix(path.Clean(request.URL.Path), "/")
		if asset == "." {
			asset = "index.html"
		}
		if info, err := fs.Stat(web, asset); err != nil || info.IsDir() {
			clone := request.Clone(request.Context())
			clone.URL.Path = "/"
			files.ServeHTTP(writer, clone)
			return
		}
		files.ServeHTTP(writer, request)
	})
}

func AssistantAvatarHandler(avatars fs.FS) http.Handler {
	files := http.FileServer(http.FS(avatars))
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		asset := strings.TrimPrefix(path.Clean(request.URL.Path), "/assets/puxin-builtin-assistants/avatars/")
		if asset == "." || asset == "" || strings.Contains(asset, "/") {
			http.NotFound(writer, request)
			return
		}
		if info, err := fs.Stat(avatars, asset); err != nil || !info.Mode().IsRegular() {
			http.NotFound(writer, request)
			return
		}
		writer.Header().Set("Cache-Control", "public, max-age=86400")
		clone := request.Clone(request.Context())
		clone.URL.Path = "/" + asset
		files.ServeHTTP(writer, clone)
	})
}
