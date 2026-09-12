package userhost

import (
	"bufio"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/portal"
	"workagent3/internal/runtimeapi"
	"workagent3/internal/store"
)

func TestPortalWebSocketStreamsAreIsolatedBySID(t *testing.T) {
	newHarness := func(identity string, seen chan<- string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			conn, buffered, err := writer.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			defer conn.Close()
			_, _ = buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
			_ = buffered.Flush()
			_, payload, err := readTestWebSocketFrame(buffered.Reader)
			if err != nil {
				t.Error(err)
				return
			}
			seen <- identity + ":" + string(payload)
			writeTestWebSocketFrame(buffered.Writer, 1, []byte(identity))
			_ = buffered.Flush()
		}))
	}
	seen := make(chan string, 2)
	harnessA := newHarness("sid-a", seen)
	defer harnessA.Close()
	harnessB := newHarness("sid-b", seen)
	defer harnessB.Close()
	urlA, _ := url.Parse(harnessA.URL)
	urlB, _ := url.Parse(harnessB.URL)

	data, _ := store.Open(":memory:")
	defer data.Close()
	hash, _ := auth.HashPassword([]byte("correct horse battery staple"))
	userA, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", hash)
	userB, _ := data.CreateUser(t.Context(), "bob", "S-1-5-21-2000", hash)
	server, _ := portal.New(data, portal.StaticRouter{
		userA.SID: {BaseURL: urlA, Token: "runtime-token-a"},
		userB.SID: {BaseURL: urlB, Token: "runtime-token-b"},
	}, false)
	portalHTTP := httptest.NewServer(server.Handler())
	defer portalHTTP.Close()

	login := func(username string) *http.Cookie {
		request, _ := http.NewRequest(http.MethodPost, portalHTTP.URL+"/api/auth/login", strings.NewReader(`{"username":"`+username+`","password":"correct horse battery staple"}`))
		request.Header.Set("Origin", portalHTTP.URL)
		response, err := portalHTTP.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		return response.Cookies()[0]
	}
	open := func(cookie *http.Cookie, payload string) (net.Conn, *bufio.Reader) {
		address := strings.TrimPrefix(portalHTTP.URL, "http://")
		conn, err := net.Dial("tcp", address)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(conn, "GET /api/events HTTP/1.1\r\nHost: "+address+"\r\nOrigin: "+portalHTTP.URL+"\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: "+cookie.Name+"="+cookie.Value+"\r\n\r\n")
		reader := bufio.NewReader(conn)
		status, _ := reader.ReadString('\n')
		if !strings.Contains(status, "101") {
			t.Fatalf("upgrade status %q", status)
		}
		for {
			line, _ := reader.ReadString('\n')
			if line == "\r\n" {
				break
			}
		}
		writeMaskedTestWebSocketFrame(conn, 1, []byte(payload))
		return conn, reader
	}

	connA, readerA := open(login("alice"), "from-a")
	defer connA.Close()
	connB, readerB := open(login("bob"), "from-b")
	defer connB.Close()
	var wg sync.WaitGroup
	wg.Add(2)
	results := make(chan string, 2)
	for _, input := range []struct {
		conn net.Conn
		read *bufio.Reader
		name string
	}{{connA, readerA, "a"}, {connB, readerB, "b"}} {
		go func() {
			defer wg.Done()
			_ = input.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			_, payload, err := readTestWebSocketFrame(input.read)
			if err != nil {
				results <- input.name + ":error"
				return
			}
			results <- input.name + ":" + string(payload)
		}()
	}
	wg.Wait()
	close(results)
	got := map[string]bool{}
	for result := range results {
		got[result] = true
	}
	if !got["a:sid-a"] || !got["b:sid-b"] || got["a:sid-b"] || got["b:sid-a"] {
		t.Fatalf("cross-SID websocket routing: %#v", got)
	}
	first, second := <-seen, <-seen
	if !((first == "sid-a:from-a" && second == "sid-b:from-b") || (first == "sid-b:from-b" && second == "sid-a:from-a")) {
		t.Fatalf("backend streams received cross-SID frames: %q, %q", first, second)
	}
}

func TestPortalAndRuntimeGatewayRelayWebSocketFramesAndClose(t *testing.T) {
	harness := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer runtime-token" {
			t.Errorf("Harness received authorization %q", request.Header.Get("Authorization"))
		}
		conn, buffered, err := writer.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_, _ = buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_ = buffered.Flush()
		kind, payload, err := readTestWebSocketFrame(buffered.Reader)
		if err != nil || kind != 1 {
			t.Errorf("read text frame: kind=%d err=%v", kind, err)
			return
		}
		writeTestWebSocketFrame(buffered.Writer, 1, payload)
		_ = buffered.Flush()
		kind, _, err = readTestWebSocketFrame(buffered.Reader)
		if err != nil || kind != 8 {
			t.Errorf("read close frame: kind=%d err=%v", kind, err)
			return
		}
		writeTestWebSocketFrame(buffered.Writer, 8, nil)
		_ = buffered.Flush()
	}))
	defer harness.Close()
	harnessURL, _ := url.Parse(harness.URL)
	gateway := httptest.NewServer(newRuntimeGatewayHandlerWithControl(nil, nil, nil, nil, nil, nil, nil, harnessURL, "runtime-token", nil, nil, nil, "", nil, nil, nil, ""))
	defer gateway.Close()
	gatewayURL, _ := url.Parse(gateway.URL)
	data, _ := store.Open(":memory:")
	defer data.Close()
	hash, _ := auth.HashPassword([]byte("correct horse battery staple"))
	user, _ := data.CreateUser(t.Context(), "alice", "S-1-5-21-1000", hash)
	server, _ := portal.New(data, portal.StaticRouter{user.SID: runtimeapi.Endpoint{BaseURL: gatewayURL, Token: "runtime-token"}}, false)
	portalHTTP := httptest.NewServer(server.Handler())
	defer portalHTTP.Close()

	login, _ := http.NewRequest(http.MethodPost, portalHTTP.URL+"/api/auth/login", strings.NewReader(`{"username":"alice","password":"correct horse battery staple"}`))
	login.Header.Set("Origin", portalHTTP.URL)
	loginResponse, err := portalHTTP.Client().Do(login)
	if err != nil {
		t.Fatal(err)
	}
	loginResponse.Body.Close()
	if len(loginResponse.Cookies()) == 0 {
		t.Fatal("login did not return a session cookie")
	}

	address := strings.TrimPrefix(portalHTTP.URL, "http://")
	conn, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "GET /api/events HTTP/1.1\r\nHost: "+address+"\r\nOrigin: "+portalHTTP.URL+"\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: "+loginResponse.Cookies()[0].Name+"="+loginResponse.Cookies()[0].Value+"\r\n\r\n")
	reader := bufio.NewReader(conn)
	status, _ := reader.ReadString('\n')
	if !strings.Contains(status, "101") {
		t.Fatalf("upgrade status %q", status)
	}
	for {
		line, _ := reader.ReadString('\n')
		if line == "\r\n" {
			break
		}
	}
	writeMaskedTestWebSocketFrame(conn, 1, []byte("sid-private-delta"))
	kind, payload, err := readTestWebSocketFrame(reader)
	if err != nil || kind != 1 || string(payload) != "sid-private-delta" {
		t.Fatalf("relayed frame kind=%d payload=%q err=%v", kind, payload, err)
	}
	writeMaskedTestWebSocketFrame(conn, 8, nil)
	kind, _, err = readTestWebSocketFrame(reader)
	if err != nil || kind != 8 {
		t.Fatalf("relayed close kind=%d err=%v", kind, err)
	}
}

func readTestWebSocketFrame(reader io.Reader) (byte, []byte, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(reader, header); err != nil {
		return 0, nil, err
	}
	length := int(header[1] & 0x7f)
	if length == 126 {
		extended := make([]byte, 2)
		if _, err := io.ReadFull(reader, extended); err != nil {
			return 0, nil, err
		}
		length = int(binary.BigEndian.Uint16(extended))
	}
	var mask []byte
	if header[1]&0x80 != 0 {
		mask = make([]byte, 4)
		if _, err := io.ReadFull(reader, mask); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return 0, nil, err
	}
	for i := range payload {
		if len(mask) != 0 {
			payload[i] ^= mask[i%4]
		}
	}
	return header[0] & 0xf, payload, nil
}

func writeTestWebSocketFrame(writer io.Writer, kind byte, payload []byte) {
	_, _ = writer.Write([]byte{0x80 | kind, byte(len(payload))})
	_, _ = writer.Write(payload)
}

func writeMaskedTestWebSocketFrame(writer io.Writer, kind byte, payload []byte) {
	mask := [4]byte{1, 2, 3, 4}
	frame := []byte{0x80 | kind, 0x80 | byte(len(payload)), mask[0], mask[1], mask[2], mask[3]}
	for index, value := range payload {
		frame = append(frame, value^mask[index%4])
	}
	_, _ = writer.Write(frame)
}
