// Package sharedtrash owns the company-wide shared-project recycle pool. It is
// used by Employee Manager under SYSTEM; employee runtimes never open this root.
package sharedtrash

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"workagent3/internal/auth"
	"workagent3/internal/contracts"
	"workagent3/internal/winutil"
)

const LimitBytes int64 = 60 * 1024 * 1024 * 1024
const RetentionDays = 7
const retention = RetentionDays * 24 * time.Hour

var (
	ErrInvalid     = errors.New("invalid_shared_trash_request")
	ErrNotFound    = errors.New("trash_entry_not_found")
	ErrExists      = errors.New("file_exists")
	projectPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
	sidPattern     = regexp.MustCompile(`^S-1-(?:[0-9]+-)*[0-9]+$`)
	entryPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{24,64}$`)
	legacyPattern  = regexp.MustCompile(`^([0-9]{10,16})-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-(.+)$`)
)

type metadata struct {
	Version   int    `json:"version"`
	ProjectID string `json:"projectId"`
	Order     int64  `json:"order"`
	Phase     string `json:"phase,omitempty"`
	contracts.SharedTrashEntry
}

type storedEntry struct {
	metadata
	directory string
}

type Store struct {
	mu    sync.Mutex
	base  string
	root  string
	now   func() time.Time
	limit int64
	order int64
	// An unreadable record makes the pool's size/order incomplete. TTL remains
	// safe for known records, while capacity-based eviction waits for a full scan.
	incomplete bool
}

func New(dataRootBase string) (*Store, error) {
	if !filepath.IsAbs(dataRootBase) {
		return nil, ErrInvalid
	}
	base := filepath.Clean(dataRootBase)
	if err := normalDirectory(base); err != nil {
		return nil, err
	}
	root := filepath.Join(base, ".workagent-shared-trash")
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	if err := normalDirectory(root); err != nil {
		return nil, err
	}
	if err := winutil.ProtectSharedTrashRoot(root); err != nil {
		return nil, err
	}
	store := &Store{base: base, root: root, now: time.Now, limit: LimitBytes}
	if err := store.recover(context.Background()); err != nil {
		log.Printf("Shared trash recovery deferred: %v", err)
	}
	items, err := store.entries()
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		if item.Order > store.order {
			store.order = item.Order
		}
	}
	return store, nil
}

// Operate is serialized with background retention. projectID and OwnerSID must
// originate from Portal's authoritative project row, never the browser.
func (s *Store) Operate(ctx context.Context, projectID string, request contracts.SharedTrashRequest) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	projectRoot, err := s.projectRoot(projectID, request.OwnerSID)
	if err != nil {
		return nil, err
	}
	if request.Operation != "list" && request.Operation != "recycle" && request.Operation != "restore" && request.Operation != "purge" {
		return nil, ErrInvalid
	}
	if err := s.recover(ctx); err != nil {
		log.Printf("Shared trash recovery deferred: %v", err)
	}
	if err := s.importProject(ctx, projectID, projectRoot); err != nil {
		log.Printf("Shared trash import preserved unavailable items: %v", err)
	}
	if err := s.prune(ctx); err != nil {
		return nil, err
	}
	switch request.Operation {
	case "list":
		return s.list(projectID)
	case "recycle":
		relative, err := relativePath(projectID, request.Path)
		if err != nil {
			return nil, err
		}
		source, err := safePath(projectRoot, relative, false)
		if err != nil {
			return nil, err
		}
		entry, err := s.recycle(projectID, projectRoot, source, relative, nil)
		if err != nil {
			return nil, err
		}
		if err := s.prune(ctx); err != nil {
			// The source has already moved into a durable, private trash entry.
			// A cleanup failure must not tell the runtime that deletion failed:
			// it still needs to mark the old file identity deleted.
			log.Printf("Shared trash retention after committed recycle deferred: %v", err)
		}
		return entry, nil
	case "restore", "purge":
		item, err := s.find(projectID, request.EntryID)
		if err != nil {
			return nil, err
		}
		if request.Operation == "purge" {
			if err := removeEntry(item); err != nil {
				return nil, err
			}
			return map[string]any{}, nil
		}
		target, err := safePath(projectRoot, item.Path, true)
		if err != nil {
			return nil, err
		}
		if _, err := os.Lstat(target); err == nil {
			return nil, ErrExists
		} else if !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		if err := s.restoreParents(projectRoot, filepath.Dir(target)); err != nil {
			return nil, err
		}
		payload := filepath.Join(item.directory, "payload")
		if _, _, err := treeSize(payload); err != nil {
			return nil, err
		}
		item.Phase = "restoring"
		if err := writeMetadata(item.directory, item.metadata); err != nil {
			return nil, err
		}
		if err := renameNoReplace(payload, target); err != nil {
			item.Phase = ""
			return nil, errors.Join(err, writeMetadata(item.directory, item.metadata))
		}
		if err := winutil.RestoreSharedTrashTree(target, projectRoot); err != nil {
			rollback := renameNoReplace(target, payload)
			if rollback == nil {
				rollback = winutil.ProtectSharedTrashTree(payload)
			}
			return nil, errors.Join(err, rollback)
		}
		return finishRestore(item), nil
	}
	return nil, ErrInvalid
}

// Sweep imports only shared-project trash, then expires entries and evicts the
// globally oldest deletions. No employee runtime needs to be running.
func (s *Store) Sweep(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var failures []error
	if err := s.recover(ctx); err != nil {
		failures = append(failures, err)
	}
	sharedRoot := filepath.Join(s.base, "shared")
	if err := normalDirectory(sharedRoot); err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			failures = append(failures, err)
		}
	} else {
		owners, err := os.ReadDir(sharedRoot)
		if err != nil {
			failures = append(failures, err)
		}
		for _, owner := range owners {
			if !sidPattern.MatchString(owner.Name()) || !owner.IsDir() {
				continue
			}
			ownerRoot := filepath.Join(sharedRoot, owner.Name())
			if err := normalDirectory(ownerRoot); err != nil {
				failures = append(failures, err)
				continue
			}
			projects, err := os.ReadDir(ownerRoot)
			if err != nil {
				failures = append(failures, err)
				continue
			}
			for _, project := range projects {
				if err := ctx.Err(); err != nil {
					return err
				}
				if !projectPattern.MatchString(project.Name()) || !project.IsDir() {
					continue
				}
				root := filepath.Join(ownerRoot, project.Name())
				if err := normalDirectory(root); err != nil {
					failures = append(failures, err)
					continue
				}
				if err := s.importProject(ctx, project.Name(), root); err != nil {
					failures = append(failures, err)
				}
			}
		}
	}
	if err := s.prune(ctx); err != nil {
		failures = append(failures, err)
	}
	return errors.Join(failures...)
}

func (s *Store) projectRoot(projectID, ownerSID string) (string, error) {
	if !projectPattern.MatchString(projectID) || !sidPattern.MatchString(ownerSID) {
		return "", ErrInvalid
	}
	current := s.base
	for _, part := range []string{"shared", ownerSID, projectID} {
		current = filepath.Join(current, part)
		if err := normalDirectory(current); err != nil {
			return "", err
		}
	}
	return current, nil
}

func (s *Store) recycle(projectID, projectRoot, source, relative string, legacy *time.Time) (contracts.SharedTrashEntry, error) {
	kind, size, err := treeSize(source)
	if err != nil {
		return contracts.SharedTrashEntry{}, err
	}
	id, err := auth.RandomToken(24)
	if err != nil {
		return contracts.SharedTrashEntry{}, err
	}
	now := s.now().UTC()
	entry := contracts.SharedTrashEntry{ID: id, Name: path.Base(relative), Path: relative, Kind: kind, Size: size, DeletedAt: now, ExpiresAt: now.Add(retention), Legacy: legacy != nil}
	if legacy != nil && !legacy.IsZero() {
		entry.LegacyDeletedAt = legacy
	}
	directory := filepath.Join(s.root, projectID, id)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return entry, err
	}
	if err := normalDirectory(filepath.Dir(directory)); err != nil {
		return entry, err
	}
	if err := normalDirectory(directory); err != nil {
		return entry, err
	}
	s.order++
	record := metadata{Version: 1, ProjectID: projectID, Order: s.order, Phase: "recycling", SharedTrashEntry: entry}
	if err := writeMetadata(directory, record); err != nil {
		return entry, err
	}
	payload := filepath.Join(directory, "payload")
	if err := renameNoReplace(source, payload); err != nil {
		return entry, errors.Join(err, removeEmptyRecord(directory))
	}
	if err := winutil.ProtectSharedTrashTree(payload); err != nil {
		rollback := renameNoReplace(payload, source)
		if rollback == nil {
			rollback = winutil.RestoreSharedTrashTree(source, projectRoot)
		}
		return entry, errors.Join(err, rollback)
	}
	return finishRecycle(directory, record), nil
}

// The pending journal and private payload already commit the deletion. Updating
// the final size/phase is recoverable bookkeeping, never a failed deletion.
func finishRecycle(directory string, record metadata) contracts.SharedTrashEntry {
	_, size, err := treeSize(filepath.Join(directory, "payload"))
	if err != nil {
		log.Printf("Shared trash size finalization after committed recycle deferred: %v", err)
		return record.SharedTrashEntry
	}
	record.Size, record.Phase = size, ""
	if err := writeMetadata(directory, record); err != nil {
		log.Printf("Shared trash metadata finalization after committed recycle deferred: %v", err)
	}
	return record.SharedTrashEntry
}

func finishRestore(item storedEntry) contracts.SharedTrashEntry {
	if err := removeEmptyRecord(item.directory); err != nil {
		log.Printf("Shared trash journal cleanup after committed restore deferred: %v", err)
	}
	return item.SharedTrashEntry
}

func (s *Store) importProject(ctx context.Context, projectID, projectRoot string) error {
	root := filepath.Join(projectRoot, ".workagent-trash")
	if err := normalDirectory(root); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	var failures []error
	for _, item := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := item.Name()
		var originalDeletedAt time.Time
		if parts := legacyPattern.FindStringSubmatch(name); parts != nil {
			name = parts[2]
			stamp, _ := strconv.ParseInt(parts[1], 10, 64)
			originalDeletedAt = time.UnixMilli(stamp).UTC()
		}
		if _, err := relativePath(projectID, name); err != nil {
			failures = append(failures, fmt.Errorf("preserved unknown shared trash item: %s", item.Name()))
			continue
		}
		if _, err := s.recycle(projectID, projectRoot, filepath.Join(root, item.Name()), name, &originalDeletedAt); err != nil {
			failures = append(failures, fmt.Errorf("preserved shared trash item %s: %w", item.Name(), err))
		}
	}
	return errors.Join(failures...)
}

func (s *Store) entries() ([]storedEntry, error) {
	s.incomplete = false
	projects, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	var result []storedEntry
	for _, project := range projects {
		if !project.IsDir() || !projectPattern.MatchString(project.Name()) {
			continue
		}
		root := filepath.Join(s.root, project.Name())
		if err := normalDirectory(root); err != nil {
			s.incomplete = true
			log.Printf("Shared trash inventory preserved unavailable project %s: %v", project.Name(), err)
			continue
		}
		items, err := os.ReadDir(root)
		if err != nil {
			s.incomplete = true
			log.Printf("Shared trash inventory preserved unreadable project %s: %v", project.Name(), err)
			continue
		}
		for _, item := range items {
			if !item.IsDir() || !entryPattern.MatchString(item.Name()) {
				continue
			}
			directory := filepath.Join(root, item.Name())
			entry, err := readEntry(directory, project.Name(), item.Name())
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			if err != nil {
				s.incomplete = true
				log.Printf("Shared trash inventory preserved unreadable entry %s/%s: %v", project.Name(), item.Name(), err)
				continue
			}
			result = append(result, entry)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].DeletedAt.Equal(result[j].DeletedAt) {
			return result[i].Order < result[j].Order
		}
		return result[i].DeletedAt.Before(result[j].DeletedAt)
	})
	return result, nil
}

func (s *Store) list(projectID string) (contracts.SharedTrashList, error) {
	items, err := s.entries()
	result := contracts.SharedTrashList{Entries: []contracts.SharedTrashEntry{}, LimitBytes: s.limit, RetentionDays: RetentionDays}
	if err != nil {
		return result, err
	}
	for _, item := range items {
		result.UsedBytes += item.Size
		if item.ProjectID == projectID {
			result.ProjectUsedBytes += item.Size
			if item.Phase == "purging" {
				continue
			}
			result.Entries = append(result.Entries, item.SharedTrashEntry)
		}
	}
	sort.Slice(result.Entries, func(i, j int) bool { return result.Entries[i].DeletedAt.After(result.Entries[j].DeletedAt) })
	return result, nil
}

func (s *Store) find(projectID, id string) (storedEntry, error) {
	if !entryPattern.MatchString(id) {
		return storedEntry{}, ErrNotFound
	}
	item, err := readEntry(filepath.Join(s.root, projectID, id), projectID, id)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, ErrInvalid) || (err == nil && item.Phase == "purging") {
		return storedEntry{}, ErrNotFound
	}
	return item, err
}

func (s *Store) prune(ctx context.Context) error {
	items, err := s.entries()
	if err != nil {
		return err
	}
	var total int64
	for _, item := range items {
		total += item.Size
	}
	var failures []error
	now := s.now()
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			return err
		}
		if now.Before(item.ExpiresAt) && (s.incomplete || total <= s.limit) {
			continue
		}
		if err := removeEntry(item); err != nil {
			failures = append(failures, err)
			continue
		}
		total -= item.Size
	}
	return errors.Join(failures...)
}

func readEntry(directory, projectID, id string) (storedEntry, error) {
	item, err := readMetadata(directory, projectID, id)
	if err != nil {
		return storedEntry{}, err
	}
	if item.Phase != "" && item.Phase != "recycling" && item.Phase != "restoring" && item.Phase != "purging" {
		return storedEntry{}, ErrInvalid
	}
	info, err := normalInfo(filepath.Join(directory, "payload"))
	if err != nil {
		return storedEntry{}, err
	}
	if (item.Kind != "directory" || !info.IsDir()) && (item.Kind != "file" || !info.Mode().IsRegular()) {
		return storedEntry{}, ErrInvalid
	}
	if item.Phase != "" {
		// A failed cleanup still occupies the shared pool. Count remaining
		// bytes while recovery retries it, without offering partial restores.
		_, item.Size, err = treeSize(filepath.Join(directory, "payload"))
		if err != nil {
			return storedEntry{}, err
		}
	}
	return storedEntry{metadata: item, directory: directory}, nil
}

func readMetadata(directory, projectID, id string) (metadata, error) {
	if err := normalDirectory(directory); err != nil {
		return metadata{}, err
	}
	name := filepath.Join(directory, "metadata.json")
	if err := normalFile(name); err != nil {
		return metadata{}, err
	}
	content, err := os.ReadFile(name)
	if err != nil {
		return metadata{}, err
	}
	var item metadata
	if json.Unmarshal(content, &item) != nil || item.Version != 1 || item.ProjectID != projectID || item.ID != id || item.Size < 0 || item.Order <= 0 || item.DeletedAt.IsZero() || !item.ExpiresAt.Equal(item.DeletedAt.Add(retention)) {
		return metadata{}, ErrInvalid
	}
	if _, err := relativePath(projectID, item.Path); err != nil || path.Base(item.Path) != item.Name {
		return metadata{}, ErrInvalid
	}
	return item, nil
}

func writeMetadata(directory string, item metadata) error {
	content, _ := json.Marshal(item)
	// Keep interrupted temporary writes outside the entry itself: its previous
	// valid journal remains recoverable after a process stop during the write.
	file, err := os.CreateTemp(filepath.Dir(directory), ".metadata-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(content)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	return os.Rename(file.Name(), filepath.Join(directory, "metadata.json"))
}

func removeEntry(item storedEntry) error {
	if _, _, err := treeSize(filepath.Join(item.directory, "payload")); err != nil {
		return err
	}
	if item.Phase == "purging" {
		return finishPurge(item.directory)
	}
	item.Phase = "purging"
	if err := writeMetadata(item.directory, item.metadata); err != nil {
		return err
	}
	return finishPurge(item.directory)
}

func finishPurge(directory string) error {
	payload := filepath.Join(directory, "payload")
	if _, _, err := treeSize(payload); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	// Keep the journal until all managed bytes are gone, and never delete
	// unrecognized files that an administrator placed beside this payload.
	if err := os.RemoveAll(payload); err != nil {
		return err
	}
	if err := removeEmptyRecord(directory); err != nil {
		log.Printf("Shared trash journal cleanup after committed purge deferred: %v", err)
	}
	return nil
}

func (s *Store) restoreParents(root, directory string) error {
	if directory == root {
		return nil
	}
	relative, _ := filepath.Rel(root, directory)
	current := root
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		if err := normalDirectory(current); err == nil {
			continue
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err := os.Mkdir(current, 0700); err != nil {
			return err
		}
		if err := winutil.RestoreSharedTrashTree(current, root); err != nil {
			return err
		}
	}
	return nil
}

func relativePath(projectID, value string) (string, error) {
	value = strings.ReplaceAll(value, `\`, "/")
	if strings.HasPrefix(value, "shared://") {
		prefix := "shared://" + projectID + "/"
		if !strings.HasPrefix(value, prefix) {
			return "", ErrInvalid
		}
		value = strings.TrimPrefix(value, prefix)
	}
	if value == "" || strings.HasPrefix(value, "/") || strings.ContainsAny(value, ":\x00") || filepath.IsAbs(value) {
		return "", ErrInvalid
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." || strings.HasPrefix(strings.ToLower(part), ".workagent") || strings.TrimRight(part, ". ") != part || strings.ContainsAny(part, `<>"|?*`) {
			return "", ErrInvalid
		}
	}
	return value, nil
}

func safePath(root, relative string, allowMissing bool) (string, error) {
	current := root
	if err := normalDirectory(current); err != nil {
		return "", err
	}
	parts := strings.Split(relative, "/")
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, err := normalInfo(current)
		if errors.Is(err, fs.ErrNotExist) && allowMissing {
			continue
		}
		if err != nil {
			return "", err
		}
		if index < len(parts)-1 && !info.IsDir() {
			return "", ErrInvalid
		}
	}
	return current, nil
}

func normalInfo(name string) (os.FileInfo, error) {
	info, err := os.Lstat(name)
	if err != nil {
		return nil, err
	}
	reparse, err := isReparse(name)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || reparse {
		return nil, ErrInvalid
	}
	if info.Mode().IsRegular() {
		multiple, err := winutil.SharedTrashFileHasMultipleLinks(name)
		if err != nil {
			return nil, err
		}
		if multiple {
			return nil, ErrInvalid
		}
	}
	return info, nil
}

func normalDirectory(name string) error {
	info, err := normalInfo(name)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return ErrInvalid
	}
	return nil
}

func normalFile(name string) error {
	info, err := normalInfo(name)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return ErrInvalid
	}
	return nil
}

func treeSize(root string) (string, int64, error) {
	info, err := normalInfo(root)
	if err != nil {
		return "", 0, err
	}
	if info.Mode().IsRegular() {
		return "file", info.Size(), nil
	}
	if !info.IsDir() {
		return "", 0, ErrInvalid
	}
	var size int64
	err = filepath.WalkDir(root, func(name string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := normalInfo(name)
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			size += info.Size()
		} else if !info.IsDir() {
			return ErrInvalid
		}
		return nil
	})
	return "directory", size, err
}
