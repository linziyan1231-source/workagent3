package publishedapps

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type Manifest struct {
	AppID          string   `json:"appId"`
	Version        string   `json:"version"`
	Kind           string   `json:"kind"`
	Entry          string   `json:"entry"`
	AllowedOrigins []string `json:"allowedOrigins"`
	Preview        bool     `json:"preview"`
	FileCount      int      `json:"fileCount"`
	ByteCount      int64    `json:"byteCount"`
	Excluded       []string `json:"excluded"`
}
type SnapshotInput struct {
	SourceRoot  string   `json:"sourceRoot"`
	Entry       string   `json:"entry"`
	Destination string   `json:"destination"`
	Manifest    Manifest `json:"manifest"`
}

func excludedName(name string) bool {
	name = strings.ToLower(name)
	return strings.HasPrefix(name, ".env") || name == ".git" || name == ".workagent" || name == ".workagent-trash" || name == ".codex" || name == ".kimi" || name == ".ssh" || name == ".aws" || name == ".azure" || name == ".npmrc" || name == ".pypirc" || name == "credential-broker.db" || name == "native-auth" || name == "__pycache__" || name == ".venv"
}
func RunSnapshot(input SnapshotInput) error {
	if !filepath.IsAbs(input.SourceRoot) || !filepath.IsAbs(input.Destination) || input.Entry == "" || strings.ContainsAny(input.Entry, "\\:\x00") || path.Clean(input.Entry) != input.Entry || strings.HasPrefix(input.Entry, "/") || input.Entry == ".." || strings.HasPrefix(input.Entry, "../") {
		return ErrInvalid
	}
	if err := Validate(App{Name: "snapshot", WorkspaceID: "source", Kind: input.Manifest.Kind, Entry: input.Entry, AllowedOrigins: input.Manifest.AllowedOrigins}); err != nil {
		return err
	}
	locks := []io.Closer{}
	defer func() {
		for _, lock := range locks {
			lock.Close()
		}
	}()
	current := input.SourceRoot
	lock, err := lockSnapshotPath(current, true)
	if err != nil {
		return err
	}
	locks = append(locks, lock)
	directory := path.Dir(input.Entry)
	if directory != "." {
		for _, segment := range strings.Split(directory, "/") {
			if excludedName(segment) {
				return errors.New("entry is in an excluded directory")
			}
			current = filepath.Join(current, segment)
			lock, err = lockSnapshotPath(current, true)
			if err != nil {
				return err
			}
			locks = append(locks, lock)
		}
	}
	if excludedName(path.Base(input.Entry)) {
		return errors.New("entry is excluded")
	}
	if _, err = os.Stat(input.Destination); !errors.Is(err, os.ErrNotExist) {
		return errors.New("snapshot destination already exists")
	}
	if err = os.Mkdir(input.Destination, 0700); err != nil {
		return err
	}
	bundle := filepath.Join(input.Destination, "bundle")
	if err = os.Mkdir(bundle, 0700); err != nil {
		return err
	}
	manifest := input.Manifest
	manifest.Entry = path.Base(input.Entry)
	manifest.Excluded = []string{}
	var copyDirectory func(string, string, string) error
	copyDirectory = func(source, target, relative string) error {
		guard, err := lockSnapshotPath(source, true)
		if err != nil {
			return err
		}
		defer guard.Close()
		children, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		for _, child := range children {
			name := child.Name()
			rel := path.Join(relative, name)
			if excludedName(name) {
				if len(manifest.Excluded) < 100 {
					manifest.Excluded = append(manifest.Excluded, rel)
				}
				continue
			}
			if strings.ContainsAny(name, "\\:\x00") || strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
				return ErrInvalid
			}
			from, to := filepath.Join(source, name), filepath.Join(target, name)
			if child.IsDir() {
				if err = os.Mkdir(to, 0700); err != nil {
					return err
				}
				if err = copyDirectory(from, to, rel); err != nil {
					return err
				}
				continue
			}
			file, err := openSnapshotFile(from)
			if err != nil {
				return err
			}
			info, err := file.Stat()
			if err != nil || !info.Mode().IsRegular() {
				file.Close()
				return errors.New("snapshot contains a non-regular file")
			}
			manifest.FileCount++
			if manifest.FileCount > 20000 || manifest.ByteCount+info.Size() > 512*1024*1024 {
				file.Close()
				return errors.New("snapshot exceeds 20000 files or 512 MiB")
			}
			output, err := os.OpenFile(to, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				file.Close()
				return err
			}
			size, copyErr := io.Copy(output, io.LimitReader(file, 512*1024*1024-manifest.ByteCount+1))
			closeErr := output.Close()
			file.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
			manifest.ByteCount += size
			if manifest.ByteCount > 512*1024*1024 {
				return errors.New("snapshot exceeds 512 MiB")
			}
		}
		return nil
	}
	if err = copyDirectory(current, bundle, ""); err != nil {
		return err
	}
	info, err := os.Stat(filepath.Join(bundle, manifest.Entry))
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("snapshot entry missing")
	}
	raw, _ := json.Marshal(manifest)
	return os.WriteFile(filepath.Join(input.Destination, "manifest.json"), raw, 0600)
}

// Static application serving also runs as an AppContainer child in the owner
// Job. Directory listings are disabled and only frozen package files are read.
func RunStatic(bundle, entry, address string) error {
	root, err := os.OpenRoot(bundle)
	if err != nil {
		return err
	}
	defer root.Close()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			w.WriteHeader(405)
			return
		}
		relative := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if relative == "" {
			relative = entry
		}
		file, err := root.Open(relative)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		http.ServeContent(w, r, info.Name(), info.ModTime(), file)
	})
	return (&http.Server{Addr: address, Handler: handler, ReadHeaderTimeout: 10_000_000_000, MaxHeaderBytes: 32 * 1024}).ListenAndServe()
}
