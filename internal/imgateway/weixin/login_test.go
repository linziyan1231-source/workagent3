package weixin

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type credentialWriterStub struct {
	ref    string
	secret string
}

func (s *credentialWriterStub) Save(_ context.Context, ref string, secret []byte) error {
	s.ref = ref
	s.secret = string(secret)
	return nil
}

func TestLoginStoresTokenPrivatelyAndEmitsNoSecret(t *testing.T) {
	var mu sync.Mutex
	polls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/ilink/bot/get_bot_qrcode":
			_, _ = io.WriteString(writer, `{"code":0,"data":{"qrcode":"ticket","qrcode_img_content":"weixin://qr-content"}}`)
		case "/ilink/bot/get_qrcode_status":
			mu.Lock()
			polls++
			current := polls
			mu.Unlock()
			if current == 1 {
				_, _ = io.WriteString(writer, `{"status":"scaned"}`)
			} else {
				_, _ = io.WriteString(writer, `{"status":"confirmed","bot_token":"private-token","ilink_bot_id":"bot-1","baseurl":"https://ilinkai.weixin.qq.com"}`)
			}
		default:
			http.NotFound(writer, request)
		}
	}))
	defer upstream.Close()
	credentials := &credentialWriterStub{}
	service, _ := NewLoginService(credentials)
	service.baseURL = upstream.URL
	service.pollEvery = time.Millisecond
	service.timeout = time.Second
	var events []string
	config, err := service.Login(t.Context(), "S-1-5-21-9000", func(name string, data any) error {
		encoded, _ := json.Marshal(data)
		events = append(events, name+":"+string(encoded))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(config)
	if credentials.ref != "S-1-5-21-9000.weixin.token" || credentials.secret != "private-token" || string(encoded) == "" {
		t.Fatalf("credential was not stored correctly: %#v %#v", credentials, config)
	}
	for _, event := range events {
		if event == "" || contains(event, "private-token") {
			t.Fatalf("login event exposed credential: %s", event)
		}
	}
	if len(events) != 2 || events[0] != `qr:{"qrcodeData":"weixin://qr-content"}` || events[1] != `scanned:{}` {
		t.Fatalf("unexpected login events: %#v", events)
	}
}

func contains(value, part string) bool {
	for index := 0; index+len(part) <= len(value); index++ {
		if value[index:index+len(part)] == part {
			return true
		}
	}
	return false
}
