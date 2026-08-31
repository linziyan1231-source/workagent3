package imdelivery

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"workagent3/internal/store"
)

type DirectoryHandler struct {
	users     *store.Store
	tokenHash [sha256.Size]byte
}

func NewDirectoryHandler(users *store.Store, token string) (*DirectoryHandler, error) {
	if users == nil || len(token) < 32 {
		return nil, errors.New("Portal user store and a 32-byte IM delivery token are required")
	}
	return &DirectoryHandler{users: users, tokenHash: sha256.Sum256([]byte(token))}, nil
}

func (h *DirectoryHandler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	provided, ok := strings.CutPrefix(request.Header.Get("Authorization"), "Bearer ")
	digest := sha256.Sum256([]byte(provided))
	if !ok || subtle.ConstantTimeCompare(digest[:], h.tokenHash[:]) != 1 {
		writeError(writer, http.StatusUnauthorized, "authentication_required")
		return
	}
	if request.Method != http.MethodGet {
		writer.Header().Set("Allow", http.MethodGet)
		writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	sid := strings.TrimPrefix(request.URL.Path, "/internal/im/employees/")
	if !strings.HasPrefix(sid, "S-1-") || strings.Contains(sid, "/") {
		writeError(writer, http.StatusBadRequest, "invalid_sid")
		return
	}
	user, err := h.users.UserBySID(request.Context(), sid)
	if err == sql.ErrNoRows || user.Disabled {
		writeError(writer, http.StatusNotFound, "employee_not_found")
		return
	}
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "employee_lookup_failed")
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}
