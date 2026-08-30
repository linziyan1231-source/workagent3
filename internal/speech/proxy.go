package speech

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"workagent3/internal/contracts"
)

const (
	DefaultMaxAudioBytes    = 30 * 1024 * 1024
	DefaultMaxStreamSeconds = 300
)

type Proxy struct {
	baseURL           *url.URL
	token             string
	maxAudioBytes     int64
	maxStreamDuration time.Duration
}

func NewProxy(rawURL, token string, maxAudioBytes int64, maxStreamDuration time.Duration) (*Proxy, error) {
	if strings.TrimSpace(rawURL) == "" {
		return &Proxy{maxAudioBytes: DefaultMaxAudioBytes, maxStreamDuration: DefaultMaxStreamSeconds * time.Second}, nil
	}
	baseURL, err := url.Parse(rawURL)
	if err != nil || (baseURL.Scheme != "http" && baseURL.Scheme != "https") || baseURL.Host == "" {
		return nil, errors.New("speech adapter URL is invalid")
	}
	if len(token) < 22 {
		return nil, errors.New("speech adapter token is required")
	}
	if maxAudioBytes <= 0 {
		maxAudioBytes = DefaultMaxAudioBytes
	}
	if maxStreamDuration <= 0 {
		maxStreamDuration = DefaultMaxStreamSeconds * time.Second
	}
	return &Proxy{baseURL: baseURL, token: token, maxAudioBytes: maxAudioBytes, maxStreamDuration: maxStreamDuration}, nil
}

func (p *Proxy) Capability() contracts.SpeechCapability {
	enabled := p.baseURL != nil
	return contracts.SpeechCapability{
		Enabled:            enabled,
		Streaming:          enabled,
		MaxAudioBytes:      p.maxAudioBytes,
		MaxStreamSeconds:   int64(p.maxStreamDuration / time.Second),
		AcceptedFormatHint: "pcm16-24000-mono, webm, wav, mp3, mp4, ogg",
	}
}

func (p *Proxy) ServeSpeech(writer http.ResponseWriter, request *http.Request, sid string) {
	if p.baseURL == nil {
		writeError(writer, http.StatusServiceUnavailable, "speech_disabled")
		return
	}
	stream := request.URL.Path == "/api/stt/stream"
	if stream {
		if request.Method != http.MethodGet || !strings.EqualFold(request.Header.Get("Upgrade"), "websocket") {
			writeError(writer, http.StatusBadRequest, "speech_stream_upgrade_required")
			return
		}
		ctx, cancel := context.WithTimeout(request.Context(), p.maxStreamDuration)
		defer cancel()
		request = request.WithContext(ctx)
	} else {
		if request.URL.Path != "/api/stt" || request.Method != http.MethodPost {
			writeError(writer, http.StatusMethodNotAllowed, "speech_method_not_allowed")
			return
		}
		if request.ContentLength > p.maxAudioBytes {
			writeError(writer, http.StatusRequestEntityTooLarge, "speech_audio_too_large")
			return
		}
		request.Body = http.MaxBytesReader(writer, request.Body, p.maxAudioBytes)
	}

	proxy := httputil.NewSingleHostReverseProxy(p.baseURL)
	original := proxy.Director
	proxy.Director = func(outgoing *http.Request) {
		original(outgoing)
		outgoing.URL.Path = request.URL.Path
		stripBrowserCredentials(outgoing.Header)
		outgoing.Header.Set("Authorization", "Bearer "+p.token)
		outgoing.Header.Set("X-WorkAgent-SID", sid)
	}
	proxy.ErrorHandler = func(response http.ResponseWriter, _ *http.Request, err error) {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(response, http.StatusRequestEntityTooLarge, "speech_audio_too_large")
			return
		}
		writeError(response, http.StatusBadGateway, "speech_adapter_unavailable")
	}
	proxy.ServeHTTP(writer, request)
}

func stripBrowserCredentials(header http.Header) {
	for name := range header {
		lower := strings.ToLower(name)
		if lower == "cookie" || lower == "authorization" || lower == "proxy-authorization" || lower == "x-api-key" || strings.HasPrefix(lower, "x-workagent-") || strings.HasPrefix(lower, "x-forwarded-") {
			header.Del(name)
		}
	}
}

func writeError(writer http.ResponseWriter, status int, code string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]string{"error": code})
}
