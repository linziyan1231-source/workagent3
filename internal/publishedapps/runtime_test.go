package publishedapps

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if handled, err := Worker(os.Args[1:]); handled {
		if err != nil {
			os.Stderr.WriteString(err.Error())
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func TestSnapshotCopiesEntryDirectoryAndExcludesPrivateFiles(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "workspace")
	os.MkdirAll(filepath.Join(source, "publish", ".git"), 0700)
	os.WriteFile(filepath.Join(source, "private.txt"), []byte("outside"), 0600)
	os.WriteFile(filepath.Join(source, "publish", "index.html"), []byte("original"), 0600)
	os.WriteFile(filepath.Join(source, "publish", ".env.local"), []byte("credential"), 0600)
	destination := filepath.Join(root, "snapshot")
	input := SnapshotInput{SourceRoot: source, Entry: "publish/index.html", Destination: destination, Manifest: Manifest{Kind: "static"}}
	if err := RunSnapshot(input); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(source, "publish", "index.html"), []byte("changed"), 0600)
	content, _ := os.ReadFile(filepath.Join(destination, "bundle", "index.html"))
	if string(content) != "original" {
		t.Fatal("snapshot changed with source")
	}
	for _, name := range []string{".env.local", ".git", "private.txt"} {
		if _, err := os.Stat(filepath.Join(destination, "bundle", name)); !os.IsNotExist(err) {
			t.Fatalf("private path copied: %s", name)
		}
	}
	var manifest Manifest
	raw, _ := os.ReadFile(filepath.Join(destination, "manifest.json"))
	json.Unmarshal(raw, &manifest)
	if manifest.FileCount != 1 || manifest.ByteCount != 8 || manifest.Entry != "index.html" || len(manifest.Excluded) != 2 {
		t.Fatal(manifest)
	}
}
func TestSnapshotRejectsLinkedFiles(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	os.Mkdir(source, 0700)
	os.WriteFile(filepath.Join(root, "secret"), []byte("private"), 0600)
	if err := os.Symlink(filepath.Join(root, "secret"), filepath.Join(source, "index.html")); err != nil {
		t.Skip("symlink privilege unavailable")
	}
	if err := RunSnapshot(SnapshotInput{SourceRoot: source, Entry: "index.html", Destination: filepath.Join(root, "copy"), Manifest: Manifest{Kind: "static"}}); err == nil {
		t.Fatal("linked file copied")
	}
}
func TestBrokerRequiresTokenAndNeverFollowsRedirectsOrPrivateDNS(t *testing.T) {
	b, err := newOutboundBroker(BrokerConfig{Token: strings.Repeat("t", 32), AllowedOrigins: []string{"https://api.example.test"}})
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("X-App-Broker-Token") != "" || r.Header.Get("Cookie") != "" || r.Host != "api.example.test" {
			t.Error("upstream credential or Host leak")
		}
		w.Header().Set("Location", "http://127.0.0.1/private")
		w.WriteHeader(302)
	}))
	defer remote.Close()
	remoteURL, _ := url.Parse(remote.URL)
	b.transport = &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", remoteURL.Host)
	}}
	// Test the forwarding path over plain HTTP while pinning the logical host.
	b.origins = map[string]bool{"http://api.example.test:80": true}
	request := httptest.NewRequest("POST", "/fetch?url="+url.QueryEscape("http://api.example.test/v1"), bytes.NewReader([]byte("payload")))
	response := httptest.NewRecorder()
	b.ServeHTTP(response, request)
	if response.Code != 401 {
		t.Fatal(response.Code)
	}
	request = httptest.NewRequest("POST", "/fetch?url="+url.QueryEscape("http://api.example.test/v1"), strings.NewReader("payload"))
	request.Header.Set("X-App-Broker-Token", strings.Repeat("t", 32))
	request.Header.Set("Cookie", "platform=secret")
	response = httptest.NewRecorder()
	b.ServeHTTP(response, request)
	if response.Code != 302 || calls != 1 {
		t.Fatalf("redirect followed: %d %d", response.Code, calls)
	}
	for _, target := range []string{"http://127.0.0.1/", "file:///private", "https://api.example.test:444/", "http://api.example.test@evil.test/"} {
		request = httptest.NewRequest("GET", "/fetch?url="+url.QueryEscape(target), nil)
		request.Header.Set("X-App-Broker-Token", strings.Repeat("t", 32))
		response = httptest.NewRecorder()
		b.ServeHTTP(response, request)
		if response.Code != 403 {
			t.Fatalf("allowed %s: %d", target, response.Code)
		}
	}
	if _, err = publicDial(t.Context(), "tcp", "127.0.0.1:1234"); err == nil {
		t.Fatal("private DNS dialed")
	}
	for _, value := range []string{"127.0.0.1", "10.0.0.1", "100.64.0.2", "169.254.1.1", "192.168.1.2", "::1", "::ffff:127.0.0.1", "fc00::1", "2001:db8::1"} {
		if publicAddress(netip.MustParseAddr(value)) {
			t.Errorf("private address accepted: %s", value)
		}
	}
	if !publicAddress(netip.MustParseAddr("1.1.1.1")) {
		t.Fatal("public address blocked")
	}
}
func TestInternalHeadersAreRemovedAndBusinessOriginRestored(t *testing.T) {
	h := http.Header{}
	h.Set("Authorization", "Bearer runtime-secret")
	h.Set("X-WorkAgent-App-Authorization", "Bearer business")
	h.Set("X-WorkAgent-App-Origin", "http://public.example:40000")
	h.Set("Origin", "http://127.0.0.1:1234")
	h.Set("X-WorkAgent-App-Version", "version")
	StripInternalHeaders(h)
	if h.Get("Authorization") != "Bearer business" || h.Get("Origin") != "http://public.example:40000" || h.Get("X-WorkAgent-App-Version") != "" {
		t.Fatal(h)
	}
}
