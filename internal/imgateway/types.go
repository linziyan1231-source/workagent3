package imgateway

import (
	"context"
	"encoding/json"
	"time"
)

type Attachment struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	ContentType   string `json:"content_type"`
	Size          int64  `json:"size"`
	SourceRef     string `json:"source_ref"`
	ContentBase64 string `json:"content_base64,omitempty"`
}

type Sender struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

type InboundMessage struct {
	ConnectorID            string       `json:"connector_id"`
	ExternalAccountID      string       `json:"external_account_id"`
	ExternalConversationID string       `json:"external_conversation_id"`
	ExternalMessageID      string       `json:"external_message_id"`
	Sender                 Sender       `json:"sender"`
	TargetEmployee         string       `json:"target_employee,omitempty"`
	Text                   string       `json:"text"`
	Attachments            []Attachment `json:"attachments"`
	ReplyCorrelation       string       `json:"reply_correlation,omitempty"`
	ReceivedAt             time.Time    `json:"received_at"`
}

type OutboundMessage struct {
	ConnectorID            string       `json:"connector_id"`
	ExternalAccountID      string       `json:"external_account_id"`
	ExternalConversationID string       `json:"external_conversation_id"`
	Text                   string       `json:"text"`
	Attachments            []Attachment `json:"attachments"`
	ReplyCorrelation       string       `json:"reply_correlation,omitempty"`
}

type SendReceipt struct {
	ExternalMessageID string    `json:"external_message_id"`
	SentAt            time.Time `json:"sent_at"`
}

type ConnectorDescriptor struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	Version     string `json:"version"`
}

type ConnectorConfig struct {
	Public        json.RawMessage `json:"public"`
	CredentialRef string          `json:"credential_ref"`
}

type ConnectorHealth struct {
	Healthy bool   `json:"healthy"`
	Detail  string `json:"detail,omitempty"`
}

// ChannelConnector is implemented by version-pinned platform adapters. It is
// deliberately outside Harness and receives only an opaque credential ref.
type ChannelConnector interface {
	Descriptor() ConnectorDescriptor
	ValidateConfig(ConnectorConfig) error
	Test(context.Context, ConnectorConfig) (ConnectorHealth, error)
	Start(context.Context, ConnectorConfig, func(context.Context, InboundMessage) error) error
	Stop(context.Context) error
	Send(context.Context, OutboundMessage) (SendReceipt, error)
}

type RuntimeDelivery struct {
	TargetSID string         `json:"target_sid"`
	SessionID string         `json:"session_id,omitempty"`
	Message   InboundMessage `json:"message"`
}

type DeliveryReceipt struct {
	RuntimeSessionID string `json:"runtime_session_id"`
	RuntimeReceiptID string `json:"runtime_receipt_id"`
	Duplicate        bool   `json:"duplicate"`
}

type RuntimeDeliveryPort interface {
	Deliver(context.Context, RuntimeDelivery) (DeliveryReceipt, error)
}
