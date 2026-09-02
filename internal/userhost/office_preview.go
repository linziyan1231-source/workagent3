package userhost

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
)

// Office preview converts DOCX/XLSX/PPTX to PDF through the managed OfficeCLI
// binary inside the SID-private UserHost process. Results are cached by
// content hash under the SID-private cache tree and served read-only with the
// same inline + CSP policy as the workspace PDF sandbox pipeline
// (harness-bundle workspace-api.ts), so no new HTML preview surface exists.

const (
	officePreviewDefaultMaxSourceBytes = 64 << 20
	officePreviewDefaultMaxOutputBytes = 32 << 20
	officePreviewConcurrency           = 2
	officePreviewTimeout               = 2 * time.Minute
)

// Error codes mirror the renderer's OfficeWatchErrorCode union so the web
// adapter can pass them through without translation.
var (
	errOfficeCLINotFound        = errors.New("OFFICECLI_NOT_FOUND")
	errOfficePreviewTooLarge    = errors.New("OFFICE_PREVIEW_FILE_TOO_LARGE")
	errOfficePreviewOutside     = errors.New("PATH_OUTSIDE_SANDBOX")
	errOfficePreviewFailed      = errors.New("OFFICECLI_START_FAILED")
	errOfficePreviewNotFound    = errors.New("office_preview_file_not_found")
	errOfficePreviewUnsupported = errors.New("office_preview_unsupported_type")
)

var (
	officePreviewContentName = regexp.MustCompile(`^[0-9a-f]{64}\.pdf$`)
	officePreviewWorkspaceID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)
)

type officePreviewFlight struct {
	done chan struct{}
	hash string
	err  error
}

type officePreviewService struct {
	cacheDir         string
	managedToolsRoot string
	assigner         mcpProcessAssigner
	sem              chan struct{}
	maxSourceBytes   int64
	maxOutputBytes   int64
	lock             sync.Mutex
	flights          map[string]*officePreviewFlight
	// lookPath and run are injectable seams for tests.
	lookPath func(string) (string, error)
	run      func(ctx context.Context, toolPath, source, output string) error
}

func newOfficePreviewService(cacheDir, managedToolsRoot string, assigner mcpProcessAssigner) (*officePreviewService, error) {
	if !filepath.IsAbs(cacheDir) {
		return nil, errors.New("office preview cache directory must be absolute")
	}
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return nil, errors.New("create office preview cache: " + err.Error())
	}
	service := &officePreviewService{
		cacheDir:         cacheDir,
		managedToolsRoot: managedToolsRoot,
		assigner:         assigner,
		sem:              make(chan struct{}, officePreviewConcurrency),
		maxSourceBytes:   officePreviewDefaultMaxSourceBytes,
		maxOutputBytes:   officePreviewDefaultMaxOutputBytes,
		flights:          map[string]*officePreviewFlight{},
		lookPath:         exec.LookPath,
	}
	service.run = service.runOfficeCLI
	return service, nil
}

func (s *officePreviewService) toolPath() (string, error) {
	if s.managedToolsRoot != "" {
		candidate := filepath.Join(s.managedToolsRoot, "officecli.exe")
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			return candidate, nil
		}
	}
	// The UserHost PATH is already prefixed with the managed tools root at
	// process start (cmd/userhost), so LookPath is the portable fallback.
	if resolved, err := s.lookPath("officecli.exe"); err == nil {
		return resolved, nil
	}
	return "", errOfficeCLINotFound
}

// convert returns the content-hash cache key for the source's PDF rendering.
// Concurrent conversions of identical content share one flight; callers may
// cancel their own context without affecting other waiters beyond the flight
// owner, whose cancellation stops the OfficeCLI process.
func (s *officePreviewService) convert(ctx context.Context, source string) (string, error) {
	switch strings.ToLower(filepath.Ext(source)) {
	case ".docx", ".xlsx", ".pptx":
	default:
		return "", errOfficePreviewUnsupported
	}
	info, err := os.Stat(source)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", errOfficePreviewNotFound
		}
		return "", err
	}
	if info.IsDir() {
		return "", errOfficePreviewNotFound
	}
	if info.Size() > s.maxSourceBytes {
		return "", errOfficePreviewTooLarge
	}
	file, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	hash := hex.EncodeToString(hasher.Sum(nil))
	target := filepath.Join(s.cacheDir, hash+".pdf")
	if cached, err := os.Stat(target); err == nil && cached.Mode().IsRegular() && cached.Size() > 0 {
		return hash, nil
	}
	s.lock.Lock()
	if flight, ok := s.flights[hash]; ok {
		s.lock.Unlock()
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-flight.done:
			return flight.hash, flight.err
		}
	}
	flight := &officePreviewFlight{done: make(chan struct{})}
	s.flights[hash] = flight
	s.lock.Unlock()
	flight.hash, flight.err = s.convertExclusive(ctx, hash, source, target)
	close(flight.done)
	s.lock.Lock()
	delete(s.flights, hash)
	s.lock.Unlock()
	return flight.hash, flight.err
}

func (s *officePreviewService) convertExclusive(ctx context.Context, hash, source, target string) (string, error) {
	toolPath, err := s.toolPath()
	if err != nil {
		return "", err
	}
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	conversion, cancel := context.WithTimeout(ctx, officePreviewTimeout)
	defer cancel()
	temporary := filepath.Join(s.cacheDir, hash+".tmp")
	defer os.Remove(temporary)
	if err := s.run(conversion, toolPath, source, temporary); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", errOfficePreviewFailed
	}
	output, err := os.Stat(temporary)
	if err != nil || output.Size() == 0 {
		return "", errOfficePreviewFailed
	}
	if output.Size() > s.maxOutputBytes {
		return "", errOfficePreviewTooLarge
	}
	if err := os.Rename(temporary, target); err != nil {
		return "", errOfficePreviewFailed
	}
	return hash, nil
}

func (s *officePreviewService) runOfficeCLI(ctx context.Context, toolPath, source, output string) error {
	command := exec.CommandContext(ctx, toolPath, "view", source, "pdf", "-o", output)
	// Keep any relative scratch output inside the SID-private cache tree; the
	// process also inherits the UserHost job object limits via the assigner.
	command.Dir = s.cacheDir
	if err := command.Start(); err != nil {
		return err
	}
	if s.assigner != nil {
		_ = s.assigner.AssignPID(uint32(command.Process.Pid))
	}
	return command.Wait()
}

func (s *officePreviewService) content(name string) (string, error) {
	if !officePreviewContentName.MatchString(name) {
		return "", errOfficePreviewNotFound
	}
	target := filepath.Join(s.cacheDir, name)
	info, err := os.Stat(target)
	if err != nil || !info.Mode().IsRegular() {
		return "", errOfficePreviewNotFound
	}
	return target, nil
}

func normalizeOfficeRelativePath(value string) (string, error) {
	value = strings.TrimSpace(strings.ReplaceAll(value, `\`, "/"))
	value = strings.TrimPrefix(value, "/")
	if value == "" || value == "." {
		return "", errOfficePreviewOutside
	}
	clean := path.Clean(value)
	if clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") || strings.Contains(clean, ":") {
		return "", errOfficePreviewOutside
	}
	for _, segment := range strings.Split(clean, "/") {
		if strings.IndexFunc(segment, unicode.IsControl) >= 0 {
			return "", errOfficePreviewOutside
		}
	}
	return clean, nil
}

func writeOfficePreviewError(writer http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	code := errOfficePreviewFailed.Error()
	switch {
	case errors.Is(err, errOfficeCLINotFound):
		status, code = http.StatusServiceUnavailable, err.Error()
	case errors.Is(err, errOfficePreviewTooLarge):
		status, code = http.StatusRequestEntityTooLarge, err.Error()
	case errors.Is(err, errOfficePreviewOutside), errors.Is(err, errOfficePreviewUnsupported):
		status, code = http.StatusBadRequest, err.Error()
	case errors.Is(err, errOfficePreviewNotFound):
		status, code = http.StatusNotFound, err.Error()
	}
	writeRuntimeError(writer, status, code)
}

func officePreviewConvertHandler(service *officePreviewService, workspaceRoot string) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		request.Body = http.MaxBytesReader(writer, request.Body, 4*1024)
		var input struct {
			Workspace string `json:"workspace"`
			Path      string `json:"path"`
		}
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_office_preview_request")
			return
		}
		if !officePreviewWorkspaceID.MatchString(input.Workspace) {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_office_preview_request")
			return
		}
		relative, err := normalizeOfficeRelativePath(input.Path)
		if err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, errOfficePreviewOutside.Error())
			return
		}
		root := filepath.Join(workspaceRoot, input.Workspace)
		if err := validateSharedPathNoReparse(root, relative, false); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				writeRuntimeError(writer, http.StatusNotFound, errOfficePreviewNotFound.Error())
				return
			}
			writeRuntimeError(writer, http.StatusBadRequest, errOfficePreviewOutside.Error())
			return
		}
		hash, err := service.convert(request.Context(), filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			writeOfficePreviewError(writer, err)
			return
		}
		writeRuntimeJSON(writer, http.StatusOK, map[string]string{"hash": hash})
	}
}

func officePreviewContentHandler(service *officePreviewService) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		target, err := service.content(request.PathValue("name"))
		if err != nil {
			writeRuntimeError(writer, http.StatusNotFound, "office_preview_not_found")
			return
		}
		writer.Header().Set("cache-control", "no-store")
		writer.Header().Set("content-disposition", "inline; filename*=UTF-8''"+request.PathValue("name"))
		writer.Header().Set("content-security-policy", "default-src 'none'; frame-ancestors 'self'; base-uri 'none'")
		http.ServeFile(writer, request, target)
	}
}
