package userhost

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"workagent3/internal/mcpruntime"
)

func testImporter(t *testing.T) *capabilityImporter {
	t.Helper()
	catalog, err := mcpruntime.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { catalog.Close() })
	return &capabilityImporter{journal: filepath.Join(t.TempDir(), "imports.jsonl"), skills: openGatewaySkills(t), skillPublisher: gatewayTestPublisher{}, mcp: catalog, credentials: openGatewayCredentials(t), mcpPublisher: gatewayTestPublisher{}}
}
func TestMCPImportProtectsSecretsAndReportsPartialFailure(t *testing.T) {
	importer := testImporter(t)
	req := httptest.NewRequest("POST", "/v1/imports/mcp", strings.NewReader(`{"mcpServers":{"good":{"url":"https://example.test/mcp","headers":{"Authorization":"secret-import-value"}},"bad":{"url":"invalid"}}}`))
	w := httptest.NewRecorder()
	importer.mcps(w, req)
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	var records []capabilityImportRecord
	if json.Unmarshal(w.Body.Bytes(), &records) != nil || len(records) != 2 {
		t.Fatal("missing import outcomes")
	}
	servers, err := importer.mcp.List(context.Background())
	if err != nil || len(servers) != 1 {
		t.Fatal("invalid partial import")
	}
	credentialID := servers[0].Transport.HeaderCredentialIDs["Authorization"]
	secret, err := importer.credentials.Resolve(context.Background(), credentialID)
	if err != nil || string(secret) != "secret-import-value" {
		t.Fatal("missing protected credential")
	}
	raw, _ := os.ReadFile(importer.journal)
	if bytes.Contains(raw, []byte("secret-import-value")) || strings.Contains(w.Body.String(), "secret-import-value") {
		t.Fatal("secret leaked to outcomes")
	}
	// A fresh handler reads persisted outcomes, rather than browser-only history.
	reopened := &capabilityImporter{journal: importer.journal}
	history := httptest.NewRecorder()
	reopened.history(history, httptest.NewRequest("GET", "/v1/imports", nil))
	if history.Code != 200 || !strings.Contains(history.Body.String(), "mcp_import_failed") {
		t.Fatal("history not persisted")
	}
}
func TestSkillDirectoryImportRejectsTraversalAndInstallsCompletePackage(t *testing.T) {
	for _, bad := range []bool{true, false} {
		t.Run(map[bool]string{true: "traversal", false: "valid"}[bad], func(t *testing.T) {
			importer := testImporter(t)
			var body bytes.Buffer
			form := multipart.NewWriter(&body)
			form.WriteField("name", "imported-skill")
			form.WriteField("format", "directory")
			paths := []string{"bundle/SKILL.md", "bundle/references/example.txt"}
			if bad {
				paths[1] = "../escape.txt"
			}
			encoded, _ := json.Marshal(paths)
			form.WriteField("paths", string(encoded))
			first, _ := form.CreateFormFile("files", "SKILL.md")
			first.Write([]byte("---\nname: imported-skill\ndescription: Import fixture\n---\nRead references/example.txt.\n"))
			second, _ := form.CreateFormFile("files", "example.txt")
			second.Write([]byte("supporting evidence"))
			form.Close()
			req := httptest.NewRequest("POST", "/v1/imports/skill", &body)
			req.Header.Set("Content-Type", form.FormDataContentType())
			w := httptest.NewRecorder()
			importer.skill(w, req)
			var result capabilityImportRecord
			if json.Unmarshal(w.Body.Bytes(), &result) != nil {
				t.Fatal(w.Body.String())
			}
			entries, err := importer.skills.List(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if bad {
				if result.Error == "" || len(entries) != 0 {
					t.Fatal("unsafe package installed")
				}
				return
			}
			if result.Error != "" || len(entries) != 1 {
				t.Fatal(w.Body.String())
			}
			content, err := os.ReadFile(filepath.Join(importer.skills.DirectoryFor(entries[0]), "references", "example.txt"))
			if err != nil || string(content) != "supporting evidence" {
				t.Fatal("support files missing")
			}
		})
	}
}
