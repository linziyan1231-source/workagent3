package portal

import (
	"net/http"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/store"
)

func (s *Server) rememberedCookie(value string) *http.Cookie {
	return &http.Cookie{Name: s.cookieName() + "-remembered", Value: value, Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteStrictMode}
}

func (s *Server) rememberedUser(request *http.Request) (store.User, error) {
	cookie, err := request.Cookie(s.rememberedCookie("").Name)
	if err != nil {
		return store.User{}, err
	}
	return s.store.UserByRememberedLogin(request.Context(), cookie.Value, s.now())
}

func (s *Server) rememberedLogin(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	user, err := s.rememberedUser(request)
	if err != nil {
		writeJSON(writer, http.StatusOK, map[string]any{"username": nil})
		return
	}
	// Neither the password nor the device credential is sent to page scripts.
	writeJSON(writer, http.StatusOK, map[string]any{"username": user.Username})
}

func (s *Server) saveRememberedLogin(writer http.ResponseWriter, request *http.Request, user store.User, remember bool) error {
	if previous, err := request.Cookie(s.rememberedCookie("").Name); err == nil {
		if err := s.store.DeleteRememberedLogin(request.Context(), previous.Value); err != nil {
			return err
		}
	}
	cookie := s.rememberedCookie("")
	cookie.MaxAge = -1
	if remember {
		token, err := auth.RandomToken(32)
		if err != nil {
			return err
		}
		cookie.Value = token
		cookie.Expires = s.now().Add(30 * 24 * time.Hour)
		cookie.MaxAge = 30 * 24 * 60 * 60
		if err := s.store.CreateRememberedLogin(request.Context(), token, user.ID, cookie.Expires); err != nil {
			return err
		}
	}
	http.SetCookie(writer, cookie)
	return nil
}

func (s *Server) forgetLogin(writer http.ResponseWriter, request *http.Request) {
	if err := s.saveRememberedLogin(writer, request, store.User{}, false); err != nil {
		writeError(writer, http.StatusInternalServerError, "internal_error")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}
