package publishedapps

import (
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

type BrokerConfig struct {
	Address        string   `json:"address"`
	Token          string   `json:"token"`
	AllowedOrigins []string `json:"allowedOrigins"`
}
type outboundBroker struct {
	origins   map[string]bool
	token     string
	transport *http.Transport
}

func newOutboundBroker(config BrokerConfig) (*outboundBroker, error) {
	b := &outboundBroker{origins: map[string]bool{}, token: config.Token}
	if len(config.Token) < 32 || len(config.AllowedOrigins) > 32 {
		return nil, ErrInvalid
	}
	for _, raw := range config.AllowedOrigins {
		u, err := url.Parse(raw)
		if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "http" && u.Scheme != "https") {
			return nil, ErrInvalid
		}
		b.origins[canonicalOrigin(u)] = true
	}
	b.transport = &http.Transport{Proxy: nil, DialContext: publicDial, ForceAttemptHTTP2: true, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 30 * time.Second, MaxIdleConns: 8, MaxConnsPerHost: 8, IdleConnTimeout: 30 * time.Second}
	return b, nil
}
func canonicalOrigin(u *url.URL) string {
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return strings.ToLower(u.Scheme) + "://" + net.JoinHostPort(strings.ToLower(u.Hostname()), port)
}

var deniedNetworks = []netip.Prefix{netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"), netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"), netip.MustParsePrefix("192.168.0.0/16"), netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("224.0.0.0/3"), netip.MustParsePrefix("fc00::/7"), netip.MustParsePrefix("fe80::/10"), netip.MustParsePrefix("2001:db8::/32")}

func publicAddress(address netip.Addr) bool {
	address = address.Unmap()
	for _, prefix := range []netip.Prefix{netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("64:ff9b:1::/48"), netip.MustParsePrefix("2001::/32"), netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("fec0::/10")} {
		if prefix.Contains(address) {
			return false
		}
	}
	if !address.IsGlobalUnicast() {
		return false
	}
	for _, prefix := range deniedNetworks {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}
func publicDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(addresses) == 0 {
		return nil, errors.New("outbound DNS failed")
	}
	for _, address := range addresses {
		if !publicAddress(address) {
			return nil, errors.New("private outbound address blocked")
		}
	}
	var last error
	for _, address := range addresses {
		connection, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(address.String(), port))
		if err == nil {
			return connection, nil
		}
		last = err
	}
	return nil, last
}
func (b *outboundBroker) allowed(u *url.URL) bool {
	return u.User == nil && u.Fragment == "" && (u.Scheme == "http" || u.Scheme == "https") && b.origins[canonicalOrigin(u)]
}

// Apps call /fetch?url=<absolute allowed URL>. The broker owns TLS, Host and
// DNS. CONNECT is forbidden. Redirects are returned; their next URL must pass
// this same origin and public-address validation before another request.
func (b *outboundBroker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-App-Broker-Token")), []byte(b.token)) != 1 {
		http.Error(w, "broker authentication required", 401)
		return
	}
	if r.URL.Path == "/healthz" && r.Method == "GET" {
		w.WriteHeader(204)
		return
	}
	if r.URL.Path != "/fetch" || r.Method == http.MethodConnect || r.Header.Get("Upgrade") != "" || r.ContentLength > 32*1024*1024 {
		http.Error(w, "invalid outbound request", 400)
		return
	}
	target, err := url.Parse(r.URL.Query().Get("url"))
	if err != nil || !b.allowed(target) {
		http.Error(w, "outbound origin blocked", 403)
		return
	}
	outgoing := r.Clone(r.Context())
	outgoing.URL = target
	outgoing.Host = target.Host
	outgoing.RequestURI = ""
	outgoing.Close = false
	for _, key := range strings.Split(outgoing.Header.Get("Connection"), ",") {
		outgoing.Header.Del(strings.TrimSpace(key))
	}
	for key := range outgoing.Header {
		if strings.HasPrefix(strings.ToLower(key), "x-workagent-") || strings.HasPrefix(strings.ToLower(key), "x-app-broker-") {
			outgoing.Header.Del(key)
		}
	}
	for _, key := range []string{"Proxy-Authorization", "Proxy-Connection", "Connection", "Keep-Alive", "TE", "Trailer", "Transfer-Encoding", "Upgrade", "Cookie"} {
		outgoing.Header.Del(key)
	}
	outgoing.Body = http.MaxBytesReader(w, r.Body, 32*1024*1024)
	response, err := b.transport.RoundTrip(outgoing)
	if err != nil {
		http.Error(w, "outbound request failed", 502)
		return
	}
	defer response.Body.Close()
	for key, values := range response.Header {
		if !strings.EqualFold(key, "Set-Cookie") && !strings.EqualFold(key, "Transfer-Encoding") {
			w.Header()[key] = values
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(response.Body, 64*1024*1024))
}
func RunBroker(config BrokerConfig) error {
	host, _, err := net.SplitHostPort(config.Address)
	if err != nil || host != "127.0.0.1" {
		return ErrInvalid
	}
	broker, err := newOutboundBroker(config)
	if err != nil {
		return err
	}
	return (&http.Server{Addr: config.Address, Handler: broker, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 32 * 1024}).ListenAndServe()
}
