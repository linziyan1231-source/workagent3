package portal

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"workagent3/internal/collaboration"
	"workagent3/internal/runtimeapi"
)

func officePreviewTestServer(t *testing.T) (http.Handler, *fakeSharedProjectPlatform, collaborationTestUser, collaborationTestUser) {
	t.Helper()
	handler, collaborationData, platform, alice, bob := collaborationTestServer(t)
	if _, err := collaborationData.CreateProject(t.Context(), collaboration.Project{ID: "project_1234567890", OwnerUserID: alice.user.ID, OwnerSID: "S-1-5-21-1000", Name: "Design"}); err != nil {
		t.Fatal(err)
	}
	if err := collaborationData.SetProvisioningResult(t.Context(), "project_1234567890", true); err != nil {
		t.Fatal(err)
	}
	return handler, platform, alice, bob
}

func TestSharedOfficePreviewRequiresAuthentication(t *testing.T) {
	handler, _, _, _ := officePreviewTestServer(t)
	request := httptest.NewRequest(http.MethodPost, "http://portal.test/api/portal/shared-office-preview", strings.NewReader(`{"project_id":"project_1234567890","path":"deck.pptx"}`))
	request.Header.Set("Origin", "http://portal.test")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous preview = %d %s", response.Code, response.Body.String())
	}
}

func TestSharedOfficePreviewRejectsNonMember(t *testing.T) {
	handler, platform, _, bob := officePreviewTestServer(t)
	response := collaborationRequest(t, handler, bob.session, http.MethodPost, "/api/portal/shared-office-preview", `{"project_id":"project_1234567890","path":"deck.pptx"}`)
	if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), "shared_project_not_found") {
		t.Fatalf("non-member preview = %d %s", response.Code, response.Body.String())
	}
	if platform.previewOwner != "" {
		t.Fatalf("non-member request reached the owner Runtime: %q", platform.previewOwner)
	}
}

func TestSharedOfficePreviewRoutesToOwnerRuntime(t *testing.T) {
	handler, platform, alice, _ := officePreviewTestServer(t)
	platform.previewData = OfficePreviewData{Name: "deck.pdf", PDF: []byte("%PDF-1.7")}
	response := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-office-preview", `{"project_id":"project_1234567890","path":"docs/deck.pptx"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("preview = %d %s", response.Code, response.Body.String())
	}
	// The caller is the owner here; the contract under test is that Portal
	// always resolves the project owner's SID, never the caller's.
	if platform.previewOwner != "S-1-5-21-1000" {
		t.Fatalf("preview owner SID = %q", platform.previewOwner)
	}
	if platform.fileRequest.Operation != "office-preview" || platform.fileRequest.Path != "docs/deck.pptx" {
		t.Fatalf("preview request = %#v", platform.fileRequest)
	}
	var body struct {
		Success bool   `json:"success"`
		URL     string `json:"url"`
	}
	if json.Unmarshal(response.Body.Bytes(), &body) != nil || !body.Success {
		t.Fatalf("preview body = %s", response.Body.String())
	}
	if !strings.HasPrefix(body.URL, "/api/portal/shared-office-preview?") || !strings.Contains(body.URL, "project_id=project_1234567890") || !strings.Contains(body.URL, "path=docs%2Fdeck.pptx") {
		t.Fatalf("preview url = %q", body.URL)
	}
}

func TestSharedOfficePreviewContentStreamsSandboxedPDF(t *testing.T) {
	handler, platform, alice, _ := officePreviewTestServer(t)
	platform.previewData = OfficePreviewData{Name: "deck.pdf", PDF: []byte("%PDF-1.7 stream")}
	response := collaborationRequest(t, handler, alice.session, http.MethodGet, "/api/portal/shared-office-preview?project_id=project_1234567890&path=docs%2Fdeck.pptx", "")
	if response.Code != http.StatusOK || response.Body.String() != "%PDF-1.7 stream" {
		t.Fatalf("content = %d %q", response.Code, response.Body.String())
	}
	if response.Header().Get("content-type") != "application/pdf" {
		t.Fatalf("content-type = %q", response.Header().Get("content-type"))
	}
	policy := response.Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "default-src 'none'") || !strings.Contains(policy, "frame-ancestors 'self'") {
		t.Fatalf("CSP = %q", policy)
	}
	if !strings.HasPrefix(response.Header().Get("content-disposition"), "inline;") {
		t.Fatalf("disposition = %q", response.Header().Get("content-disposition"))
	}
}

func TestSharedOfficePreviewPropagatesUpstreamErrorCode(t *testing.T) {
	handler, platform, alice, _ := officePreviewTestServer(t)
	platform.previewErr = &upstreamRuntimeError{status: http.StatusServiceUnavailable, code: "OFFICECLI_NOT_FOUND"}
	response := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-office-preview", `{"project_id":"project_1234567890","path":"deck.pptx"}`)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "OFFICECLI_NOT_FOUND") {
		t.Fatalf("upstream error = %d %s", response.Code, response.Body.String())
	}
	platform.previewErr = errors.New("connection refused")
	if generic := collaborationRequest(t, handler, alice.session, http.MethodPost, "/api/portal/shared-office-preview", `{"project_id":"project_1234567890","path":"deck.pptx"}`); generic.Code != http.StatusBadGateway || strings.Contains(generic.Body.String(), "connection refused") {
		t.Fatalf("generic error = %d %s", generic.Code, generic.Body.String())
	}
}

func TestRuntimeSharedFilePlatformOfficePreview(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var input SharedFileRequest
		if json.NewDecoder(request.Body).Decode(&input) != nil {
			t.Fatalf("decode: %v", input)
		}
		if input.Operation != "office-preview" {
			t.Fatalf("operation = %q", input.Operation)
		}
		if input.Path == "deck.pptx" {
			writeJSON(writer, http.StatusOK, map[string]any{"success": true, "data": map[string]string{"name": "deck.pdf", "pdf": base64.StdEncoding.EncodeToString([]byte("%PDF-1.7"))}})
			return
		}
		writeError(writer, http.StatusServiceUnavailable, "OFFICECLI_NOT_FOUND")
	}))
	defer server.Close()
	registry := runtimeapi.NewRegistry()
	if err := registry.Register(runtimeapi.Registration{SID: "S-1-5-21-1000", BaseURL: server.URL, Token: "owner-token", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	platform, _ := NewRuntimeSharedFilePlatform(registry)
	data, err := platform.OperateOfficePreview(t.Context(), "S-1-5-21-1000", SharedFileRequest{ProjectID: "project_1234567890", Path: "deck.pptx"})
	if err != nil || data.Name != "deck.pdf" || string(data.PDF) != "%PDF-1.7" {
		t.Fatalf("preview = %#v, %v", data, err)
	}
	// A non-preview failure keeps the owner Runtime's stable error code.
	platform2, _ := NewRuntimeSharedFilePlatform(registry)
	_, err = platform2.OperateOfficePreview(t.Context(), "S-1-5-21-1000", SharedFileRequest{ProjectID: "project_1234567890", Path: "other.pptx"})
	var upstream *upstreamRuntimeError
	if !errors.As(err, &upstream) || upstream.code != "OFFICECLI_NOT_FOUND" || upstream.status != http.StatusServiceUnavailable {
		t.Fatalf("upstream error = %v", err)
	}
}
