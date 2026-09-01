package weixin

import (
	"bytes"
	"context"
	"crypto/aes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"workagent3/internal/imgateway"
)

type credentialStub struct{ secret []byte }

func (c credentialStub) Resolve(context.Context, string) ([]byte, error) {
	return append([]byte(nil), c.secret...), nil
}

func TestConnectorPollsNormalizesAndSendsWithPrivateCredential(t *testing.T) {
	var mu sync.Mutex
	var pollCount int
	var sent sendMessageRequest
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer private-weixin-token" || request.Header.Get("AuthorizationType") != "ilink_bot_token" || request.Header.Get("X-WECHAT-UIN") == "" {
			t.Errorf("missing private Weixin headers: %v", request.Header)
		}
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/ilink/bot/getupdates":
			mu.Lock()
			pollCount++
			current := pollCount
			mu.Unlock()
			if current == 1 {
				_, _ = io.WriteString(writer, `{"ret":0,"errcode":0,"get_updates_buf":"next","msgs":[{"from_user_id":"weixin-user-123456","context_token":"reply-context","msg_id":"wx-message-1","item_list":[{"type":1,"text_item":{"text":"hello from WeChat"}}]}]}`)
				return
			}
			time.Sleep(20 * time.Millisecond)
			_, _ = io.WriteString(writer, `{"ret":0,"errcode":0,"get_updates_buf":"next","msgs":[]}`)
		case "/ilink/bot/sendmessage":
			if err := json.NewDecoder(request.Body).Decode(&sent); err != nil {
				t.Error(err)
			}
			_, _ = io.WriteString(writer, `{"ret":0,"errcode":0}`)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer upstream.Close()

	connector, err := New(credentialStub{secret: []byte("private-weixin-token")})
	if err != nil {
		t.Fatal(err)
	}
	config := imgateway.ConnectorConfig{
		Public:        json.RawMessage(`{"account_id":"bot-1","base_url":"` + upstream.URL + `"}`),
		CredentialRef: "vault:weixin/bot-1",
	}
	runContext, cancel := context.WithCancel(t.Context())
	received := make(chan imgateway.InboundMessage, 1)
	if err := connector.Start(runContext, config, func(_ context.Context, message imgateway.InboundMessage) error {
		received <- message
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	defer connector.Stop(context.Background())

	var inbound imgateway.InboundMessage
	select {
	case inbound = <-received:
	case <-time.After(2 * time.Second):
		t.Fatal("Weixin poll did not emit message")
	}
	if inbound.ConnectorID != "weixin" || inbound.ExternalAccountID != "bot-1" || inbound.ExternalMessageID != "wx-message-1" || inbound.Text != "hello from WeChat" || inbound.ReplyCorrelation != "reply-context" {
		t.Fatalf("unexpected normalized message: %#v", inbound)
	}
	receipt, err := connector.Send(t.Context(), imgateway.OutboundMessage{
		ConnectorID: "weixin", ExternalAccountID: "bot-1",
		ExternalConversationID: inbound.ExternalConversationID, Text: "reply",
		IdempotencyKey: "inbox-11111111-1111-1111-1111-111111111111",
	})
	if err != nil {
		t.Fatal(err)
	}
	if receipt.ExternalMessageID != "11111111111111111111111111111111" || sent.Msg.ClientID != receipt.ExternalMessageID || sent.Msg.ToUserID != inbound.ExternalConversationID || sent.Msg.ContextToken != "reply-context" || sent.Msg.ItemList[0].TextItem.Text != "reply" {
		t.Fatalf("unexpected send request=%#v receipt=%#v", sent, receipt)
	}
	cancel()
}

func TestConnectorRejectsNonLoopbackPlainHTTPAndUnknownConfig(t *testing.T) {
	connector, _ := New(credentialStub{secret: []byte("token")})
	for _, public := range []string{
		`{"account_id":"bot","base_url":"http://example.com"}`,
		`{"account_id":"bot","unknown":true}`,
	} {
		err := connector.ValidateConfig(imgateway.ConnectorConfig{Public: json.RawMessage(public), CredentialRef: "vault:bot"})
		if err == nil {
			t.Fatalf("unsafe config accepted: %s", public)
		}
	}
	encoded, _ := json.Marshal(connector.Descriptor())
	if strings.Contains(string(encoded), "token") || strings.Contains(string(encoded), "vault") {
		t.Fatal("connector descriptor exposed credentials")
	}
}

func TestConnectorFailsClosedInsteadOfDroppingOutboundAttachments(t *testing.T) {
	connector, _ := New(credentialStub{secret: []byte("token")})
	_, err := connector.Send(t.Context(), imgateway.OutboundMessage{
		ConnectorID: "weixin",
		Text:        "report",
		Attachments: []imgateway.Attachment{{Name: "report.pdf", ContentBase64: "cGRm"}},
	})
	if err == nil || !strings.Contains(err.Error(), "attachments are not supported") {
		t.Fatalf("outbound attachment was silently dropped: %v", err)
	}
}

func TestMediaKeyAndECBDecryption(t *testing.T) {
	rawKey := []byte("0123456789abcdef")
	encodedHex := base64.StdEncoding.EncodeToString([]byte("30313233343536373839616263646566"))
	key, err := mediaKey(encodedHex, "")
	if err != nil || string(key[:]) != string(rawKey) {
		t.Fatalf("unexpected decoded media key: %q, %v", key, err)
	}
	plaintext := []byte("private attachment")
	padding := aes.BlockSize - len(plaintext)%aes.BlockSize
	ciphertext := append(append([]byte(nil), plaintext...), bytes.Repeat([]byte{byte(padding)}, padding)...)
	block, _ := aes.NewCipher(rawKey)
	for offset := 0; offset < len(ciphertext); offset += aes.BlockSize {
		block.Encrypt(ciphertext[offset:offset+aes.BlockSize], ciphertext[offset:offset+aes.BlockSize])
	}
	decrypted, err := decryptECB(ciphertext, key)
	if err != nil || string(decrypted) != string(plaintext) {
		t.Fatalf("unexpected decrypted media: %q, %v", decrypted, err)
	}
	clear(decrypted)
}

func TestMediaDownloadURLRejectsUntrustedHost(t *testing.T) {
	if _, err := mediaDownloadURL(mediaEncryptInfo{FullURL: "https://example.com/private"}); err == nil {
		t.Fatal("untrusted media URL accepted")
	}
	value, err := mediaDownloadURL(mediaEncryptInfo{EncryptQueryParam: "opaque value"})
	if err != nil || !strings.HasPrefix(value, defaultCDNURL+"/download?") || !strings.Contains(value, "opaque+value") {
		t.Fatalf("unexpected CDN media URL: %q, %v", value, err)
	}
}
