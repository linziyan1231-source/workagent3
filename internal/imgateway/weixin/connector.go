package weixin

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"workagent3/internal/imgateway"
)

const defaultBaseURL = "https://ilinkai.weixin.qq.com"
const defaultCDNURL = "https://novac2c.cdn.weixin.qq.com/c2c"
const maxInboundMediaBytes = 16 * 1024 * 1024

type CredentialPort interface {
	Resolve(context.Context, string) ([]byte, error)
}

type publicConfig struct {
	AccountID string `json:"account_id"`
	BaseURL   string `json:"base_url,omitempty"`
}

type Connector struct {
	credentials CredentialPort
	client      *http.Client

	mu            sync.Mutex
	cancel        context.CancelFunc
	done          chan struct{}
	accountID     string
	baseURL       string
	botToken      []byte
	wechatUIN     string
	contextTokens map[string]string
}

func New(credentials CredentialPort) (*Connector, error) {
	if credentials == nil {
		return nil, errors.New("Weixin credential port is required")
	}
	return &Connector{
		credentials:   credentials,
		client:        &http.Client{Timeout: 50 * time.Second},
		contextTokens: make(map[string]string),
	}, nil
}

func (c *Connector) Descriptor() imgateway.ConnectorDescriptor {
	return imgateway.ConnectorDescriptor{ID: "weixin", DisplayName: "WeChat", Version: "1.0.0"}
}

func (c *Connector) ValidateConfig(config imgateway.ConnectorConfig) error {
	_, _, err := parseConfig(config)
	return err
}

func (c *Connector) Test(ctx context.Context, config imgateway.ConnectorConfig) (imgateway.ConnectorHealth, error) {
	parsed, endpoint, err := parseConfig(config)
	if err != nil {
		return imgateway.ConnectorHealth{}, err
	}
	token, err := c.credentials.Resolve(ctx, config.CredentialRef)
	if err != nil {
		return imgateway.ConnectorHealth{}, fmt.Errorf("resolve Weixin credential: %w", err)
	}
	defer clear(token)
	var response getUpdatesResponse
	err = c.post(ctx, endpoint, token, randomUIN(), "ilink/bot/getupdates", getUpdatesRequest{GetUpdatesBuf: "", BaseInfo: map[string]any{}}, &response)
	if err != nil {
		return imgateway.ConnectorHealth{Healthy: false, Detail: err.Error()}, nil
	}
	if response.Ret != 0 || response.ErrorCode != 0 {
		return imgateway.ConnectorHealth{Healthy: false, Detail: response.ErrorMessage}, nil
	}
	return imgateway.ConnectorHealth{Healthy: true, Detail: "WeChat account " + parsed.AccountID + " is reachable"}, nil
}

func (c *Connector) Start(ctx context.Context, config imgateway.ConnectorConfig, receive func(context.Context, imgateway.InboundMessage) error) error {
	if receive == nil {
		return errors.New("Weixin receive callback is required")
	}
	parsed, endpoint, err := parseConfig(config)
	if err != nil {
		return err
	}
	token, err := c.credentials.Resolve(ctx, config.CredentialRef)
	if err != nil {
		return fmt.Errorf("resolve Weixin credential: %w", err)
	}
	if len(bytes.TrimSpace(token)) == 0 {
		clear(token)
		return errors.New("Weixin bot token is empty")
	}
	runContext, cancel := context.WithCancel(ctx)
	c.mu.Lock()
	if c.cancel != nil {
		c.mu.Unlock()
		cancel()
		clear(token)
		return errors.New("Weixin connector is already running")
	}
	c.cancel = cancel
	c.done = make(chan struct{})
	c.accountID = parsed.AccountID
	c.baseURL = endpoint
	c.botToken = append([]byte(nil), bytes.TrimSpace(token)...)
	c.wechatUIN = randomUIN()
	clear(token)
	c.mu.Unlock()
	go func(done chan struct{}) {
		defer close(done)
		c.poll(runContext, receive)
	}(c.done)
	return nil
}

func (c *Connector) Stop(ctx context.Context) error {
	c.mu.Lock()
	cancel, done := c.cancel, c.done
	c.cancel = nil
	c.done = nil
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	clear(c.botToken)
	c.botToken = nil
	c.contextTokens = make(map[string]string)
	return nil
}

func (c *Connector) Send(ctx context.Context, message imgateway.OutboundMessage) (imgateway.SendReceipt, error) {
	c.mu.Lock()
	if c.cancel == nil || message.ExternalAccountID != c.accountID {
		c.mu.Unlock()
		return imgateway.SendReceipt{}, errors.New("Weixin connector is not running for this account")
	}
	endpoint := c.baseURL
	token := append([]byte(nil), c.botToken...)
	uin := c.wechatUIN
	contextToken := message.ReplyCorrelation
	if contextToken == "" {
		contextToken = c.contextTokens[message.ExternalConversationID]
	}
	c.mu.Unlock()
	defer clear(token)
	if strings.TrimSpace(message.Text) == "" {
		return imgateway.SendReceipt{}, errors.New("Weixin text message is empty")
	}
	clientID := randomID()
	body := sendMessageRequest{Msg: sendMessage{
		ToUserID: message.ExternalConversationID, ClientID: clientID,
		MessageType: 2, MessageState: 2,
		ItemList:     []sendItem{{Type: 1, TextItem: &textItem{Text: message.Text}}},
		ContextToken: contextToken,
	}, BaseInfo: map[string]any{}}
	var response businessResponse
	if err := c.post(ctx, endpoint, token, uin, "ilink/bot/sendmessage", body, &response); err != nil {
		return imgateway.SendReceipt{}, err
	}
	if response.Ret != 0 || response.ErrorCode != 0 {
		return imgateway.SendReceipt{}, fmt.Errorf("Weixin sendmessage rejected: %s", response.ErrorMessage)
	}
	return imgateway.SendReceipt{ExternalMessageID: clientID, SentAt: time.Now().UTC()}, nil
}

func (c *Connector) poll(ctx context.Context, receive func(context.Context, imgateway.InboundMessage) error) {
	buffer := ""
	failures := 0
	for ctx.Err() == nil {
		c.mu.Lock()
		endpoint := c.baseURL
		token := append([]byte(nil), c.botToken...)
		uin := c.wechatUIN
		accountID := c.accountID
		c.mu.Unlock()
		var response getUpdatesResponse
		err := c.post(ctx, endpoint, token, uin, "ilink/bot/getupdates", getUpdatesRequest{GetUpdatesBuf: buffer, BaseInfo: map[string]any{}}, &response)
		clear(token)
		if err != nil || response.Ret != 0 || response.ErrorCode != 0 {
			failures++
			delay := time.Second
			if failures >= 3 {
				delay = 10 * time.Second
				failures = 0
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			continue
		}
		failures = 0
		if response.Buffer != "" {
			buffer = response.Buffer
		}
		for _, raw := range response.Messages {
			message, ok := c.normalize(ctx, accountID, raw)
			if ok {
				_ = receive(ctx, message)
			}
		}
	}
}

func (c *Connector) normalize(ctx context.Context, accountID string, raw rawMessage) (imgateway.InboundMessage, bool) {
	if raw.FromUserID == "" || raw.MessageID == "" {
		return imgateway.InboundMessage{}, false
	}
	var textParts []string
	var attachments []imgateway.Attachment
	for index, item := range raw.Items {
		if (item.Type == 1 || item.Type == 3) && item.TextItem != nil && strings.TrimSpace(item.TextItem.Text) != "" {
			textParts = append(textParts, item.TextItem.Text)
		}
		media := item.ImageItem
		defaultName := fmt.Sprintf("image-%d.jpg", index+1)
		if item.Type == 4 {
			media = item.FileItem
			defaultName = fmt.Sprintf("file-%d.bin", index+1)
		}
		if media != nil {
			attachment, err := c.downloadAttachment(ctx, raw.MessageID, index, defaultName, *media)
			if err == nil {
				attachments = append(attachments, attachment)
			}
		}
	}
	if len(textParts) == 0 && len(attachments) == 0 {
		return imgateway.InboundMessage{}, false
	}
	c.mu.Lock()
	if raw.ContextToken != "" {
		c.contextTokens[raw.FromUserID] = raw.ContextToken
	}
	c.mu.Unlock()
	displayName := raw.FromUserID
	if len(displayName) > 6 {
		displayName = displayName[len(displayName)-6:]
	}
	return imgateway.InboundMessage{
		ConnectorID: "weixin", ExternalAccountID: accountID,
		ExternalConversationID: raw.FromUserID, ExternalMessageID: raw.MessageID,
		Sender: imgateway.Sender{ID: raw.FromUserID, DisplayName: displayName},
		Text:   strings.Join(textParts, "\n"), Attachments: attachments,
		ReplyCorrelation: raw.ContextToken, ReceivedAt: time.Now().UTC(),
	}, true
}

func (c *Connector) downloadAttachment(ctx context.Context, messageID string, index int, defaultName string, item mediaItem) (imgateway.Attachment, error) {
	if item.Media == nil {
		return imgateway.Attachment{}, errors.New("Weixin media metadata is missing")
	}
	downloadURL, err := mediaDownloadURL(*item.Media)
	if err != nil {
		return imgateway.Attachment{}, err
	}
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
	response, err := c.client.Do(request)
	if err != nil {
		return imgateway.Attachment{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return imgateway.Attachment{}, fmt.Errorf("Weixin media returned HTTP %d", response.StatusCode)
	}
	ciphertext, err := io.ReadAll(io.LimitReader(response.Body, maxInboundMediaBytes+1))
	if err != nil || len(ciphertext) > maxInboundMediaBytes {
		clear(ciphertext)
		return imgateway.Attachment{}, errors.New("Weixin media exceeds the 16 MiB limit")
	}
	key, err := mediaKey(item.Media.AESKey, item.AESKey)
	if err != nil {
		clear(ciphertext)
		return imgateway.Attachment{}, err
	}
	plaintext, err := decryptECB(ciphertext, key)
	clear(ciphertext)
	if err != nil {
		return imgateway.Attachment{}, err
	}
	name := safeName(item.FileName, defaultName)
	contentType := mime.TypeByExtension(filepath.Ext(name))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	encoded := base64.StdEncoding.EncodeToString(plaintext)
	size := int64(len(plaintext))
	clear(plaintext)
	return imgateway.Attachment{
		ID: messageID + "-" + fmt.Sprint(index), Name: name,
		ContentType: contentType, Size: size, SourceRef: "weixin:inline", ContentBase64: encoded,
	}, nil
}

func mediaDownloadURL(media mediaEncryptInfo) (string, error) {
	if media.FullURL != "" {
		parsed, err := url.Parse(media.FullURL)
		if err != nil || parsed.Scheme != "https" || !(parsed.Hostname() == "weixin.qq.com" || strings.HasSuffix(parsed.Hostname(), ".weixin.qq.com")) {
			return "", errors.New("untrusted Weixin media URL")
		}
		return parsed.String(), nil
	}
	if media.EncryptQueryParam == "" {
		return "", errors.New("Weixin media download parameter is missing")
	}
	parsed, _ := url.Parse(defaultCDNURL + "/download")
	query := parsed.Query()
	query.Set("encrypted_query_param", media.EncryptQueryParam)
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func mediaKey(encoded, rawHex string) ([16]byte, error) {
	var key [16]byte
	if rawHex != "" {
		decoded, err := hex.DecodeString(rawHex)
		if err != nil || len(decoded) != len(key) {
			return key, errors.New("invalid Weixin media AES key")
		}
		copy(key[:], decoded)
		clear(decoded)
		return key, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return key, errors.New("invalid Weixin media AES key")
	}
	if len(decoded) == 32 {
		wrapped := decoded
		decoded, err = hex.DecodeString(string(wrapped))
		clear(wrapped)
	}
	if err != nil || len(decoded) != len(key) {
		clear(decoded)
		return key, errors.New("invalid Weixin media AES key length")
	}
	copy(key[:], decoded)
	clear(decoded)
	return key, nil
}

func decryptECB(ciphertext []byte, key [16]byte) ([]byte, error) {
	if len(ciphertext) == 0 || len(ciphertext)%aes.BlockSize != 0 {
		return nil, errors.New("invalid Weixin encrypted media length")
	}
	cipher, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	for offset := 0; offset < len(ciphertext); offset += aes.BlockSize {
		cipher.Decrypt(ciphertext[offset:offset+aes.BlockSize], ciphertext[offset:offset+aes.BlockSize])
	}
	padding := int(ciphertext[len(ciphertext)-1])
	if padding < 1 || padding > aes.BlockSize || padding > len(ciphertext) {
		return nil, errors.New("invalid Weixin media padding")
	}
	for _, value := range ciphertext[len(ciphertext)-padding:] {
		if int(value) != padding {
			return nil, errors.New("invalid Weixin media padding")
		}
	}
	plaintext := append([]byte(nil), ciphertext[:len(ciphertext)-padding]...)
	clear(ciphertext)
	return plaintext, nil
}

func safeName(value, fallback string) string {
	name := filepath.Base(strings.TrimSpace(value))
	if name == "." || name == "" || strings.ContainsAny(name, `:\/`) {
		return fallback
	}
	if len(name) > 200 {
		return name[:200]
	}
	return name
}

func (c *Connector) post(ctx context.Context, baseURL string, token []byte, uin, path string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/"+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("AuthorizationType", "ilink_bot_token")
	request.Header.Set("Authorization", "Bearer "+string(token))
	request.Header.Set("X-WECHAT-UIN", uin)
	response, err := c.client.Do(request)
	if err != nil {
		return fmt.Errorf("Weixin %s request: %w", path, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		return fmt.Errorf("Weixin %s returned HTTP %d", path, response.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(output); err != nil {
		return fmt.Errorf("decode Weixin %s response: %w", path, err)
	}
	return nil
}

func parseConfig(config imgateway.ConnectorConfig) (publicConfig, string, error) {
	var parsed publicConfig
	decoder := json.NewDecoder(bytes.NewReader(config.Public))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&parsed); err != nil || parsed.AccountID == "" || config.CredentialRef == "" {
		return publicConfig{}, "", errors.New("Weixin account_id and credential_ref are required")
	}
	baseURL := strings.TrimRight(parsed.BaseURL, "/")
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	endpoint, err := url.Parse(baseURL)
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "https" && !(endpoint.Scheme == "http" && isLoopback(endpoint.Hostname()))) {
		return publicConfig{}, "", errors.New("Weixin base_url must use HTTPS or loopback HTTP")
	}
	return parsed, endpoint.String(), nil
}

func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func randomUIN() string {
	value := make([]byte, 4)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	return base64.StdEncoding.EncodeToString(value)
}

func randomID() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	return hex.EncodeToString(value)
}

type getUpdatesRequest struct {
	GetUpdatesBuf string         `json:"get_updates_buf"`
	BaseInfo      map[string]any `json:"base_info"`
}

type getUpdatesResponse struct {
	Ret          int          `json:"ret"`
	ErrorCode    int          `json:"errcode"`
	ErrorMessage string       `json:"errmsg"`
	Messages     []rawMessage `json:"msgs"`
	Buffer       string       `json:"get_updates_buf"`
}

type rawMessage struct {
	FromUserID   string    `json:"from_user_id"`
	ContextToken string    `json:"context_token"`
	MessageID    string    `json:"msg_id"`
	Items        []rawItem `json:"item_list"`
}

type rawItem struct {
	Type      int        `json:"type"`
	TextItem  *textItem  `json:"text_item"`
	VoiceItem *textItem  `json:"voice_item"`
	ImageItem *mediaItem `json:"image_item"`
	FileItem  *mediaItem `json:"file_item"`
}

type textItem struct {
	Text string `json:"text"`
}

type mediaItem struct {
	Media    *mediaEncryptInfo `json:"media"`
	AESKey   string            `json:"aeskey"`
	FileName string            `json:"file_name"`
}

type mediaEncryptInfo struct {
	EncryptQueryParam string `json:"encrypt_query_param"`
	AESKey            string `json:"aes_key"`
	FullURL           string `json:"full_url"`
}

func (item *rawItem) UnmarshalJSON(data []byte) error {
	type alias rawItem
	var value alias
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	if value.TextItem == nil {
		value.TextItem = value.VoiceItem
	}
	*item = rawItem(value)
	return nil
}

type sendMessageRequest struct {
	Msg      sendMessage    `json:"msg"`
	BaseInfo map[string]any `json:"base_info"`
}

type sendMessage struct {
	ToUserID     string     `json:"to_user_id"`
	ClientID     string     `json:"client_id"`
	MessageType  int        `json:"message_type"`
	MessageState int        `json:"message_state"`
	ItemList     []sendItem `json:"item_list"`
	ContextToken string     `json:"context_token,omitempty"`
}

type sendItem struct {
	Type     int       `json:"type"`
	TextItem *textItem `json:"text_item,omitempty"`
}

type businessResponse struct {
	Ret          int    `json:"ret"`
	ErrorCode    int    `json:"errcode"`
	ErrorMessage string `json:"errmsg"`
}
