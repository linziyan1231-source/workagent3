package userhost

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode"
)

const maxSharedFileData = 8 * 1024 * 1024

type sharedFileRequest struct {
	ProjectID string `json:"project_id"`
	Operation string `json:"operation"`
	Path      string `json:"path,omitempty"`
	Data      string `json:"data,omitempty"`
	NewName   string `json:"new_name,omitempty"`
}

type sharedFileOperator interface {
	OperateFile(context.Context, sharedFileRequest) (json.RawMessage, error)
}

type sharedFileManager struct {
	base     string
	ownerSID string
	recycle  func(context.Context, string, string) error
	// officePreview converts Office documents to cached PDFs for the
	// "office-preview" operation; wired by newRuntimeGateway.
	officePreview *officePreviewService
}

// sharedBase exposes the shared-project base root to the session interceptor
// (sharedSessionBaseProvider); it equals filepath.Dir(dataRoot).
func (m *sharedFileManager) sharedBase() string { return m.base }

func (m *sharedFileManager) ProjectRoot(_ context.Context, projectID string) (string, error) {
	if !sharedProjectIDPattern.MatchString(strings.TrimSpace(projectID)) {
		return "", errors.New("shared project is invalid")
	}
	root := filepath.Join(m.base, "shared", m.ownerSID, projectID)
	if err := requireNormalDirectory(root); err != nil {
		return "", err
	}
	if err := validateSharedPathNoReparse(root, "", false); err != nil {
		return "", err
	}
	return root, nil
}

func newSharedFileManager(dataRoot, ownerSID string) (*sharedFileManager, error) {
	dataRoot = filepath.Clean(dataRoot)
	if !filepath.IsAbs(dataRoot) || !strings.EqualFold(filepath.Base(dataRoot), ownerSID) || !validSharedSID(ownerSID) {
		return nil, errors.New("shared-file manager requires the SID-private Runtime")
	}
	return &sharedFileManager{base: filepath.Dir(dataRoot), ownerSID: ownerSID}, nil
}

func (m *sharedFileManager) OperateFile(ctx context.Context, request sharedFileRequest) (json.RawMessage, error) {
	if !sharedProjectIDPattern.MatchString(request.ProjectID) {
		return nil, errors.New("shared file project is invalid")
	}
	root := filepath.Join(m.base, "shared", m.ownerSID, request.ProjectID)
	if err := requireNormalDirectory(root); err != nil {
		return nil, err
	}
	relative, err := normalizeSharedRelativePath(request.ProjectID, request.Path)
	if err != nil {
		return nil, err
	}
	targetPath := root
	if relative != "" {
		targetPath = filepath.Join(root, filepath.FromSlash(relative))
	}
	operation := strings.TrimSpace(request.Operation)
	if operation != "list" {
		if err := validateSharedPathNoReparse(root, relative, operation == "write" || operation == "write-buffer"); err != nil {
			return nil, err
		}
	}
	switch operation {
	case "dir":
		entries, err := os.ReadDir(targetPath)
		if err != nil {
			return nil, err
		}
		result := make([]map[string]string, 0, len(entries))
		for _, entry := range entries {
			entryPath := filepath.Join(targetPath, entry.Name())
			if entry.Type()&os.ModeSymlink != 0 || sharedPathIsReparse(entryPath) {
				continue
			}
			kind := "file"
			if entry.IsDir() {
				kind = "directory"
			}
			result = append(result, map[string]string{"name": entry.Name(), "type": kind})
		}
		return json.Marshal(result)
	case "list":
		if request.Path != "" || request.Data != "" || request.NewName != "" {
			return nil, errors.New("shared file list fields are invalid")
		}
		if err := rejectSharedTreeReparse(root); err != nil {
			return nil, err
		}
		result := []map[string]string{}
		err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if name == root || entry.IsDir() {
				return nil
			}
			relativeName, err := filepath.Rel(root, name)
			if err != nil {
				return err
			}
			relativeName = filepath.ToSlash(relativeName)
			result = append(result, map[string]string{"name": entry.Name(), "full_path": "shared://" + request.ProjectID + "/" + relativeName, "relative_path": relativeName})
			return nil
		})
		if err != nil {
			return nil, err
		}
		return json.Marshal(result)
	case "metadata", "read", "read-buffer", "image-base64":
		if relative == "" {
			return nil, errors.New("shared file path is required")
		}
		info, err := os.Stat(targetPath)
		if err != nil {
			return nil, err
		}
		if operation == "metadata" {
			contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(info.Name())))
			if contentType == "" {
				contentType = "application/octet-stream"
			}
			return json.Marshal(map[string]any{"name": info.Name(), "path": "shared://" + request.ProjectID + "/" + relative, "size": info.Size(), "type": contentType, "lastModified": info.ModTime().UnixMilli(), "isDirectory": info.IsDir()})
		}
		if info.IsDir() || info.Size() > maxSharedFileData {
			return nil, errors.New("shared file is not readable or is oversized")
		}
		content, err := os.ReadFile(targetPath)
		if err != nil {
			return nil, err
		}
		if operation == "read" {
			return json.Marshal(string(content))
		}
		encoded := base64.StdEncoding.EncodeToString(content)
		if operation == "read-buffer" {
			return json.Marshal(encoded)
		}
		contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(info.Name())))
		if contentType == "" {
			contentType = http.DetectContentType(content)
		}
		return json.Marshal("data:" + contentType + ";base64," + encoded)
	case "write-buffer":
		if relative == "" || len(request.Data) > maxSharedFileData {
			return nil, errors.New("shared upload is invalid or oversized")
		}
		data, err := base64.StdEncoding.DecodeString(request.Data)
		if err != nil {
			return nil, errors.New("shared upload encoding is invalid")
		}
		file, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return nil, err
		}
		_, writeErr := file.Write(data)
		closeErr := file.Close()
		if err := errors.Join(writeErr, closeErr); err != nil {
			_ = os.Remove(targetPath)
			return nil, err
		}
		return []byte("true"), nil
	case "write":
		if relative == "" || len(request.Data) > maxSharedFileData {
			return nil, errors.New("shared file write is invalid or oversized")
		}
		file, err := os.CreateTemp(filepath.Dir(targetPath), filepath.Base(targetPath)+".tmp-*")
		if err != nil {
			return nil, err
		}
		defer os.Remove(file.Name())
		_, writeErr := file.Write([]byte(request.Data))
		closeErr := file.Close()
		if err := errors.Join(writeErr, closeErr); err != nil {
			return nil, err
		}
		if err := os.Rename(file.Name(), targetPath); err != nil {
			return nil, err
		}
		return json.Marshal(true)
	case "remove":
		if relative == "" {
			return nil, errors.New("shared project root cannot be removed")
		}
		if m.recycle == nil {
			return nil, errors.New("shared_trash_unavailable")
		}
		if err := m.recycle(ctx, request.ProjectID, relative); err != nil {
			return nil, err
		}
		return []byte("null"), nil
	case "rename":
		if relative == "" || !validSharedFileName(request.NewName) {
			return nil, errors.New("shared file rename is invalid")
		}
		renamed := filepath.Join(filepath.Dir(targetPath), strings.TrimSpace(request.NewName))
		if _, err := os.Lstat(renamed); err == nil {
			return nil, errors.New("shared file rename target already exists")
		} else if !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		if err := os.Rename(targetPath, renamed); err != nil {
			return nil, err
		}
		parent := path.Dir(relative)
		newRelative := strings.TrimSpace(request.NewName)
		if parent != "." {
			newRelative = parent + "/" + newRelative
		}
		return json.Marshal(map[string]string{"new_path": "shared://" + request.ProjectID + "/" + newRelative})
	case "office-preview":
		// Shared Office files convert on the owner's UserHost through the same
		// SID-private cache as personal previews; the PDF travels back as
		// base64 inside the shared-files envelope and is rendered by the
		// caller's sandboxed PDF pipeline.
		if relative == "" {
			return nil, errors.New("shared file path is required")
		}
		if m.officePreview == nil {
			return nil, errOfficeCLINotFound
		}
		info, err := os.Stat(targetPath)
		if err != nil || info.IsDir() {
			return nil, errOfficePreviewNotFound
		}
		hash, err := m.officePreview.convert(ctx, targetPath)
		if err != nil {
			return nil, err
		}
		content, err := os.ReadFile(filepath.Join(m.officePreview.cacheDir, hash+".pdf"))
		if err != nil {
			return nil, errOfficePreviewFailed
		}
		if len(content) > maxSharedFileData {
			return nil, errOfficePreviewTooLarge
		}
		return json.Marshal(map[string]string{"name": hash + ".pdf", "pdf": base64.StdEncoding.EncodeToString(content)})
	default:
		return nil, errors.New("unsupported shared file operation")
	}
}

func sharedFileHandler(operator sharedFileOperator) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		request.Body = http.MaxBytesReader(writer, request.Body, maxSharedFileData+16*1024)
		var input sharedFileRequest
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF {
			writeRuntimeError(writer, http.StatusBadRequest, "invalid_shared_file_request")
			return
		}
		data, err := operator.OperateFile(request.Context(), input)
		if err != nil {
			writeRuntimeError(writer, http.StatusBadRequest, err.Error())
			return
		}
		writeRuntimeJSON(writer, http.StatusOK, map[string]any{"success": true, "data": data})
	}
}

func normalizeSharedRelativePath(projectID, value string) (string, error) {
	value = strings.TrimSpace(strings.ReplaceAll(value, `\`, "/"))
	prefix := "shared://" + projectID
	if strings.HasPrefix(value, "shared://") {
		if value != prefix && !strings.HasPrefix(value, prefix+"/") {
			return "", errors.New("shared path project does not match authorization")
		}
		value = strings.TrimPrefix(value, prefix)
	}
	value = strings.TrimPrefix(value, "/")
	if value == "" || value == "." {
		return "", nil
	}
	clean := path.Clean(value)
	if clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") || strings.Contains(clean, ":") {
		return "", errors.New("shared path escapes the project")
	}
	for _, segment := range strings.Split(clean, "/") {
		if strings.IndexFunc(segment, unicode.IsControl) >= 0 {
			return "", errors.New("shared path contains an invalid segment")
		}
	}
	return clean, nil
}

func validateSharedPathNoReparse(root, relative string, allowMissingFinal bool) error {
	if err := requireNormalDirectory(root); err != nil {
		return err
	}
	current := root
	for index, segment := range strings.Split(relative, "/") {
		if relative == "" {
			return nil
		}
		current = filepath.Join(current, segment)
		info, err := os.Lstat(current)
		if err != nil {
			if allowMissingFinal && index == len(strings.Split(relative, "/"))-1 && errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || sharedPathIsReparse(current) {
			return fmt.Errorf("reparse points are forbidden in shared file paths: %s", current)
		}
		if index < len(strings.Split(relative, "/"))-1 && !info.IsDir() {
			return errors.New("shared file path traverses a non-directory")
		}
	}
	return nil
}

func rejectSharedTreeReparse(root string) error {
	return filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 || sharedPathIsReparse(name) {
			return fmt.Errorf("reparse points are forbidden in shared projects: %s", name)
		}
		return nil
	})
}

func validSharedFileName(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && value != "." && value != ".." && len(value) <= 255 && !strings.ContainsAny(value, `<>:"/\|?*`) && strings.IndexFunc(value, unicode.IsControl) < 0
}
