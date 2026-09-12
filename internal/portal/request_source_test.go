package portal

import (
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestRequestSourceTrustBoundary(t *testing.T) {
	p := RequestSourcePolicy{TrustedProxies: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}}
	r := httptest.NewRequest("GET", "http://example.test", nil)
	r.RemoteAddr = "192.0.2.7:55"
	r.Header.Set("X-Forwarded-For", "198.51.100.3")
	if got := p.source(r)["client_ip"]; got != "192.0.2.7" {
		t.Fatal(got)
	}
	r.RemoteAddr = "127.0.0.1:55"
	r.Header.Set("X-Forwarded-For", "203.0.113.7, 198.51.100.3, 127.0.0.2")
	if got := p.source(r)["client_ip"]; got != "198.51.100.3" {
		t.Fatal(got)
	}
	r.Header.Set("X-Forwarded-For", "::ffff:192.0.2.8")
	if got := p.source(r)["client_ip"]; got != "192.0.2.8" {
		t.Fatal(got)
	}
	r.Header.Set("X-Forwarded-For", "invalid")
	if got := p.source(r)["client_ip"]; got != "127.0.0.1" {
		t.Fatal(got)
	}
}
func TestDuplicateAuthenticationCookieRejected(t *testing.T) {
	r := httptest.NewRequest("GET", "http://example.test", nil)
	r.Header.Set("Cookie", "workagent-session=one; workagent-session=two")
	if _, err := uniqueCookie(r, "workagent-session"); err == nil {
		t.Fatal("accepted duplicate")
	}
}
