package portal

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIMGatewayProxyInjectsSIDAndKeepsPrivateTokenServerSide(t *testing.T) {
	var path, authorization, sid, cookie string
	gateway := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		path = request.URL.RequestURI()
		authorization = request.Header.Get("Authorization")
		sid = request.Header.Get("X-WorkAgent-SID")
		cookie = request.Header.Get("Cookie")
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"ok":true}`)
	}))
	defer gateway.Close()
	proxy, err := NewIMGatewayProxy(gateway.URL, "0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/channels/connectors?active=true", nil)
	request.Header.Set("Cookie", "workagent-session=browser-secret")
	request.Header.Set("Authorization", "Bearer browser-value")
	request.Header.Set("X-WorkAgent-SID", "S-1-forged")
	response := httptest.NewRecorder()
	proxy.ServeIM(response, request, "S-1-5-21-9000")
	if response.Code != http.StatusOK || path != "/v1/connectors?active=true" || authorization != "Bearer 0123456789abcdef0123456789abcdef" || sid != "S-1-5-21-9000" || cookie != "" {
		t.Fatalf("unsafe IM proxy result code=%d path=%q auth=%q sid=%q cookie=%q", response.Code, path, authorization, sid, cookie)
	}
}
