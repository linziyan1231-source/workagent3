package sqlitebackup

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

func Snapshot(ctx context.Context, source, destination string) error {
	if err := ValidateSource(source); err != nil {
		return err
	}
	database, err := sql.Open("sqlite", source)
	if err != nil {
		return err
	}
	defer database.Close()
	if _, err := database.ExecContext(ctx, `VACUUM INTO ?`, destination); err != nil {
		return fmt.Errorf("create consistent SQLite snapshot: %w", err)
	}
	return os.Chmod(destination, 0o600)
}

func ValidateSource(source string) error {
	if !filepath.IsAbs(source) {
		return errors.New("backup source path must be absolute")
	}
	info, err := os.Lstat(source)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || isReparsePoint(info) {
		return errors.New("backup source must be a non-reparse regular file")
	}
	current := filepath.Dir(source)
	for {
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || isReparsePoint(info) {
			return errors.New("backup source path contains a reparse point")
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
		current = parent
	}
}
