package userhost

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMarketSkillInstallExtractsOneValidatedSkill(t *testing.T) {
	skills := openGatewaySkills(t)
	archive := marketSkillZip(t, map[string]string{
		"wiki/SKILL.md":           "---\nname: wiki\ndescription: Wiki workflows\n---\n# Wiki\n",
		"wiki/references/help.md": "help",
	})
	metadata, _ := json.Marshal(marketSkillMetadata{ID: "market-wiki", Name: "Wiki", Description: "Wiki workflows", Version: "1.0.0"})
	request := httptest.NewRequest(http.MethodPost, "/v1/skills/market-install", bytes.NewReader(archive))
	request.Header.Set("Content-Type", "application/zip")
	request.Header.Set("X-WorkAgent-Skill-Metadata", base64.RawURLEncoding.EncodeToString(metadata))
	response := httptest.NewRecorder()
	installMarketSkill(skills, gatewayTestPublisher{}).ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("install status %d: %s", response.Code, response.Body.String())
	}
	entry, err := skills.Get(t.Context(), "market-wiki")
	if err != nil || entry.Source != "market" || !entry.Enabled {
		t.Fatalf("installed entry = %#v, %v", entry, err)
	}
}

func TestMarketSkillInstallRejectsArchiveTraversal(t *testing.T) {
	skills := openGatewaySkills(t)
	archive := marketSkillZip(t, map[string]string{"../escape/SKILL.md": "bad"})
	metadata, _ := json.Marshal(marketSkillMetadata{ID: "escape", Name: "Escape", Version: "1.0.0"})
	request := httptest.NewRequest(http.MethodPost, "/v1/skills/market-install", bytes.NewReader(archive))
	request.Header.Set("Content-Type", "application/zip")
	request.Header.Set("X-WorkAgent-Skill-Metadata", base64.RawURLEncoding.EncodeToString(metadata))
	response := httptest.NewRecorder()
	installMarketSkill(skills, gatewayTestPublisher{}).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("traversal status %d: %s", response.Code, response.Body.String())
	}
}

func marketSkillZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, contents := range files {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(contents)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
