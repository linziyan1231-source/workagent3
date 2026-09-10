package userhost

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ConfigureRuntimeStorage also covers MCP children launched by UserHost itself.
func ConfigureRuntimeStorage(root string) error {
	dirs, err := ensureDirectories(root)
	if err != nil {
		return err
	}
	for key, value := range map[string]string{
		"TEMP": dirs.temporary, "TMP": dirs.temporary,
		"XDG_CACHE_HOME": dirs.cache, "npm_config_cache": filepath.Join(dirs.cache, "npm"),
		"PIP_CACHE_DIR": filepath.Join(dirs.cache, "pip"), "UV_CACHE_DIR": filepath.Join(dirs.cache, "uv"),
		"PYTHONPYCACHEPREFIX": filepath.Join(dirs.cache, "python"),
	} {
		if err := os.Setenv(key, value); err != nil {
			return err
		}
	}
	return nil
}

func OpenRuntimeLog(path string) (io.WriteCloser, error) { return openHarnessLog(path, 16*1024*1024) }

// Only disposable runtime cache/temp files are aged out. Never traverse links,
// or touch sessions, credentials, workspaces, personal plugins or shared files.
func cleanRuntimeCache(root string, before time.Time) {
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err == nil && info.Mode().IsRegular() && info.ModTime().Before(before) {
			_ = os.Remove(path)
		}
		return nil
	})
}

type rotatingHarnessLog struct {
	mu    sync.Mutex
	path  string
	file  *os.File
	size  int64
	limit int64
}

func openHarnessLog(path string, limit int64) (*rotatingHarnessLog, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	return &rotatingHarnessLog{path: path, file: file, size: info.Size(), limit: limit}, nil
}
func (log *rotatingHarnessLog) Write(data []byte) (int, error) {
	log.mu.Lock()
	defer log.mu.Unlock()
	written := 0
	for len(data) > 0 {
		if log.size >= log.limit {
			if err := log.file.Close(); err != nil {
				return written, err
			}
			for index := 3; index >= 1; index-- {
				target := fmt.Sprintf("%s.%d", log.path, index)
				if index == 3 {
					if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
						return written, err
					}
				}
				source := log.path
				if index > 1 {
					source = fmt.Sprintf("%s.%d", log.path, index-1)
				}
				if err := os.Rename(source, target); err != nil && !os.IsNotExist(err) {
					return written, err
				}
			}
			file, err := os.OpenFile(log.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				return written, err
			}
			log.file, log.size = file, 0
		}
		count := min(len(data), int(log.limit-log.size))
		n, err := log.file.Write(data[:count])
		written += n
		log.size += int64(n)
		data = data[n:]
		if err != nil {
			return written, err
		}
	}
	return written, nil
}
func (log *rotatingHarnessLog) Close() error {
	log.mu.Lock()
	defer log.mu.Unlock()
	return log.file.Close()
}
