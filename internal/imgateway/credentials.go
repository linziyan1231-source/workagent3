package imgateway

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type FileCredentialStore struct{ root string }

func NewFileCredentialStore(root string) (*FileCredentialStore, error) {
	absolute, err := filepath.Abs(root)
	if err != nil || strings.TrimSpace(root) == "" {
		return nil, errors.New("IM credential root is required")
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return nil, fmt.Errorf("create IM credential root: %w", err)
	}
	return &FileCredentialStore{root: absolute}, nil
}

func (s *FileCredentialStore) Resolve(_ context.Context, ref string) ([]byte, error) {
	if ref == "" || filepath.Base(ref) != ref || strings.ContainsAny(ref, `/\`) {
		return nil, errors.New("invalid IM credential ref")
	}
	path := filepath.Join(s.root, ref)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect IM credential: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 64*1024 {
		return nil, errors.New("IM credential must be a regular non-symlink file no larger than 64 KiB")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open IM credential: %w", err)
	}
	defer file.Close()
	secret, err := io.ReadAll(io.LimitReader(file, 64*1024+1))
	if err != nil || len(secret) == 0 || len(secret) > 64*1024 {
		clear(secret)
		return nil, errors.New("IM credential is empty or too large")
	}
	return secret, nil
}
