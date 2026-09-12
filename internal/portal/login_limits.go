package portal

import (
	"context"
	"net/http"
	"strconv"
	"time"
)

func (s *Server) beginLogin(w http.ResponseWriter, r *http.Request, account string) (func(), bool) {
	select {
	case s.loginSlots <- struct{}{}:
	default:
		w.Header().Set("Retry-After", "1")
		writeError(w, 429, "authentication_busy")
		return nil, false
	}
	release := func() { <-s.loginSlots }
	ip := s.modules.RequestSource.source(r)["client_ip"]
	until, err := s.store.LoginBlockedUntil(r.Context(), account, ip, s.now())
	if err != nil {
		release()
		writeError(w, 503, "authentication_unavailable")
		return nil, false
	}
	if !until.IsZero() {
		release()
		seconds := int(until.Sub(s.now()).Seconds()) + 1
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
		writeError(w, 429, "login_rate_limited")
		return nil, false
	}
	return release, true
}
func (s *Server) recordLogin(w http.ResponseWriter, r *http.Request, account string, success bool) bool {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	if err := s.store.RecordLoginAttempt(ctx, account, s.modules.RequestSource.source(r)["client_ip"], success, s.now(), s.modules.LoginPolicy); err != nil {
		writeError(w, 503, "authentication_unavailable")
		return false
	}
	return true
}
