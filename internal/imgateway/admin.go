package imgateway

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

type connectorState struct {
	Running bool   `json:"running"`
	Error   string `json:"error,omitempty"`
}

type Admin struct {
	store      *Store
	registry   *Registry
	gateway    *Gateway
	directory  EmployeeDirectoryPort
	adminHash  [sha256.Size]byte
	runContext context.Context

	mu     sync.RWMutex
	states map[string]connectorState
}

func NewAdmin(ctx context.Context, store *Store, registry *Registry, gateway *Gateway, directory EmployeeDirectoryPort, adminToken string) (*Admin, error) {
	if ctx == nil || store == nil || registry == nil || gateway == nil || directory == nil || len(adminToken) < 32 {
		return nil, errors.New("IM admin dependencies and a 32-byte admin token are required")
	}
	return &Admin{store: store, registry: registry, gateway: gateway, directory: directory, adminHash: sha256.Sum256([]byte(adminToken)), runContext: ctx, states: map[string]connectorState{}}, nil
}

func (a *Admin) StartEnabled(ctx context.Context) error {
	configs, err := a.store.Connectors(ctx)
	if err != nil {
		return err
	}
	for _, config := range configs {
		if config.Enabled {
			a.start(config)
		}
	}
	return nil
}

func (a *Admin) Stop(ctx context.Context) {
	for _, descriptor := range a.registry.List() {
		if connector, ok := a.registry.Get(descriptor.ID); ok {
			_ = connector.Stop(ctx)
		}
	}
}

func (a *Admin) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if !a.authorized(request) {
		writeAdminJSON(writer, http.StatusUnauthorized, map[string]string{"error": "authentication_required"})
		return
	}
	path := strings.TrimPrefix(request.URL.Path, "/v1/")
	if path == "connectors" && request.Method == http.MethodGet {
		a.listConnectors(writer, request)
		return
	}
	if path == "pairings" && request.Method == http.MethodGet {
		pairings, err := a.store.Pairings(request.Context())
		if err != nil {
			writeAdminJSON(writer, 500, map[string]string{"error": "pairing_list_failed"})
			return
		}
		writeAdminJSON(writer, 200, pairings)
		return
	}
	if match := strings.Split(path, "/"); len(match) >= 2 && match[0] == "connectors" {
		a.connector(writer, request, match)
		return
	} else if len(match) == 3 && match[0] == "pairings" {
		a.pairing(writer, request, match)
		return
	}
	writeAdminJSON(writer, http.StatusNotFound, map[string]string{"error": "not_found"})
}

func (a *Admin) listConnectors(writer http.ResponseWriter, request *http.Request) {
	configs, err := a.store.Connectors(request.Context())
	if err != nil {
		writeAdminJSON(writer, 500, map[string]string{"error": "connector_list_failed"})
		return
	}
	configured := map[string]StoredConnector{}
	for _, config := range configs {
		configured[config.ID] = config
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	type view struct {
		ConnectorDescriptor
		Configured bool           `json:"configured"`
		Enabled    bool           `json:"enabled"`
		State      connectorState `json:"state"`
	}
	views := make([]view, 0)
	for _, descriptor := range a.registry.List() {
		config, exists := configured[descriptor.ID]
		views = append(views, view{ConnectorDescriptor: descriptor, Configured: exists, Enabled: config.Enabled, State: a.states[descriptor.ID]})
	}
	writeAdminJSON(writer, 200, views)
}

func (a *Admin) connector(writer http.ResponseWriter, request *http.Request, parts []string) {
	id := parts[1]
	connector, exists := a.registry.Get(id)
	if !exists {
		writeAdminJSON(writer, 404, map[string]string{"error": "connector_not_found"})
		return
	}
	if len(parts) == 2 && request.Method == http.MethodPut {
		var input struct {
			Enabled       bool            `json:"enabled"`
			Public        json.RawMessage `json:"public"`
			CredentialRef string          `json:"credential_ref"`
		}
		if readAdminJSON(request, &input) != nil {
			writeAdminJSON(writer, 400, map[string]string{"error": "invalid_connector_config"})
			return
		}
		config := StoredConnector{ID: id, Enabled: input.Enabled, Config: ConnectorConfig{Public: input.Public, CredentialRef: input.CredentialRef}}
		if err := connector.ValidateConfig(config.Config); err != nil {
			writeAdminJSON(writer, 400, map[string]string{"error": "invalid_connector_config"})
			return
		}
		_ = connector.Stop(request.Context())
		if err := a.store.PutConnector(request.Context(), config); err != nil {
			writeAdminJSON(writer, 500, map[string]string{"error": "connector_store_failed"})
			return
		}
		if input.Enabled {
			a.start(config)
		} else {
			a.setState(id, connectorState{})
		}
		writeAdminJSON(writer, 200, map[string]any{"id": id, "enabled": input.Enabled})
		return
	}
	if len(parts) == 3 && parts[2] == "test" && request.Method == http.MethodPost {
		config, ok, err := a.config(request.Context(), id)
		if err != nil || !ok {
			writeAdminJSON(writer, 404, map[string]string{"error": "connector_not_configured"})
			return
		}
		health, err := connector.Test(request.Context(), config.Config)
		if err != nil {
			writeAdminJSON(writer, 502, map[string]string{"error": "connector_test_failed"})
			return
		}
		writeAdminJSON(writer, 200, health)
		return
	}
	writeAdminJSON(writer, 405, map[string]string{"error": "method_not_allowed"})
}

func (a *Admin) pairing(writer http.ResponseWriter, request *http.Request, parts []string) {
	if request.Method != http.MethodPost {
		writeAdminJSON(writer, 405, map[string]string{"error": "method_not_allowed"})
		return
	}
	id, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		writeAdminJSON(writer, 400, map[string]string{"error": "invalid_pairing"})
		return
	}
	action := parts[2]
	targetSID := ""
	if action == "approve" {
		var input struct {
			TargetSID string `json:"target_sid"`
		}
		if readAdminJSON(request, &input) != nil {
			writeAdminJSON(writer, 400, map[string]string{"error": "invalid_pairing"})
			return
		}
		exists, err := a.directory.Exists(request.Context(), input.TargetSID)
		if err != nil {
			writeAdminJSON(writer, 502, map[string]string{"error": "employee_directory_failed"})
			return
		}
		if !exists {
			writeAdminJSON(writer, 404, map[string]string{"error": "employee_not_found"})
			return
		}
		targetSID = input.TargetSID
	} else if action != "reject" && action != "revoke" {
		writeAdminJSON(writer, 404, map[string]string{"error": "not_found"})
		return
	}
	status := map[string]string{"approve": "approved", "reject": "rejected", "revoke": "revoked"}[action]
	if err := a.store.SetPairingStatus(request.Context(), id, status, targetSID); err != nil {
		writeAdminJSON(writer, 404, map[string]string{"error": "pairing_not_found"})
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (a *Admin) start(config StoredConnector) {
	connector, ok := a.registry.Get(config.ID)
	if !ok {
		return
	}
	err := connector.Start(a.runContext, config.Config, func(ctx context.Context, message InboundMessage) error {
		_, err := a.gateway.Receive(ctx, message)
		return err
	})
	state := connectorState{Running: err == nil}
	if err != nil {
		state.Error = err.Error()
	}
	a.setState(config.ID, state)
}

func (a *Admin) setState(id string, state connectorState) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.states[id] = state
}

func (a *Admin) config(ctx context.Context, id string) (StoredConnector, bool, error) {
	configs, err := a.store.Connectors(ctx)
	for _, config := range configs {
		if config.ID == id {
			return config, true, err
		}
	}
	return StoredConnector{}, false, err
}

func (a *Admin) authorized(request *http.Request) bool {
	provided, ok := strings.CutPrefix(request.Header.Get("Authorization"), "Bearer ")
	digest := sha256.Sum256([]byte(provided))
	return ok && subtle.ConstantTimeCompare(digest[:], a.adminHash[:]) == 1
}

func readAdminJSON(request *http.Request, value any) error {
	decoder := json.NewDecoder(io.LimitReader(request.Body, 256*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("multiple JSON values")
	}
	return nil
}

func writeAdminJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
