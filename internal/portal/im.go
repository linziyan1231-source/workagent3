package portal

import (
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

// IMGatewayProxy is the browser-safe ChannelPort adapter. Portal authentication
// supplies the employee SID and the private Gateway credential never reaches
// renderer code.
type IMGatewayProxy struct {
	target *url.URL
	token  string
	proxy  *httputil.ReverseProxy
}

func NewIMGatewayProxy(rawURL, token string) (*IMGatewayProxy, error) {
	target, err := url.Parse(rawURL)
	if err != nil || target.Scheme != "http" && target.Scheme != "https" || target.Host == "" || len(token) < 32 {
		return nil, errors.New("valid IM Gateway URL and 32-byte token are required")
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 6 * time.Minute}
	return &IMGatewayProxy{target: target, token: token, proxy: proxy}, nil
}

func (p *IMGatewayProxy) ServeIM(writer http.ResponseWriter, request *http.Request, sid string) {
	if !strings.HasPrefix(request.URL.Path, "/api/channels/") {
		http.NotFound(writer, request)
		return
	}
	clone := request.Clone(request.Context())
	clone.URL.Path = "/v1/" + strings.TrimPrefix(request.URL.Path, "/api/channels/")
	clone.URL.RawPath = ""
	clone.Host = p.target.Host
	clone.Header.Del("Cookie")
	clone.Header.Del("X-WorkAgent-SID")
	clone.Header.Set("Authorization", "Bearer "+p.token)
	clone.Header.Set("X-WorkAgent-SID", sid)
	p.proxy.ServeHTTP(writer, clone)
}
