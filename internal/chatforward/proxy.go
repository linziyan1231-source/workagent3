package chatforward

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"

	"workagent3/internal/contracts"
)

const (
	headerUserID    = "X-ChatForward-User-ID"
	headerTimestamp = "X-ChatForward-Timestamp"
	headerSignature = "X-ChatForward-Signature"
)

type Proxy struct {
	target  *url.URL
	secret  []byte
	quota   *Store
	enabled func(context.Context, string) bool
}

// SetQuota enables fresh per-SID accounting. No legacy ledger is imported.
func (p *Proxy) SetQuota(quota *Store, enabled func(context.Context, string) bool) {
	p.quota, p.enabled = quota, enabled
}

func NewProxy(rawURL, secretFile string) (*Proxy, error) {
	target, err := url.Parse(rawURL)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
		return nil, errors.New("ChatForward URL must be an absolute HTTP URL")
	}
	info, err := os.Lstat(secretFile)
	if err != nil {
		return nil, fmt.Errorf("inspect ChatForward secret: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("ChatForward secret must be a regular non-symlink file")
	}
	secret, err := os.ReadFile(secretFile)
	if err != nil {
		return nil, fmt.Errorf("read ChatForward secret: %w", err)
	}
	secret = bytes.TrimSpace(secret)
	if len(secret) < 32 {
		return nil, errors.New("ChatForward secret must contain at least 32 bytes")
	}
	return &Proxy{target: target, secret: secret}, nil
}

func (p *Proxy) ServeChatForward(writer http.ResponseWriter, request *http.Request, identity contracts.ChatForwardDelegation) {
	if p.quota != nil {
		if !p.enabled(request.Context(), identity.SID) {
			http.Error(writer, "ChatForward account is unavailable", http.StatusForbidden)
			return
		}
		subject, err := p.quota.Subject(request.Context(), identity.SID)
		if err != nil {
			http.Error(writer, "ChatForward quota is unavailable", http.StatusServiceUnavailable)
			return
		}
		identity.UserID = strconv.FormatInt(subject, 10)
	}
	target := *p.target
	proxy := &httputil.ReverseProxy{
		Rewrite: func(outgoing *httputil.ProxyRequest) {
			outgoing.SetURL(&target)
			outgoing.Out.URL.Path = strings.TrimPrefix(outgoing.Out.URL.Path, "/chatgpt")
			if outgoing.Out.URL.Path == "" {
				outgoing.Out.URL.Path = "/"
			}
			outgoing.Out.URL.RawPath = ""
			outgoing.Out.Host = target.Host
			stripCredentials(outgoing.Out.Header)
			outgoing.Out.Header.Set("Origin", target.Scheme+"://"+target.Host)
			outgoing.Out.Header.Set("X-Forwarded-Prefix", "/chatgpt")
			for name, value := range delegationHeaders(p.secret, identity, outgoing.Out.Method, outgoing.Out.URL.RequestURI()) {
				outgoing.Out.Header.Set(name, value)
			}
		},
		ModifyResponse: func(response *http.Response) error {
			response.Header.Del("Set-Cookie")
			response.Header.Del("WWW-Authenticate")
			return nil
		},
		ErrorHandler: func(response http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(response, "ChatForward is unavailable", http.StatusBadGateway)
		},
		FlushInterval: -1,
	}
	proxy.ServeHTTP(writer, request)
}

func delegationHeaders(secret []byte, identity contracts.ChatForwardDelegation, method, requestURI string) map[string]string {
	timestamp := strconv.FormatInt(identity.NowUnix, 10)
	canonical := strings.Join([]string{strings.ToUpper(method), requestURI, timestamp, identity.UserID}, "\n")
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(canonical))
	return map[string]string{
		headerUserID:    identity.UserID,
		headerTimestamp: timestamp,
		headerSignature: base64.RawURLEncoding.EncodeToString(mac.Sum(nil)),
	}
}

func stripCredentials(header http.Header) {
	for _, name := range []string{
		"Authorization", "Cookie", "Proxy-Authorization", "X-CSRF-Token",
		"X-WorkAgent-Runtime-Token", "X-Windows-Identity",
	} {
		header.Del(name)
	}
}
