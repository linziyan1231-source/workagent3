package userhost

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/credentialbroker"
	"workagent3/internal/mcpruntime"
	"workagent3/internal/skillruntime"
)

// The journal contains outcomes only. Uploaded configuration and credentials
// are never included; their existing catalogs remain the source of truth.
type capabilityImportRecord struct {
	Kind       string    `json:"kind"`
	Name       string    `json:"name"`
	ResourceID string    `json:"resourceId,omitempty"`
	Error      string    `json:"error,omitempty"`
	At         time.Time `json:"at"`
}
type capabilityImporter struct {
	mu             sync.Mutex
	journal        string
	skills         *skillruntime.Store
	skillPublisher skillProjectionPublisher
	mcp            *mcpruntime.Catalog
	credentials    runtimeCredentialCatalog
	mcpPublisher   mcpProjectionPublisher
}

func (s *capabilityImporter) record(record capabilityImportRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := os.OpenFile(s.journal, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	return json.NewEncoder(file).Encode(record)
}
func (s *capabilityImporter) history(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows := []capabilityImportRecord{}
	file, err := os.Open(s.journal)
	if errors.Is(err, os.ErrNotExist) {
		writeRuntimeJSON(w, 200, rows)
		return
	}
	if err != nil {
		writeRuntimeError(w, 500, "import_history_failed")
		return
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var row capabilityImportRecord
		if json.Unmarshal(scanner.Bytes(), &row) != nil {
			writeRuntimeError(w, 500, "import_history_failed")
			return
		}
		rows = append(rows, row)
		if len(rows) > 1000 {
			rows = rows[1:]
		}
	}
	if scanner.Err() != nil {
		writeRuntimeError(w, 500, "import_history_failed")
		return
	}
	writeRuntimeJSON(w, 200, rows)
}
func (s *capabilityImporter) skill(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxMarketArchiveBytes)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeRuntimeError(w, 400, "invalid_skill_upload")
		return
	}
	defer r.MultipartForm.RemoveAll()
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" || len(name) > 120 {
		writeRuntimeError(w, 400, "invalid_skill_name")
		return
	}
	record := capabilityImportRecord{Kind: "skill", Name: name, At: time.Now().UTC()}
	entry, err := s.installUploadedSkill(r)
	if err != nil {
		record.Error = "skill_import_failed"
	} else {
		record.ResourceID = entry.ID
		if s.skillPublisher.Publish(r.Context()) != nil {
			record.Error = "skill_projection_failed"
		}
	}
	if s.record(record) != nil {
		writeRuntimeError(w, 500, "import_history_failed")
		return
	}
	writeRuntimeJSON(w, 200, record)
}
func (s *capabilityImporter) installUploadedSkill(r *http.Request) (skillruntime.Entry, error) {
	temp, err := os.MkdirTemp("", "workagent-skill-import-")
	if err != nil {
		return skillruntime.Entry{}, err
	}
	defer os.RemoveAll(temp)
	files := r.MultipartForm.File["files"]
	if len(files) == 0 || len(files) > 10000 {
		return skillruntime.Entry{}, errors.New("invalid file count")
	}
	root := filepath.Join(temp, "package")
	if r.FormValue("format") == "zip" {
		if len(files) != 1 {
			return skillruntime.Entry{}, errors.New("one archive required")
		}
		input, err := files[0].Open()
		if err != nil {
			return skillruntime.Entry{}, err
		}
		defer input.Close()
		archivePath := filepath.Join(temp, "upload.zip")
		archive, err := os.Create(archivePath)
		if err != nil {
			return skillruntime.Entry{}, err
		}
		_, copyErr := io.Copy(archive, input)
		closeErr := archive.Close()
		if copyErr != nil {
			return skillruntime.Entry{}, copyErr
		}
		if closeErr != nil {
			return skillruntime.Entry{}, closeErr
		}
		if err := extractMarketSkillArchive(archivePath, root); err != nil {
			return skillruntime.Entry{}, err
		}
	} else {
		var paths []string
		if json.Unmarshal([]byte(r.FormValue("paths")), &paths) != nil || len(paths) != len(files) {
			return skillruntime.Entry{}, errors.New("invalid file paths")
		}
		for i, file := range files {
			name := paths[i]
			clean := path.Clean(name)
			if clean == "." || clean == ".." || path.IsAbs(clean) || strings.HasPrefix(clean, "../") || strings.ContainsAny(name, "\\:") {
				return skillruntime.Entry{}, errors.New("invalid file path")
			}
			target := filepath.Join(root, filepath.FromSlash(clean))
			if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				return skillruntime.Entry{}, err
			}
			input, err := file.Open()
			if err != nil {
				return skillruntime.Entry{}, err
			}
			output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				input.Close()
				return skillruntime.Entry{}, err
			}
			_, copyErr := io.Copy(output, input)
			input.Close()
			closeErr := output.Close()
			if copyErr != nil {
				return skillruntime.Entry{}, copyErr
			}
			if closeErr != nil {
				return skillruntime.Entry{}, closeErr
			}
		}
	}
	source, err := marketSkillSource(root)
	if err != nil {
		return skillruntime.Entry{}, err
	}
	id, err := auth.RandomToken(18)
	if err != nil {
		return skillruntime.Entry{}, err
	}
	return s.skills.Install(r.Context(), skillruntime.InstallInput{Entry: skillruntime.Entry{ID: "import-" + id, Name: strings.TrimSpace(r.FormValue("name")), Description: r.FormValue("description"), Version: "1.0.0", Source: "user", Enabled: true, RequiredMCPServerIDs: []string{}, RequiredCommands: []string{}}, SourceDirectory: source})
}

type importedMCP struct {
	GlobalSource string            `json:"-"`
	NativeName   string            `json:"-"`
	Command      string            `json:"command"`
	Args         []string          `json:"args"`
	URL          string            `json:"url"`
	Type         string            `json:"type"`
	Env          map[string]string `json:"env"`
	Headers      map[string]string `json:"headers"`
}

func (s *capabilityImporter) importMCP(ctx context.Context, name string, input importedMCP) (string, error) {
	return s.importMCPRecord(ctx, name, input, nil)
}

func (s *capabilityImporter) importMCPRecord(ctx context.Context, name string, input importedMCP, existing *mcpruntime.Server) (string, error) {
	id, err := auth.RandomToken(18)
	if err != nil {
		return "", err
	}
	transport := mcpruntime.Transport{Kind: input.Type, URL: input.URL, Command: input.Command, Args: input.Args, EnvironmentCredentialIDs: map[string]string{}, HeaderCredentialIDs: map[string]string{}}
	transport.GlobalSource, transport.NativeName = input.GlobalSource, input.NativeName
	if transport.Kind == "" {
		if input.Command != "" {
			transport.Kind = "stdio"
		} else {
			transport.Kind = "http"
		}
	}
	if transport.Kind == "streamable-http" || transport.Kind == "streamablehttp" {
		transport.Kind = "http"
	}
	created := []string{}
	rollback := func() {
		for _, key := range created {
			_ = s.credentials.Revoke(context.Background(), key)
		}
	}
	for key, value := range input.Env {
		credentialID := "import-" + id + "-env-" + key
		secret := []byte(value)
		_, err := s.credentials.Put(ctx, credentialbroker.Input{ID: credentialID, Kind: credentialbroker.KindMCPEnv, Label: name + " / " + key, Secret: secret, State: credentialbroker.StateReady})
		clear(secret)
		if err != nil {
			rollback()
			return "", err
		}
		created = append(created, credentialID)
		transport.EnvironmentCredentialIDs[key] = credentialID
	}
	for key, value := range input.Headers {
		credentialID, err := auth.RandomToken(18)
		if err != nil {
			rollback()
			return "", err
		}
		secret := []byte(value)
		_, err = s.credentials.Put(ctx, credentialbroker.Input{ID: credentialID, Kind: credentialbroker.KindMCPHeader, Label: name + " / " + key, Secret: secret, State: credentialbroker.StateReady})
		clear(secret)
		if err != nil {
			rollback()
			return "", err
		}
		created = append(created, credentialID)
		transport.HeaderCredentialIDs[key] = credentialID
	}
	health := "unknown"
	if transport.Kind == "stdio" {
		health = "needs_review"
	}
	if input.GlobalSource != "" {
		health = "unknown"
	}
	server := mcpruntime.Server{ID: id, Name: name, Source: "user", Enabled: true, Transport: transport, ToolPolicy: "all", AllowedTools: []string{}, OAuthState: "none", Health: health}
	if existing != nil {
		server.ID, server.Enabled, server.ToolPolicy, server.AllowedTools = existing.ID, existing.Enabled, existing.ToolPolicy, existing.AllowedTools
		_, err = s.mcp.Replace(ctx, server)
		id = existing.ID
	} else {
		_, err = s.mcp.Create(ctx, server)
	}
	if err != nil {
		rollback()
		return "", err
	}
	if input.GlobalSource != "" {
		if err := s.mcp.RememberNativeName(ctx, input.NativeName, transport); err != nil {
			return "", err
		}
	}
	return id, nil
}
func (s *capabilityImporter) mcps(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Servers map[string]importedMCP `json:"mcpServers"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	if json.NewDecoder(r.Body).Decode(&input) != nil || len(input.Servers) == 0 || len(input.Servers) > 100 {
		writeRuntimeError(w, 400, "invalid_mcp_import")
		return
	}
	rows := []capabilityImportRecord{}
	for name, server := range input.Servers {
		row := capabilityImportRecord{Kind: "mcp", Name: name, At: time.Now().UTC()}
		if len(name) > 120 || strings.TrimSpace(name) == "" {
			row.Name = ""
			row.Error = "invalid_mcp_name"
		} else {
			id, err := s.importMCP(r.Context(), name, server)
			if err != nil {
				row.Error = "mcp_import_failed"
			} else {
				row.ResourceID = id
			}
		}
		rows = append(rows, row)
	}
	if s.mcpPublisher.Publish(r.Context()) != nil {
		for i := range rows {
			if rows[i].Error == "" {
				rows[i].Error = "mcp_projection_failed"
			}
		}
	}
	for _, row := range rows {
		if s.record(row) != nil {
			writeRuntimeError(w, 500, "import_history_failed")
			return
		}
	}
	writeRuntimeJSON(w, 200, rows)
}
