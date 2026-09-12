package portal

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

type RequestSourcePolicy struct{ TrustedProxies []netip.Prefix }

func (p RequestSourcePolicy) trusted(ip netip.Addr) bool {
	for _, prefix := range p.TrustedProxies {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}
func (p RequestSourcePolicy) source(r *http.Request) map[string]string {
	peerText, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		peerText = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(peerText)
	if err != nil {
		return map[string]string{"source_kind": "http", "user_agent": boundedAuditTarget(r.UserAgent())}
	}
	peer = peer.Unmap()
	client := peer
	if p.trusted(peer) {
		raw := r.Header.Get("X-Forwarded-For")
		if len(raw) <= 2048 {
			parts := strings.Split(raw, ",")
			if len(parts) <= 32 {
				for i := len(parts) - 1; i >= 0 && p.trusted(client); i-- {
					ip, e := netip.ParseAddr(strings.TrimSpace(parts[i]))
					if e != nil {
						client = peer
						break
					}
					client = ip.Unmap()
				}
			}
		}
	}
	return map[string]string{"source_kind": "http", "peer_ip": peer.String(), "client_ip": client.String(), "user_agent": boundedAuditTarget(r.UserAgent())}
}

// Authentication cookies must be unique: cookies are not scoped to TCP ports.
func uniqueCookie(r *http.Request, name string) (*http.Cookie, error) {
	var found *http.Cookie
	for _, cookie := range r.Cookies() {
		if cookie.Name == name {
			if found != nil {
				return nil, http.ErrNoCookie
			}
			found = cookie
		}
	}
	if found == nil {
		return nil, http.ErrNoCookie
	}
	return found, nil
}
