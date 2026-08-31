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
	Action                 string   `json:"action"`
	OwnerSID               string   `json:"ownerSid"`
	OldOwnerSID            string   `json:"oldOwnerSid,omitempty"`
	MemberSIDs             []string `json:"memberSids"`
	RootMemberSIDs         []string `json:"rootMemberSids"`
	OldMemberSIDs          []string `json:"oldMemberSids,omitempty"`
	PreviousRootMemberSIDs []string `json:"previousRootMemberSids,omitempty"`
}

type sharedProjectOperator interface {
	Apply(context.Context, string, sharedProjectRequest) error
}

type sharedProjectManager struct {
	base     string
	dataRoot string
	ownerSID string
}

type sharedTransferJournal struct {
	ProjectID              string   `json:"projectId"`
	OldOwnerSID            string   `json:"oldOwnerSid"`
	Source                 string   `json:"source"`
	Target                 string   `json:"target"`
	OldMemberSIDs          []string `json:"oldMemberSids"`
	PreviousRootMemberSIDs []string `json:"previousRootMemberSids"`
}

func newSharedProjectManager(dataRoot, ownerSID string) (*sharedProjectManager, error) {
	dataRoot = filepath.Clean(dataRoot)
	if !filepath.IsAbs(dataRoot) || !strings.EqualFold(filepath.Base(dataRoot), ownerSID) || !validSharedSID(ownerSID) {
		return nil, errors.New("shared-project manager requires the SID-private data root")
	}
	return &sharedProjectManager{base: filepath.Dir(dataRoot), dataRoot: dataRoot, ownerSID: ownerSID}, nil
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
		return m.prepareTransfer(projectID, request, members, rootMembers)
	case "transfer_commit":
		return m.finishTransfer(projectID, true)
	case "transfer_rollback":
		return m.finishTransfer(projectID, false)
	default:
		return errors.New("unknown shared-project platform action")
	}
}

func (m *sharedProjectManager) prepareTransfer(projectID string, request sharedProjectRequest, members, rootMembers []string) error {
	if !validSharedSID(request.OldOwnerSID) || strings.EqualFold(request.OldOwnerSID, m.ownerSID) {
		return errors.New("old shared-project owner SID is invalid")
	}
	oldMembers, err := normalizeSharedMembers(request.OldOwnerSID, request.OldMemberSIDs)
	if err != nil {
		return err
	}
	previousRootMembers, err := normalizeSharedMembers(m.ownerSID, request.PreviousRootMemberSIDs)
	if err != nil {
		return err
	}
	source := filepath.Join(m.base, "shared", request.OldOwnerSID, projectID)
	targetOwnerRoot := filepath.Join(m.base, "shared", m.ownerSID)
	target := filepath.Join(targetOwnerRoot, projectID)
	if err := requireNormalDirectory(source); err != nil {
		return err
	}
	if err := requireNormalDirectory(targetOwnerRoot); err != nil {
		return err
	}
	if _, err := os.Lstat(target); err == nil {
		return errors.New("new owner project path already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := winutil.ApplySharedOwnerRoot(targetOwnerRoot, m.ownerSID, rootMembers); err != nil {
		return err
	}
	journal := sharedTransferJournal{ProjectID: projectID, OldOwnerSID: request.OldOwnerSID, Source: source, Target: target, OldMemberSIDs: oldMembers, PreviousRootMemberSIDs: previousRootMembers}
	if err := m.writeTransferJournal(journal); err != nil {
		_ = winutil.ApplySharedOwnerRoot(targetOwnerRoot, m.ownerSID, previousRootMembers)
		return err
	}
	if err := os.Rename(source, target); err != nil {
		return errors.Join(err, m.rollbackTransfer(journal))
	}
	if err := winutil.ApplySharedProjectTree(target, m.ownerSID, members); err != nil {
		return errors.Join(err, m.rollbackTransfer(journal))
	}
	return nil
}

func (m *sharedProjectManager) finishTransfer(projectID string, commit bool) error {
	journal, err := m.readTransferJournal(projectID)
	if err != nil {
		if commit && errors.Is(err, os.ErrNotExist) {
			return requireNormalDirectory(filepath.Join(m.base, "shared", m.ownerSID, projectID))
		}
		return err
	}
	if !commit {
		return m.rollbackTransfer(journal)
	}
	if err := requireNormalDirectory(journal.Target); err != nil {
		return err
	}
	return os.Remove(m.transferJournalPath(projectID))
}

func (m *sharedProjectManager) rollbackTransfer(journal sharedTransferJournal) error {
	targetErr, sourceErr := requireNormalDirectory(journal.Target), requireNormalDirectory(journal.Source)
	if (targetErr == nil) == (sourceErr == nil) {
		return errors.New("shared transfer rollback requires exactly one project location")
	}
	if targetErr == nil {
		if err := os.Rename(journal.Target, journal.Source); err != nil {
			return err
		}
	}
	if err := winutil.ApplySharedProjectTree(journal.Source, journal.OldOwnerSID, journal.OldMemberSIDs); err != nil {
		return err
	}
	if err := winutil.ApplySharedOwnerRoot(filepath.Dir(journal.Target), m.ownerSID, journal.PreviousRootMemberSIDs); err != nil {
		return err
	}
	return os.Remove(m.transferJournalPath(journal.ProjectID))
}

func (m *sharedProjectManager) transferJournalPath(projectID string) string {
	return filepath.Join(m.dataRoot, "runtime", "shared-project-transactions", projectID+".json")
}

func (m *sharedProjectManager) writeTransferJournal(journal sharedTransferJournal) error {
	path := m.transferJournalPath(journal.ProjectID)
	if err := ensureNormalDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	encoded, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, encoded, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func (m *sharedProjectManager) readTransferJournal(projectID string) (sharedTransferJournal, error) {
	encoded, err := os.ReadFile(m.transferJournalPath(projectID))
	if err != nil {
		return sharedTransferJournal{}, err
	}
	var journal sharedTransferJournal
	if json.Unmarshal(encoded, &journal) != nil || journal.ProjectID != projectID || !validSharedSID(journal.OldOwnerSID) || strings.EqualFold(journal.OldOwnerSID, m.ownerSID) {
		return sharedTransferJournal{}, errors.New("shared transfer journal is invalid")
	}
	expectedSource := filepath.Join(m.base, "shared", journal.OldOwnerSID, projectID)
	expectedTarget := filepath.Join(m.base, "shared", m.ownerSID, projectID)
	if !strings.EqualFold(filepath.Clean(journal.Source), expectedSource) || !strings.EqualFold(filepath.Clean(journal.Target), expectedTarget) {
		return sharedTransferJournal{}, errors.New("shared transfer journal escaped stable roots")
	}
	if _, err := normalizeSharedMembers(journal.OldOwnerSID, journal.OldMemberSIDs); err != nil {
		return sharedTransferJournal{}, err
	}
	if _, err := normalizeSharedMembers(m.ownerSID, journal.PreviousRootMemberSIDs); err != nil {
		return sharedTransferJournal{}, err
	}
	return journal, nil
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
