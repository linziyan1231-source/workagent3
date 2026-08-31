package imgateway

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

type Gateway struct {
	store    *Store
	registry *Registry
	runtime  RuntimeDeliveryPort
}

func New(store *Store, registry *Registry, runtime RuntimeDeliveryPort) (*Gateway, error) {
	if store == nil || registry == nil || runtime == nil {
		return nil, errors.New("IM Gateway store, connector registry, and runtime delivery port are required")
	}
	return &Gateway{store: store, registry: registry, runtime: runtime}, nil
}

func (g *Gateway) Receive(ctx context.Context, message InboundMessage) (DeliveryReceipt, error) {
	if err := validateInbound(message); err != nil {
		return DeliveryReceipt{}, err
	}
	if !g.registry.Has(message.ConnectorID) {
		return DeliveryReceipt{}, errors.New("unknown channel connector")
	}
	targetSID, err := g.store.AuthorizedSID(ctx, message.ConnectorID, message.ExternalAccountID, message.Sender.ID)
	if err != nil {
		if errors.Is(err, ErrPairingNotAuthorized) {
			_, _ = g.store.RequestPairing(ctx, message.ConnectorID, message.ExternalAccountID, message.Sender)
		}
		return DeliveryReceipt{}, err
	}
	state, duplicate, err := g.store.BeginReceipt(ctx, message)
	if err != nil {
		return DeliveryReceipt{}, err
	}
	if duplicate {
		return DeliveryReceipt{RuntimeSessionID: state.RuntimeSessionID, RuntimeReceiptID: state.RuntimeReceiptID, Duplicate: true}, nil
	}
	sessionID, err := g.store.SessionMapping(ctx, message, targetSID)
	if err != nil {
		_ = g.store.FailReceipt(ctx, message, err)
		return DeliveryReceipt{}, err
	}
	receipt, err := g.runtime.Deliver(ctx, RuntimeDelivery{TargetSID: targetSID, SessionID: sessionID, Message: message})
	if err != nil {
		_ = g.store.FailReceipt(ctx, message, err)
		return DeliveryReceipt{}, fmt.Errorf("deliver external message: %w", err)
	}
	if receipt.RuntimeSessionID == "" || receipt.RuntimeReceiptID == "" {
		err = errors.New("runtime returned an incomplete delivery receipt")
		_ = g.store.FailReceipt(ctx, message, err)
		return DeliveryReceipt{}, err
	}
	if err := g.store.CompleteReceipt(ctx, message, targetSID, receipt); err != nil {
		return DeliveryReceipt{}, err
	}
	return receipt, nil
}

func validateInbound(message InboundMessage) error {
	if strings.TrimSpace(message.ConnectorID) == "" || strings.TrimSpace(message.ExternalAccountID) == "" || strings.TrimSpace(message.ExternalConversationID) == "" || strings.TrimSpace(message.ExternalMessageID) == "" || strings.TrimSpace(message.Sender.ID) == "" {
		return errors.New("external message identity is incomplete")
	}
	if strings.TrimSpace(message.Text) == "" && len(message.Attachments) == 0 {
		return errors.New("external message content is empty")
	}
	if message.ReceivedAt.IsZero() {
		return errors.New("external message received_at is required")
	}
	return nil
}
