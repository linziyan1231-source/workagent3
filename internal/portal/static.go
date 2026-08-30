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
