package userhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"workagent3/internal/winutil"
)

var sharedProjectIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

type sharedProjectRequest struct {
	Action         string   `json:"action"`
	OwnerSID       string   `json:"ownerSid"`
	OldOwnerSID    string   `json:"oldOwnerSid,omitempty"`
	MemberSIDs     []string `json:"memberSids"`
	RootMemberSIDs []string `json:"rootMemberSids"`
}

type sharedProjectOperator interface {
	Apply(context.Context, string, sharedProjectRequest) error
}

type sharedProjectManager struct {
	base     string
	ownerSID string
}

func newSharedProjectManager(dataRoot, ownerSID string) (*sharedProjectManager, error) {
	dataRoot = filepath.Clean(dataRoot)
	if !filepath.IsAbs(dataRoot) || !strings.EqualFold(filepath.Base(dataRoot), ownerSID) || !validSharedSID(ownerSID) {
		return nil, errors.New("shared-project manager requires the SID-private data root")
	}
	return &sharedProjectManager{base: filepath.Dir(dataRoot), ownerSID: ownerSID}, nil
}

func (m *sharedProjectManager) Apply(_ context.Context, projectID string, request sharedProjectRequest) error {
	if !sharedProjectIDPattern.MatchString(projectID) || !strings.EqualFold(request.OwnerSID, m.ownerSID) {
		return errors.New("shared-project request does not match this owner Runtime")
	}
	members, err := normalizeSharedMembers(request.OwnerSID, request.MemberSIDs)
	if err != nil {
		return err
	}
	rootMembers, err := normalizeSharedMembers(request.OwnerSID, request.RootMemberSIDs)
	if err != nil {
		return err
	}
	ownerRoot := filepath.Join(m.base, "shared", m.ownerSID)
	switch request.Action {
	case "provision":
		if len(members) != 0 {
			return errors.New("new shared project cannot have members before provisioning")
		}
		if err := ensureNormalDirectory(ownerRoot); err != nil {
			return err
		}
		if err := winutil.ApplySharedOwnerRoot(ownerRoot, m.ownerSID, rootMembers); err != nil {
			return err
		}
		projectRoot := filepath.Join(ownerRoot, projectID)
		if err := os.Mkdir(projectRoot, 0o700); err != nil {
			return err
		}
		if err := winutil.ApplySharedProjectTree(projectRoot, m.ownerSID, nil); err != nil {
			_ = os.Remove(projectRoot)
			return err
		}
		return nil
	case "reconcile":
		if err := requireNormalDirectory(ownerRoot); err != nil {
			return err
		}
		projectRoot := filepath.Join(ownerRoot, projectID)
		if err := requireNormalDirectory(projectRoot); err != nil {
			return err
		}
		if err := winutil.ApplySharedOwnerRoot(ownerRoot, m.ownerSID, rootMembers); err != nil {
			return err
		}
		return winutil.ApplySharedProjectTree(projectRoot, m.ownerSID, members)
	case "transfer":
		return errors.New("shared-project ownership transfer requires the recovery journal adapter")
	default:
		return errors.New("unknown shared-project platform action")
	}
}

func sharedProjectPlatformHandler(operator sharedProjectOperator) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		var input sharedProjectRequest
		decoder := json.NewDecoder(io.LimitReader(request.Body, 16*1024))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_shared_project_request")
			return
		}
		if err := operator.Apply(request.Context(), request.PathValue("id"), input); err != nil {
			writeRuntimeError(writer, http.StatusConflict, err.Error())
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	}
}

func normalizeSharedMembers(ownerSID string, values []string) ([]string, error) {
	seen := map[string]struct{}{}
	members := make([]string, 0, len(values))
	for _, sid := range values {
		if !validSharedSID(sid) || strings.EqualFold(sid, ownerSID) || forbiddenSharedSID(sid) {
			return nil, errors.New("invalid shared-project member SID")
		}
		key := strings.ToUpper(sid)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		members = append(members, sid)
	}
	return members, nil
}

func validSharedSID(value string) bool {
	return strings.HasPrefix(strings.ToUpper(value), "S-1-") && len(value) <= 184
}

func forbiddenSharedSID(value string) bool {
	for _, sid := range []string{"S-1-1-0", "S-1-5-11", "S-1-5-18", "S-1-5-32-544", "S-1-5-32-545", "S-1-3-4"} {
		if strings.EqualFold(value, sid) {
			return true
		}
	}
	return false
}

func ensureNormalDirectory(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return requireNormalDirectory(path)
}

func requireNormalDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("shared-project path must be a normal directory")
	}
	return nil
}
