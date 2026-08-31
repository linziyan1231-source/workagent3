package runtimeapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const DefaultLeaseDuration = 90 * time.Second

type LeaseRequest struct {
	SID     string `json:"sid"`
	BaseURL string `json:"baseUrl"`
	Token   string `json:"token"`
}

type LeaseAuthorizer interface {
	RuntimeRegistrationAuthorized(context.Context, string, string) bool
}

// LeaseHandler is deliberately separate from the browser API. It accepts
// requests only from the local machine and authenticates each employee SID
// with its own provisioning credential.
func LeaseHandler(registry *Registry, authorizer LeaseAuthorizer) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !isLoopbackRequest(request) {
			http.Error(writer, "loopback_required", http.StatusForbidden)
			return
		}
		credential, ok := strings.CutPrefix(request.Header.Get("Authorization"), "Bearer ")
		if !ok || credential == "" {
			http.Error(writer, "authentication_required", http.StatusUnauthorized)
			return
		}
		if request.Method == http.MethodGet {
			sid := request.URL.Query().Get("sid")
			if !authorizer.RuntimeRegistrationAuthorized(request.Context(), sid, credential) {
				http.Error(writer, "registration_rejected", http.StatusUnauthorized)
				return
			}
			if _, err := registry.Resolve(request.Context(), sid); err != nil {
				http.Error(writer, "runtime_unavailable", http.StatusServiceUnavailable)
				return
			}
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		var input LeaseRequest
		decoder := json.NewDecoder(io.LimitReader(request.Body, 8*1024))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			http.Error(writer, "invalid_request", http.StatusBadRequest)
			return
		}
		switch request.Method {
		case http.MethodPut:
			registration := Registration{SID: input.SID, BaseURL: input.BaseURL, Token: input.Token, ExpiresAt: registry.now().Add(DefaultLeaseDuration)}
			if !authorizer.RuntimeRegistrationAuthorized(request.Context(), input.SID, credential) {
				http.Error(writer, "registration_rejected", http.StatusUnauthorized)
				return
			}
			if err := registry.Register(registration); err != nil {
				http.Error(writer, "registration_rejected", http.StatusBadRequest)
				return
			}
			writer.WriteHeader(http.StatusNoContent)
		case http.MethodDelete:
			if !authorizer.RuntimeRegistrationAuthorized(request.Context(), input.SID, credential) {
				http.Error(writer, "registration_rejected", http.StatusUnauthorized)
				return
			}
			registry.Remove(input.SID, input.Token)
			writer.WriteHeader(http.StatusNoContent)
		default:
			writer.Header().Set("Allow", "PUT, DELETE")
			http.Error(writer, "method_not_allowed", http.StatusMethodNotAllowed)
		}
	})
}

func (r *Registry) authorize(sid, credential string) error {
	digest := sha256Digest(credential)
	r.mu.RLock()
	expected, ok := r.credentials[sid]
	r.mu.RUnlock()
	if !ok || !equalDigest(digest, expected) {
		return errors.New("runtime registration is not authorized")
	}
	return nil
}

func sha256Digest(value string) [32]byte { return sha256.Sum256([]byte(value)) }
func equalDigest(left, right [32]byte) bool {
	return subtle.ConstantTimeCompare(left[:], right[:]) == 1
}

func isLoopbackRequest(request *http.Request) bool {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	return err == nil && net.ParseIP(host).IsLoopback()
}
