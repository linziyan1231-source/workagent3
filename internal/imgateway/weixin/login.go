package weixin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"workagent3/internal/imgateway"
)

type CredentialWriter interface {
	Save(context.Context, string, []byte) error
}

type LoginService struct {
	client      *http.Client
	baseURL     string
	credentials CredentialWriter
	pollEvery   time.Duration
	timeout     time.Duration
}

func NewLoginService(credentials CredentialWriter) (*LoginService, error) {
	if credentials == nil {
		return nil, errors.New("Weixin login credential store is required")
	}
	return &LoginService{client: &http.Client{Timeout: 40 * time.Second}, baseURL: defaultBaseURL, credentials: credentials, pollEvery: 2 * time.Second, timeout: 5 * time.Minute}, nil
}

func (s *LoginService) Login(ctx context.Context, ownerSID string, emit imgateway.LoginEmitter) (imgateway.ConnectorConfig, error) {
	var qr qrCodeData
	if err := s.get(ctx, "/ilink/bot/get_bot_qrcode", url.Values{"bot_type": {"3"}}, &qr); err != nil {
		return imgateway.ConnectorConfig{}, fmt.Errorf("fetch Weixin QR code: %w", err)
	}
	if qr.QRCode == "" || qr.ImageContent == "" {
		return imgateway.ConnectorConfig{}, errors.New("Weixin QR response is incomplete")
	}
	if err := emit("qr", map[string]string{"qrcodeData": qr.ImageContent}); err != nil {
		return imgateway.ConnectorConfig{}, err
	}
	deadline := time.NewTimer(s.timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(s.pollEvery)
	defer ticker.Stop()
	scanned := false
	for {
		select {
		case <-ctx.Done():
			return imgateway.ConnectorConfig{}, ctx.Err()
		case <-deadline.C:
			return imgateway.ConnectorConfig{}, errors.New("Weixin QR login timed out")
		case <-ticker.C:
			var status qrStatusData
			if err := s.get(ctx, "/ilink/bot/get_qrcode_status", url.Values{"qrcode": {qr.QRCode}}, &status); err != nil {
				continue
			}
			switch status.Status {
			case "scaned":
				if !scanned {
					scanned = true
					if err := emit("scanned", map[string]any{}); err != nil {
						return imgateway.ConnectorConfig{}, err
					}
				}
			case "expired":
				return imgateway.ConnectorConfig{}, errors.New("Weixin QR code expired")
			case "confirmed":
				if status.AccountID == "" || status.BotToken == "" {
					return imgateway.ConnectorConfig{}, errors.New("Weixin login response is incomplete")
				}
				credentialRef := ownerSID + ".weixin.token"
				secret := []byte(status.BotToken)
				err := s.credentials.Save(ctx, credentialRef, secret)
				clear(secret)
				if err != nil {
					return imgateway.ConnectorConfig{}, err
				}
				baseURL := strings.TrimRight(status.BaseURL, "/")
				if baseURL == "" {
					baseURL = defaultBaseURL
				}
				public, _ := json.Marshal(map[string]string{"account_id": status.AccountID, "base_url": baseURL})
				return imgateway.ConnectorConfig{Public: public, CredentialRef: credentialRef}, nil
			}
		}
	}
}

func (s *LoginService) get(ctx context.Context, path string, query url.Values, output any) error {
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(s.baseURL, "/")+path+"?"+query.Encode(), nil)
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 256*1024))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, output); err == nil && loginResponsePresent(output) {
		return nil
	}
	var wrapped struct {
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(body, &wrapped) != nil || len(wrapped.Data) == 0 || json.Unmarshal(wrapped.Data, output) != nil || !loginResponsePresent(output) {
		return errors.New("invalid Weixin login response")
	}
	return nil
}

func loginResponsePresent(value any) bool {
	switch typed := value.(type) {
	case *qrCodeData:
		return typed.QRCode != ""
	case *qrStatusData:
		return typed.Status != ""
	default:
		return false
	}
}

type qrCodeData struct {
	QRCode       string `json:"qrcode"`
	ImageContent string `json:"qrcode_img_content"`
}

type qrStatusData struct {
	Status    string `json:"status"`
	BotToken  string `json:"bot_token"`
	AccountID string `json:"ilink_bot_id"`
	BaseURL   string `json:"baseurl"`
}
