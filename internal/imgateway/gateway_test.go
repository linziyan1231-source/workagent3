package imgateway

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

type connectorStub struct {
	id        string
	sends     []OutboundMessage
	failFirst bool
}

func (c *connectorStub) Descriptor() ConnectorDescriptor {
	return ConnectorDescriptor{ID: c.id, DisplayName: "Test", Version: "1.0.0"}
}
func (*connectorStub) ValidateConfig(ConnectorConfig) error { return nil }
func (*connectorStub) Test(context.Context, ConnectorConfig) (ConnectorHealth, error) {
	return ConnectorHealth{Healthy: true}, nil
}
func (*connectorStub) Start(context.Context, ConnectorConfig, func(context.Context, InboundMessage) error) error {
	return nil
}
func (*connectorStub) Stop(context.Context) error { return nil }
func (c *connectorStub) Send(_ context.Context, message OutboundMessage) (SendReceipt, error) {
	c.sends = append(c.sends, message)
	if c.failFirst && len(c.sends) == 1 {
		return SendReceipt{}, errors.New("connector offline")
	}
	return SendReceipt{ExternalMessageID: "external-reply-1", SentAt: time.Now().UTC()}, nil
}

type deliveryStub struct {
	calls      int
	deliveries []RuntimeDelivery
	failFirst  bool
}

func (d *deliveryStub) Deliver(_ context.Context, delivery RuntimeDelivery) (DeliveryReceipt, error) {
	d.calls++
	d.deliveries = append(d.deliveries, delivery)
	if d.failFirst && d.calls == 1 {
		return DeliveryReceipt{}, errors.New("runtime offline")
	}
	return DeliveryReceipt{RuntimeSessionID: "session-1", RuntimeReceiptID: "inbox-11111111-1111-1111-1111-111111111111", ReplyText: "hello back"}, nil
}

func testGateway(t *testing.T, delivery RuntimeDeliveryPort) (*Gateway, *Store, *connectorStub) {
	t.Helper()
	store, err := Open(filepath.Join(t.TempDir(), "im.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	connector := &connectorStub{id: "weixin"}
	registry, err := NewRegistry(connector)
	if err != nil {
		t.Fatal(err)
	}
	gateway, err := New(store, registry, delivery)
	if err != nil {
		t.Fatal(err)
	}
	return gateway, store, connector
}

func message() InboundMessage {
	return InboundMessage{
		ConnectorID: "weixin", ExternalAccountID: "account-1",
		ExternalConversationID: "conversation-1", ExternalMessageID: "message-1",
		Sender: Sender{ID: "wx-user-1", DisplayName: "Alice"}, Text: "hello",
		Attachments: []Attachment{}, ReceivedAt: time.Date(2026, 8, 31, 2, 0, 0, 0, time.UTC),
	}
}

func approve(t *testing.T, store *Store) {
	t.Helper()
	pairing, err := store.RequestPairing(t.Context(), "weixin", "account-1", Sender{ID: "wx-user-1", DisplayName: "Alice"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetPairingStatus(t.Context(), pairing.ID, "approved", "S-1-5-21-9000"); err != nil {
		t.Fatal(err)
	}
}

func TestReceiveRequiresApprovedPairing(t *testing.T) {
	delivery := &deliveryStub{}
	gateway, store, connector := testGateway(t, delivery)
	if _, err := gateway.Receive(t.Context(), message(), connector); !errors.Is(err, ErrPairingNotAuthorized) {
		t.Fatalf("expected pairing rejection, got %v", err)
	}
	if delivery.calls != 0 {
		t.Fatal("unauthorized sender reached employee runtime")
	}
	pairing, err := store.RequestPairing(t.Context(), "weixin", "account-1", message().Sender)
	if err != nil || pairing.Status != "pending" {
		t.Fatalf("pending pairing %#v err=%v", pairing, err)
	}
}

func TestDuplicateInboundMessageExecutesOnlyOnce(t *testing.T) {
	delivery := &deliveryStub{}
	gateway, store, connector := testGateway(t, delivery)
	approve(t, store)
	first, err := gateway.Receive(t.Context(), message(), connector)
	if err != nil {
		t.Fatal(err)
	}
	second, err := gateway.Receive(t.Context(), message(), connector)
	if err != nil {
		t.Fatal(err)
	}
	if delivery.calls != 1 || first.Duplicate || !second.Duplicate || second.RuntimeReceiptID != first.RuntimeReceiptID {
		t.Fatalf("deduplication failed calls=%d first=%#v second=%#v", delivery.calls, first, second)
	}
	if len(connector.sends) != 1 {
		t.Fatalf("duplicate inbound message sent %d replies", len(connector.sends))
	}
	reply := connector.sends[0]
	if reply.Text != "hello back" || reply.ExternalConversationID != "conversation-1" || reply.IdempotencyKey != first.RuntimeReceiptID {
		t.Fatalf("wrong outbound reply: %#v", reply)
	}
}

func TestFailedDeliveryCanRetryAndReusesConversationMapping(t *testing.T) {
	delivery := &deliveryStub{failFirst: true}
	gateway, store, connector := testGateway(t, delivery)
	approve(t, store)
	if _, err := gateway.Receive(t.Context(), message(), connector); err == nil {
		t.Fatal("expected first delivery failure")
	}
	if _, err := gateway.Receive(t.Context(), message(), connector); err != nil {
		t.Fatal(err)
	}
	next := message()
	next.ExternalMessageID = "message-2"
	if _, err := gateway.Receive(t.Context(), next, connector); err != nil {
		t.Fatal(err)
	}
	if delivery.calls != 3 || delivery.deliveries[2].SessionID != "session-1" {
		t.Fatalf("retry or conversation mapping failed: %#v", delivery.deliveries)
	}
}

func TestFailedReplyCanRetryWithStableIdempotencyKey(t *testing.T) {
	delivery := &deliveryStub{}
	gateway, store, connector := testGateway(t, delivery)
	connector.failFirst = true
	approve(t, store)
	if _, err := gateway.Receive(t.Context(), message(), connector); err == nil {
		t.Fatal("expected first reply failure")
	}
	if _, err := gateway.Receive(t.Context(), message(), connector); err != nil {
		t.Fatal(err)
	}
	if delivery.calls != 2 || len(connector.sends) != 2 {
		t.Fatalf("retry did not traverse the persisted Runtime reply: deliveries=%d sends=%d", delivery.calls, len(connector.sends))
	}
	if connector.sends[0].IdempotencyKey != connector.sends[1].IdempotencyKey {
		t.Fatalf("reply retry changed idempotency key: %#v", connector.sends)
	}
}

func TestRegistryRejectsDuplicateConnectorAndDoesNotExposeSecrets(t *testing.T) {
	if _, err := NewRegistry(&connectorStub{id: "weixin"}, &connectorStub{id: "weixin"}); err == nil {
		t.Fatal("duplicate connector was accepted")
	}
	config := ConnectorConfig{Public: json.RawMessage(`{"base_url":"https://example.test"}`), CredentialRef: "vault:weixin/account-1"}
	encoded, err := json.Marshal(config)
	if err != nil || string(encoded) == "" {
		t.Fatal(err)
	}
}
