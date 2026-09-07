package portal

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
)

func dshBrandingDocument(path string) bool {
	return path == "/" || path == "/index.html" || path == "/manifest.webmanifest"
}

// WorkAgent owns the public application name, including the document loaded
// before client plugins start and the name used when installing the web app.
func brandDshResponse(response *http.Response) error {
	if response.StatusCode != http.StatusOK || response.Request.Method != http.MethodGet || !dshBrandingDocument(response.Request.URL.Path) {
		return nil
	}
	manifest := response.Request.URL.Path == "/manifest.webmanifest"
	if !manifest && !strings.HasPrefix(response.Header.Get("Content-Type"), "text/html") {
		return nil
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		return err
	}
	if manifest {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(body, &fields); err != nil {
			return err
		}
		fields["name"] = json.RawMessage(`"WorkAgent"`)
		fields["short_name"] = json.RawMessage(`"WorkAgent"`)
		body, _ = json.Marshal(fields)
	} else {
		body = bytes.Replace(body, []byte("<title>DeepSeek Harness</title>"), []byte("<title>WorkAgent</title>"), 1)
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	response.ContentLength = int64(len(body))
	response.Header.Set("Content-Length", strconv.Itoa(len(body)))
	response.Header.Set("Cache-Control", "no-store")
	response.Header.Del("ETag")
	response.Header.Del("Last-Modified")
	return nil
}
