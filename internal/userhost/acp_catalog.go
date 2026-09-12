package userhost

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"workagent3/internal/acpcatalog"
	"workagent3/internal/credentialbroker"
)

// Catalog definitions are re-read from Portal for each new admission. Broker
// values remain in the owning SID process and never appear in public metadata.
func acpCatalogHandler(credentials runtimeCredentialCatalog, platform *auditClient, token, privateToken string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		supplied, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		internal := strings.HasPrefix(r.URL.Path, "/internal/")
		expected := token
		if internal {
			expected = privateToken
		}
		if expected == "" || subtle.ConstantTimeCompare([]byte(supplied), []byte(expected)) != 1 {
			writeRuntimeError(w, 401, "runtime_authentication_required")
			return
		}
		if platform == nil {
			writeRuntimeError(w, 503, "acp_catalog_unavailable")
			return
		}
		prefix := "/v1/acp-catalog"
		if internal {
			prefix = "/internal/acp-catalog"
		}
		rest := strings.Trim(strings.TrimPrefix(r.URL.Path, prefix), "/")
		parts := strings.Split(rest, "/")
		id := parts[0]
		credentialRequest := len(parts) == 2 && parts[1] == "credentials"
		if len(parts) > 2 || (len(parts) == 2 && !credentialRequest) {
			writeRuntimeError(w, 404, "not_found")
			return
		}
		input := map[string]string{"sid": platform.sid, "id": id, "revision": r.URL.Query().Get("revision")}
		encoded, _ := json.Marshal(input)
		endpoint, _ := url.Parse(platform.endpoint)
		endpoint.Path = "/internal/runtime/acp-catalog"
		downstream, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, endpoint.String(), bytes.NewReader(encoded))
		downstream.Header.Set("Authorization", "Bearer "+platform.credential)
		downstream.Header.Set("Content-Type", "application/json")
		result, err := platform.client.Do(downstream)
		if err != nil {
			writeRuntimeError(w, 503, "acp_catalog_unavailable")
			return
		}
		defer result.Body.Close()
		if result.StatusCode != 200 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(result.StatusCode)
			_, _ = io.Copy(w, io.LimitReader(result.Body, 4096))
			return
		}
		if id == "" {
			if r.Method != http.MethodGet {
				writeRuntimeError(w, 405, "method_not_allowed")
				return
			}
			var value struct {
				Entries []acpcatalog.Entry `json:"entries"`
			}
			if json.NewDecoder(io.LimitReader(result.Body, 1024*1024)).Decode(&value) != nil {
				writeRuntimeError(w, 503, "acp_catalog_unavailable")
				return
			}
			if internal {
				writeRuntimeJSON(w, 200, value)
				return
			}
			rows := []map[string]any{}
			for _, entry := range value.Entries {
				rows = append(rows, publicAcpEntry(entry, credentials, r))
			}
			writeRuntimeJSON(w, 200, map[string]any{"entries": rows})
			return
		}
		var entry acpcatalog.Entry
		if json.NewDecoder(io.LimitReader(result.Body, 64*1024)).Decode(&entry) != nil {
			writeRuntimeError(w, 503, "acp_catalog_unavailable")
			return
		}
		if !credentialRequest {
			if r.Method != http.MethodGet {
				writeRuntimeError(w, 405, "method_not_allowed")
				return
			}
			if internal {
				writeRuntimeJSON(w, 200, entry)
			} else {
				writeRuntimeJSON(w, 200, publicAcpEntry(entry, credentials, r))
			}
			return
		}
		if internal && r.Method == http.MethodGet {
			environment := map[string]string{}
			for _, field := range entry.CredentialFields {
				secret, err := credentials.Resolve(r.Context(), acpCredentialID(entry.ID, field.ID))
				if err != nil {
					if field.Required {
						writeRuntimeError(w, 409, "acp_credentials_required")
						return
					}
					continue
				}
				environment[field.Environment] = string(secret)
				clearBytes(secret)
			}
			writeRuntimeJSON(w, 200, map[string]any{"environment": environment})
			return
		}
		if internal || r.Method != http.MethodPut {
			writeRuntimeError(w, 405, "method_not_allowed")
			return
		}
		var inputCredentials struct {
			Values map[string]string `json:"values"`
		}
		decoder := json.NewDecoder(io.LimitReader(r.Body, 64*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&inputCredentials) != nil {
			writeRuntimeError(w, 400, "invalid_acp_credentials")
			return
		}
		allowed := map[string]acpcatalog.CredentialField{}
		for _, field := range entry.CredentialFields {
			allowed[field.ID] = field
		}
		for field, value := range inputCredentials.Values {
			if _, ok := allowed[field]; !ok || len(value) > 16384 {
				writeRuntimeError(w, 400, "invalid_acp_credentials")
				return
			}
		}
		for field, value := range inputCredentials.Values {
			key := acpCredentialID(entry.ID, field)
			if value == "" {
				err = credentials.Revoke(r.Context(), key)
			} else {
				_, err = credentials.Put(r.Context(), credentialbroker.Input{ID: key, Kind: credentialbroker.KindProvider, Label: entry.Label + " · " + allowed[field].Label, Secret: []byte(value), State: credentialbroker.StateReady})
			}
			if err != nil {
				writeRuntimeError(w, 500, "credential_save_failed")
				return
			}
		}
		writeRuntimeJSON(w, 200, publicAcpEntry(entry, credentials, r))
	})
}
func acpCredentialID(id, field string) string { return "acp:" + id + ":" + field }
func publicAcpEntry(entry acpcatalog.Entry, credentials runtimeCredentialCatalog, r *http.Request) map[string]any {
	fields := []map[string]any{}
	ready := true
	for _, field := range entry.CredentialFields {
		meta, err := credentials.Metadata(r.Context(), acpCredentialID(entry.ID, field.ID))
		configured := err == nil && meta.State == credentialbroker.StateReady
		if field.Required && !configured {
			ready = false
		}
		fields = append(fields, map[string]any{"id": field.ID, "label": field.Label, "required": field.Required, "configured": configured})
	}
	return map[string]any{"id": entry.ID, "label": entry.Label, "revision": entry.Revision, "enabled": entry.Enabled, "billingModelId": entry.BillingModelID, "credentialFields": fields, "ready": ready, "permissionModes": entry.PermissionModes}
}
