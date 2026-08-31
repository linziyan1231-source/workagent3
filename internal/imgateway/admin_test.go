package imgateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

type adminConnector struct {
	started int
	receive func(context.Context, InboundMessage) error
}

func (*adminConnector) Descriptor() ConnectorDescriptor {
	return ConnectorDescriptor{ID: "weixin", DisplayName: "WeChat", Version: "1.0.0"}
}
func (*adminConnector) ValidateConfig(config ConnectorConfig) error {
	var value struct {
		AccountID string `json:"account_id"`
	}
	return json.Unmarshal(config.Public, &value)
}
func (*adminConnector) Test(context.Context, ConnectorConfig) (ConnectorHealth, error) {
	return ConnectorHealth{Healthy: true}, nil
}
func (c *adminConnector) Start(_ context.Context, _ ConnectorConfig, receive func(context.Context, InboundMessage) error) error {
	c.started++
	c.receive = receive
	return nil
}
func (*adminConnector) Stop(context.Context) error { return nil }
func (*adminConnector) Send(context.Context, OutboundMessage) (SendReceipt, error) {
	return SendReceipt{}, nil
}

type directoryStub struct{ sid string }

func (d directoryStub) Exists(_ context.Context, sid string) (bool, error) {
	return sid == d.sid, nil
}

func adminRequest(admin *Admin, method, path, body string, authenticated bool) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if authenticated {
		request.Header.Set("Authorization", "Bearer 0123456789abcdef0123456789abcdef")
	}
	response := httptest.NewRecorder()
	admin.ServeHTTP(response, request)
	return response
}

func TestAdminControlsConnectorAndApprovesOnlyExistingEmployee(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "im.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connector := &adminConnector{}
	registry, _ := NewRegistry(connector)
	delivery := &deliveryStub{}
	gateway, _ := New(store, registry, delivery)
	admin, err := NewAdmin(t.Context(), store, registry, gateway, directoryStub{sid: "S-1-5-21-9000"}, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	if response := adminRequest(admin, http.MethodGet, "/v1/connectors", "", false); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status %d", response.Code)
	}
	configured := adminRequest(admin, http.MethodPut, "/v1/connectors/weixin", `{"enabled":true,"public":{"account_id":"bot-1"},"credential_ref":"bot-1.token"}`, true)
	if configured.Code != http.StatusOK || connector.started != 1 || connector.receive == nil {
		t.Fatalf("configure status=%d starts=%d body=%s", configured.Code, connector.started, configured.Body.String())
	}

	first := message()
	if err := connector.receive(t.Context(), first); err == nil {
		t.Fatal("unpaired sender was accepted")
	}
	pairings, _ := store.Pairings(t.Context())
	if len(pairings) != 1 || pairings[0].Status != "pending" {
		t.Fatalf("pending pairing missing: %#v", pairings)
	}
	bad := adminRequest(admin, http.MethodPost, "/v1/pairings/1/approve", `{"target_sid":"S-1-5-21-unknown"}`, true)
	if bad.Code != http.StatusNotFound {
		t.Fatalf("unknown employee approval status %d", bad.Code)
	}
	approved := adminRequest(admin, http.MethodPost, "/v1/pairings/1/approve", `{"target_sid":"S-1-5-21-9000"}`, true)
	if approved.Code != http.StatusNoContent {
		t.Fatalf("approval status %d: %s", approved.Code, approved.Body.String())
	}
	if err := connector.receive(t.Context(), first); err != nil {
		t.Fatal(err)
	}
	if err := connector.receive(t.Context(), first); err != nil || delivery.calls != 1 {
		t.Fatalf("duplicate delivery err=%v calls=%d", err, delivery.calls)
	}

	testResponse := adminRequest(admin, http.MethodPost, "/v1/connectors/weixin/test", "", true)
	if testResponse.Code != http.StatusOK || !strings.Contains(testResponse.Body.String(), `"healthy":true`) {
		t.Fatalf("test response %d: %s", testResponse.Code, testResponse.Body.String())
	}
}
