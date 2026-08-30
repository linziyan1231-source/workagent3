package userhost

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"

	"workagent3/internal/auth"
	"workagent3/internal/mcpruntime"
)

type runtimeGateway struct {
	server  *http.Server
	catalog *mcpruntime.Catalog
}

func newRuntimeGateway(runtimeDirectory string, target *url.URL, token string) (*runtimeGateway, error) {
	catalog, err := mcpruntime.Open(filepath.Join(runtimeDirectory, "mcp-catalog.db"))
	if err != nil {
		return nil, err
	}
	handler := newRuntimeGatewayHandler(catalog, target, token)
	return &runtimeGateway{server: &http.Server{Handler: handler}, catalog: catalog}, nil
}

func (g *runtimeGateway) Close() error {
	serverErr := g.server.Close()
	catalogErr := g.catalog.Close()
	if serverErr != nil && !errors.Is(serverErr, http.ErrServerClosed) {
		return serverErr
	}
	return catalogErr
}

func newRuntimeGatewayHandler(catalog *mcpruntime.Catalog, target *url.URL, token string) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(target)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/mcp-servers", listMCPServers(catalog))
	mux.HandleFunc("POST /v1/mcp-servers", createMCPServer(catalog))
	mux.HandleFunc("PATCH /v1/mcp-servers/{id}", updateMCPServer(catalog))
	mux.HandleFunc("DELETE /v1/mcp-servers/{id}", deleteMCPServer(catalog))
	mux.Handle("/", proxy)
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		provided, ok := strings.CutPrefix(request.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			writeRuntimeError(writer, http.StatusUnauthorized, "runtime_authentication_required")
			return
		}
		mux.ServeHTTP(writer, request)
	})
}

func listMCPServers(catalog *mcpruntime.Catalog) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		servers, err := catalog.List(request.Context())
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "mcp_catalog_failed")
			return
		}
		writeRuntimeJSON(writer, http.StatusOK, servers)
	}
}

func createMCPServer(catalog *mcpruntime.Catalog) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		var input mcpMutation
		decoder := json.NewDecoder(io.LimitReader(request.Body, 64*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || input.Name == nil || input.Transport == nil || input.Enabled == nil ||
			input.ToolPolicy == nil || input.AllowedTools == nil || input.Source == nil || *input.Source != "user" ||
			input.OAuthState == nil || *input.OAuthState != "none" {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_mcp_server")
			return
		}
		if len(input.Transport.EnvironmentCredentialIDs) != 0 || len(input.Transport.HeaderCredentialIDs) != 0 {
			writeRuntimeError(writer, http.StatusBadRequest, "credential_reference_not_found")
			return
		}
		id, err := auth.RandomToken(18)
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "mcp_catalog_failed")
			return
		}
		health := "unknown"
		if input.Transport.Kind == "stdio" {
			health = "needs_review"
		}
		server, err := catalog.Create(request.Context(), mcpruntime.Server{
			ID: id, Name: *input.Name, Description: valueOrEmpty(input.Description), Source: "user", Enabled: *input.Enabled,
			Transport: *input.Transport, ToolPolicy: *input.ToolPolicy, AllowedTools: *input.AllowedTools,
			OAuthState: "none", Health: health,
		})
		if err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_mcp_server")
			return
		}
		writeRuntimeJSON(writer, http.StatusCreated, server)
	}
}

func updateMCPServer(catalog *mcpruntime.Catalog) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		server, err := catalog.Get(request.Context(), request.PathValue("id"))
		if errors.Is(err, mcpruntime.ErrNotFound) {
			writeRuntimeError(writer, http.StatusNotFound, "mcp_server_not_found")
			return
		}
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "mcp_catalog_failed")
			return
		}
		if server.Source != "user" {
			writeRuntimeError(writer, http.StatusForbidden, "managed_mcp_read_only")
			return
		}
		var input mcpMutation
		decoder := json.NewDecoder(io.LimitReader(request.Body, 64*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || (input.Source != nil && *input.Source != "user") ||
			(input.OAuthState != nil && *input.OAuthState != server.OAuthState) || input.Health != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_mcp_server")
			return
		}
		if input.Name != nil {
			server.Name = *input.Name
		}
		if input.Description != nil {
			server.Description = *input.Description
		}
		if input.Enabled != nil {
			server.Enabled = *input.Enabled
		}
		if input.Transport != nil {
			if len(input.Transport.EnvironmentCredentialIDs) != 0 || len(input.Transport.HeaderCredentialIDs) != 0 {
				writeRuntimeError(writer, http.StatusBadRequest, "credential_reference_not_found")
				return
			}
			server.Transport = *input.Transport
			server.Health = "unknown"
			if server.Transport.Kind == "stdio" {
				server.Health = "needs_review"
			}
		}
		if input.ToolPolicy != nil {
			server.ToolPolicy = *input.ToolPolicy
		}
		if input.AllowedTools != nil {
			server.AllowedTools = *input.AllowedTools
		}
		server, err = catalog.Replace(request.Context(), server)
		if err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_mcp_server")
			return
		}
		writeRuntimeJSON(writer, http.StatusOK, server)
	}
}

func deleteMCPServer(catalog *mcpruntime.Catalog) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		server, err := catalog.Get(request.Context(), request.PathValue("id"))
		if errors.Is(err, mcpruntime.ErrNotFound) {
			writeRuntimeError(writer, http.StatusNotFound, "mcp_server_not_found")
			return
		}
		if err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "mcp_catalog_failed")
			return
		}
		if server.Source != "user" {
			writeRuntimeError(writer, http.StatusForbidden, "managed_mcp_read_only")
			return
		}
		if err := catalog.Delete(request.Context(), server.ID); err != nil {
			writeRuntimeError(writer, http.StatusInternalServerError, "mcp_catalog_failed")
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	}
}

type mcpMutation struct {
	Name         *string               `json:"name"`
	Description  *string               `json:"description"`
	Source       *string               `json:"source"`
	Enabled      *bool                 `json:"enabled"`
	Transport    *mcpruntime.Transport `json:"transport"`
	ToolPolicy   *string               `json:"toolPolicy"`
	AllowedTools *[]string             `json:"allowedTools"`
	OAuthState   *string               `json:"oauthState"`
	Health       *string               `json:"health"`
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func writeRuntimeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeRuntimeError(writer http.ResponseWriter, status int, code string) {
	writeRuntimeJSON(writer, status, map[string]string{"error": code})
}
