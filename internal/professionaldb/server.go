package professionaldb

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
	"unicode"
)

const (
	protocolVersion  = "2025-06-18"
	maxRequestBytes  = 2 << 20
	maxResponseBytes = 8 << 20
	ServiceName      = "workagent3-professional-database"
)

type Config struct {
	CredentialPath string `json:"credential_path"`
	OAuthHost      string `json:"oauth_host,omitempty"`
	APIURL         string `json:"api_url,omitempty"`
	OutboundProxy  string `json:"outbound_proxy_url,omitempty"`
}

type Server struct {
	cfg        Config
	store      *Store
	enabled    func(context.Context, string) (bool, error)
	client     *http.Client
	credential credentialManager
}

func NewServer(cfg Config, store *Store, enabled func(context.Context, string) (bool, error)) (*Server, error) {
	if cfg.OAuthHost == "" {
		cfg.OAuthHost = "https://auth.kimi.com"
	}
	if cfg.APIURL == "" {
		cfg.APIURL = "https://api.kimi.com/coding/v1/tools"
	}
	if cfg.CredentialPath != "" && !filepath.IsAbs(cfg.CredentialPath) {
		return nil, errors.New("professional database credential path must be absolute")
	}
	for _, endpoint := range []string{cfg.OAuthHost, cfg.APIURL} {
		parsed, err := url.Parse(endpoint)
		if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" || (parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopback(parsed.Hostname()))) {
			return nil, errors.New("professional database endpoints require HTTPS (HTTP allowed only for loopback)")
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// A service deployment opts into its own proxy; inherited shell/SYSTEM
	// proxies may belong to an unrelated, stopped desktop application.
	transport.Proxy = nil
	if cfg.OutboundProxy != "" {
		proxy, err := url.Parse(cfg.OutboundProxy)
		if err != nil || proxy.Hostname() == "" || proxy.User != nil || (proxy.Scheme != "http" && proxy.Scheme != "https") {
			return nil, errors.New("invalid professional database outbound proxy")
		}
		transport.Proxy = http.ProxyURL(proxy)
	}
	// Redirects must not forward credentials or resend a metered call elsewhere.
	client := &http.Client{Transport: transport, Timeout: 35 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return &Server{cfg: cfg, store: store, enabled: enabled, client: client,
		credential: credentialManager{path: cfg.CredentialPath, oauthHost: cfg.OAuthHost, client: client}}, nil
}

func isLoopback(host string) bool { return host == "localhost" || net.ParseIP(host).IsLoopback() }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/mcp", s.handleMCP)
	return mux
}

func (s *Server) Ready() bool { return s.credential.ready() }

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	status := "needs_auth"
	if s.Ready() {
		status = "ready"
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": status, "service": ServiceName})
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		http.Error(w, ErrUnauthorized.Error(), http.StatusUnauthorized)
		return
	}
	token := parts[1]
	grant, sid, err := s.store.authenticate(r.Context(), s.store.db, token, s.store.now())
	if err != nil {
		status := http.StatusServiceUnavailable
		if errors.Is(err, ErrUnauthorized) {
			status = http.StatusUnauthorized
		}
		if errors.Is(err, ErrDisabled) {
			status = http.StatusForbidden
		}
		http.Error(w, publicError(err).Error(), status)
		return
	}
	active, err := s.enabled(r.Context(), sid)
	if err != nil || !active {
		http.Error(w, ErrDisabled.Error(), http.StatusForbidden)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()
	data, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes+1))
	if err != nil || len(data) > maxRequestBytes {
		http.Error(w, "Request too large or unreadable", http.StatusRequestEntityTooLarge)
		return
	}
	var request rpcRequest
	if json.Unmarshal(data, &request) != nil || request.JSONRPC != "2.0" || request.Method == "" {
		writeRPC(w, rpcResponse{JSONRPC: "2.0", Error: &rpcError{-32600, "Invalid Request"}})
		return
	}
	if len(request.ID) == 0 || string(request.ID) == "null" {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	response := rpcResponse{JSONRPC: "2.0", ID: request.ID}
	switch request.Method {
	case "initialize":
		response.Result = map[string]any{"protocolVersion": protocolVersion, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]string{"name": ServiceName, "version": "1.0.0"}}
	case "ping":
		response.Result = map[string]any{}
	case "tools/list":
		response.Result = map[string]any{"tools": tools(grant.AllowedSources)}
	case "tools/call":
		result, err := s.callTool(r.Context(), token, sid, grant, request.Params)
		if err != nil {
			result = toolError(publicError(err))
		}
		response.Result = result
	default:
		response.Error = &rpcError{-32601, "Method not found"}
	}
	writeRPC(w, response)
}

func (s *Server) callTool(ctx context.Context, token, sid string, grant Grant, raw json.RawMessage) (any, error) {
	var params struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if json.Unmarshal(raw, &params) != nil {
		return nil, ErrInvalidArguments
	}
	arguments, source, err := validateArguments(params.Name, params.Arguments)
	if err != nil {
		return nil, err
	}
	if !slices.Contains(grant.AllowedSources, source) {
		return nil, ErrSourceDenied
	}
	// Missing credentials and validation failures are rejected before reserving.
	upstreamToken, err := s.credential.accessToken(ctx)
	if err != nil {
		return nil, err
	}
	active, err := s.enabled(ctx, sid)
	if err != nil || !active {
		return nil, ErrDisabled
	}
	id, err := s.store.reserve(ctx, token, source, params.Name)
	if err != nil {
		return nil, err
	}
	outcome := "upstream_error"
	defer func() { s.store.finish(id, outcome) }()
	upstream, err := s.callUpstream(ctx, upstreamToken, params.Name, arguments)
	if err != nil {
		return nil, err
	}
	result, err := formatResult(upstream, id)
	if err != nil {
		return nil, err
	}
	outcome = "success"
	return result, nil
}

func validateArguments(method string, args map[string]any) (map[string]any, string, error) {
	field := "name"
	if method == "call_data_source_tool" {
		field = "data_source_name"
	} else if method != "get_data_source_desc" {
		return nil, "", ErrInvalidArguments
	}
	source, ok := args[field].(string)
	if !ok || !slices.Contains(Sources, source) {
		return nil, "", ErrInvalidArguments
	}
	if method == "get_data_source_desc" {
		return map[string]any{"name": source}, source, nil
	}
	api, ok := args["api_name"].(string)
	if !ok || strings.TrimSpace(api) == "" || len(api) > 256 || strings.ContainsFunc(api, unicode.IsControl) {
		return nil, "", ErrInvalidArguments
	}
	values, ok := args["params"].(map[string]any)
	if !ok {
		return nil, "", ErrInvalidArguments
	}
	// Output filenames are labels for embedded resources. No request can write
	// a host path; normalize common upstream output-path fields to plain names.
	for _, key := range []string{"file_path", "filepath"} {
		if value, exists := values[key]; exists {
			name, ok := value.(string)
			if !ok {
				return nil, "", ErrInvalidArguments
			}
			values[key] = safeFilename(name)
		}
	}
	return map[string]any{"data_source_name": source, "api_name": strings.TrimSpace(api), "params": values}, source, nil
}

func (s *Server) callUpstream(ctx context.Context, token, method string, params map[string]any) (any, error) {
	body, _ := json.Marshal(map[string]any{"method": method, "params": params})
	callID := make([]byte, 16)
	if _, err := rand.Read(callID); err != nil {
		return nil, ErrUpstream
	}
	for attempt := 0; attempt < 2; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.APIURL, strings.NewReader(string(body)))
		if err != nil {
			return nil, ErrUpstream
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Msh-Platform", "workagent3")
		request.Header.Set("X-Msh-Version", "1.0.0")
		request.Header.Set("X-Msh-Os-Version", runtime.GOOS+"/"+runtime.GOARCH)
		request.Header.Set("X-Msh-Tool-Call-Id", hex.EncodeToString(callID))
		request.Header.Set("User-Agent", ServiceName+"/1.0.0")
		response, err := s.client.Do(request)
		if err != nil {
			return nil, ErrUpstream
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
		response.Body.Close()
		if readErr != nil || len(data) > maxResponseBytes {
			return nil, ErrUpstream
		}
		if response.StatusCode == http.StatusUnauthorized && attempt == 0 {
			token, err = s.credential.refreshRejected(ctx, token)
			if err != nil {
				return nil, err
			}
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, ErrUpstream
		}
		var result any
		if json.Unmarshal(data, &result) != nil {
			return string(data), nil
		}
		return result, nil
	}
	return nil, ErrUpstream
}

func tools(sources []string) []map[string]any {
	return []map[string]any{
		{"name": "get_data_source_desc", "description": "获取已授权专业数据源的当前接口说明，查询前先调用。每次获取说明消耗 1 次调用额度。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string", "enum": sources}}, "required": []string{"name"}}},
		{"name": "call_data_source_tool", "description": "使用数据源说明中的接口名称和参数查询。每次查询消耗 1 次额度，上游失败仍计次。CSV 等文件作为嵌入资源返回，可保存到自己的工作区。", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{
			"data_source_name": map[string]any{"type": "string", "enum": sources}, "api_name": map[string]string{"type": "string"}, "params": map[string]string{"type": "object"},
		}, "required": []string{"data_source_name", "api_name", "params"}}},
	}
}

func formatResult(upstream any, callID int64) (any, error) {
	object, isObject := upstream.(map[string]any)
	if isObject && object["is_success"] == false {
		return nil, ErrUpstream
	}
	text := ""
	if value, ok := upstream.(string); ok {
		text = value
	}
	if isObject {
		text = channelText(object["result"])
		if text == "" {
			for _, key := range []string{"text", "content", "result"} {
				if value, ok := object[key].(string); ok && value != "" {
					text = value
					break
				}
			}
		}
	}
	if text == "" {
		// File payloads belong in resources, not duplicated in the text channel.
		value := upstream
		if isObject {
			summary := make(map[string]any, len(object))
			for key, item := range object {
				if key != "files" {
					summary[key] = item
				}
			}
			value = summary
		}
		data, _ := json.MarshalIndent(value, "", "  ")
		text = string(data)
	}
	content := []map[string]any{{"type": "text", "text": text}}
	if files, ok := object["files"].([]any); ok {
		for index, item := range files {
			file, ok := item.(map[string]any)
			if !ok {
				continue
			}
			name, _ := file["name"].(string)
			body, ok := file["content"].(string)
			if !ok || name == "" {
				continue
			}
			name = safeFilename(name)
			mime := "text/plain"
			if strings.EqualFold(path.Ext(name), ".csv") {
				mime = "text/csv"
			}
			resource := map[string]any{"uri": fmt.Sprintf("professional-database://calls/%d/%d/%s", callID, index, url.PathEscape(name)), "mimeType": mime}
			if file["encoding"] == "base64" {
				decoded, err := base64.StdEncoding.DecodeString(body)
				if err != nil {
					return nil, ErrUpstream
				}
				resource["blob"] = base64.StdEncoding.EncodeToString(decoded)
			} else {
				resource["text"] = body
			}
			content = append(content, map[string]any{"type": "resource", "resource": resource})
		}
	}
	return map[string]any{"content": content}, nil
}

func channelText(value any) string {
	object, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	for _, channel := range []string{"assistant", "user"} {
		items, _ := object[channel].([]any)
		var values []string
		for _, item := range items {
			entry, ok := item.(map[string]any)
			if !ok || entry["type"] != "text" {
				continue
			}
			if value, ok := entry["text"].(string); ok && value != "" {
				values = append(values, value)
			}
		}
		if len(values) > 0 {
			return strings.Join(values, "\n\n")
		}
	}
	return ""
}

func safeFilename(name string) string {
	name = path.Base(strings.ReplaceAll(strings.TrimSpace(name), "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`<>:"|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(name, ". ")
	if name == "" {
		return "result.csv"
	}
	return name
}

func publicError(err error) error {
	for _, known := range []error{ErrUnauthorized, ErrDisabled, ErrSourceDenied, ErrDailyExceeded, ErrMonthlyExceeded, ErrInvalidArguments, ErrNeedsAuth, ErrUpstream} {
		if errors.Is(err, known) {
			return known
		}
	}
	return errors.New("PROFESSIONAL_DATABASE_UNAVAILABLE：专业数据库暂时不可用，请稍后重试")
}
func toolError(err error) map[string]any {
	return map[string]any{"isError": true, "content": []map[string]string{{"type": "text", "text": err.Error()}}}
}
func writeRPC(w http.ResponseWriter, value rpcResponse) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}
