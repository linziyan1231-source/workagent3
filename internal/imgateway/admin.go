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

	mu        sync.RWMutex
	states    map[string]connectorState
	instances map[string]ChannelConnector
}

func NewAdmin(ctx context.Context, store *Store, registry *Registry, gateway *Gateway, directory EmployeeDirectoryPort, adminToken string) (*Admin, error) {
	if ctx == nil || store == nil || registry == nil || gateway == nil || directory == nil || len(adminToken) < 32 {
		return nil, errors.New("IM admin dependencies and a 32-byte admin token are required")
	}
	return &Admin{store: store, registry: registry, gateway: gateway, directory: directory, adminHash: sha256.Sum256([]byte(adminToken)), runContext: ctx, states: map[string]connectorState{}, instances: map[string]ChannelConnector{}}, nil
}

func (a *Admin) StartEnabled(ctx context.Context) error {
	configs, err := a.store.AllConnectors(ctx)
	if err != nil {
		return err
	}
	for _, config := range configs {
		if config.Enabled && strings.HasPrefix(config.OwnerSID, "S-1-") {
			a.start(config)
		}
	}
	return nil
}

func (a *Admin) Stop(ctx context.Context) {
	a.mu.RLock()
	instances := make([]ChannelConnector, 0, len(a.instances))
	for _, connector := range a.instances {
		instances = append(instances, connector)
	}
	a.mu.RUnlock()
	for _, connector := range instances {
		_ = connector.Stop(ctx)
	}
}

func (a *Admin) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if !a.authorized(request) {
		writeAdminJSON(writer, http.StatusUnauthorized, map[string]string{"error": "authentication_required"})
		return
	}
	ownerSID := request.Header.Get("X-WorkAgent-SID")
	if !strings.HasPrefix(ownerSID, "S-1-") {
		writeAdminJSON(writer, http.StatusBadRequest, map[string]string{"error": "owner_sid_required"})
		return
	}
	path := strings.TrimPrefix(request.URL.Path, "/v1/")
	if path == "connectors" && request.Method == http.MethodGet {
		a.listConnectors(writer, request, ownerSID)
		return
	}
	if path == "pairings" && request.Method == http.MethodGet {
		pairings, err := a.store.PairingsForOwner(request.Context(), ownerSID)
		if err != nil {
			writeAdminJSON(writer, 500, map[string]string{"error": "pairing_list_failed"})
			return
		}
		writeAdminJSON(writer, 200, pairings)
		return
	}
	if match := strings.Split(path, "/"); len(match) >= 2 && match[0] == "connectors" {
		a.connector(writer, request, match, ownerSID)
		return
	} else if len(match) == 3 && match[0] == "pairings" {
		a.pairing(writer, request, match, ownerSID)
		return
	}
	writeAdminJSON(writer, http.StatusNotFound, map[string]string{"error": "not_found"})
}

func (a *Admin) listConnectors(writer http.ResponseWriter, request *http.Request, ownerSID string) {
	configs, err := a.store.Connectors(request.Context(), ownerSID)
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
		AccountID  string         `json:"account_id,omitempty"`
		HasToken   bool           `json:"has_token"`
		State      connectorState `json:"state"`
	}
	views := make([]view, 0)
	for _, descriptor := range a.registry.List() {
		config, exists := configured[descriptor.ID]
		var public struct {
			AccountID string `json:"account_id"`
		}
		_ = json.Unmarshal(config.Config.Public, &public)
		views = append(views, view{ConnectorDescriptor: descriptor, Configured: exists, Enabled: config.Enabled, AccountID: public.AccountID, HasToken: config.Config.CredentialRef != "", State: a.state(ownerSID, descriptor.ID)})
	}
	writeAdminJSON(writer, 200, views)
}

func (a *Admin) connector(writer http.ResponseWriter, request *http.Request, parts []string, ownerSID string) {
	id := parts[1]
	connector, exists, createErr := a.registry.Create(id)
	if !exists || createErr != nil {
		writeAdminJSON(writer, 404, map[string]string{"error": "connector_not_found"})
		return
	}
	if len(parts) == 3 && parts[2] == "login" && request.Method == http.MethodGet {
		a.login(writer, request, ownerSID, id, connector)
		return
	}
	if len(parts) == 3 && (parts[2] == "enable" || parts[2] == "disable") && request.Method == http.MethodPost {
		config, ok, err := a.config(request.Context(), ownerSID, id)
		if err != nil || !ok {
			writeAdminJSON(writer, http.StatusNotFound, map[string]string{"error": "connector_not_configured"})
			return
		}
		a.stop(request.Context(), ownerSID, id)
		config.Enabled = parts[2] == "enable"
		if err := a.store.PutConnector(request.Context(), config); err != nil {
			writeAdminJSON(writer, http.StatusInternalServerError, map[string]string{"error": "connector_store_failed"})
			return
		}
		if config.Enabled {
			a.start(config)
		} else {
			a.setState(ownerSID, id, connectorState{})
		}
		writeAdminJSON(writer, http.StatusOK, map[string]any{"id": id, "enabled": config.Enabled})
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
		config := StoredConnector{OwnerSID: ownerSID, ID: id, Enabled: input.Enabled, Config: ConnectorConfig{Public: input.Public, CredentialRef: input.CredentialRef}}
		if err := connector.ValidateConfig(config.Config); err != nil {
			writeAdminJSON(writer, 400, map[string]string{"error": "invalid_connector_config"})
			return
		}
		a.stop(request.Context(), ownerSID, id)
		if err := a.store.PutConnector(request.Context(), config); err != nil {
			writeAdminJSON(writer, 500, map[string]string{"error": "connector_store_failed"})
			return
		}
		if input.Enabled {
			a.start(config)
		} else {
			a.setState(ownerSID, id, connectorState{})
		}
		writeAdminJSON(writer, 200, map[string]any{"id": id, "enabled": input.Enabled})
		return
	}
	if len(parts) == 3 && parts[2] == "test" && request.Method == http.MethodPost {
		config, ok, err := a.config(request.Context(), ownerSID, id)
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

func (a *Admin) login(writer http.ResponseWriter, request *http.Request, ownerSID, id string, connector ChannelConnector) {
	login, ok := a.registry.Login(id)
	if !ok {
		writeAdminJSON(writer, http.StatusNotFound, map[string]string{"error": "connector_login_unavailable"})
		return
	}
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeAdminJSON(writer, http.StatusInternalServerError, map[string]string{"error": "streaming_unavailable"})
		return
	}
	writer.Header().Set("Cache-Control", "no-cache, no-store")
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.Header().Set("X-Accel-Buffering", "no")
	emit := func(name string, data any) error {
		encoded, err := json.Marshal(data)
		if err != nil {
			return err
		}
		if _, err := writer.Write([]byte("event: " + name + "\ndata: " + string(encoded) + "\n\n")); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	config, err := login(request.Context(), ownerSID, emit)
	if err != nil {
		_ = emit("error", map[string]string{"message": err.Error()})
		return
	}
	if err := connector.ValidateConfig(config); err != nil {
		_ = emit("error", map[string]string{"message": "invalid connector login result"})
		return
	}
	stored := StoredConnector{OwnerSID: ownerSID, ID: id, Enabled: true, Config: config}
	a.stop(request.Context(), ownerSID, id)
	if err := a.store.PutConnector(request.Context(), stored); err != nil {
		_ = emit("error", map[string]string{"message": "could not save connector login"})
		return
	}
	a.start(stored)
	var public struct {
		AccountID string `json:"account_id"`
		BaseURL   string `json:"base_url"`
	}
	_ = json.Unmarshal(config.Public, &public)
	_ = emit("done", map[string]string{"accountId": public.AccountID, "baseUrl": public.BaseURL})
}

func (a *Admin) pairing(writer http.ResponseWriter, request *http.Request, parts []string, ownerSID string) {
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
	if action == "approve" {
		exists, err := a.directory.Exists(request.Context(), ownerSID)
		if err != nil {
			writeAdminJSON(writer, 502, map[string]string{"error": "employee_directory_failed"})
			return
		}
		if !exists {
			writeAdminJSON(writer, 404, map[string]string{"error": "employee_not_found"})
			return
		}
	} else if action != "reject" && action != "revoke" {
		writeAdminJSON(writer, 404, map[string]string{"error": "not_found"})
		return
	}
	status := map[string]string{"approve": "approved", "reject": "rejected", "revoke": "revoked"}[action]
	if err := a.store.SetOwnerPairingStatus(request.Context(), ownerSID, id, status); err != nil {
		writeAdminJSON(writer, 404, map[string]string{"error": "pairing_not_found"})
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func (a *Admin) start(config StoredConnector) {
	connector, ok, err := a.registry.Create(config.ID)
	if !ok || err != nil {
		if err != nil {
			a.setState(config.OwnerSID, config.ID, connectorState{Error: err.Error()})
		}
		return
	}
	err = connector.Start(a.runContext, config.Config, func(ctx context.Context, message InboundMessage) error {
		_, err := a.gateway.Receive(ctx, message)
		return err
	})
	state := connectorState{Running: err == nil}
	if err != nil {
		state.Error = err.Error()
	}
	key := connectorKey(config.OwnerSID, config.ID)
	a.mu.Lock()
	if err == nil {
		a.instances[key] = connector
	}
	a.states[key] = state
	a.mu.Unlock()
}

func (a *Admin) setState(ownerSID, id string, state connectorState) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.states[connectorKey(ownerSID, id)] = state
}

func (a *Admin) state(ownerSID, id string) connectorState {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.states[connectorKey(ownerSID, id)]
}

func (a *Admin) config(ctx context.Context, ownerSID, id string) (StoredConnector, bool, error) {
	configs, err := a.store.Connectors(ctx, ownerSID)
	for _, config := range configs {
		if config.ID == id {
			return config, true, err
		}
	}
	return StoredConnector{}, false, err
}

func (a *Admin) stop(ctx context.Context, ownerSID, id string) {
	key := connectorKey(ownerSID, id)
	a.mu.Lock()
	connector := a.instances[key]
	delete(a.instances, key)
	a.mu.Unlock()
	if connector != nil {
		_ = connector.Stop(ctx)
	}
}

func connectorKey(ownerSID, id string) string { return ownerSID + "\x00" + id }

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
